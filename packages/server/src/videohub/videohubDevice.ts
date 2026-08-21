import { EventEmitter } from 'node:events';
import { VideohubClient, type LockAction, type VideohubState } from '@av/videohub';
import type { Destination, MatrixModel, Section, Source } from '@av/atem-matrix';
import type { DeviceConfig } from '../config.js';
import { log } from '../log.js';
import type { ConnectionState, RoutableDevice } from '../atem/device.js';

const SECTIONS: Section[] = [
  { id: 'outputs', label: 'Outputs', hint: 'Router video outputs' },
  { id: 'monitoring', label: 'Monitoring outputs', hint: 'The router’s monitoring outputs' },
];

/**
 * A real Blackmagic Videohub, as a device in the same fleet as the switchers.
 *
 * Nothing here interprets anything: a Videohub is already a router, every input
 * is legal on every output, and its labels, routes and locks are its own. The
 * job is only to shape what it reports into the same matrix the grid draws for
 * an ATEM, so one screen covers both and a salvo can span them.
 */
export class VideohubDevice extends EventEmitter implements RoutableDevice {
  readonly id: string;
  readonly name: string;
  readonly address: string;
  private client: VideohubClient;
  private status: ConnectionState = 'disconnected';

  constructor(config: DeviceConfig) {
    super();
    this.id = config.id;
    this.name = config.name;
    this.address = config.address;

    const [host, port] = splitHostPort(config.address);
    this.client = new VideohubClient({
      host,
      port,
      log: (message) => log.info(`${this.id}: ${message}`),
    });

    this.client.on('status', (status: string) => {
      this.status = status === 'connected' ? 'connected' : status === 'connecting' ? 'connecting' : 'disconnected';
      this.emit('connection', this.status);
      this.emit('state');
    });
    this.client.on('state', () => this.emit('state'));
  }

  get connection(): ConnectionState {
    return this.status;
  }

  get model(): string {
    const state = this.client.state;
    if (!state) return 'Videohub';
    return state.friendlyName ? `${state.modelName} (${state.friendlyName})` : state.modelName || 'Videohub';
  }

  async connect(): Promise<void> {
    this.client.connect();
  }

  async disconnect(): Promise<void> {
    this.client.close();
  }

  buildMatrix(): MatrixModel | null {
    const state = this.client.state;
    if (!state) return null;

    const sources: Source[] = state.inputLabels.map((label, index) => ({
      id: index,
      label: label || `Input ${index + 1}`,
      short: shorten(label || `In ${index + 1}`),
      kind: 'router',
      // A Videohub crosspoint has no availability rules; `accepts: 'any'` on the
      // destinations is what actually decides, and these are here so the shape
      // matches what the rest of the app expects.
      availability: 0xff,
      meAvailability: 0xff,
    }));

    const destinations: Destination[] = [];
    state.outputLabels.forEach((label, index) => {
      destinations.push({
        id: `out.${index}`,
        kind: 'routerOutput',
        section: 'outputs',
        label: label || `Output ${index + 1}`,
        short: shorten(label || `Out ${index + 1}`),
        address: { unit: index },
        accepts: 'any',
      });
    });
    state.monitoringLabels.forEach((label, index) => {
      destinations.push({
        id: `mon.${index}`,
        kind: 'routerMonitoring',
        section: 'monitoring',
        label: label || `Monitor ${index + 1}`,
        short: shorten(label || `Mon ${index + 1}`),
        address: { unit: index },
        accepts: 'any',
      });
    });

    const routes: Record<string, number> = {};
    destinations.forEach((destination) => {
      const table = destination.kind === 'routerMonitoring' ? state.monitoringRouting : state.routing;
      routes[destination.id] = table[destination.address.unit] ?? -1;
    });

    return {
      sections: SECTIONS.filter((section) =>
        destinations.some((destination) => destination.section === section.id),
      ),
      sources,
      destinations,
      routes,
    };
  }

  async route(destination: Destination, source: number): Promise<void> {
    if (this.status !== 'connected') throw new Error(`${this.id} is not connected`);
    // Sent and not awaited on purpose: the protocol's ACK means "received", and
    // the truth arrives as a status update. Waiting for one would be waiting for
    // the wrong thing.
    this.client.route(destination.address.unit, source, destination.kind === 'routerMonitoring');
  }

  async setSourceLabel(sourceId: number, label: string): Promise<void> {
    this.client.setInputLabel(sourceId, label);
  }

  /**
   * The router's own locks, not ours. "O" means this app holds it — every
   * connection from this process shares one, since the Videohub locks by IP.
   */
  locks(): Record<string, string | null> {
    const state = this.client.state;
    const result: Record<string, string | null> = {};
    if (!state) return result;
    state.outputLabels.forEach((_label, index) => {
      result[`out.${index}`] = describeLock(state.locks[index]);
    });
    state.monitoringLabels.forEach((_label, index) => {
      result[`mon.${index}`] = describeLock(state.monitoringLocks[index]);
    });
    return result;
  }

  async setLock(destination: Destination, action: LockAction): Promise<void> {
    this.client.setLock(destination.address.unit, action, destination.kind === 'routerMonitoring');
  }

  /** The raw protocol state, for diagnostics. */
  get raw(): VideohubState | null {
    return this.client.state;
  }
}

function describeLock(letter: string | undefined): string | null {
  if (letter === 'O') return 'this app';
  if (letter === 'L') return 'another client';
  return null;
}

function splitHostPort(address: string): [string, number] {
  const match = /^(.*?)(?::(\d+))?$/.exec(address.trim());
  return [match?.[1] || address, match?.[2] ? Number(match[2]) : 9990];
}

function shorten(label: string): string {
  return label.length <= 8 ? label : label.slice(0, 8);
}
