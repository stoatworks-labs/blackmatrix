import fs from 'node:fs';
import path from 'node:path';
import { log } from './log.js';

export interface DeviceConfig {
  id: string;
  name: string;
  /** Hostname or IP of the switcher. Ignored in --mock. */
  address: string;
  /** TCP port for this device's Videohub protocol server. */
  videohubPort?: number;
}

export interface Salvo {
  id: string;
  name: string;
  crosspoints: Array<{ deviceId: string; destination: string; source: number }>;
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
}

export const CONFIG_FILENAME = 'atem-crosspoint.config.json';

const DEFAULTS: AppConfig = {
  port: 8533,
  videohub: { enabled: true, basePort: 9990, host: '0.0.0.0' },
  devices: [],
  labels: {},
  salvos: [],
};

/** A three-switcher fleet with deliberately different shapes, for --mock. */
export const MOCK_CONFIG: AppConfig = {
  ...DEFAULTS,
  devices: [
    { id: 'stage', name: 'Stage', address: 'mock://stage' },
    { id: 'studio', name: 'Studio', address: 'mock://studio' },
    { id: 'flypack', name: 'Flypack', address: 'mock://flypack' },
  ],
  labels: { stage: { 'aux.0': 'FOH screens' } },
  salvos: [
    {
      id: 'salvo-house',
      name: 'House to wide',
      crosspoints: [
        { deviceId: 'stage', destination: 'aux.0', source: 1 },
        { deviceId: 'studio', destination: 'aux.0', source: 1 },
      ],
    },
  ],
};

export function configPath(): string {
  return process.env.ATEM_CROSSPOINT_CONFIG ?? path.resolve(process.cwd(), CONFIG_FILENAME);
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
