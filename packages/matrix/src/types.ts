/**
 * A crosspoint model for an ATEM. The switcher has no single "router" — it has
 * aux buses, ME program/preview buses, keyer fill and key inputs, SuperSource
 * boxes and multiview windows, each of which takes one source at a time. Every
 * one of those is a destination here, grouped into sections.
 */

export type SectionId = 'outputs' | 'buses' | 'keyers' | 'supersource' | 'multiview';

export interface Section {
  id: SectionId;
  label: string;
  /** One line explaining what the section routes, shown above its rows. */
  hint: string;
}

export const SECTIONS: Section[] = [
  { id: 'outputs', label: 'Outputs', hint: 'Aux buses — the switcher’s physical spare outputs' },
  { id: 'buses', label: 'Program / Preview', hint: 'The ME buses. Routing program is a cut, not a transition' },
  { id: 'keyers', label: 'Keyer sources', hint: 'Fill and key inputs for the upstream and downstream keyers' },
  { id: 'supersource', label: 'SuperSource', hint: 'Box sources plus the art fill and key' },
  { id: 'multiview', label: 'Multiview', hint: 'Multiviewer windows' },
];

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
  | 'mvWindow';

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
  | 'other';

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
}

export interface MatrixModel {
  sections: Section[];
  sources: Source[];
  destinations: Destination[];
  /** destination id -> ATEM source id, or -1 when the state does not say. */
  routes: Record<string, number>;
}
