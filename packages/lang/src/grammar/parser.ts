/**
 * The grammar: verb first, then what it acts on.
 *
 * ```text
 * Cut ME 1
 * Program 5 ME 1
 * Aux 3 Input 5
 * KeyOn On ME 1 Key 2
 * Macro 4
 * Cut ME 1 Thru 4
 * Cut ME 1 Device wing-b
 * RecordStart All
 * ```
 *
 * ## Shape
 *
 * ```text
 * <Phrase> [<its own number>] ( <Noun> <number(s)> | [<marker>] <value> )* [Device <id> | All]
 * ```
 *
 * The phrase comes first and decides which command this is. Everything after
 * it either addresses a unit (`ME 1`, `Key 2`) or supplies the value. A value
 * may be introduced by `Input`, `Source`, `To` or `At`, or simply be the bare
 * token — all four markers exist so the line reads the way it would be said.
 *
 * ## Ranges
 *
 * `Thru` expands a number into a run, and a command that addresses several
 * units produces one op per unit. `Cut ME 1 Thru 4` is four cuts. This is
 * grandMA3's, by way of Mynah, and it is the feature that makes a command line
 * worth having over a grid of buttons.
 *
 * ## Numbering
 *
 * ⚠️ **One-based**, unlike every other language here. `ME 1` is `me: 0` on the
 * wire. See the note at the top of `vocabulary.ts` — this is the same split the
 * repo already lives with between its line protocol and Videohub, and for the
 * same reason.
 */

import { CATALOGUE } from '../catalogue-data.js'
import { buildCall } from '../compile.js'
import { checkAddress, coerceValue, resolveDevices, showValue } from '../resolve.js'
import { completions, resolveKeyword, shortestForm } from './keywords.js'
import { NOUNS, PHRASES, VALUE_MARKERS } from './vocabulary.js'
import type { CommandSpec } from '../catalogue.js'
import type { Op } from '../ops.js'
import type { LineError, RunContext, RunResult } from '../types.js'

const fail = (message: string): RunResult => ({
  ok: false,
  language: 'bm',
  declared: false,
  errors: [{ message }],
})

const MARKERS = new Set(VALUE_MARKERS.map((w) => w.toLowerCase()))

export function run(body: string, ctx: RunContext): RunResult {
  const tokens = body.trim().split(/\s+/).filter(Boolean)
  if (!tokens.length) return fail('nothing to do')

  const head = resolveKeyword(tokens[0] as string)
  if (head === null) {
    const near = completions((tokens[0] as string).slice(0, 2))
    return fail(
      near.length
        ? `"${tokens[0]}" is not a command — did you mean ${near.slice(0, 4).join(', ')}?`
        : `"${tokens[0]}" is not a command`,
    )
  }
  if (!head.ok) {
    return fail(`"${tokens[0]}" could be ${head.candidates.join(', ')} — add a letter`)
  }
  if (head.keyword.kind === 'control' && head.keyword.word === 'Help') {
    return helpResult()
  }
  if (head.keyword.kind !== 'phrase') {
    return fail(`a command starts with what to do, not "${head.keyword.word}"`)
  }

  const phrase = head.keyword.phrase
  const command = CATALOGUE.commands.find((c) => c.id === phrase.id && c.verb === phrase.verb)
  if (!command) return fail(`"${phrase.word}" names a command that is not in the catalogue`)

  const addresses: Record<string, number[]> = {}
  let valueText: string | undefined
  let deviceWord: string | undefined

  let index = 1

  /* A phrase that carries its own number takes it immediately, before anything
     else can claim it: in `Aux 3 Input 5` the 3 is the aux bus and the 5 is
     what it takes. */
  if (phrase.self) {
    const run_ = readRun(tokens, index)
    if (run_) {
      addresses[phrase.self] = run_.values
      index = run_.next
    }
  }

  while (index < tokens.length) {
    const token = tokens[index] as string

    if (MARKERS.has(token.toLowerCase())) {
      const next = tokens[index + 1]
      if (next === undefined) return fail(`"${token}" needs a value after it`)
      valueText = next
      index += 2
      continue
    }

    const keyword = resolveKeyword(token)
    if (keyword && !keyword.ok) {
      return fail(`"${token}" could be ${keyword.candidates.join(', ')} — add a letter`)
    }

    if (keyword?.ok && keyword.keyword.kind === 'noun') {
      const noun = keyword.keyword.noun
      if (!command.address.some((a) => a.name === noun.address)) {
        return fail(
          `"${phrase.word}" has no ${noun.word} — it addresses ${command.address.map((a) => a.name).join(', ') || 'nothing'}`,
        )
      }
      const run_ = readRun(tokens, index + 1)
      if (!run_) return fail(`"${noun.word}" needs a number`)
      addresses[noun.address] = run_.values
      index = run_.next
      continue
    }

    if (keyword?.ok && keyword.keyword.kind === 'control') {
      const word = keyword.keyword.word
      if (word === 'All') {
        deviceWord = '*'
        index += 1
        continue
      }
      if (word === 'Device') {
        const next = tokens[index + 1]
        if (next === undefined) return fail('"Device" needs a name after it')
        deviceWord = next
        index += 2
        continue
      }
      /* On and Off are values, not structure. */
      valueText = word
      index += 1
      continue
    }

    /* Anything else is the value, bare. */
    if (valueText !== undefined) return fail(`"${token}" is one value too many`)
    valueText = token
    index += 1
  }

  // --- turn the words into calls ------------------------------------------

  const devices = resolveDevices(ctx, deviceWord)
  if (!devices.ok) return { ok: false, language: 'bm', declared: false, errors: [devices.error] }

  const values: Record<string, unknown> = {}
  if (phrase.field) {
    const field = command.fields.find((f) => f.name === phrase.field)
    if (!field) return fail(`"${phrase.word}" names a value that is not in the catalogue`)
    if (valueText === undefined) {
      return fail(`"${phrase.word}" needs a value — ${field.name}`)
    }
    const coerced = coerceValue(valueText, field)
    if (!coerced.ok) return { ok: false, language: 'bm', declared: false, errors: [coerced.error] }
    values[field.name] = coerced.value
  } else if (valueText !== undefined) {
    return fail(`"${phrase.word}" takes no value, so "${valueText}" has nowhere to go`)
  }

  for (const parameter of command.address) {
    if (parameter.optional) continue
    if (!(parameter.name in addresses)) {
      const noun = nounFor(parameter.name)
      return fail(`"${phrase.word}" needs ${noun ?? parameter.name}`)
    }
  }

  const combinations = expand(command, addresses)
  const ops: Op[] = []
  const errors: LineError[] = []

  for (const id of devices.value) {
    const device = ctx.devices?.find((d) => d.id === id)
    for (const address of combinations) {
      let rejected = false
      for (const parameter of command.address) {
        const value = address[parameter.name]
        if (value === undefined) continue
        const problem = checkAddress(parameter, value, device)
        if (problem) {
          errors.push(problem)
          rejected = true
        }
      }
      if (rejected) continue
      ops.push(buildCall(command, id, address, values, say(phrase.word, address, values, command, id)))
    }
  }

  if (!ops.length) {
    return {
      ok: false,
      language: 'bm',
      declared: false,
      errors: errors.length ? errors : [{ message: 'nothing to send' }],
    }
  }

  return {
    ok: true,
    language: 'bm',
    declared: false,
    ops,
    reads: [],
    summary:
      ops.length === 1
        ? (ops[0] as Op).describe
        : `${phrase.word} × ${ops.length} on ${devices.value.join(', ')}`,
  }
}

/**
 * Read `1`, or `1 Thru 4`, converting from the operator's numbering to the
 * protocol's on the way through.
 */
function readRun(
  tokens: readonly string[],
  start: number,
): { values: number[]; next: number } | null {
  const first = tokens[start]
  if (first === undefined || !/^\d+$/.test(first)) return null

  const from = Number(first)
  const maybeThru = tokens[start + 1]
  if (maybeThru !== undefined) {
    const keyword = resolveKeyword(maybeThru)
    if (keyword?.ok && keyword.keyword.kind === 'control' && keyword.keyword.word === 'Thru') {
      const second = tokens[start + 2]
      if (second !== undefined && /^\d+$/.test(second)) {
        const to = Number(second)
        const step = from <= to ? 1 : -1
        const values: number[] = []
        for (let n = from; step > 0 ? n <= to : n >= to; n += step) values.push(toIndex(n))
        return { values, next: start + 3 }
      }
    }
  }
  return { values: [toIndex(from)], next: start + 1 }
}

/** The grammar counts from 1; the protocol counts from 0. */
function toIndex(spoken: number): number {
  return spoken - 1
}

/** Every combination of the runs the operator gave. `ME 1 Thru 2 Key 1 Thru 2` is four. */
function expand(
  command: CommandSpec,
  addresses: Readonly<Record<string, number[]>>,
): Array<Record<string, number>> {
  let out: Array<Record<string, number>> = [{}]
  for (const parameter of command.address) {
    const values = addresses[parameter.name]
    if (!values?.length) continue
    out = out.flatMap((base) => values.map((value) => ({ ...base, [parameter.name]: value })))
  }
  return out
}

function nounFor(address: string): string | null {
  return NOUNS.find((n) => n.address === address)?.word ?? null
}

function say(
  word: string,
  address: Readonly<Record<string, number>>,
  values: Readonly<Record<string, unknown>>,
  command: CommandSpec,
  device: string,
): string {
  const where = Object.entries(address)
    .map(([name, value]) => `${name} ${value}`)
    .join(' ')
  const what = Object.entries(values)
    .map(([name, value]) => {
      const field = command.fields.find((f) => f.name === name)
      return field ? showValue(value, field) : String(value)
    })
    .join(' ')
  return [word, what, where, `on ${device}`].filter(Boolean).join(' ')
}

/**
 * The help, generated from the live vocabulary.
 *
 * Short forms are computed rather than written down, so this cannot claim an
 * abbreviation that adding a word has since made ambiguous — which is exactly
 * what a hand-kept list would do, quietly, on the day someone extends the
 * table.
 */
export function helpLines(): string[] {
  const commands = PHRASES.map((phrase) => {
    const short = shortestForm(phrase.word)
    const label = short === phrase.word ? phrase.word : `${phrase.word} (${short})`
    return `#   ${label.padEnd(22)} ${phrase.summary}`
  })
  const nouns = NOUNS.map((noun) => `#   ${noun.word.padEnd(22)} ${noun.summary}`)

  return [
    '# The BlackMatrix grammar. Verb first, then what it acts on.',
    '#   Cut ME 1        Program 5 ME 1        Aux 3 Input 5',
    '#   Cut ME 1 Thru 4        KeyOn On ME 1 Key 2        Macro 4',
    '# Numbers here start at 1. The other languages address the protocol and start at 0.',
    '# Any keyword may be shortened to any unambiguous prefix.',
    '# Commands:',
    ...commands,
    '# Units:',
    ...nouns,
    '# Also: Device <id>, All, Thru, and Input/Source/To/At before a value.',
    '# Other languages: STATE, RAW, JSON, OSC — or just type one and it is recognised.',
    '#   video.mixEffects.0.programInput = 3     CPgI mixEffect=0 source=3     /bm/<device>/cut/0',
  ]
}

function helpResult(): RunResult {
  return {
    ok: true,
    language: 'bm',
    declared: false,
    ops: [],
    reads: [],
    summary: helpLines().join('\n'),
  }
}
