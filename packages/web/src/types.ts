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

/** How the health of a redundant system is judged. Mirrors the server's. */
export type HealthProbe =
  | { kind: 'tcp'; host: string; port: number }
  | { kind: 'http'; url: string; expectStatus?: number }
  | { kind: 'heartbeat' };

export interface FailoverWatch {
  id: string;
  name: string;
  probe: HealthProbe;
  intervalMs: number;
  failAfter: number;
  restoreAfter: number;
  onLostSalvo: string;
  onRestoredSalvo?: string;
  armed: boolean;
  /** A failover route is not refused by a lock. */
  overrideLocks: boolean;
  /** Nothing fires until the main system has been seen working once. */
  requireHealthyFirst: boolean;
}

export type WatchState = 'unknown' | 'healthy' | 'failing' | 'failed' | 'returned';

/** A watch plus what the server has seen of it. */
export interface FailoverView extends FailoverWatch {
  state: WatchState;
  goodRun: number;
  badRun: number;
  everHealthy: boolean;
  lastProbeAt: string | null;
  lastChangeAt: string | null;
  firedAt: string | null;
  lastReason: string | null;
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
  failover: FailoverView[];
}
