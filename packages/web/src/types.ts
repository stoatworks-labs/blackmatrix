/** Mirrors the server's snapshot shape. Kept hand-written so the UI has no build-order dependency. */

export type SectionId = 'outputs' | 'buses' | 'keyers' | 'supersource' | 'multiview';

export interface Section {
  id: SectionId;
  label: string;
  hint: string;
}

export interface Destination {
  id: string;
  kind: string;
  section: SectionId;
  label: string;
  short: string;
  address: { unit: number; slot?: number };
  caveat?: string;
}

export interface Source {
  id: number;
  label: string;
  short: string;
  kind: string;
  availability: number;
  meAvailability: number;
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

export interface FleetSnapshot {
  devices: DeviceView[];
  salvos: Salvo[];
}
