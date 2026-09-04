/**
 * The OSC address space, so a show-control system can drive the fleet with no
 * code on either side.
 *
 * ```text
 * /bm/mini/cut/0                     cut ME 1
 * /bm/mini/program/input/0      3    program input 3 on ME 1
 * /bm/mini/recording/start           start recording
 * /bm/*\/aux/source/2           5    aux 3 takes source 5, on every switcher
 * /bm/_/dsk/on/air/0            1    the connection's own switcher
 * ```
 *
 * ## The address is derived, not invented
 *
 * Every address here is a projection of the generated catalogue, by one rule:
 *
 * ```text
 * /bm / <device> / <command id, dots as slashes> / <addresses…> [/ <verb>] [/ <field>]
 * ```
 *
 * with the value carried as the OSC argument. The two optional segments are
 * required exactly when they are needed to disambiguate — the verb when the id
 * offers more than one (`recording` can be started, stopped or configured), the
 * field when the command sets more than one value. That keeps the common
 * address short without a second hand-kept table that could disagree with the
 * catalogue. `dictionary()` enumerates the whole space, which is what the
 * published documentation is generated from.
 *
 * ## The rules that are not derivable
 *
 * **1. The address is the target; the argument is only the value.** Everything
 * about *what* is addressed is in the path, so a button with a fixed address
 * and no argument still means something specific. That is the difference
 * between a TouchOSC layout you draw once and one that needs logic behind
 * every control.
 *
 * **2. A trigger fires on a non-zero argument, and on no argument at all.**
 * Surfaces send `1` on press and `0` on release. A cut that fired on both
 * would fire twice per press, and the second one is the one nobody meant.
 *
 * **3. `_` means the switcher this connection points at, and `*` means all of
 * them.** A device segment is always required: an address that silently means
 * "whichever switcher happens to be selected" is not one you can put on a
 * printed layout.
 *
 * **4. There is no `/norm`.** Mynah publishes normalised addresses that scale a
 * fader's 0..1 into device units, and it can because its device states its own
 * ranges. `atem-connection`'s types carry no minimum or maximum for anything,
 * so scaling here would mean inventing a range and quietly putting a layer, a
 * rate or a gain somewhere nobody asked for. Values are the switcher's own
 * units until the switcher tells us otherwise.
 */

import { CATALOGUE } from '../catalogue-data.js'
import { buildCall, describeCall } from '../compile.js'
import { checkAddress, coerceValue, resolveDevices } from '../resolve.js'
import type { CommandSpec } from '../catalogue.js'
import type { Op } from '../ops.js'
import type { RunContext, RunResult } from '../types.js'

export const OSC_ROOT = '/bm'

const fail = (message: string): RunResult => ({
  ok: false,
  language: 'osc',
  declared: false,
  errors: [{ message }],
})

/** How many verbs answer at one id. Drives whether the verb segment is needed. */
function verbsAt(id: string): string[] {
  return [...new Set(CATALOGUE.commands.filter((c) => c.id === id).map((c) => c.verb))]
}

export interface OscEntry {
  readonly address: string
  readonly id: string
  readonly verb: string
  readonly takesValue: boolean
  readonly describe: string
}

/**
 * Every address this app answers, generated.
 *
 * Published as the integration documentation, so it cannot drift from what the
 * parser accepts — both read the same catalogue.
 */
export function dictionary(): OscEntry[] {
  const out: OscEntry[] = []
  for (const command of CATALOGUE.commands) {
    if (command.verb === 'get') continue
    const path = command.id.split('.').join('/')
    const indices = command.address.map((a) => `<${a.name}>`).join('/')
    const needsVerb = verbsAt(command.id).length > 1
    const fields = command.fields

    const base = [OSC_ROOT, '<device>', path, indices].filter(Boolean).join('/')
    const withVerb = needsVerb ? `${base}/${command.verb}` : base

    if (fields.length === 0) {
      out.push({
        address: withVerb,
        id: command.id,
        verb: command.verb,
        takesValue: false,
        describe: `${command.verb} ${command.id}`,
      })
      continue
    }
    for (const field of fields) {
      const address = fields.length === 1 ? withVerb : `${withVerb}/${field.name}`
      out.push({
        address,
        id: command.id,
        verb: command.verb,
        takesValue: true,
        describe: `${command.verb} ${command.id} ${field.name}`,
      })
    }
  }
  return out.sort((a, b) => a.address.localeCompare(b.address))
}

export function run(body: string, ctx: RunContext): RunResult {
  const text = body.trim()
  if (!text.startsWith('/')) return fail('an OSC address starts with a slash')

  /* Arguments follow the address, whitespace-separated, the way a monitor
     prints them — so a line copied out of one pastes in and runs. */
  const [address, ...args] = text.split(/\s+/)
  const segments = (address as string).split('/').filter(Boolean)

  if (segments[0] !== OSC_ROOT.slice(1)) {
    return fail(`addresses start with ${OSC_ROOT}/`)
  }
  const deviceSegment = segments[1]
  if (deviceSegment === undefined) return fail(`${OSC_ROOT} needs a device: ${OSC_ROOT}/<device>/…`)

  const explicit = deviceSegment === '_' ? undefined : deviceSegment
  const devices = resolveDevices(ctx, explicit)
  if (!devices.ok) return { ok: false, language: 'osc', declared: false, errors: [devices.error] }

  const rest = segments.slice(2)
  const match = resolve(rest)
  if (!match.ok) return fail(match.message)

  const { command, address: addressValues, field } = match

  /*
   * Rule 2: a trigger fires on a non-zero argument and on none at all, so the
   * release half of a surface's press does nothing.
   */
  if (!field) {
    if (args.length && Number(args[0]) === 0) {
      return {
        ok: true,
        language: 'osc',
        declared: false,
        ops: [],
        reads: [],
        summary: `${address} released — nothing sent`,
      }
    }
  }

  const values: Record<string, unknown> = {}
  if (field) {
    if (!args.length) return fail(`${address} needs a value — ${field.name}`)
    const coerced = coerceValue(args.join(' '), field)
    if (!coerced.ok) return { ok: false, language: 'osc', declared: false, errors: [coerced.error] }
    values[field.name] = coerced.value
  }

  const ops: Op[] = []
  for (const id of devices.value) {
    const device = ctx.devices?.find((d) => d.id === id)
    for (const parameter of command.address) {
      const value = addressValues[parameter.name]
      if (value === undefined) continue
      const problem = checkAddress(parameter, value, device)
      if (problem) return { ok: false, language: 'osc', declared: false, errors: [problem] }
    }
    ops.push(
      buildCall(command, id, addressValues, values, describeCall(command, id, addressValues, values, command.fields)),
    )
  }

  return {
    ok: true,
    language: 'osc',
    declared: false,
    ops,
    reads: [],
    summary: `${address} on ${devices.value.join(', ')}`,
  }
}

type Match =
  | {
      ok: true
      command: CommandSpec
      address: Record<string, number>
      field?: CommandSpec['fields'][number]
    }
  | { ok: false; message: string }

/**
 * Walk the segments back onto a command.
 *
 * The id is greedy-matched longest-first, because `transition` and
 * `transition.style` are both real and the longer one has to win. Everything
 * after it is indices, then optionally the verb, then optionally the field.
 */
function resolve(segments: readonly string[]): Match {
  const ids = [...new Set(CATALOGUE.commands.map((c) => c.id))].sort((a, b) => b.length - a.length)

  for (const id of ids) {
    const parts = id.split('.')
    if (parts.length > segments.length) continue
    if (!parts.every((part, index) => segments[index] === part)) continue

    const tail = segments.slice(parts.length)
    const verbs = verbsAt(id)

    for (const verb of verbs) {
      const command = CATALOGUE.commands.find((c) => c.id === id && c.verb === verb)
      if (!command) continue

      const needsVerb = verbs.length > 1
      const wanted = command.address.length + (needsVerb ? 1 : 0)
      if (tail.length < wanted) continue

      const indices = tail.slice(0, command.address.length)
      if (needsVerb && tail[command.address.length] !== verb) continue

      const address: Record<string, number> = {}
      let bad = false
      for (const [index, parameter] of command.address.entries()) {
        const raw = indices[index]
        if (raw === undefined || !/^\d+$/.test(raw)) {
          bad = true
          break
        }
        address[parameter.name] = Number(raw)
      }
      if (bad) continue

      const after = tail.slice(command.address.length + (needsVerb ? 1 : 0))
      if (command.fields.length === 0) {
        if (after.length === 0) return { ok: true, command, address }
        continue
      }
      if (command.fields.length === 1) {
        if (after.length === 0) return { ok: true, command, address, field: command.fields[0] }
        continue
      }
      const named = command.fields.find((f) => f.name === after[0])
      if (named && after.length === 1) return { ok: true, command, address, field: named }
    }
  }

  return {
    ok: false,
    message: `no such address — ${OSC_ROOT}/<device>/${segments.join('/')} does not name a command`,
  }
}
