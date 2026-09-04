/**
 * The JSON dialect: a command as a frame rather than a line.
 *
 * ```json
 * {"verb":"set","id":"program.input","address":{"me":0},"values":{"input":3}}
 * {"path":"video.mixEffects.0.programInput","value":3}
 * {"raw":"CPgI","values":{"mixEffect":0,"source":3}}
 * [ … an array of any of the above … ]
 * ```
 *
 * This is what a show controller with an HTTP or websocket client sends, and
 * what this app's own API can echo back. Three shapes are accepted because
 * three shapes exist in the wild — the catalogue's own address space, the
 * state tree, and the wire codes — and asking someone to convert between them
 * before sending is asking them to make a mistake.
 *
 * An array runs in order, and one bad member fails the whole line rather than
 * half-applying it. A partly-applied salvo is worse than a refused one: it
 * leaves the operator with no idea which half landed.
 */

import { CATALOGUE } from '../catalogue-data.js'
import { buildCall, describeCall } from '../compile.js'
import { checkAddress, coerceValue, resolveDevices, showValue } from '../resolve.js'
import type { Op } from '../ops.js'
import type { LineError, Read, RunContext, RunResult } from '../types.js'
import * as raw from './raw.js'
import * as state from './state.js'

const fail = (message: string): RunResult => ({
  ok: false,
  language: 'json',
  declared: false,
  errors: [{ message }],
})

export function run(body: string, ctx: RunContext): RunResult {
  let parsed: unknown
  try {
    parsed = JSON.parse(body)
  } catch (error) {
    return fail(`not valid JSON — ${(error as Error).message}`)
  }

  const frames = Array.isArray(parsed) ? parsed : [parsed]
  if (frames.length === 0) return fail('an empty array does nothing')

  const ops: Op[] = []
  const reads: Read[] = []
  const summaries: string[] = []

  for (const [index, frame] of frames.entries()) {
    const result = one(frame, ctx)
    if (!result.ok) {
      const where = frames.length > 1 ? `item ${index + 1}: ` : ''
      return {
        ok: false,
        language: 'json',
        declared: false,
        errors: result.errors.map((e) => ({ ...e, message: `${where}${e.message}` })),
      }
    }
    ops.push(...result.ops)
    reads.push(...result.reads)
    summaries.push(result.summary)
  }

  return { ok: true, language: 'json', declared: false, ops, reads, summary: summaries.join('; ') }
}

function one(frame: unknown, ctx: RunContext): RunResult {
  if (typeof frame !== 'object' || frame === null || Array.isArray(frame)) {
    return fail('each item must be an object')
  }
  const it = frame as Record<string, unknown>
  const scoped: RunContext =
    typeof it.device === 'string' ? { ...ctx, device: undefined, devices: ctx.devices } : ctx

  /* The state and raw spellings are handed to the dialects that own them, so
     there is one implementation of each rather than a second, drifting copy
     behind a different syntax. */
  if (typeof it.path === 'string') {
    const line =
      'value' in it
        ? `${it.path} = ${literal(it.value)}${suffix(it.device)}`
        : `get ${it.path}${suffix(it.device)}`
    return relabel(state.run(line, scoped))
  }

  if (typeof it.raw === 'string') {
    const values = (it.values ?? {}) as Record<string, unknown>
    const pairs = Object.entries(values).map(([k, v]) => `${k}=${literal(v)}`)
    return relabel(raw.run(`${it.raw} ${pairs.join(' ')}${suffix(it.device)}`, scoped))
  }

  if (typeof it.id !== 'string') {
    return fail('an item needs one of "id", "path" or "raw"')
  }
  return byId(it, ctx)
}

/** The catalogue's own address space: `{verb, id, address, values}`. */
function byId(it: Record<string, unknown>, ctx: RunContext): RunResult {
  const id = it.id as string
  const verb = typeof it.verb === 'string' ? it.verb : 'set'

  const command = CATALOGUE.commands.find((c) => c.id === id && c.verb === verb)
  if (!command) {
    const others = CATALOGUE.commands.filter((c) => c.id === id).map((c) => c.verb)
    return fail(
      others.length
        ? `"${id}" has no "${verb}" — it takes ${others.join(', ')}`
        : `no command called "${id}"`,
    )
  }

  const devices = resolveDevices(ctx, typeof it.device === 'string' ? it.device : undefined)
  if (!devices.ok) return { ok: false, language: 'json', declared: false, errors: [devices.error] }

  const givenAddress = (it.address ?? {}) as Record<string, unknown>
  const address: Record<string, number | string> = {}
  for (const parameter of command.address) {
    const value = givenAddress[parameter.name]
    if (value === undefined) {
      if (parameter.optional) continue
      return fail(`"${verb} ${id}" needs address ${parameter.name}`)
    }
    if (parameter.type === 'string') {
      address[parameter.name] = String(value)
    } else if (typeof value === 'number') {
      address[parameter.name] = value
    } else {
      return fail(`address ${parameter.name} must be a number`)
    }
  }

  const givenValues = (it.values ?? {}) as Record<string, unknown>
  const values: Record<string, unknown> = {}
  const errors: LineError[] = []
  for (const [key, value] of Object.entries(givenValues)) {
    const field = command.fields.find((f) => f.name === key)
    if (!field) {
      errors.push({
        message: `"${verb} ${id}" has no "${key}" — it takes ${command.fields.map((f) => f.name).join(', ') || 'no values'}`,
      })
      continue
    }
    const coerced = coerceValue(String(value), field)
    if (!coerced.ok) errors.push(coerced.error)
    else values[key] = coerced.value
  }
  if (errors.length) return { ok: false, language: 'json', declared: false, errors }

  for (const field of command.fields) {
    if (!command.props && !field.optional && !(field.name in values)) {
      return fail(`"${verb} ${id}" needs ${field.name}`)
    }
  }

  const ops: Op[] = []
  for (const deviceId of devices.value) {
    const device = ctx.devices?.find((d) => d.id === deviceId)
    for (const parameter of command.address) {
      const value = address[parameter.name]
      if (typeof value !== 'number') continue
      const problem = checkAddress(parameter, value, device)
      if (problem) return { ok: false, language: 'json', declared: false, errors: [problem] }
    }
    ops.push(
      buildCall(
        command,
        deviceId,
        address,
        values,
        describeCall(command, deviceId, address, values, command.fields),
      ),
    )
  }

  return {
    ok: true,
    language: 'json',
    declared: false,
    ops,
    reads: [],
    summary: `${verb} ${id} on ${devices.value.join(', ')}`,
  }
}

function literal(value: unknown): string {
  if (typeof value === 'string') return value
  return JSON.stringify(value) ?? String(value)
}

function suffix(device: unknown): string {
  return typeof device === 'string' ? ` on ${device}` : ''
}

/** Keep the reported language as JSON when a frame was handed to another dialect. */
function relabel(result: RunResult): RunResult {
  return { ...result, language: 'json' } as RunResult
}
