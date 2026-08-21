import { ExternalPortType, type SwitcherProfile } from '@av/atem-matrix';

/**
 * The device library the simulator offers.
 *
 * **On accuracy, plainly.** The model *names* are Blackmagic's, taken from the
 * list `atem-connection` maintains. The *numbers* are another matter:
 *
 * - `capture` — taken off that switcher over the protocol. Ground truth.
 * - `declared` — an approximate shape for that class of switcher. It produces a
 *   working switcher of roughly the right size; it is not a specification, and
 *   nothing here should be quoted as one.
 *
 * A `declared` entry is replaced by truth the moment someone runs a capture
 * against the real thing and loads the file. That is the intended path — this
 * catalogue is a starting point for a demo, not a claim about hardware.
 *
 * A Videohub is a different case: its model *is* its size, and its behaviour is
 * "any input on any output". A simulated one is faithful in a way a simulated
 * switcher cannot be.
 */
export type Provenance = 'capture' | 'declared';

export interface CatalogueEntry {
  id: string;
  name: string;
  family: string;
  kind: 'atem' | 'videohub';
  provenance: Provenance;
  /** Switchers only. */
  profile?: SwitcherProfile;
  /** Routers only. */
  router?: { inputs: number; outputs: number; monitoring?: number };
  note?: string;
}

const hdmiOnly = () => ({ available: [ExternalPortType.HDMI], current: ExternalPortType.HDMI });
const sdiOnly = () => ({ available: [ExternalPortType.SDI], current: ExternalPortType.SDI });
const sdiOrHdmi = () => ({
  available: [ExternalPortType.SDI, ExternalPortType.HDMI],
  current: ExternalPortType.SDI,
});

function switcher(
  partial: Partial<SwitcherProfile> & { product: string; inputs: number },
): SwitcherProfile {
  return {
    mixEffects: 1,
    usksPerMe: 1,
    auxes: 1,
    dsks: 1,
    superSources: 0,
    ssrcBoxes: 4,
    multiviewers: 1,
    mvWindows: 10,
    mediaPlayers: 1,
    colourGenerators: 2,
    cleanFeeds: 1,
    inputPorts: hdmiOnly,
    ...partial,
  };
}

/**
 * The Mini Extreme ISO's numbers are not guesses: they were read off the
 * switcher on 2026-08-21 — 8 HDMI inputs, one ME with four upstream keyers, two
 * downstream keyers, one SuperSource of four boxes, three aux outputs (Output 1,
 * Output 2 and the webcam out), sixteen multiviewer windows, two media players.
 */
const MINI_EXTREME_ISO = switcher({
  product: 'ATEM Mini Extreme ISO',
  inputs: 8,
  usksPerMe: 4,
  auxes: 3,
  dsks: 2,
  superSources: 1,
  mvWindows: 16,
  mediaPlayers: 2,
});

export const CATALOGUE: CatalogueEntry[] = [
  // --- ATEM Mini -----------------------------------------------------------
  {
    id: 'atem-mini',
    name: 'ATEM Mini',
    family: 'ATEM Mini',
    kind: 'atem',
    provenance: 'declared',
    profile: switcher({ product: 'ATEM Mini', inputs: 4, auxes: 0, mvWindows: 10 }),
  },
  {
    id: 'atem-mini-pro',
    name: 'ATEM Mini Pro',
    family: 'ATEM Mini',
    kind: 'atem',
    provenance: 'declared',
    profile: switcher({ product: 'ATEM Mini Pro', inputs: 4, auxes: 1, mvWindows: 10 }),
  },
  {
    id: 'atem-mini-pro-iso',
    name: 'ATEM Mini Pro ISO',
    family: 'ATEM Mini',
    kind: 'atem',
    provenance: 'declared',
    profile: switcher({ product: 'ATEM Mini Pro ISO', inputs: 4, auxes: 1, mvWindows: 10 }),
  },
  {
    id: 'atem-mini-extreme',
    name: 'ATEM Mini Extreme',
    family: 'ATEM Mini',
    kind: 'atem',
    provenance: 'declared',
    profile: switcher({
      product: 'ATEM Mini Extreme',
      inputs: 8,
      usksPerMe: 4,
      auxes: 3,
      dsks: 2,
      superSources: 1,
      mvWindows: 16,
      mediaPlayers: 2,
    }),
    note: 'Shape taken from its ISO sibling, which was captured off hardware.',
  },
  {
    id: 'atem-mini-extreme-iso',
    name: 'ATEM Mini Extreme ISO',
    family: 'ATEM Mini',
    kind: 'atem',
    provenance: 'capture',
    profile: MINI_EXTREME_ISO,
    note: 'Read off a real switcher on 2026-08-21.',
  },
  {
    id: 'atem-mini-extreme-iso-g2',
    name: 'ATEM Mini Extreme ISO G2',
    family: 'ATEM Mini',
    kind: 'atem',
    provenance: 'declared',
    profile: switcher({ ...MINI_EXTREME_ISO, product: 'ATEM Mini Extreme ISO G2' }),
    note: 'Assumed to match the first generation. Unverified.',
  },

  // --- ATEM SDI ------------------------------------------------------------
  {
    id: 'atem-sdi',
    name: 'ATEM SDI',
    family: 'ATEM SDI',
    kind: 'atem',
    provenance: 'declared',
    profile: switcher({ product: 'ATEM SDI', inputs: 4, auxes: 0, inputPorts: sdiOnly }),
  },
  {
    id: 'atem-sdi-pro-iso',
    name: 'ATEM SDI Pro ISO',
    family: 'ATEM SDI',
    kind: 'atem',
    provenance: 'declared',
    profile: switcher({ product: 'ATEM SDI Pro ISO', inputs: 4, auxes: 1, inputPorts: sdiOnly }),
  },
  {
    id: 'atem-sdi-extreme-iso',
    name: 'ATEM SDI Extreme ISO',
    family: 'ATEM SDI',
    kind: 'atem',
    provenance: 'declared',
    profile: switcher({
      product: 'ATEM SDI Extreme ISO',
      inputs: 8,
      usksPerMe: 4,
      auxes: 3,
      dsks: 2,
      superSources: 1,
      mvWindows: 16,
      mediaPlayers: 2,
      inputPorts: sdiOnly,
    }),
  },

  // --- Television Studio ---------------------------------------------------
  {
    id: 'atem-tvs-hd8',
    name: 'ATEM Television Studio HD8',
    family: 'ATEM Television Studio',
    kind: 'atem',
    provenance: 'declared',
    profile: switcher({
      product: 'ATEM Television Studio HD8',
      inputs: 8,
      usksPerMe: 4,
      auxes: 2,
      dsks: 2,
      superSources: 1,
      mvWindows: 16,
      mediaPlayers: 2,
      inputPorts: sdiOrHdmi,
    }),
  },
  {
    id: 'atem-tvs-hd8-iso',
    name: 'ATEM Television Studio HD8 ISO',
    family: 'ATEM Television Studio',
    kind: 'atem',
    provenance: 'declared',
    profile: switcher({
      product: 'ATEM Television Studio HD8 ISO',
      inputs: 8,
      usksPerMe: 4,
      auxes: 2,
      dsks: 2,
      superSources: 1,
      mvWindows: 16,
      mediaPlayers: 2,
      inputPorts: sdiOrHdmi,
    }),
  },
  {
    id: 'atem-tvs-4k8',
    name: 'ATEM Television Studio 4K8',
    family: 'ATEM Television Studio',
    kind: 'atem',
    provenance: 'declared',
    profile: switcher({
      product: 'ATEM Television Studio 4K8',
      inputs: 8,
      usksPerMe: 4,
      auxes: 2,
      dsks: 2,
      superSources: 1,
      mvWindows: 16,
      mediaPlayers: 2,
      inputPorts: sdiOrHdmi,
    }),
  },

  // --- Constellation HD ----------------------------------------------------
  {
    id: 'atem-constellation-hd-1me',
    name: 'ATEM Constellation HD 1 M/E',
    family: 'ATEM Constellation',
    kind: 'atem',
    provenance: 'declared',
    profile: switcher({
      product: 'ATEM Constellation HD 1 M/E',
      inputs: 10,
      usksPerMe: 4,
      auxes: 4,
      dsks: 2,
      superSources: 1,
      mvWindows: 16,
      mediaPlayers: 2,
      inputPorts: sdiOnly,
    }),
  },
  {
    id: 'atem-constellation-hd-2me',
    name: 'ATEM Constellation HD 2 M/E',
    family: 'ATEM Constellation',
    kind: 'atem',
    provenance: 'declared',
    profile: switcher({
      product: 'ATEM Constellation HD 2 M/E',
      inputs: 20,
      mixEffects: 2,
      usksPerMe: 4,
      auxes: 8,
      dsks: 2,
      superSources: 1,
      multiviewers: 2,
      mvWindows: 16,
      mediaPlayers: 2,
      cleanFeeds: 2,
      inputPorts: sdiOnly,
    }),
  },
  {
    id: 'atem-constellation-hd-4me',
    name: 'ATEM Constellation HD 4 M/E',
    family: 'ATEM Constellation',
    kind: 'atem',
    provenance: 'declared',
    profile: switcher({
      product: 'ATEM Constellation HD 4 M/E',
      inputs: 40,
      mixEffects: 4,
      usksPerMe: 4,
      auxes: 24,
      dsks: 4,
      superSources: 2,
      multiviewers: 2,
      mvWindows: 16,
      mediaPlayers: 4,
      cleanFeeds: 4,
      inputPorts: sdiOnly,
    }),
  },

  // --- Constellation 4K ----------------------------------------------------
  {
    id: 'atem-constellation-4k-1me',
    name: 'ATEM Constellation 4K 1 M/E',
    family: 'ATEM Constellation',
    kind: 'atem',
    provenance: 'declared',
    profile: switcher({
      product: 'ATEM Constellation 4K 1 M/E',
      inputs: 10,
      usksPerMe: 4,
      auxes: 4,
      dsks: 2,
      superSources: 1,
      mvWindows: 16,
      mediaPlayers: 2,
      inputPorts: sdiOnly,
    }),
  },
  {
    id: 'atem-constellation-4k-2me',
    name: 'ATEM Constellation 4K 2 M/E',
    family: 'ATEM Constellation',
    kind: 'atem',
    provenance: 'declared',
    profile: switcher({
      product: 'ATEM Constellation 4K 2 M/E',
      inputs: 20,
      mixEffects: 2,
      usksPerMe: 4,
      auxes: 8,
      dsks: 2,
      superSources: 1,
      multiviewers: 2,
      mvWindows: 16,
      mediaPlayers: 2,
      cleanFeeds: 2,
      inputPorts: sdiOnly,
    }),
  },
  {
    id: 'atem-constellation-4k-4me',
    name: 'ATEM Constellation 4K 4 M/E',
    family: 'ATEM Constellation',
    kind: 'atem',
    provenance: 'declared',
    profile: switcher({
      product: 'ATEM Constellation 4K 4 M/E',
      inputs: 40,
      mixEffects: 4,
      usksPerMe: 4,
      auxes: 24,
      dsks: 4,
      superSources: 2,
      multiviewers: 2,
      mvWindows: 16,
      mediaPlayers: 4,
      cleanFeeds: 4,
      inputPorts: sdiOnly,
    }),
  },
  {
    id: 'atem-constellation-8k',
    name: 'ATEM Constellation 8K',
    family: 'ATEM Constellation',
    kind: 'atem',
    provenance: 'declared',
    profile: switcher({
      product: 'ATEM Constellation 8K',
      inputs: 40,
      mixEffects: 4,
      usksPerMe: 4,
      auxes: 24,
      dsks: 4,
      superSources: 2,
      multiviewers: 2,
      mvWindows: 16,
      mediaPlayers: 4,
      cleanFeeds: 4,
      inputPorts: sdiOnly,
    }),
  },

  // --- Older production switchers -----------------------------------------
  {
    id: 'atem-1me-4k',
    name: 'ATEM 1 M/E Production Studio 4K',
    family: 'ATEM Production Studio',
    kind: 'atem',
    provenance: 'declared',
    profile: switcher({
      product: 'ATEM 1 M/E Production Studio 4K',
      inputs: 10,
      usksPerMe: 4,
      auxes: 3,
      dsks: 2,
      mvWindows: 10,
      mediaPlayers: 2,
      inputPorts: sdiOnly,
    }),
  },
  {
    id: 'atem-2me-4k',
    name: 'ATEM 2 M/E Production Studio 4K',
    family: 'ATEM Production Studio',
    kind: 'atem',
    provenance: 'declared',
    profile: switcher({
      product: 'ATEM 2 M/E Production Studio 4K',
      inputs: 20,
      mixEffects: 2,
      usksPerMe: 4,
      auxes: 6,
      dsks: 2,
      superSources: 1,
      mvWindows: 10,
      mediaPlayers: 2,
      cleanFeeds: 2,
      inputPorts: sdiOnly,
    }),
  },
  {
    id: 'atem-2me-bs-4k',
    name: 'ATEM 2 M/E Broadcast Studio 4K',
    family: 'ATEM Production Studio',
    kind: 'atem',
    provenance: 'declared',
    profile: switcher({
      product: 'ATEM 2 M/E Broadcast Studio 4K',
      inputs: 20,
      mixEffects: 2,
      usksPerMe: 4,
      auxes: 6,
      dsks: 2,
      superSources: 1,
      multiviewers: 2,
      mvWindows: 10,
      mediaPlayers: 2,
      cleanFeeds: 2,
      inputPorts: sdiOnly,
    }),
  },
  {
    id: 'atem-tvs-pro-4k',
    name: 'ATEM Television Studio Pro 4K',
    family: 'ATEM Television Studio',
    kind: 'atem',
    provenance: 'declared',
    profile: switcher({
      product: 'ATEM Television Studio Pro 4K',
      inputs: 8,
      usksPerMe: 1,
      auxes: 1,
      dsks: 2,
      mvWindows: 10,
      mediaPlayers: 2,
      inputPorts: sdiOrHdmi,
    }),
  },

  // --- Videohub ------------------------------------------------------------
  // A router's model is its size, and any input may go to any output. These are
  // faithful in a way the switchers above are not.
  { id: 'vh-micro-12', name: 'Micro Videohub 12x12', family: 'Videohub', kind: 'videohub', provenance: 'declared', router: { inputs: 12, outputs: 12 } },
  { id: 'vh-smart-12', name: 'Smart Videohub 12x12', family: 'Videohub', kind: 'videohub', provenance: 'declared', router: { inputs: 12, outputs: 12 } },
  { id: 'vh-smart-20', name: 'Smart Videohub 20x20', family: 'Videohub', kind: 'videohub', provenance: 'declared', router: { inputs: 20, outputs: 20 } },
  { id: 'vh-smart-40', name: 'Smart Videohub 40x40', family: 'Videohub', kind: 'videohub', provenance: 'declared', router: { inputs: 40, outputs: 40 } },
  { id: 'vh-12g-40', name: 'Videohub 40x40 12G', family: 'Videohub', kind: 'videohub', provenance: 'declared', router: { inputs: 40, outputs: 40 } },
  { id: 'vh-12g-80', name: 'Videohub 80x80 12G', family: 'Videohub', kind: 'videohub', provenance: 'declared', router: { inputs: 80, outputs: 80 } },
  { id: 'vh-12g-120', name: 'Videohub 120x120 12G', family: 'Videohub', kind: 'videohub', provenance: 'declared', router: { inputs: 120, outputs: 120 } },
  { id: 'vh-universal-72', name: 'Universal Videohub 72', family: 'Videohub', kind: 'videohub', provenance: 'declared', router: { inputs: 72, outputs: 72 } },
  { id: 'vh-universal-288', name: 'Universal Videohub 288', family: 'Videohub', kind: 'videohub', provenance: 'declared', router: { inputs: 288, outputs: 288 } },
];

export const FAMILIES = [...new Set(CATALOGUE.map((entry) => entry.family))];
