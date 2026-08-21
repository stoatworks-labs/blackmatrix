import fs from 'node:fs';
import path from 'node:path';
import { log } from './log.js';

export type DeviceKind = 'atem' | 'videohub';

export interface DeviceConfig {
  id: string;
  name: string;
  /** Defaults to 'atem'. A 'videohub' is a real Blackmagic router on the network. */
  type?: DeviceKind;
  /** Hostname or IP of the switcher. Ignored in --mock, and when `capture` is set. */
  address: string;
  /**
   * TCP port for this device's Videohub protocol *server* — the emulation that
   * lets panels drive it. Videohub devices already are one, so they get no
   * emulation unless a port is named here explicitly.
   */
  videohubPort?: number;
  /**
   * Path to a capture file (see `npm run capture`). When set, this device is
   * replayed from that file instead of connecting to hardware — the way to keep
   * developing against a real switcher's exact shape once it has gone.
   */
  capture?: string;
}

export interface Salvo {
  id: string;
  name: string;
  crosspoints: Array<{ deviceId: string; destination: string; source: number }>;
}

/**
 * A tie makes one destination follow another across boxes: route the leader,
 * and the follower goes to the matching source. The mapping is explicit because
 * nothing else could be — "camera 1" is input 1 on a switcher and whatever it
 * happens to be patched to on a router.
 */
export interface Tie {
  id: string;
  name: string;
  /** `deviceId:destinationId` — the destination an operator actually routes. */
  leader: string;
  /** `deviceId:destinationId` — the one that follows. */
  follower: string;
  /** Leader source id -> follower source id. */
  sourceMap: Record<string, number>;
}

export interface AppConfig {
  /** HTTP port for the UI and REST API. */
  port: number;
  videohub: {
    enabled: boolean;
    /** First device gets this port, the next one basePort + 1, and so on. */
    basePort: number;
    host: string;
  };
  devices: DeviceConfig[];
  /** Per device, destination id -> operator's own name for it. */
  labels: Record<string, Record<string, string>>;
  salvos: Salvo[];
  ties: Tie[];
}

export const CONFIG_FILENAME = 'blackmatrix.config.json';
/** What this app was called before. Read, never written. */
const LEGACY_CONFIG_FILENAME = 'atem-crosspoint.config.json';

const DEFAULTS: AppConfig = {
  port: 8533,
  videohub: { enabled: true, basePort: 9990, host: '0.0.0.0' },
  devices: [],
  labels: {},
  salvos: [],
  ties: [],
};

/** A three-switcher fleet with deliberately different shapes, for --mock. */
export const MOCK_CONFIG: AppConfig = {
  ...DEFAULTS,
  devices: [
    { id: 'stage', name: 'Stage', address: 'mock://stage' },
    { id: 'studio', name: 'Studio', address: 'mock://studio' },
    { id: 'flypack', name: 'Flypack', address: 'mock://flypack' },
    // A real videohub device pointed at the simulated router --mock starts up,
    // so the client half of the protocol is exercised over actual TCP.
    { id: 'router', name: 'Router', type: 'videohub', address: '127.0.0.1:19990' },
  ],
  labels: { stage: { 'aux.0': 'FOH screens' } },
  salvos: [
    {
      id: 'salvo-house',
      name: 'House to wide',
      crosspoints: [
        { deviceId: 'stage', destination: 'aux.0', source: 1 },
        { deviceId: 'studio', destination: 'aux.0', source: 1 },
        { deviceId: 'router', destination: 'out.0', source: 0 },
      ],
    },
  ],
  ties: [
    {
      id: 'tie-house',
      name: 'House screen follows Stage aux 1',
      leader: 'stage:aux.0',
      follower: 'router:out.1',
      // Cameras 1-4 on the switcher are router inputs 5-8 in this imaginary rig.
      sourceMap: { '1': 4, '2': 5, '3': 6, '4': 7 },
    },
  ],
};

export function configPath(): string {
  const named = process.env.BLACKMATRIX_CONFIG ?? process.env.ATEM_CROSSPOINT_CONFIG;
  if (named) return named;

  const current = path.resolve(process.cwd(), CONFIG_FILENAME);
  if (fs.existsSync(current)) return current;

  // This app used to be called ATEM Crosspoint. An existing config keeps
  // working under its old name rather than the rename quietly emptying
  // somebody's fleet; it is read from there and saved back there.
  const legacy = path.resolve(process.cwd(), LEGACY_CONFIG_FILENAME);
  if (fs.existsSync(legacy)) {
    log.warn(`using ${LEGACY_CONFIG_FILENAME} — rename it to ${CONFIG_FILENAME} when convenient`);
    return legacy;
  }
  return current;
}

export function loadConfig(): AppConfig {
  const file = configPath();
  if (!fs.existsSync(file)) {
    log.warn(`no config at ${file} — starting with an empty fleet. Add devices in the UI or the file.`);
    return structuredClone(DEFAULTS);
  }
  try {
    const parsed = JSON.parse(fs.readFileSync(file, 'utf8')) as Partial<AppConfig>;
    return {
      ...DEFAULTS,
      ...parsed,
      videohub: { ...DEFAULTS.videohub, ...(parsed.videohub ?? {}) },
      devices: parsed.devices ?? [],
      labels: parsed.labels ?? {},
      salvos: parsed.salvos ?? [],
      ties: parsed.ties ?? [],
    };
  } catch (error) {
    log.error(`config at ${file} is not readable JSON: ${String(error)}`);
    return structuredClone(DEFAULTS);
  }
}

export function saveConfig(config: AppConfig): void {
  const file = configPath();
  fs.writeFileSync(file, `${JSON.stringify(config, null, 2)}\n`, 'utf8');
}
