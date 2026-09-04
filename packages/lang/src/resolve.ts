/**
 * The decisions every language has to make identically.
 *
 * Which switcher a line addresses, and what a typed word means as a value.
 * Both are easy to get subtly different in five places, and a difference
 * between languages here is the kind of bug that only shows up when someone
 * switches from one to another mid-show.
 */

import { CATALOGUE } from './catalogue-data.js'
import type { AddressParam, FieldSpec } from './catalogue.js'
import type { DeviceView, LineError, RunContext } from './types.js'

export type Resolved<T> = { readonly ok: true; readonly value: T } | { readonly ok: false; readonly error: LineError }

const ok = <T>(value: T): Resolved<T> => ({ ok: true, value })
const bad = <T>(message: string): Resolved<T> => ({ ok: false, error: { message } })

/** Every spelling that means "the whole fleet". */
const ALL = new Set(['*', 'all'])

/**
 * Which switchers a line addresses.
 *
 * The rule that matters is the last one: an unqualified line with several
 * switchers in the fleet is **refused**, not broadcast. Mynah's grammar keeps
 * the same principle for a different reason — an under-specified command must
 * not be able to reach air — and it applies with more force here, because the
 * under-specified thing is *which building's switcher*. Someone who means all
 * of them can say so in one word.
 */
export function resolveDevices(ctx: RunContext, explicit?: string): Resolved<string[]> {
  const fleet = ctx.devices ?? []
  if (fleet.length === 0) return bad('no switchers are connected')

  if (explicit !== undefined) {
    if (ALL.has(explicit.toLowerCase())) return ok(fleet.map((d) => d.id))
    const wanted = explicit.toLowerCase()
    const found = fleet.find(
      (d) => d.id.toLowerCase() === wanted || d.name?.toLowerCase() === wanted,
    )
    if (!found) {
      return bad(`no switcher called "${explicit}" — the fleet is ${fleet.map((d) => d.id).join(', ')}`)
    }
    return ok([found.id])
  }

  if (ctx.device !== undefined) {
    const found = fleet.find((d) => d.id === ctx.device)
    if (!found) return bad(`this connection points at "${ctx.device}", which is not in the fleet`)
    return ok([found.id])
  }

  if (fleet.length === 1) return ok([(fleet[0] as DeviceView).id])

  return bad(
    `say which switcher — the fleet is ${fleet.map((d) => d.id).join(', ')}, or "all" for every one`,
  )
}

/**
 * Check an index against what the switcher says it has.
 *
 * Only when the catalogue names a count path *and* the device reported it.
 * A bound that is not known is not invented: the command goes to the switcher
 * and the switcher refuses it, which is the rule crosspoint legality already
 * follows in this repo and the reason it survived contact with real hardware.
 */
export function checkAddress(
  parameter: AddressParam,
  value: number,
  device: DeviceView | undefined,
): LineError | null {
  if (!Number.isInteger(value) || value < 0) {
    return { message: `${parameter.name} must be a whole number from 0, not "${value}"` }
  }
  const path = parameter.countPath
  if (!path || !device?.counts) return null
  const count = device.counts[path]
  if (count === undefined) return null
  if (value >= count) {
    return {
      message:
        count === 0
          ? `${device.id} has no ${parameter.name} to address`
          : `${parameter.name} ${value} is out of range on ${device.id} — it has ${count} (0 to ${count - 1})`,
    }
  }
  return null
}

/** Words that mean true and false wherever a boolean is wanted. */
const TRUE = new Set(['true', 'on', 'yes', '1'])
const FALSE = new Set(['false', 'off', 'no', '0'])

/**
 * Turn a typed word into the value a field wants.
 *
 * Enums are accepted by name, case-insensitively, and refused *with their
 * spellings* — the device's own words are things like `STING` and
 * `MultiviewerLayout`, and no one guesses those twice. A bare number is also
 * accepted for an enum, because a packet capture shows numbers.
 */
export function coerceValue(text: string, field: FieldSpec): Resolved<unknown> {
  const word = text.trim()
  if (word === '') return bad(`${field.name} needs a value`)

  switch (field.type) {
    case 'boolean': {
      const lower = word.toLowerCase()
      if (TRUE.has(lower)) return ok(true)
      if (FALSE.has(lower)) return ok(false)
      return bad(`${field.name} takes on or off, not "${word}"`)
    }
    case 'string':
      return ok(stripQuotes(word))
    case 'enum': {
      const members = field.enum ? CATALOGUE.enums[field.enum] : undefined
      if (!members) return bad(`${field.name} has no known values`)
      const match = Object.keys(members).find((k) => k.toLowerCase() === word.toLowerCase())
      if (match !== undefined) return ok(members[match])
      if (/^\d+$/.test(word)) {
        const numeric = Number(word)
        if (Object.values(members).includes(numeric)) return ok(numeric)
      }
      return bad(`${field.name} takes ${Object.keys(members).join(', ')} — not "${word}"`)
    }
    case 'int':
    case 'number': {
      const numeric = Number(word)
      if (!Number.isFinite(numeric)) return bad(`${field.name} takes a number, not "${word}"`)
      if (field.type === 'int' && !Number.isInteger(numeric)) {
        return bad(`${field.name} takes a whole number, not "${word}"`)
      }
      return ok(numeric)
    }
  }
}

function stripQuotes(word: string): string {
  const quoted = /^"(.*)"$|^'(.*)'$/.exec(word)
  return quoted ? (quoted[1] ?? quoted[2] ?? '') : word
}

/** How a value reads back in a description. */
export function showValue(value: unknown, field: FieldSpec): string {
  if (field.type === 'enum' && field.enum) {
    const members = CATALOGUE.enums[field.enum]
    const name = members && Object.keys(members).find((k) => members[k] === value)
    if (name) return name
  }
  if (typeof value === 'boolean') return value ? 'on' : 'off'
  if (typeof value === 'string') return `"${value}"`
  return String(value)
}
