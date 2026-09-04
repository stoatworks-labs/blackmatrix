/**
 * What every command language in this package has in common.
 *
 * A console hands one line to `run()` and gets one shape back, whichever
 * language the line turned out to be. Which language it was is reported so the
 * UI can say so, and is otherwise nobody's business.
 *
 * ```text
 * Cut ME 1                                      the grammar
 * video.mixEffects.0.programInput = 3           state path
 * CPgI mixEffect=0 source=3                     raw wire code
 * {"device":"a","method":"cut","args":[0]}      JSON
 * /bm/me/1/cut                                  OSC
 * ```
 *
 * ## Two kinds of op, because there are two ways in
 *
 * Most languages compile to a method call on `atem-connection`. The raw
 * dialect does not — it constructs a protocol command and sends it, which is a
 * different code path in the host and cannot be flattened into the first
 * without lying about what is happening. So `Op` is a union and the host
 * switches on it.
 *
 * ## Reads are cheap here
 *
 * This matters more than it looks. In a device protocol a read is a round
 * trip, and languages that cannot perform one have to refuse. This app already
 * holds the whole `AtemState` for every switcher in the fleet, so a read is a
 * lookup — every transport can answer one, including a UDP datagram.
 */

import type { Op } from './ops.js'

export type { CallOp, Op, RawOp } from './ops.js'

/** The languages the command line understands. */
export type LanguageId = 'bm' | 'state' | 'raw' | 'json' | 'osc'

/**
 * What the operator has chosen.
 *
 * `all` is the default and means "work it out": a line may declare its own
 * language with a leading word, and is sniffed when it does not. Picking a
 * single language turns detection off, which is what someone pasting
 * machine-generated JSON wants — a payload that happens to start with a slash
 * should be a JSON error, not silently an OSC command.
 */
export type LanguageChoice = LanguageId | 'all'

export const LANGUAGES: readonly LanguageId[] = ['bm', 'state', 'raw', 'json', 'osc']

export const LANGUAGE_LABELS: Readonly<Record<LanguageId, string>> = {
  bm: 'BlackMatrix',
  state: 'State path',
  raw: 'Raw',
  json: 'JSON',
  osc: 'OSC',
}

/**
 * One switcher, as much as a language needs to know about it.
 *
 * `counts` is how an address is bounds-checked: the catalogue says `me` is
 * bounded by `video.mixEffects`, and this says that array is four long on this
 * box. A device that does not report a count does not get one checked — the
 * switcher refuses the command instead, which is the same rule crosspoint
 * legality already follows.
 */
export interface DeviceView {
  readonly id: string
  readonly name?: string
  /** State array lengths: `video.mixEffects` -> 4. */
  readonly counts?: Readonly<Record<string, number>>
}

export interface RunContext {
  /** What the operator has chosen. `all` — detect — is the default. */
  readonly language?: LanguageChoice
  /** The fleet. Without it nothing can be addressed and every line is refused. */
  readonly devices?: readonly DeviceView[]
  /**
   * Which switcher an unqualified line means.
   *
   * A console and a socket each point at one device at a time. When this is
   * unset and the fleet holds exactly one switcher, that is the one; when it
   * holds several, an unqualified line is refused rather than broadcast.
   * Routing every switcher in the building because a word was missing is not a
   * reasonable reading of a half-typed command.
   */
  readonly device?: string
}

/** A property the line asked to look at rather than change. */
export interface Read {
  readonly device: string
  /** Concrete, with indices filled in: `video.mixEffects.0.programInput`. */
  readonly path: string
  /** One line of plain English, shown the same way an op's is. */
  readonly describe: string
}

export interface LineError {
  readonly message: string
  /** Where in the line, when the language can say. */
  readonly start?: number
  readonly end?: number
}

export type RunResult =
  | {
      readonly ok: true
      readonly language: LanguageId
      /** True when a leading `BM`/`STATE`/`RAW`/`JSON`/`OSC` named the language. */
      readonly declared: boolean
      readonly ops: readonly Op[]
      readonly reads: readonly Read[]
      readonly summary: string
    }
  | {
      readonly ok: false
      readonly language: LanguageId
      readonly declared: boolean
      readonly errors: readonly LineError[]
    }

/** A line with any language prefix taken off it. */
export interface Declared {
  readonly language: LanguageId | null
  readonly body: string
  /** Offset of `body` within the original line, so spans stay honest. */
  readonly offset: number
}
