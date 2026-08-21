/** Mirrors the server's snapshot shape. Kept hand-written so the UI has no build-order dependency. */

/** Declared by the device — an ATEM's five, a Videohub's outputs/monitoring. */
export type SectionId = string;

export interface Section {
  id: SectionId;
  label: string;
  hint: string;
}

export interface Destination {
  id: string;
  kind: string;
  /** 'any' for a plain router crosspoint; absent means the ATEM mask rules. */
  accepts?: 'atem' | 'any';
  section: SectionId;
  label: string;
  short: string;
  address: { unit: number; slot?: number };
  caveat?: string;
}

export interface SourcePorts {
  current: number;
  available: number[];
}

export interface Source {
  id: number;
  label: string;
  short: string;
  kind: string;
  availability: number;
  meAvailability: number;
  /** Only on external inputs, and only on devices that have plugs at all. */
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
  routes: Record<string, number>;
}

export interface DeviceView {
  id: string;
  name: string;
  address: string;
  model: string;
  connection: string;
  videohubPort: number | null;
  videohubClients: number;
  matrix: MatrixModel | null;
  locks: Record<string, string | null>;
}

export interface Salvo {
  id: string;
  name: string;
  crosspoints: Array<{ deviceId: string; destination: string; source: number }>;
}

export interface FoundDevice {
  address: string;
  /** An ATEM answers on both protocols; adding it as a switcher gets every bus. */
  kinds: Array<'atem' | 'videohub'>;
  model: string;
  alreadyAdded: boolean;
}

export interface DiscoverResult {
  ok: boolean;
  subnets: string[];
  devices: FoundDevice[];
}

/** The editable half of a device — what the devices page sends back. */
export interface DeviceInput {
  id: string;
  name: string;
  address: string;
  type?: 'atem' | 'videohub';
  videohubPort?: number;
  capture?: string;
}

export interface FleetSnapshot {
  devices: DeviceView[];
  salvos: Salvo[];
}
