/**
 * The raw dialect: the switcher's own four-character wire codes.
 *
 * ```text
 * CPgI mixEffect=0 source=3      program input 3 on ME 1
 * DCut mixEffect=0               cut
 * CTTp mixEffect=0 nextStyle=WIPE
 * ```
 *
 * This is the spelling for someone working from a packet capture or Blackmagic's
 * own documentation, where the command is a code and not a verb. It exists for
 * the same reason Mynah accepts AWJ: what an integrator has in front of them at
 * the awkward moment is the vendor's spelling, and translating it by hand is a
 * typo on a live frame.
 *
 * It is also how the rest of this package gets checked. A code typed raw and a
 * command compiled from the grammar go out over the same transport and land in
 * the same place, so "does the catalogue agree with the protocol" stops being a
 * question about the code and becomes something anyone can try in one line.
 *
 * ## The masked commands are the trap
 *
 * `atem-connection` has two writable shapes. A `basic` command carries every
 * value in its constructor. A `masked` one is constructed with the address
 * alone, and each property must then be assigned *and its mask bit set*, which
 * is how the switcher is told which fields were meant. Send a masked command
 * with no bits set and it changes nothing, successfully and silently. The
 * catalogue records which shape each code is so the host can set the mask for
 * exactly the keys present, and this dialect refuses a masked command with no
 * properties rather than send a no-op that looks like it worked.
 */

import { CATALOGUE } from '../catalogue-data.js'
import { coerceValue, resolveDevices, showValue } from '../resolve.js'
import type { FieldSpec } from '../catalogue.js'
import type { Op } from '../ops.js'
import type { LineError, RunContext, RunResult } from '../types.js'

const fail = (message: string): RunResult => ({
  ok: false,
  language: 'raw',
  declared: false,
  errors: [{ message }],
})

export function run(body: string, ctx: RunContext): RunResult {
  const line = body.trim()
  if (line === '') return fail('nothing to do')

  const scoped = /\s+on\s+([A-Za-z0-9_*-]+)\s*$/i.exec(line)
  const explicit = scoped?.[1]
  const rest = scoped ? line.slice(0, scoped.index).trim() : line

  const tokens = rest.split(/\s+/)
  const code = tokens[0] as string

  const spec = CATALOGUE.raw.find((r) => r.rawName === code)
  if (!spec) {
    return fail(
      `no protocol command called "${code}" — codes are four characters and case-sensitive, like CPgI or DCut`,
    )
  }
  if (!spec.writable) {
    return fail(
      `${code} (${spec.className}) is a command the switcher sends, not one it accepts — it cannot be written`,
    )
  }

  const devices = resolveDevices(ctx, explicit)
  if (!devices.ok) return { ok: false, language: 'raw', declared: false, errors: [devices.error] }

  const given = parsePairs(tokens.slice(1))
  if (!given.ok) return { ok: false, language: 'raw', declared: false, errors: [given.error] }

  const known = new Map<string, FieldSpec>()
  for (const field of spec.ctor) known.set(field.name, field)
  for (const field of spec.properties) known.set(field.name, field)

  const values: Record<string, unknown> = {}
  for (const [key, text] of given.value) {
    const field = known.get(key)
    if (!field) {
      const names = [...known.keys()]
      return fail(
        names.length
          ? `${code} has no "${key}" — it takes ${names.join(', ')}`
          : `${code} takes no values`,
      )
    }
    const value = coerceValue(text, field)
    if (!value.ok) return { ok: false, language: 'raw', declared: false, errors: [value.error] }
    values[key] = value.value
  }

  /* Constructor arguments are positional and the library defaults nothing here,
     so a missing one is an error rather than an `undefined` on the wire. */
  const ctor: unknown[] = []
  for (const field of spec.ctor) {
    if (!(field.name in values)) {
      return fail(`${code} needs ${field.name} — it takes ${spec.ctor.map((f) => f.name).join(', ')}`)
    }
    ctor.push(values[field.name])
  }

  const properties: Record<string, unknown> = {}
  for (const field of spec.properties) {
    if (field.name in values && !spec.ctor.some((c) => c.name === field.name)) {
      properties[field.name] = values[field.name]
    }
  }

  if (spec.kind === 'masked' && Object.keys(properties).length === 0) {
    return fail(
      `${code} is a masked command: it changes only the values you name, so with none named it would do nothing. ` +
        `It takes ${spec.properties.map((f) => f.name).join(', ')}.`,
    )
  }

  const shown = Object.entries(values)
    .map(([key, value]) => `${key} ${showValue(value, known.get(key) as FieldSpec)}`)
    .join(', ')

  const ops: Op[] = devices.value.map((device) => ({
    kind: 'raw',
    device,
    rawName: spec.rawName,
    className: spec.className,
    ctor,
    ...(Object.keys(properties).length ? { properties } : {}),
    describe: `${code}${shown ? ` ${shown}` : ''} on ${device}`,
  }))

  return {
    ok: true,
    language: 'raw',
    declared: false,
    ops,
    reads: [],
    summary: `${code}${shown ? ` ${shown}` : ''} on ${devices.value.join(', ')}`,
  }
}

function parsePairs(
  tokens: readonly string[],
): { ok: true; value: Array<[string, string]> } | { ok: false; error: LineError } {
  const out: Array<[string, string]> = []
  for (const token of tokens) {
    const pair = /^([A-Za-z_][A-Za-z0-9_]*)=(.*)$/.exec(token)
    if (!pair) {
      return { ok: false, error: { message: `"${token}" is not name=value` } }
    }
    out.push([pair[1] as string, pair[2] as string])
  }
  return { ok: true, value: out }
}
