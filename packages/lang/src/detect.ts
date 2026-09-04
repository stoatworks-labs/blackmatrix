/**
 * Which language a line is written in.
 *
 * Two mechanisms, in this order, and the order is the whole design:
 *
 *  1. **A declared prefix wins.** `RAW DCut mixEffect=0` is raw because it says
 *     so. Nothing is guessed about a line that has told you.
 *  2. **Otherwise sniff it**, on shapes the grammar cannot produce.
 *
 * ## Why the five prefixes are safe
 *
 * `BM`, `STATE`, `RAW`, `JSON` and `OSC` are not keywords in the grammar and
 * must never become them. There is a test asserting it against the live
 * keyword table, because the day one of them is added is the day `Osc Screen 1`
 * stops meaning what it says. Mynah learned this the expensive way: `STORE` was
 * briefly an alias for its JSON prefix, which quietly turned every
 * `Store Master 12` into a JSON parse error.
 *
 * A prefix only counts when something follows it, so a bare `OSC` on its own
 * line is an ordinary parse error rather than an empty OSC command.
 *
 * ## What each sniff keys on
 *
 * | Shape | Read as | Why the grammar cannot produce it |
 * |---|---|---|
 * | starts `/` | OSC | commands start with a letter |
 * | starts `{` or `[` | JSON | same |
 * | a dotted word in the first two tokens | state path | no keyword contains a dot |
 * | a known four-character code, exact case | raw | asserted disjoint from the keywords |
 * | anything else | the grammar | it is the fallback, deliberately |
 *
 * The grammar being the fallback is what makes a mistyped command produce the
 * grammar's complaint about the word that is wrong, rather than JSON's
 * complaint about a missing brace. That is the error an operator can act on.
 */

import { CATALOGUE } from './catalogue-data.js'
import type { Declared, LanguageId } from './types.js'

const PREFIXES: ReadonlyArray<readonly [RegExp, LanguageId]> = [
  [/^bm$/i, 'bm'],
  [/^state$/i, 'state'],
  [/^raw$/i, 'raw'],
  [/^json$/i, 'json'],
  [/^osc$/i, 'osc'],
]

/** The words that may introduce a line. Asserted disjoint from the keywords. */
export const PREFIX_WORDS: readonly string[] = ['BM', 'STATE', 'RAW', 'JSON', 'OSC']

const RAW_NAMES: ReadonlySet<string> = new Set(CATALOGUE.raw.map((r) => r.rawName))

/** Split a declared language off the front of a line. */
export function declared(line: string): Declared {
  const match = /^(\s*)([A-Za-z]+)(\s+)(?=\S)/.exec(line)
  if (!match) return { language: null, body: line, offset: 0 }
  for (const [pattern, id] of PREFIXES) {
    if (pattern.test(match[2] as string)) {
      return { language: id, body: line.slice(match[0].length), offset: match[0].length }
    }
  }
  return { language: null, body: line, offset: 0 }
}

/**
 * Guess the language of a line that did not declare one.
 *
 * Never returns null: an unrecognised shape is the grammar's problem to
 * report, because the grammar is what an operator is typing when they are not
 * deliberately typing one of the others.
 */
export function sniff(body: string): LanguageId {
  const text = body.trim()
  if (text === '') return 'bm'

  /* An OSC address is the only thing here that starts with a slash. */
  if (text.startsWith('/')) return 'osc'
  if (text.startsWith('{') || text.startsWith('[')) return 'json'

  const tokens = text.split(/\s+/)

  /*
   * A four-character wire code, matched case-sensitively.
   *
   * The case is doing real work: `DCut` is a protocol command and `dcut` is
   * not, and the grammar is case-insensitive, so requiring the exact spelling
   * keeps the two apart even if a keyword ever shares the letters.
   */
  const head = tokens[0] ?? ''
  if (head.length === 4 && RAW_NAMES.has(head)) return 'raw'

  /*
   * A dotted word addresses the state tree. No keyword contains a dot, so this
   * cannot collide — and it catches both spellings, the bare assignment and
   * the one with a leading verb.
   *
   *   video.mixEffects.0.programInput = 3
   *   get video.mixEffects.0.programInput
   */
  const dotted = /^[A-Za-z_][A-Za-z0-9_]*(\[\d*\])?(\.[A-Za-z0-9_]+(\[\d*\])?)+$/
  if (dotted.test(head)) return 'state'
  if (/^(get|set)$/i.test(head) && dotted.test(tokens[1] ?? '')) return 'state'

  return 'bm'
}
