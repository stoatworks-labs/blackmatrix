/**
 * The state-path dialect: address the switcher's own object model.
 *
 * ```text
 * video.mixEffects.0.programInput = 3
 * set video.mixEffects.0.programInput 3
 * get video.downstreamKeyers.0.onAir
 * video.mixEffects.0.programInput = 3 on wing-b
 * ```
 *
 * This is the spelling for someone who has the state tree in front of them —
 * a snapshot, a debugger, this app's own websocket frames — and wants to poke
 * the thing they are looking at without translating it into a verb first.
 *
 * ## Reads and writes are not the same space, and this dialect says so
 *
 * All 408 leaves of `AtemState` can be read. Only 27 can be written, because
 * writing is not what a state tree does — you send a command and the state
 * catches up. Which command corresponds to which leaf is vouched for one at a
 * time in the generator's write list, never derived; the note on
 * `WritePathSpec` has the mis-mapping that settled the argument.
 *
 * So a write to a readable-but-unmapped path is refused **by name**, and the
 * refusal points at the command that does the job. That is a better answer
 * than either silently doing nothing or confidently writing the wrong node.
 */

import { CATALOGUE } from '../catalogue-data.js'
import { buildCall, describeCall } from '../compile.js'
import { checkAddress, coerceValue, resolveDevices, showValue } from '../resolve.js'
import type { Op } from '../ops.js'
import type { Read, RunContext, RunResult } from '../types.js'

const fail = (message: string): RunResult => ({
  ok: false,
  language: 'state',
  declared: false,
  errors: [{ message }],
})

export function run(body: string, ctx: RunContext): RunResult {
  const line = body.trim()
  if (line === '') return fail('nothing to do')

  /* `on <device>` may end any line. Taken off first so the rest of the parse
     never has to think about it. */
  const scoped = /\s+on\s+([A-Za-z0-9_*-]+)\s*$/i.exec(line)
  const explicit = scoped?.[1]
  const rest = scoped ? line.slice(0, scoped.index).trim() : line

  const devices = resolveDevices(ctx, explicit)
  if (!devices.ok) return { ok: false, language: 'state', declared: false, errors: [devices.error] }

  const read = /^get\s+(\S+)$/i.exec(rest)
  if (read) return readPath(read[1] as string, devices.value, ctx)

  const write =
    /^set\s+(\S+)\s*=\s*(.+)$/i.exec(rest) ??
    /^set\s+(\S+)\s+(.+)$/i.exec(rest) ??
    /^(\S+)\s*=\s*(.+)$/.exec(rest)
  if (write) return writePath(write[1] as string, write[2] as string, devices.value, ctx)

  /* A bare path with nothing after it reads, because that is plainly what was
     meant and refusing it would be pedantry. */
  if (!/\s/.test(rest)) return readPath(rest, devices.value, ctx)

  return fail(`cannot read that as a state path — try "path = value" or "get path"`)
}

/** `video.mixEffects.0.programInput` -> shape plus the indices it carried. */
function split(path: string): { shape: string; indices: number[] } | null {
  const indices: number[] = []
  const segments = path.split('.')
  const shape: string[] = []

  for (const segment of segments) {
    /* Both spellings are accepted, because both are in front of people: dotted
       indices are how this app's websocket frames read, and bracketed ones are
       how the catalogue and most debuggers print an array. */
    const bracketed = /^([A-Za-z_][A-Za-z0-9_]*)\[(\d+)\]$/.exec(segment)
    if (bracketed) {
      shape.push(`${bracketed[1]}[]`)
      indices.push(Number(bracketed[2]))
      continue
    }
    if (/^\d+$/.test(segment)) {
      const previous = shape.length - 1
      if (previous < 0) return null
      shape[previous] = `${shape[previous]}[]`
      indices.push(Number(segment))
      continue
    }
    if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(segment)) return null
    shape.push(segment)
  }
  return { shape: shape.join('.'), indices }
}

function readPath(path: string, devices: readonly string[], ctx: RunContext): RunResult {
  const parts = split(path)
  if (!parts) return fail(`"${path}" is not a state path`)

  const spec = CATALOGUE.state.find((s) => s.path === parts.shape)
  if (!spec) return fail(`nothing at "${path}" — ${nearest(parts.shape)}`)

  const reads: Read[] = devices.map((device) => ({
    device,
    path,
    describe: `read ${path} on ${device}`,
  }))
  return {
    ok: true,
    language: 'state',
    declared: false,
    ops: [],
    reads,
    summary: `read ${path} on ${devices.join(', ')}`,
  }
}

function writePath(
  path: string,
  text: string,
  devices: readonly string[],
  ctx: RunContext,
): RunResult {
  const parts = split(path)
  if (!parts) return fail(`"${path}" is not a state path`)

  const write = CATALOGUE.writes.find((w) => w.path === parts.shape)
  if (!write) {
    const readable = CATALOGUE.state.some((s) => s.path === parts.shape)
    if (readable) {
      return fail(
        `${path} can be read but not written — this package only writes paths it has a command vouched for. ` +
          `Use the grammar or a "set <command>" line instead.`,
      )
    }
    return fail(`nothing at "${path}" — ${nearest(parts.shape)}`)
  }

  const command = CATALOGUE.commands.find((c) => c.id === write.id && c.verb === write.verb)
  if (!command) return fail(`${path} maps to a command that is not in the catalogue`)

  const field = command.fields.find((f) => f.name === write.field)
  if (!field) return fail(`${path} maps to a value that is not in the catalogue`)

  const value = coerceValue(text, field)
  if (!value.ok) return { ok: false, language: 'state', declared: false, errors: [value.error] }

  if (parts.indices.length !== write.indices.length) {
    return fail(
      `${path} needs ${write.indices.length} index number(s) and was given ${parts.indices.length}`,
    )
  }

  /* The path's index order and the method's parameter order are not the same —
     `superSources[a].boxes[b]` is written by a method that takes the box
     first. `write.indices` names which address each slot fills, which is what
     makes putting them back in the right order possible at all. */
  const address: Record<string, number> = {}
  for (const [slot, name] of write.indices.entries()) {
    address[name] = parts.indices[slot] as number
  }

  const ops: Op[] = []
  for (const id of devices) {
    const device = ctx.devices?.find((d) => d.id === id)
    for (const parameter of command.address) {
      const given = address[parameter.name]
      if (given === undefined) continue
      const problem = checkAddress(parameter, given, device)
      if (problem) return { ok: false, language: 'state', declared: false, errors: [problem] }
    }
    const values = { [field.name]: value.value }
    ops.push(
      buildCall(
        command,
        id,
        address,
        values,
        `${path} = ${showValue(value.value, field)} on ${id}`,
      ),
    )
  }

  return {
    ok: true,
    language: 'state',
    declared: false,
    ops,
    reads: [],
    summary: `${path} = ${showValue(value.value, field)} on ${devices.join(', ')}`,
  }
}

/** A hint that names real neighbours, rather than "unknown path". */
function nearest(shape: string): string {
  const head = shape.split('.')[0] ?? ''
  const siblings = CATALOGUE.state
    .filter((s) => s.path.startsWith(`${head}.`))
    .slice(0, 3)
    .map((s) => s.path)
  if (!siblings.length) {
    const roots = [...new Set(CATALOGUE.state.map((s) => s.path.split('.')[0]))]
    return `the tree starts at ${roots.join(', ')}`
  }
  return `did you mean one of ${siblings.join(', ')}?`
}
