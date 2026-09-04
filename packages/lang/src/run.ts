/**
 * One command line, five languages.
 *
 * A console hands a line to `run()` and gets ops back. Which language it was
 * is worked out here, reported in the result so the UI can say so, and
 * otherwise nobody's business.
 *
 * ## Why the four raw languages exist at all
 *
 * The grammar is the language for driving a show. The other four are for when
 * a show is not going well: a path out of this app's own websocket frames, a
 * four-character code out of a packet capture, a frame from a show controller,
 * an address a lighting console is already sending. Each is something an
 * operator or an integrator *already has in front of them*, and the cost of
 * translating it by hand is a typo on a live frame.
 */

import { declared, sniff } from './detect.js'
import * as json from './dialects/json.js'
import * as osc from './dialects/osc.js'
import * as grammar from './grammar/parser.js'
import * as raw from './dialects/raw.js'
import * as state from './dialects/state.js'
import type { LanguageChoice, LanguageId, RunContext, RunResult } from './types.js'

/**
 * Parse and compile one line in whichever language it turns out to be.
 *
 * Never throws. A language that cannot make sense of the line returns its own
 * error, which is the useful one: a nearly-valid command should get the
 * grammar's complaint about the word that is wrong, not JSON's complaint about
 * a missing brace.
 */
export function run(line: string, ctx: RunContext = {}): RunResult {
  const choice: LanguageChoice = ctx.language ?? 'all'

  /* A declared prefix is honoured even when a single language is selected.
     Someone who has pinned the console to JSON and then types `BM Cut ME 1`
     has said what they want plainly, and refusing it would be pedantry.
     Pinning still switches off *guessing*, which is the part that surprises. */
  const head = declared(line)
  const language: LanguageId = head.language ?? (choice === 'all' ? sniff(head.body) : choice)

  const result = dispatch(language, head.body, ctx)
  return { ...result, language, declared: head.language !== null } as RunResult
}

function dispatch(language: LanguageId, body: string, ctx: RunContext): RunResult {
  switch (language) {
    case 'state':
      return state.run(body, ctx)
    case 'raw':
      return raw.run(body, ctx)
    case 'json':
      return json.run(body, ctx)
    case 'osc':
      return osc.run(body, ctx)
    case 'bm':
      return grammar.run(body, ctx)
  }
}
