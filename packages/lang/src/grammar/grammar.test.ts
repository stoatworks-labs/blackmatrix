/**
 * The grammar.
 *
 * The cases that matter here are the ones about *refusing* — an operator
 * typing under pressure is served much better by a command line that says
 * which letter to add than by one that guesses.
 */

import { describe, expect, it } from 'vitest'
import { run } from '../run.js'
import { completions, resolveKeyword, shortestForm } from './keywords.js'
import { PREFIX_WORDS } from '../detect.js'
import { CATALOGUE } from '../catalogue-data.js'
import { CONTROL_WORDS, NOUNS, PHRASES } from './vocabulary.js'
import type { CallOp, RunContext } from '../types.js'

const fleet: RunContext = {
  devices: [
    { id: 'mini', counts: { 'video.mixEffects': 1, 'video.downstreamKeyers': 1 } },
    { id: 'con', counts: { 'video.mixEffects': 4 } },
  ],
  device: 'mini',
}

const ops = (line: string, ctx: RunContext = fleet): CallOp[] => {
  const result = run(line, ctx)
  if (!result.ok) throw new Error(result.errors.map((e) => e.message).join('; '))
  return result.ops as CallOp[]
}
const errorOf = (line: string, ctx: RunContext = fleet): string => {
  const result = run(line, ctx)
  if (result.ok) throw new Error(`expected "${line}" to be refused`)
  return result.errors.map((e) => e.message).join('; ')
}

describe('grammar', () => {
  it('reads a command verb-first', () => {
    expect(ops('Cut ME 1')[0]).toMatchObject({ method: 'cut', args: [0] })
  })

  /* The one thing most likely to be got wrong by someone reading the wire. */
  it('counts from one, and the protocol counts from zero', () => {
    expect(ops('Cut ME 1')[0]?.args).toEqual([0])
    expect(ops('Macro 4')[0]?.args).toEqual([3])
    /* A value is NOT an index: input 5 is source 5. */
    expect(ops('Program 5 ME 1')[0]?.args).toEqual([5, 0])
  })

  it('takes a value bare or behind any of its markers', () => {
    const expected = [5, 2]
    expect(ops('Aux 3 Input 5')[0]?.args).toEqual(expected)
    expect(ops('Aux 3 Source 5')[0]?.args).toEqual(expected)
    expect(ops('Aux 3 To 5')[0]?.args).toEqual(expected)
    expect(ops('Aux 3 At 5')[0]?.args).toEqual(expected)
    expect(ops('Aux 3 5')[0]?.args).toEqual(expected)
  })

  it('expands a Thru range into one op per unit', () => {
    const cuts = ops('Cut ME 1 Thru 4 Device con')
    expect(cuts).toHaveLength(4)
    expect(cuts.map((o) => o.args[0])).toEqual([0, 1, 2, 3])
  })

  it('crosses two ranges', () => {
    const keys = ops('KeyOn On ME 1 Thru 2 Key 1 Thru 2 Device con')
    expect(keys).toHaveLength(4)
    expect(keys.map((o) => o.args.slice(1))).toEqual([
      [0, 0],
      [0, 1],
      [1, 0],
      [1, 1],
    ])
  })

  it('takes On and Off as the boolean they are', () => {
    expect(ops('KeyOn On ME 1 Key 1')[0]?.args[0]).toBe(true)
    expect(ops('KeyOn Off ME 1 Key 1')[0]?.args[0]).toBe(false)
  })

  it('takes an enum by its own name', () => {
    expect(ops('Style WIPE ME 1')[0]?.args[0]).toEqual({ nextStyle: 2 })
  })
})

describe('abbreviation', () => {
  it('accepts any prefix that is unambiguous across the whole table', () => {
    expect(ops('C ME 1')[0]?.method).toBe('cut')
    expect(ops('Pro 5 ME 1')[0]?.method).toBe('changeProgramInput')
    expect(ops('Pre 5 ME 1')[0]?.method).toBe('changePreviewInput')
  })

  /*
   * An exact word wins even when it is the start of a longer one, or `Key`
   * would be refused for being the beginning of `KeyFill`.
   */
  it('lets an exact word beat the longer words it starts', () => {
    const resolved = resolveKeyword('Key')
    expect(resolved?.ok && resolved.keyword.word).toBe('Key')
  })

  it('refuses an ambiguous prefix with its candidates, not as unknown', () => {
    expect(errorOf('Ke ME 1')).toMatch(/could be KeyFill, KeyCut, KeyOn, Key/)
  })

  it('suggests real words for a typo', () => {
    expect(errorOf('Cutt ME 1')).toMatch(/did you mean Cut/)
  })

  /* Short forms are a property of the table, so they are computed and never
     written down. `Aux` cannot shorten because `Auto` shares its start. */
  it('computes short forms from the live table', () => {
    expect(shortestForm('Cut')).toBe('C')
    expect(shortestForm('Aux')).toBe('Aux')
    expect(completions('Rec')).toEqual(['RecordStart', 'RecordStop'])
  })
})

describe('refusing', () => {
  it('says which unit a command does not have', () => {
    expect(errorOf('Cut ME 1 Key 2')).toMatch(/"Cut" has no Key/)
  })

  it('says when a value has nowhere to go', () => {
    expect(errorOf('Cut ME 1 99')).toMatch(/takes no value/)
  })

  it('names the value a command is missing', () => {
    expect(errorOf('Program ME 1')).toMatch(/needs a value — input/)
  })

  it('bounds an index against the switcher that would run it', () => {
    expect(errorOf('Cut ME 9')).toMatch(/out of range on mini — it has 1/)
    expect(ops('Cut ME 4 Device con')[0]?.args).toEqual([3])
  })
})

/*
 * The collision that cost Mynah a command for a commit: a language prefix that
 * is also a keyword silently turns every use of that keyword into a parse
 * error in the wrong language. This is the assertion that stops it here.
 */
describe('the language prefixes stay out of the vocabulary', () => {
  it('shares no word with the grammar', () => {
    const vocabulary = new Set(
      [...PHRASES.map((p) => p.word), ...NOUNS.map((n) => n.word), ...CONTROL_WORDS].map((w) =>
        w.toLowerCase(),
      ),
    )
    for (const prefix of PREFIX_WORDS) {
      expect(vocabulary.has(prefix.toLowerCase()), `${prefix} is also a keyword`).toBe(false)
    }
  })

  it('shares no word with a wire code, case-insensitively', () => {
    /* `DCut` and the keyword `Cut` are different words; the danger would be a
       code spelled exactly like one, which would make the sniffer's job
       impossible. */
    const vocabulary = new Set(PHRASES.map((p) => p.word.toLowerCase()))
    for (const raw of CATALOGUE.raw) {
      expect(vocabulary.has(raw.rawName.toLowerCase()), `${raw.rawName} is also a keyword`).toBe(
        false,
      )
    }
  })
})
