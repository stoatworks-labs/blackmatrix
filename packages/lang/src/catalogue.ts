/**
 * What an ATEM can be told to do, as data.
 *
 * ## Why this is generated rather than written
 *
 * `atem-connection` exposes 142 methods on its `Atem` class. Every language in
 * this package — the grammar, the state-path dialect, the raw command codes,
 * JSON and OSC — is a different spelling of "call one of those with these
 * arguments". Writing that table by hand would mean 142 chances to transcribe a
 * field name wrongly, and a silent drift every time the library is upgraded.
 *
 * So `tools/generate.ts` reads it out of the library's own TypeScript
 * declarations with the compiler API, and this file is the shape it produces.
 * A field name here is the library's field name because it was never retyped.
 *
 * ## What generation cannot decide
 *
 * One thing: which parameters *address* a unit and which carry a *value*.
 *
 * ```ts
 * changeProgramInput(input: number, me?: number)      // value, then address
 * setFairlightAudioMixerInputProps(index: number, props)  // address, then props
 * ```
 *
 * There is nothing in the types that separates them — both are `number` — and
 * getting it backwards routes a source number onto a mix-effect index. So the
 * generator classifies by parameter *name* against a closed vocabulary and
 * **fails rather than guesses** when it meets a name it does not know. That is
 * the one hand-maintained list in this package, it is twenty-odd words long,
 * and a library upgrade that adds a parameter stops the build instead of
 * quietly mis-addressing a live switcher.
 *
 * ## Nothing here is a promise about a particular switcher
 *
 * The catalogue says what the *protocol* offers. Whether the box in front of
 * you has four keyers, a SuperSource or a stinger is read off its state at run
 * time, exactly as legality already is for crosspoints — never from a model
 * table. See `availability.ts`.
 */

/** The primitive a value ultimately lands on. */
export type ValueType = 'number' | 'int' | 'boolean' | 'string' | 'enum'

/**
 * One parameter that says *which* unit is being addressed: a mix effect, a
 * keyer, a media player, a Fairlight input.
 *
 * `optional` is the library's own `?`, and it means the method defaults it —
 * almost always to 0. A language may leave it out and get that default.
 */
export interface AddressParam {
  /** The library's parameter name, unchanged: `me`, `keyer`, `index`. */
  readonly name: string
  readonly type: 'number' | 'string'
  readonly optional: boolean
  /**
   * Where the count comes from at run time, when this package knows.
   *
   * A dotted path into `AtemState` whose array length is the number of these
   * that exist — `video.mixEffects` for `me`. Absent when the bound is not
   * something the state reports, in which case nothing is bounds-checked and
   * the switcher gets to refuse.
   */
  readonly countPath?: string
}

/** One settable field, either a member of a props object or a bare parameter. */
export interface FieldSpec {
  /** The library's field name, unchanged. */
  readonly name: string
  readonly type: ValueType
  readonly optional: boolean
  /** Present when `type` is `enum`: the enum's name in `Enums`. */
  readonly enum?: string
  /** Present when `type` is `enum`: its member names, in declaration order. */
  readonly values?: readonly string[]
  /** True when the field is an array of the above, e.g. `nextSelection`. */
  readonly array?: boolean
}

/**
 * One callable thing on an ATEM.
 *
 * `id` is the dotted address every language derives its spelling from —
 * `mixEffect.transition.wipe`. Swap the dots for slashes and it is the tail of
 * an OSC address; it is also the node the grammar's nouns resolve to. That
 * correspondence is why the ids are structural rather than pretty.
 */
/**
 * One parameter of the method, in signature order.
 *
 * Needed because the order is not predictable from the kinds. Most methods put
 * their values first and the unit they address last —
 * `changeProgramInput(input, me)` — but `drawMultiviewerLabel(inputId, text)`
 * is the other way round, and a props object can sit at either end. Rebuilding
 * an argument list from the address and value lists alone therefore has to
 * guess, and guessing wrong swaps a source number with a mix-effect index.
 */
export interface ParamRef {
  /** The parameter's own name, matching an `AddressParam` or `FieldSpec`. */
  readonly name: string
  readonly kind: 'address' | 'value' | 'props'
}

export interface CommandSpec {
  readonly id: string
  /**
   * What the command does at that address: `set`, `start`, `stop`, `run`,
   * `store`, `clear`, `capture`, `switch`, `auto`, `preview`, `get`, or `do`
   * for the ones whose method name is already a verb (`cut`, `fadeToBlack`).
   *
   * Kept apart from the id because seven pairs of commands share a noun and
   * differ only here — `startRecording` and `stopRecording` among them. The
   * pair `(id, verb)` is what is unique, and it is also how a command line
   * reads: verb first, then what it acts on.
   */
  readonly verb: string
  /** The `atem-connection` method this calls. */
  readonly method: string
  readonly address: readonly AddressParam[]
  /**
   * The values it carries.
   *
   * A props-object method contributes its fields; a scalar method contributes
   * its non-address parameters. Both arrive here identically, because from a
   * command line there is no difference between them.
   */
  readonly fields: readonly FieldSpec[]
  /** True when the values go in a props object rather than as arguments. */
  readonly props: boolean
  /** Where the props object sits among the arguments. */
  readonly propsIndex?: number
  /** Every parameter in signature order, so an argument list can be rebuilt. */
  readonly params: readonly ParamRef[]
  /** The state subtree this command writes, when it maps to one. */
  readonly statePath?: string
  /** One line of plain English, where this package has one to offer. */
  readonly summary?: string
}

/**
 * How a raw command is put together.
 *
 * `atem-connection` has two writable shapes and the difference is not cosmetic:
 *
 * - **`basic`** — every value is sent at once, and the constructor takes them.
 *   `new ProgramInputCommand(mixEffect, source)`.
 * - **`masked`** — the constructor takes only the address, then each property
 *   is assigned and its bit set in a mask, so the switcher is told which
 *   fields were meant. `new TransitionPropertiesCommand(mixEffect)` followed
 *   by `nextStyle` and its flag.
 *
 * Send a masked command with no flags set and the switcher changes nothing,
 * silently. That is why the shape is recorded rather than inferred.
 */
export type RawKind = 'basic' | 'masked' | 'readonly'

/** A raw protocol command, for the four-character-code dialect. */
export interface RawCommandSpec {
  /** The four-character code on the wire: `CPgI`, `DCut`. */
  readonly rawName: string
  /** The class name in `Commands`. */
  readonly className: string
  readonly kind: RawKind
  readonly writable: boolean
  readonly readable: boolean
  /**
   * The constructor's parameters, in order.
   *
   * For a `masked` command this is the address alone; for a `basic` one it is
   * the address followed by the values, or a single properties object.
   */
  readonly ctor: readonly FieldSpec[]
  /** The command's property bag, which is what `properties` holds. */
  readonly properties: readonly FieldSpec[]
  /** Property names that have a mask bit. Only on `masked` commands. */
  readonly maskFlags?: readonly string[]
  /** The protocol version this first appeared in, when the library says. */
  readonly minimumVersion?: number
}

/** A readable leaf of `AtemState`, for `Get` and the state-path dialect. */
export interface StatePathSpec {
  /** Dotted, with `[]` where an array is indexed: `video.mixEffects[].programInput`. */
  readonly path: string
  readonly type: ValueType
  readonly enum?: string
  readonly values?: readonly string[]
}

/**
 * A state path that may be written, and the command that writes it.
 *
 * ## Why this list is hand-written when everything else is generated
 *
 * Deriving it was tried and abandoned. Matching a command's field name against
 * the state tree produced 224 "matches", and among them
 * `set audio.classic.input.balance` resolved to `audio.master.balance` — an
 * input control that writes the master bus. A read path that is wrong shows
 * you the wrong number; a write path that is wrong changes the wrong thing on
 * a live switcher, silently, because the switcher has no idea what you meant.
 *
 * So writes are vouched for one at a time. The list starts with the crosspoints
 * this repo has verified against hardware plus the obvious transport controls,
 * and grows as things are confirmed. Everything else in the state tree stays
 * readable, and a write to it is refused *by name*, pointing at the command
 * that does the job.
 *
 * ## `indices` is not decoration
 *
 * `video.superSources[a].boxes[b].source` is written by
 * `setSuperSourceBoxSettings(props, box, ssrcId)` — the path names the
 * SuperSource first and the command takes the box first. The two orders are
 * reversed, and nothing in either spelling says so. `indices` names the
 * address parameter each `[]` fills, in path order, so the compiler can put
 * them back in the order the method wants.
 */
export interface WritePathSpec {
  /** The state path, with `[]` where an index goes. */
  readonly path: string
  /** The command that performs the write. */
  readonly id: string
  readonly verb: string
  /** Which of that command's fields the path's value lands in. */
  readonly field: string
  /** The address parameter each `[]` fills, in the order they appear in `path`. */
  readonly indices: readonly string[]
}

export interface Catalogue {
  /** The `atem-connection` version these were read from. */
  readonly library: string
  readonly generated: string
  readonly commands: readonly CommandSpec[]
  readonly raw: readonly RawCommandSpec[]
  readonly state: readonly StatePathSpec[]
  /** The subset of `state` that may be assigned to. See `WritePathSpec`. */
  readonly writes: readonly WritePathSpec[]
  /**
   * The switcher's enums, each a map from member name to the number that goes
   * on the wire. `Object.keys` gives the spellings a command line accepts.
   */
  readonly enums: Readonly<Record<string, Readonly<Record<string, number>>>>
}
