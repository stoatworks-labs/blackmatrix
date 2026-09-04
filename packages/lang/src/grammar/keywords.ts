/**
 * Keyword resolution: case-insensitive, and abbreviated to any prefix that is
 * unambiguous **across the whole vocabulary**.
 *
 * These are the same command:
 *
 * ```text
 * Cut ME 1
 * cut me 1
 * Cu M 1
 * ```
 *
 * Because ambiguity is resolved against every word at once, a word's short
 * form is a property of the table rather than of the word. `Prog` reaches
 * `Program` only because nothing else starts `Prog`, and `Pre` is shared
 * between `Preview` and nothing else only for as long as that stays true.
 * Short forms are therefore computed and shown in the app, never written down:
 * adding a word can lengthen its neighbours, and a hand-kept list would go
 * quietly wrong.
 *
 * An ambiguous prefix is refused **with its candidates**, so the command line
 * tells you which letter to add rather than calling the word unknown.
 */

import { CATALOGUE } from '../catalogue-data.js'
import { CONTROL_WORDS, NOUNS, PHRASES } from './vocabulary.js'
import type { Noun, Phrase } from './vocabulary.js'

export type Keyword =
  | { readonly kind: 'phrase'; readonly word: string; readonly phrase: Phrase }
  | { readonly kind: 'noun'; readonly word: string; readonly noun: Noun }
  | { readonly kind: 'control'; readonly word: string }

/**
 * Check the hand-written vocabulary against the generated catalogue.
 *
 * Runs once, at load. Every failure here is one that would otherwise surface
 * as a command that parses, compiles and does nothing — or worse, does
 * something at the wrong address — so none of them is tolerated.
 */
function validate(): void {
  const problems: string[] = []

  for (const phrase of PHRASES) {
    const command = CATALOGUE.commands.find((c) => c.id === phrase.id && c.verb === phrase.verb)
    if (!command) {
      problems.push(`${phrase.word}: no command "${phrase.verb} ${phrase.id}"`)
      continue
    }
    if (phrase.self && !command.address.some((a) => a.name === phrase.self)) {
      problems.push(
        `${phrase.word}: "${phrase.self}" is not one of its addresses (${command.address.map((a) => a.name).join(', ') || 'none'})`,
      )
    }
    if (phrase.field && !command.fields.some((f) => f.name === phrase.field)) {
      problems.push(
        `${phrase.word}: "${phrase.field}" is not one of its values (${command.fields.map((f) => f.name).join(', ') || 'none'})`,
      )
    }
  }

  /* A noun that names an address no command has is a word that can never be
     used — harmless, but it means the table has drifted. */
  const addresses = new Set(CATALOGUE.commands.flatMap((c) => c.address.map((a) => a.name)))
  for (const noun of NOUNS) {
    if (!addresses.has(noun.address)) {
      problems.push(`${noun.word}: no command addresses "${noun.address}"`)
    }
  }

  const words = [...PHRASES.map((p) => p.word), ...NOUNS.map((n) => n.word), ...CONTROL_WORDS]
  const seen = new Set<string>()
  for (const word of words) {
    const lower = word.toLowerCase()
    if (seen.has(lower)) problems.push(`"${word}" appears twice in the vocabulary`)
    seen.add(lower)
  }

  if (problems.length) {
    throw new Error(`the grammar's vocabulary disagrees with the catalogue:\n  ${problems.join('\n  ')}`)
  }
}

validate()

const TABLE: readonly Keyword[] = [
  ...PHRASES.map((phrase): Keyword => ({ kind: 'phrase', word: phrase.word, phrase })),
  ...NOUNS.map((noun): Keyword => ({ kind: 'noun', word: noun.word, noun })),
  ...CONTROL_WORDS.map((word): Keyword => ({ kind: 'control', word })),
]

export function keywordTable(): readonly Keyword[] {
  return TABLE
}

export type Resolution =
  | { readonly ok: true; readonly keyword: Keyword }
  | { readonly ok: false; readonly candidates: readonly string[] }

/** Resolve a typed word to exactly one keyword, or report the ambiguity. */
export function resolveKeyword(typed: string): Resolution | null {
  const lower = typed.toLowerCase()

  /* An exact match always wins, even when it is a prefix of something longer:
     `Key` is a word in its own right and must not be refused for being the
     start of `KeyFill`. */
  const exact = TABLE.find((k) => k.word.toLowerCase() === lower)
  if (exact) return { ok: true, keyword: exact }

  const matches = TABLE.filter((k) => k.word.toLowerCase().startsWith(lower))
  if (matches.length === 1) return { ok: true, keyword: matches[0] as Keyword }
  if (matches.length > 1) return { ok: false, candidates: matches.map((k) => k.word) }
  return null
}

/** The shortest prefix that reaches a word, computed from the live table. */
export function shortestForm(word: string): string {
  for (let length = 1; length <= word.length; length++) {
    const prefix = word.slice(0, length)
    const resolved = resolveKeyword(prefix)
    if (resolved?.ok && resolved.keyword.word === word) return prefix
  }
  return word
}

/** Every word a partial one could become, for completion. */
export function completions(partial: string): readonly string[] {
  const lower = partial.toLowerCase()
  return TABLE.filter((k) => k.word.toLowerCase().startsWith(lower)).map((k) => k.word)
}
