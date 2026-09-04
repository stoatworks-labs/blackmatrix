/**
 * The words the grammar knows, and what each one means in the catalogue.
 *
 * ## Why this table is hand-written when the catalogue is not
 *
 * The catalogue is complete and machine-derived, and it is unspeakable. Nobody
 * types `set usk.fill.source me=0 keyer=1 fillSource=3` on a show. The grammar
 * exists to put an operator's words in front of that, and an operator's words
 * are not derivable from a method name — `Key` means `upstreamKeyers`, `DSK`
 * means `downstreamKeyers`, and only a person knows that.
 *
 * So this is a translation table, and every entry is checked against the
 * catalogue when the vocabulary is built: a phrase naming a command that does
 * not exist, an address that command does not have, or a field it does not
 * take is a thrown error, not a silent miss. The table cannot drift from the
 * catalogue without the package failing to load.
 *
 * The machine languages reach all 114 commands. This reaches the ones worth a
 * word, and grows as words are agreed. That asymmetry is deliberate: an
 * unspeakable command is still reachable, and a badly-chosen word is forever.
 *
 * ## Numbering
 *
 * ⚠️ **The grammar counts from 1. Every other language here counts from 0.**
 *
 * `Cut ME 1` is mix effect index 0. This is not an inconsistency to tidy away —
 * it is the same split the repo already lives with, where the line protocol is
 * one-based and Videohub is zero-based, and for the same reason. An operator
 * says "ME 1" and a protocol says `me: 0`. A grammar that made an operator
 * type `ME 0` would be wrong in the only place it matters, and the machine
 * languages address the protocol directly and must not lie about it.
 *
 * The compiled summary always shows the resolved call, so what actually went
 * out is visible rather than inferred.
 */

/** A word that names a command, and optionally carries its own index. */
export interface Phrase {
  /** The word an operator types. Abbreviated to any unambiguous prefix. */
  readonly word: string
  readonly verb: string
  readonly id: string
  /** The address this phrase's own number fills, if it takes one. */
  readonly self?: string
  /** The field a trailing value lands in, if it takes one. */
  readonly field?: string
  /** One line for the help and the completion list. */
  readonly summary: string
}

/** A word that addresses a unit within a command. */
export interface Noun {
  readonly word: string
  /** The catalogue address parameter it fills. */
  readonly address: string
  readonly summary: string
}

/**
 * The commands worth a word.
 *
 * Ordered by how often a hand reaches for them, which is also roughly the
 * order they should appear in help.
 */
export const PHRASES: readonly Phrase[] = [
  // Transport.
  { word: 'Cut', verb: 'do', id: 'cut', summary: 'Cut preview to program' },
  { word: 'Auto', verb: 'auto', id: 'transition', summary: 'Run the transition' },
  { word: 'FTB', verb: 'do', id: 'fade.to.black', summary: 'Fade to black' },

  // Crosspoints — what this app is for.
  { word: 'Program', verb: 'set', id: 'program.input', field: 'input', summary: 'Set the program bus' },
  { word: 'Preview', verb: 'set', id: 'preview.input', field: 'input', summary: 'Set the preview bus' },
  { word: 'Aux', verb: 'set', id: 'aux.source', self: 'bus', field: 'source', summary: 'Route an aux output' },

  // Keyers.
  { word: 'KeyFill', verb: 'set', id: 'usk.fill.source', field: 'fillSource', summary: 'Upstream keyer fill' },
  { word: 'KeyCut', verb: 'set', id: 'usk.cut.source', field: 'cutSource', summary: 'Upstream keyer key' },
  { word: 'KeyOn', verb: 'set', id: 'usk.on.air', field: 'onAir', summary: 'Upstream keyer on air' },
  { word: 'DskFill', verb: 'set', id: 'dsk.fill.source', field: 'input', summary: 'Downstream keyer fill' },
  { word: 'DskCut', verb: 'set', id: 'dsk.cut.source', field: 'input', summary: 'Downstream keyer key' },
  { word: 'DskOn', verb: 'set', id: 'dsk.on.air', field: 'onAir', summary: 'Downstream keyer on air' },
  { word: 'DskTie', verb: 'set', id: 'dsk.tie', field: 'tie', summary: 'Tie a downstream keyer' },

  // The other routable buses.
  { word: 'Window', verb: 'set', id: 'mv.window.source', self: 'window', field: 'source', summary: 'Multiview window source' },
  { word: 'Box', verb: 'set', id: 'ssrc.box', self: 'box', field: 'source', summary: 'SuperSource box source' },

  // Macros and the recorders.
  { word: 'Macro', verb: 'do', id: 'macro.run', self: 'index', summary: 'Run a macro' },
  { word: 'MacroStop', verb: 'do', id: 'macro.stop', summary: 'Stop the running macro' },
  { word: 'RecordStart', verb: 'start', id: 'recording', summary: 'Start recording' },
  { word: 'RecordStop', verb: 'stop', id: 'recording', summary: 'Stop recording' },
  { word: 'StreamStart', verb: 'start', id: 'streaming', summary: 'Start streaming' },
  { word: 'StreamStop', verb: 'stop', id: 'streaming', summary: 'Stop streaming' },

  // Transition shaping.
  { word: 'Style', verb: 'set', id: 'transition.style', field: 'nextStyle', summary: 'Next transition style' },
  { word: 'MixRate', verb: 'set', id: 'mix.transition', field: 'rate', summary: 'Mix transition rate, in frames' },
  { word: 'FtbRate', verb: 'set', id: 'fade.to.black.rate', field: 'rate', summary: 'Fade-to-black rate, in frames' },
  { word: 'DskRate', verb: 'set', id: 'dsk.rate', field: 'rate', summary: 'Downstream keyer rate, in frames' },
]

/**
 * The words that address a unit.
 *
 * `ME` is the one an operator says most and the one the protocol calls `me`;
 * the rest are the switcher's own furniture under the names people use for it.
 */
export const NOUNS: readonly Noun[] = [
  { word: 'ME', address: 'me', summary: 'Mix effect' },
  { word: 'Key', address: 'keyer', summary: 'Upstream keyer' },
  { word: 'Dsk', address: 'key', summary: 'Downstream keyer' },
  { word: 'Multiview', address: 'mv', summary: 'Multiviewer' },
  { word: 'SuperSource', address: 'ssrcId', summary: 'SuperSource' },
]

/**
 * Words that are not commands but change what a line means.
 *
 * `Input`, `Source`, `To` and `At` all introduce the value, and all mean the
 * same thing. Four spellings for one job looks like indulgence until you write
 * the lines out: `Aux 3 Input 5` and `Program To 5` and `MixRate At 25` each
 * read the way the person saying them would say them, and a grammar an
 * operator has to translate into is one they will not use under pressure.
 * Mynah borrows `At` from grandMA3 and Titan for the same reason.
 */
export const CONTROL_WORDS: readonly string[] = [
  'Device',
  'All',
  'On',
  'Off',
  'Thru',
  'Help',
  'Input',
  'Source',
  'To',
  'At',
]

/** The control words that introduce a value. */
export const VALUE_MARKERS: readonly string[] = ['Input', 'Source', 'To', 'At']
