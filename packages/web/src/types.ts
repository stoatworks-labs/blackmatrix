/**
 * The shapes the UI works with.
 *
 * The matrix model — destinations, sources, sections, port assignments and the
 * labels for them — is re-exported from @av/atem-matrix rather than restated
 * here. It used to be restated, and the copies drifted: the web kept a version
 * of the aux legality rule from before a real switcher corrected it, so the grid
 * offered crosspoints the server then refused. One definition, imported.
 *
 * What is declared below is only what the *server* shapes: its snapshot, its
 * device view, and the forms the UI posts back.
 */
// Imported as well as re-exported: `export type { X } from` forwards the name
// without binding it locally, and DeviceView below needs to refer to it.
import type { MatrixModel } from '@av/atem-matrix';

export type {
  Acceptance,
  Destination,
  DestinationKind,
  MatrixModel,
  Section,
  SectionId,
  Source,
  SourceKind,
  SourcePorts,
} from '@av/atem-matrix';
export { PORT_LABELS, portLabel } from '@av/atem-matrix';

export interface DeviceView {
  id: string;
  name: string;
  address: string;
  model: string;
  expectedModel?: string;
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
  /** Optional: the server makes one from the name or address when absent. */
  id?: string;
  name: string;
  address: string;
  type?: 'atem' | 'videohub';
  videohubPort?: number;
  capture?: string;
  /** Empty means auto-detect: take whatever the device reports. */
  expectedModel?: string;
}

export interface FleetSnapshot {
  devices: DeviceView[];
  salvos: Salvo[];
}
