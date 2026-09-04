/**
 * Command languages for an ATEM fleet.
 *
 * The public surface of `@av/atem-lang`. Everything here is pure — no sockets,
 * no files, no React — which is what lets the server, the web console and a
 * Companion module all compile the same line with the same code rather than
 * with three drifting implementations of the same grammar.
 *
 * Today this exports the catalogue: what an ATEM can be told to do, generated
 * from `atem-connection`'s own types. The languages are built on top of it.
 */

import { CATALOGUE } from './catalogue-data.js'
import type { CommandSpec, RawCommandSpec, StatePathSpec } from './catalogue.js'

export type {
  AddressParam,
  Catalogue,
  CommandSpec,
  FieldSpec,
  ParamRef,
  RawCommandSpec,
  RawKind,
  StatePathSpec,
  ValueType,
  WritePathSpec,
} from './catalogue.js'

/* The languages. `run()` is what a console should call: it takes a line in any
   of them and returns the same shape whichever it was. */
export { run } from './run.js'
export { declared, sniff, PREFIX_WORDS } from './detect.js'
export { helpLines } from './grammar/parser.js'
export { completions, keywordTable, resolveKeyword, shortestForm } from './grammar/keywords.js'
export { NOUNS, PHRASES } from './grammar/vocabulary.js'
export { dictionary as oscDictionary, OSC_ROOT } from './dialects/osc.js'
export { LANGUAGES, LANGUAGE_LABELS } from './types.js'
export type {
  CallOp,
  Declared,
  DeviceView,
  LanguageChoice,
  LanguageId,
  LineError,
  Op,
  RawOp,
  Read,
  RunContext,
  RunResult,
} from './types.js'

/** The generated catalogue, read from `atem-connection`'s declarations. */
export { CATALOGUE }

/**
 * Look one command up by the pair that addresses it.
 *
 * `(id, verb)` rather than id alone: `recording` is three different commands
 * depending on whether it is started, stopped or configured.
 */
export function command(id: string, verb: string): CommandSpec | undefined {
  return CATALOGUE.commands.find((c) => c.id === id && c.verb === verb)
}

/** Every verb offered at one address, for completion and for error messages. */
export function verbsFor(id: string): string[] {
  return CATALOGUE.commands.filter((c) => c.id === id).map((c) => c.verb)
}

/** One raw protocol command by its four-character code. */
export function rawCommand(rawName: string): RawCommandSpec | undefined {
  return CATALOGUE.raw.find((c) => c.rawName === rawName)
}

/**
 * A readable state path.
 *
 * Indices are written `[]` in the catalogue — `video.mixEffects[].programInput`
 * — because the catalogue describes the shape rather than one switcher. A
 * concrete path from a command line has numbers in those slots, so it is
 * normalised before the lookup.
 */
export function statePath(path: string): StatePathSpec | undefined {
  const shape = path.replace(/\[\d+\]|\.\d+(?=\.|$)/g, '[]')
  return CATALOGUE.state.find((s) => s.path === shape)
}

/** The spellings one of the switcher's enums accepts, in declaration order. */
export function enumValues(name: string): readonly string[] | undefined {
  const members = CATALOGUE.enums[name]
  return members ? Object.keys(members) : undefined
}

/** The number that goes on the wire for one enum member. */
export function enumValue(name: string, member: string): number | undefined {
  return CATALOGUE.enums[name]?.[member]
}

/** Whether a state path may be assigned to, and what writes it. */
export function writablePath(path: string) {
  const shape = path.replace(/\[\d+\]|\.\d+(?=\.|$)/g, '[]')
  return CATALOGUE.writes.find((w) => w.path === shape)
}
