/**
 * A crosspoint model for an ATEM. The switcher has no single "router" — it has
 * aux buses, ME program/preview buses, keyer fill and key inputs, SuperSource
 * boxes and multiview windows, each of which takes one source at a time. Every
 * one of those is a destination here, grouped into sections.
 */

/**
 * Sections are declared by the device, not fixed by this package: an ATEM has
 * aux buses and keyers, a Videohub has outputs and monitoring outputs. The five
 * ATEM ones are below; anything routable is free to name its own.
 */
export type SectionId = string;

export interface Section {
  id: SectionId;
  label: string;
  /** One line explaining what the section routes, shown above its rows. */
  hint: string;
}

export const ATEM_SECTIONS: Section[] = [
  { id: 'outputs', label: 'Outputs', hint: 'Aux buses — the switcher’s physical spare outputs' },
  { id: 'buses', label: 'Program / Preview', hint: 'The ME buses. Routing program is a cut, not a transition' },
  { id: 'keyers', label: 'Keyer sources', hint: 'Fill and key inputs for the upstream and downstream keyers' },
  { id: 'supersource', label: 'SuperSource', hint: 'Box sources plus the art fill and key' },
  { id: 'multiview', label: 'Multiview', hint: 'Multiviewer windows' },
];

/**
 * How a destination decides which sources it will take.
 *
 * `atem` reads the switcher's own availability bitmasks, which is what stops an
 * aux output being routed back onto an aux bus. `any` is a plain router
 * crosspoint — a Videohub takes any input on any output, and pretending
 * otherwise would grey out the whole grid.
 */
export type Acceptance = 'atem' | 'any';

export type DestinationKind =
  | 'aux'
  | 'program'
  | 'preview'
  | 'uskFill'
  | 'uskKey'
  | 'dskFill'
  | 'dskKey'
  | 'ssrcBox'
  | 'ssrcArtFill'
  | 'ssrcArtKey'
  | 'mvWindow'
  // Videohub, and anything else that is already a router.
  | 'routerOutput'
  | 'routerMonitoring';

/** Where the destination lives on the switcher, in the numbering the API uses. */
export interface DestinationAddress {
  /** Aux bus, ME index, DSK index, SuperSource index or multiviewer index. */
  unit: number;
  /** Keyer, box or window within that unit. */
  slot?: number;
}

export interface Destination {
  /** Stable across restarts — the web UI, salvos and the API all key on it. */
  id: string;
  kind: DestinationKind;
  section: SectionId;
  label: string;
  /** Six-ish characters, for a router panel button. */
  short: string;
  address: DestinationAddress;
  /** Defaults to `atem` when absent, since that is what this package builds. */
  accepts?: Acceptance;
  /** Set when the switcher may refuse the route; surfaced in the UI. */
  caveat?: string;
}

export type SourceKind =
  | 'input'
  | 'black'
  | 'bars'
  | 'colour'
  | 'mediaPlayer'
  | 'mediaPlayerKey'
  | 'supersource'
  | 'meOutput'
  | 'aux'
  | 'multiview'
  | 'router'
  | 'other';

/**
 * Which physical plug an input is taking, and which it could take.
 *
 * Present only on inputs the switcher says are external. Many models offer one
 * option and no choice — an ATEM Mini Extreme ISO reports HDMI and nothing else
 * on every input — while a Constellation or Television Studio can switch an
 * input between SDI and HDMI, and newer models expose `RJ45`, the network input.
 *
 * The port is all the protocol offers: an SRT URL or a stream key is not
 * settable through it, and stays in ATEM Setup.
 */
export interface SourcePorts {
  /** The ExternalPortType in use. */
  current: number;
  /** Every ExternalPortType this input can be assigned to. */
  available: number[];
}

export interface Source {
  /** The ATEM's own source id — sparse, and not a column index. */
  id: number;
  label: string;
  short: string;
  kind: SourceKind;
  /** SourceAvailability bitmask, straight off the switcher. */
  availability: number;
  /** MeAvailability bitmask, straight off the switcher. */
  meAvailability: number;
  /** Absent on internal sources, and on devices that have no such concept. */
  ports?: SourcePorts;
}

/** ExternalPortType, named. The switcher sends the number. */
export const PORT_LABELS: Record<number, string> = {
  0: 'Unknown',
  1: 'SDI',
  2: 'HDMI',
  4: 'Component',
  8: 'Composite',
  16: 'S-Video',
  32: 'XLR',
  64: 'AES/EBU',
  128: 'RCA',
  256: 'Internal',
  512: 'TS jack',
  1024: 'MADI',
  2048: 'TRS jack',
  4096: 'Network',
};

export function portLabel(port: number): string {
  return PORT_LABELS[port] ?? `Port ${port}`;
}

export interface MatrixModel {
  sections: Section[];
  sources: Source[];
  destinations: Destination[];
  /** destination id -> ATEM source id, or -1 when the state does not say. */
  routes: Record<string, number>;
}
