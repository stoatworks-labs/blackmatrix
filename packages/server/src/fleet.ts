import { EventEmitter } from 'node:events';
import {
  applyRoute,
  buildMatrix,
  isLegal,
  type Destination,
  type MatrixModel,
  type Source,
} from '@av/atem-matrix';
import { VideohubServer, type LockAction, type RouterBackend, type RouterUpdate } from '@av/videohub';
import type { AppConfig, DeviceConfig, Salvo } from './config.js';
import { log } from './log.js';
import type { DeviceRunner } from './atem/device.js';
import { MockDevice } from './atem/mock.js';
import { RealDevice } from './atem/realDevice.js';

export interface DeviceView {
  id: string;
  name: string;
  address: string;
  model: string;
  connection: string;
  videohubPort: number | null;
  videohubClients: number;
  matrix: MatrixModel | null;
  /** destination id -> lock owner, or null when unlocked. */
  locks: Record<string, string | null>;
}

export interface FleetSnapshot {
  devices: DeviceView[];
  salvos: Salvo[];
}

export interface RouteResult {
  ok: boolean;
  reason?: string;
}

interface DeviceEntry {
  config: DeviceConfig;
  runner: DeviceRunner;
  matrix: MatrixModel | null;
  locks: Map<string, string | null>;
  videohub: VideohubServer | null;
  backend: AtemRouterBackend;
  /** Identifies the destination/source shape, to spot a switcher changing under us. */
  shape: string;
  listeners: Set<(update: RouterUpdate) => void>;
}

/**
 * The fleet: every configured switcher, its crosspoint matrix, its locks, and
 * its Videohub protocol server. One authority, so a route made from a panel and
 * a route made from the browser are the same operation.
 */
export class Fleet extends EventEmitter {
  private entries = new Map<string, DeviceEntry>();
  private config: AppConfig;
  private mock: boolean;

  constructor(config: AppConfig, mock: boolean) {
    super();
    this.config = config;
    this.mock = mock;
  }

  async start(): Promise<void> {
    for (const [index, deviceConfig] of this.config.devices.entries()) {
      const runner: DeviceRunner = this.mock
        ? new MockDevice(deviceConfig, index)
        : new RealDevice(deviceConfig);

      const entry: DeviceEntry = {
        config: deviceConfig,
        runner,
        matrix: null,
        locks: new Map(),
        videohub: null,
        backend: null as unknown as AtemRouterBackend,
        shape: '',
        listeners: new Set(),
      };
      entry.backend = new AtemRouterBackend(this, entry);
      this.entries.set(deviceConfig.id, entry);

      runner.on('state', () => this.refresh(entry));
      runner.on('connection', () => {
        this.refresh(entry);
        this.emit('change');
      });

      try {
        await runner.connect();
      } catch (error) {
        log.error(`${deviceConfig.id}: connect failed — ${String(error)}`);
      }

      if (this.config.videohub.enabled) {
        const port = deviceConfig.videohubPort ?? this.config.videohub.basePort + index;
        const server = new VideohubServer({
          backend: entry.backend,
          port,
          host: this.config.videohub.host,
          log: (message) => log.info(`${deviceConfig.id}: ${message}`),
        });
        try {
          await server.start();
          entry.videohub = server;
        } catch (error) {
          log.error(`${deviceConfig.id}: videohub port ${port} unavailable — ${String(error)}`);
        }
      }
    }
  }

  async stop(): Promise<void> {
    for (const entry of this.entries.values()) {
      await entry.videohub?.stop();
      await entry.runner.disconnect();
    }
    this.entries.clear();
  }

  /** Rebuild a device's matrix and tell everyone only about what moved. */
  private refresh(entry: DeviceEntry): void {
    const state = entry.runner.state;
    if (!state) {
      if (entry.matrix) {
        entry.matrix = null;
        entry.shape = '';
        this.emit('change');
      }
      return;
    }

    const previous = entry.matrix;
    const matrix = buildMatrix(state);
    applyLabelOverrides(matrix, this.config.labels[entry.config.id]);
    entry.matrix = matrix;

    for (const destination of matrix.destinations) {
      if (!entry.locks.has(destination.id)) entry.locks.set(destination.id, null);
    }

    const shape = shapeOf(matrix);
    if (shape !== entry.shape) {
      entry.shape = shape;
      this.notify(entry, { type: 'device' });
      this.emit('change');
      return;
    }
    if (!previous) return;

    const movedOutputs: number[] = [];
    matrix.destinations.forEach((destination, index) => {
      if (previous.routes[destination.id] !== matrix.routes[destination.id]) movedOutputs.push(index);
    });
    if (movedOutputs.length > 0) {
      this.notify(entry, { type: 'routing', outputs: movedOutputs });
      this.emit('change');
    }

    const renamedInputs: number[] = [];
    matrix.sources.forEach((source, index) => {
      if (previous.sources[index]?.label !== source.label) renamedInputs.push(index);
    });
    if (renamedInputs.length > 0) {
      this.notify(entry, { type: 'inputLabels', inputs: renamedInputs });
      this.emit('change');
    }
  }

  private notify(entry: DeviceEntry, update: RouterUpdate): void {
    for (const listener of entry.listeners) listener(update);
  }

  snapshot(): FleetSnapshot {
    return {
      devices: [...this.entries.values()].map((entry) => ({
        id: entry.config.id,
        name: entry.config.name,
        address: entry.config.address,
        model: entry.runner.model,
        connection: entry.runner.connection,
        videohubPort: entry.videohub?.port ?? null,
        videohubClients: entry.videohub?.clientCount ?? 0,
        matrix: entry.matrix,
        locks: Object.fromEntries(entry.locks),
      })),
      salvos: this.config.salvos,
    };
  }

  getEntry(deviceId: string): DeviceEntry | undefined {
    return this.entries.get(deviceId);
  }

  /**
   * Route one crosspoint. Refuses when the destination is locked by somebody
   * else or when the switcher would not accept the source there.
   */
  async route(
    deviceId: string,
    destinationId: string,
    sourceId: number,
    client: string,
  ): Promise<RouteResult> {
    const entry = this.entries.get(deviceId);
    if (!entry) return { ok: false, reason: `no such device: ${deviceId}` };
    if (!entry.matrix) return { ok: false, reason: `${deviceId} is not connected` };

    const destination = entry.matrix.destinations.find((d) => d.id === destinationId);
    if (!destination) return { ok: false, reason: `no such destination: ${destinationId}` };

    const owner = entry.locks.get(destinationId) ?? null;
    if (owner !== null && owner !== client) {
      return { ok: false, reason: `${destination.label} is locked by ${owner}` };
    }

    const source = entry.matrix.sources.find((s) => s.id === sourceId);
    if (!source) return { ok: false, reason: `no such source: ${sourceId}` };
    if (!isLegal(source, destination)) {
      return { ok: false, reason: `${source.label} is not available on ${destination.label}` };
    }

    const commands = entry.runner.commands;
    if (!commands) return { ok: false, reason: `${deviceId} is not connected` };

    try {
      await applyRoute(commands, destination, sourceId);
      return { ok: true };
    } catch (error) {
      return { ok: false, reason: String(error) };
    }
  }

  lock(deviceId: string, destinationId: string, action: LockAction, client: string): RouteResult {
    const entry = this.entries.get(deviceId);
    if (!entry) return { ok: false, reason: `no such device: ${deviceId}` };
    if (!entry.locks.has(destinationId)) return { ok: false, reason: `no such destination: ${destinationId}` };

    const owner = entry.locks.get(destinationId) ?? null;
    switch (action) {
      case 'lock':
        if (owner !== null && owner !== client) return { ok: false, reason: `already locked by ${owner}` };
        entry.locks.set(destinationId, client);
        break;
      case 'unlock':
        if (owner !== null && owner !== client) return { ok: false, reason: `locked by ${owner}` };
        entry.locks.set(destinationId, null);
        break;
      case 'force':
        entry.locks.set(destinationId, null);
        break;
    }

    const index = entry.matrix?.destinations.findIndex((d) => d.id === destinationId) ?? -1;
    if (index >= 0) this.notify(entry, { type: 'locks', outputs: [index] });
    this.emit('change');
    return { ok: true };
  }

  /** An operator's own name for a destination. Stored here, not on the switcher. */
  setDestinationLabel(deviceId: string, destinationId: string, label: string): RouteResult {
    const entry = this.entries.get(deviceId);
    if (!entry) return { ok: false, reason: `no such device: ${deviceId}` };
    const labels = (this.config.labels[deviceId] ??= {});
    if (label.trim() === '') delete labels[destinationId];
    else labels[destinationId] = label;

    if (entry.matrix) {
      applyLabelOverrides(entry.matrix, labels);
      const index = entry.matrix.destinations.findIndex((d) => d.id === destinationId);
      if (index >= 0) this.notify(entry, { type: 'outputLabels', outputs: [index] });
    }
    this.emit('change');
    this.emit('configChanged');
    return { ok: true };
  }

  /** Renaming a source renames the input on the switcher itself. */
  async setSourceLabel(deviceId: string, sourceId: number, label: string): Promise<RouteResult> {
    const entry = this.entries.get(deviceId);
    if (!entry) return { ok: false, reason: `no such device: ${deviceId}` };
    try {
      await entry.runner.setInputLabel(sourceId, label, label.slice(0, 4));
      return { ok: true };
    } catch (error) {
      return { ok: false, reason: String(error) };
    }
  }

  get salvos(): Salvo[] {
    return this.config.salvos;
  }

  saveSalvo(salvo: Salvo): void {
    const index = this.config.salvos.findIndex((s) => s.id === salvo.id);
    if (index >= 0) this.config.salvos[index] = salvo;
    else this.config.salvos.push(salvo);
    this.emit('change');
    this.emit('configChanged');
  }

  deleteSalvo(id: string): void {
    this.config.salvos = this.config.salvos.filter((s) => s.id !== id);
    this.emit('change');
    this.emit('configChanged');
  }

  /** Fire a salvo. Every crosspoint is attempted; the failures come back named. */
  async takeSalvo(id: string, client: string): Promise<{ ok: boolean; failures: string[] }> {
    const salvo = this.config.salvos.find((s) => s.id === id);
    if (!salvo) return { ok: false, failures: [`no such salvo: ${id}`] };

    const failures: string[] = [];
    for (const crosspoint of salvo.crosspoints) {
      const result = await this.route(crosspoint.deviceId, crosspoint.destination, crosspoint.source, client);
      if (!result.ok) failures.push(`${crosspoint.deviceId}/${crosspoint.destination}: ${result.reason}`);
    }
    return { ok: failures.length === 0, failures };
  }
}

function shapeOf(matrix: MatrixModel): string {
  return JSON.stringify([
    matrix.destinations.map((d) => d.id),
    matrix.sources.map((s) => s.id),
  ]);
}

function applyLabelOverrides(matrix: MatrixModel, labels: Record<string, string> | undefined): void {
  if (!labels) return;
  for (const destination of matrix.destinations) {
    const override = labels[destination.id];
    if (override) destination.label = override;
  }
}

/**
 * Presents one switcher's matrix as a Videohub. Destination order is the output
 * numbering and source order is the input numbering, both fixed by the matrix
 * builder so a panel's buttons keep meaning the same thing.
 */
class AtemRouterBackend implements RouterBackend {
  constructor(
    private fleet: Fleet,
    private entry: DeviceEntry,
  ) {}

  private get destinations(): Destination[] {
    return this.entry.matrix?.destinations ?? [];
  }

  private get sources(): Source[] {
    return this.entry.matrix?.sources ?? [];
  }

  getInfo() {
    return {
      modelName: this.entry.runner.model,
      friendlyName: this.entry.config.name,
      uniqueId: this.entry.config.id,
      inputCount: this.sources.length,
      outputCount: this.destinations.length,
      monitoringOutputCount: 0,
      serialPortCount: 0,
      processingUnitCount: 0,
    };
  }

  getInputLabels(): string[] {
    return this.sources.map((source) => source.label);
  }

  getOutputLabels(): string[] {
    return this.destinations.map((destination) => destination.label);
  }

  getRouting(): number[] {
    const matrix = this.entry.matrix;
    if (!matrix) return [];
    return matrix.destinations.map((destination) => {
      const sourceId = matrix.routes[destination.id] ?? -1;
      const index = matrix.sources.findIndex((source) => source.id === sourceId);
      return index;
    });
  }

  getLocks(): Array<string | null> {
    return this.destinations.map((destination) => this.entry.locks.get(destination.id) ?? null);
  }

  async setRoute(output: number, input: number, client: string): Promise<boolean> {
    const destination = this.destinations[output];
    const source = this.sources[input];
    if (!destination || !source) return false;
    const result = await this.fleet.route(this.entry.config.id, destination.id, source.id, client);
    if (!result.ok) log.warn(`${this.entry.config.id}: videohub route refused — ${result.reason}`);
    return result.ok;
  }

  async setLock(output: number, action: LockAction, client: string): Promise<boolean> {
    const destination = this.destinations[output];
    if (!destination) return false;
    return this.fleet.lock(this.entry.config.id, destination.id, action, client).ok;
  }

  async setInputLabel(input: number, label: string): Promise<boolean> {
    const source = this.sources[input];
    if (!source) return false;
    const result = await this.fleet.setSourceLabel(this.entry.config.id, source.id, label);
    return result.ok;
  }

  async setOutputLabel(output: number, label: string): Promise<boolean> {
    const destination = this.destinations[output];
    if (!destination) return false;
    return this.fleet.setDestinationLabel(this.entry.config.id, destination.id, label).ok;
  }

  subscribe(listener: (update: RouterUpdate) => void): () => void {
    this.entry.listeners.add(listener);
    return () => this.entry.listeners.delete(listener);
  }
}
