import { EventEmitter } from 'node:events';
import { isLegal, type Destination, type MatrixModel, type Source } from '@av/atem-matrix';
import { VideohubServer, type LockAction, type RouterBackend, type RouterUpdate } from '@av/videohub';
import type { AppConfig, DeviceConfig, Salvo, Tie } from './config.js';
import { log } from './log.js';
import { AtemRoutable, type RoutableDevice } from './atem/device.js';
import { MockDevice } from './atem/mock.js';
import { RealDevice } from './atem/realDevice.js';
import { ReplayDevice } from './atem/replayDevice.js';
import { VideohubDevice } from './videohub/videohubDevice.js';

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
  runner: RoutableDevice;
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
  /** Re-entrancy guard for ties: a follower's move never fires another tie. */
  private applyingTie = false;

  constructor(config: AppConfig, mock: boolean) {
    super();
    this.config = config;
    this.mock = mock;
  }

  async start(): Promise<void> {
    for (const deviceConfig of this.config.devices) {
      await this.addEntry(deviceConfig);
    }
  }

  /**
   * Bring one device up: connect it, and stand up its Videohub emulation.
   *
   * Used both at startup and when a device is added from the UI, which is why
   * nothing here depends on a device's position in the list — a port derived
   * from an index would move under every other device the moment one was
   * removed, and a panel's buttons would quietly start meaning something else.
   */
  private async addEntry(deviceConfig: DeviceConfig): Promise<void> {
    const runner: RoutableDevice = buildRunner(deviceConfig, this.entries.size, this.mock);

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

    // A real Videohub already speaks this protocol; putting an emulation in
    // front of one is only useful if asked for by name.
    const emulate =
      this.config.videohub.enabled &&
      (deviceConfig.type !== 'videohub' || deviceConfig.videohubPort !== undefined);
    if (emulate) {
      const port = deviceConfig.videohubPort ?? this.nextFreeVideohubPort();
      const server = new VideohubServer({
        backend: entry.backend,
        port,
        host: this.config.videohub.host,
        log: (message) => log.info(`${deviceConfig.id}: ${message}`),
      });
      try {
        await server.start();
        entry.videohub = server;
        // Written back so it survives a restart and a reordering. A panel is
        // configured against a port number; that number is now a fact about
        // this device, not about where it happens to sit in a list.
        deviceConfig.videohubPort = server.port;
      } catch (error) {
        log.error(`${deviceConfig.id}: videohub port ${port} unavailable — ${String(error)}`);
      }
    }
  }

  private nextFreeVideohubPort(): number {
    const taken = new Set<number>();
    for (const device of this.config.devices) if (device.videohubPort) taken.add(device.videohubPort);
    for (const entry of this.entries.values()) if (entry.videohub) taken.add(entry.videohub.port);
    let port = this.config.videohub.basePort;
    while (taken.has(port)) port++;
    return port;
  }

  /** Add a device at runtime. The config file is updated, and it connects now. */
  async addDevice(deviceConfig: DeviceConfig): Promise<RouteResult> {
    const problem = validateDevice(deviceConfig, this.config.devices);
    if (problem) return { ok: false, reason: problem };

    this.config.devices.push(deviceConfig);
    await this.addEntry(deviceConfig);
    this.emit('change');
    this.emit('configChanged');
    log.info(`added device ${deviceConfig.id} (${deviceConfig.type ?? 'atem'}) at ${deviceConfig.address}`);
    return { ok: true };
  }

  /**
   * Change a device. Everything except its id, which is the key that salvos,
   * ties and label overrides are all written against — renaming it would leave
   * those pointing at nothing, so the id is fixed once made.
   */
  async updateDevice(id: string, patch: Partial<DeviceConfig>): Promise<RouteResult> {
    const entry = this.entries.get(id);
    if (!entry) return { ok: false, reason: `no such device: ${id}` };
    if (patch.id && patch.id !== id) {
      return { ok: false, reason: 'a device id cannot change — salvos, ties and labels are keyed on it' };
    }

    const merged: DeviceConfig = { ...entry.config, ...patch, id };
    const others = this.config.devices.filter((device) => device.id !== id);
    const problem = validateDevice(merged, others);
    if (problem) return { ok: false, reason: problem };

    await this.removeEntry(id);
    const at = this.config.devices.findIndex((device) => device.id === id);
    if (at >= 0) this.config.devices[at] = merged;
    else this.config.devices.push(merged);
    await this.addEntry(merged);

    this.emit('change');
    this.emit('configChanged');
    return { ok: true };
  }

  /** Take a device down and out of the config. Reports what it leaves dangling. */
  async removeDevice(id: string): Promise<{ ok: boolean; reason?: string; orphaned?: string[] }> {
    if (!this.entries.has(id)) return { ok: false, reason: `no such device: ${id}` };

    await this.removeEntry(id);
    this.config.devices = this.config.devices.filter((device) => device.id !== id);
    delete this.config.labels[id];

    // Salvos and ties are not silently rewritten: an operator who removes a
    // switcher for an hour should get their salvos back when it returns.
    const orphaned: string[] = [];
    for (const salvo of this.config.salvos) {
      if (salvo.crosspoints.some((crosspoint) => crosspoint.deviceId === id)) orphaned.push(`salvo "${salvo.name}"`);
    }
    for (const tie of this.config.ties) {
      if (tie.leader.startsWith(`${id}:`) || tie.follower.startsWith(`${id}:`)) orphaned.push(`tie "${tie.name}"`);
    }

    this.emit('change');
    this.emit('configChanged');
    log.info(`removed device ${id}`);
    return { ok: true, orphaned };
  }

  /** Drop and rebuild a device's connection, without touching the config. */
  async reconnectDevice(id: string): Promise<RouteResult> {
    const entry = this.entries.get(id);
    if (!entry) return { ok: false, reason: `no such device: ${id}` };
    const deviceConfig = entry.config;
    await this.removeEntry(id);
    await this.addEntry(deviceConfig);
    this.emit('change');
    return { ok: true };
  }

  private async removeEntry(id: string): Promise<void> {
    const entry = this.entries.get(id);
    if (!entry) return;
    await entry.videohub?.stop();
    await entry.runner.disconnect();
    entry.runner.removeAllListeners();
    entry.listeners.clear();
    this.entries.delete(id);
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
    const built = entry.runner.buildMatrix();
    if (!built) {
      if (entry.matrix) {
        entry.matrix = null;
        entry.shape = '';
        this.emit('change');
      }
      return;
    }

    const previous = entry.matrix;
    const matrix = built;
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
      // Ties fire on the change, not on the request, so a route made from a
      // panel or from the switcher's own front panel drags its follower too.
      for (const index of movedOutputs) {
        const destination = matrix.destinations[index];
        if (destination) {
          void this.applyTies(entry.config.id, destination.id, matrix.routes[destination.id] ?? -1);
        }
      }
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
        locks: this.locksOf(entry),
      })),
      salvos: this.config.salvos,
    };
  }

  getEntry(deviceId: string): DeviceEntry | undefined {
    return this.entries.get(deviceId);
  }

  /**
   * Locks come from the device when the device has them — a Videohub's locks
   * are part of its protocol and shared with every other client on it, so ours
   * would be a second, disagreeing opinion. An ATEM has no such concept, so the
   * fleet holds those itself.
   */
  private locksOf(entry: DeviceEntry): Record<string, string | null> {
    return entry.runner.locks ? entry.runner.locks() : Object.fromEntries(entry.locks);
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

    const owner = this.locksOf(entry)[destinationId] ?? null;
    if (owner !== null && owner !== client && owner !== 'this app') {
      return { ok: false, reason: `${destination.label} is locked by ${owner}` };
    }

    const source = entry.matrix.sources.find((s) => s.id === sourceId);
    if (!source) return { ok: false, reason: `no such source: ${sourceId}` };
    if (!isLegal(source, destination)) {
      return { ok: false, reason: `${source.label} is not available on ${destination.label}` };
    }

    try {
      await entry.runner.route(destination, sourceId);
      return { ok: true };
    } catch (error) {
      return { ok: false, reason: String(error) };
    }
  }

  /**
   * Drive whatever follows this destination.
   *
   * One level only: a follower's own move does not fire a further tie. Chained
   * ties would be a loop waiting to happen, and nothing in a real rig needs
   * one — the depth guard is the feature, not a limitation to be lifted.
   */
  private async applyTies(deviceId: string, destinationId: string, source: number): Promise<void> {
    if (this.applyingTie || source < 0) return;
    const leader = `${deviceId}:${destinationId}`;
    const ties = this.config.ties.filter((tie) => tie.leader === leader);
    if (ties.length === 0) return;

    this.applyingTie = true;
    try {
      for (const tie of ties) {
        const target = tie.sourceMap[String(source)];
        if (target === undefined) {
          log.warn(`tie "${tie.name}": leader took source ${source}, which is not in its source map`);
          continue;
        }
        const follower = splitRef(tie.follower);
        if (!follower) {
          log.warn(`tie "${tie.name}": follower "${tie.follower}" is not deviceId:destinationId`);
          continue;
        }
        const result = await this.route(follower.deviceId, follower.id, target, 'tie');
        if (!result.ok) log.warn(`tie "${tie.name}": ${result.reason}`);
        else log.info(`tie "${tie.name}": ${tie.follower} followed to source ${target}`);
      }
    } finally {
      this.applyingTie = false;
    }
  }

  lock(deviceId: string, destinationId: string, action: LockAction, client: string): RouteResult {
    const entry = this.entries.get(deviceId);
    if (!entry) return { ok: false, reason: `no such device: ${deviceId}` };

    // A device that owns its locks does the work; the answer comes back as a
    // status update like any other change.
    if (entry.runner.setLock) {
      const destination = entry.matrix?.destinations.find((d) => d.id === destinationId);
      if (!destination) return { ok: false, reason: `no such destination: ${destinationId}` };
      void entry.runner.setLock(destination, action);
      return { ok: true };
    }

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

  /** Renaming a source renames the input on the device itself. */
  async setSourceLabel(deviceId: string, sourceId: number, label: string): Promise<RouteResult> {
    const entry = this.entries.get(deviceId);
    if (!entry) return { ok: false, reason: `no such device: ${deviceId}` };
    try {
      await entry.runner.setSourceLabel(sourceId, label);
      return { ok: true };
    } catch (error) {
      return { ok: false, reason: String(error) };
    }
  }

  get ties(): Tie[] {
    return this.config.ties;
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

/** Builds the right kind of device for a config entry. */
function buildRunner(config: DeviceConfig, index: number, mock: boolean): RoutableDevice {
  if (config.type === 'videohub') {
    if (mock) log.warn(`${config.id}: --mock has no simulated Videohub; connecting to the real one`);
    return new VideohubDevice(config);
  }
  // Three kinds of ATEM, one interface: synthetic, replayed from a capture, or
  // the real thing on the network.
  if (mock) return new AtemRoutable(new MockDevice(config, index));
  if (config.capture) return new AtemRoutable(ReplayDevice.fromFile(config, config.capture));
  return new AtemRoutable(new RealDevice(config));
}

/** Everything that would make a device unusable, checked before it is accepted. */
function validateDevice(device: DeviceConfig, others: DeviceConfig[]): string | null {
  if (!device.id || !/^[a-zA-Z0-9_-]+$/.test(device.id)) {
    return 'id must be letters, numbers, dash or underscore';
  }
  if (others.some((other) => other.id === device.id)) return `a device with id "${device.id}" already exists`;
  if (!device.name?.trim()) return 'name is required';
  if (!device.capture && !device.address?.trim()) return 'address is required';
  if (device.videohubPort !== undefined) {
    if (!Number.isInteger(device.videohubPort) || device.videohubPort < 1 || device.videohubPort > 65535) {
      return 'videohub port must be a port number';
    }
    if (others.some((other) => other.videohubPort === device.videohubPort)) {
      return `videohub port ${device.videohubPort} is already used by another device`;
    }
  }
  return null;
}

function splitRef(value: string): { deviceId: string; id: string } | null {
  const at = value.indexOf(':');
  if (at <= 0) return null;
  return { deviceId: value.slice(0, at), id: value.slice(at + 1) };
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
    const locks = this.entry.runner.locks?.() ?? Object.fromEntries(this.entry.locks);
    return this.destinations.map((destination) => locks[destination.id] ?? null);
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
