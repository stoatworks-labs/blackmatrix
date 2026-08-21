/**
 * The handful of ATEM enum values this package needs at runtime, inlined.
 *
 * They are copied from `atem-connection`'s own enums, and a test asserts they
 * still match it. The reason they are here rather than imported: importing the
 * enums pulls the whole library in at runtime — UDP sockets, worker threads —
 * which cannot be bundled for a browser. Type-only imports erase, values do not.
 *
 * That matters because the simulator runs this exact code in a tab. Duplicating
 * the model for the browser would mean two implementations of the rules about
 * what may be routed where, and they would drift.
 */

export enum InternalPortType {
  External = 0,
  Black = 1,
  ColorBars = 2,
  ColorGenerator = 3,
  MediaPlayerFill = 4,
  MediaPlayerKey = 5,
  SuperSource = 6,
  ExternalDirect = 7,
  MEOutput = 128,
  Auxiliary = 129,
  Mask = 130,
  MultiViewer = 131,
  AudioMonitor = 132,
}

export enum SourceAvailability {
  None = 0,
  Auxiliary = 1,
  Multiviewer = 2,
  SuperSourceArt = 4,
  SuperSourceBox = 8,
  KeySource = 16,
  Auxiliary1 = 32,
  Auxiliary2 = 64,
  WebcamOut = 128,
  All = 255,
}

export enum MeAvailability {
  None = 0,
  Me1 = 1,
  Me2 = 2,
  Me3 = 4,
  Me4 = 8,
  All = 15,
}

export enum ExternalPortType {
  Unknown = 0,
  SDI = 1,
  HDMI = 2,
  Component = 4,
  Composite = 8,
  SVideo = 16,
  XLR = 32,
  AESEBU = 64,
  RCA = 128,
  Internal = 256,
  TSJack = 512,
  MADI = 1024,
  TRSJack = 2048,
  RJ45 = 4096,
}
