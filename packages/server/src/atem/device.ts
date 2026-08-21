import { EventEmitter } from 'node:events';
import type { AtemState } from 'atem-connection';
import { applyRoute, buildMatrix, type AtemRouterCommands, type Destination, type MatrixModel } from '@av/atem-matrix';
import type { LockAction } from '@av/videohub';

export type ConnectionState = 'connecting' | 'connected' | 'disconnected';

/**
 * One switcher, real or simulated. Emits `state` whenever its AtemState
 * changes and `connection` when it comes and goes.
 */
export interface DeviceRunner extends EventEmitter {
  readonly id: string;
  readonly name: string;
  readonly address: string;
  readonly connection: ConnectionState;
  readonly state: AtemState | null;
  /** The switcher's own product string once known, else the configured name. */
  readonly model: string;
  readonly commands: AtemRouterCommands | null;

  connect(): Promise<void>;
  disconnect(): Promise<void>;
  /** Rename a switcher input — a Videohub client renaming an input lands here. */
  setInputLabel(inputId: number, longName: string, shortName: string): Promise<void>;
  /** Assign an input to one of the plugs the switcher says it accepts. */
  setInputPort(inputId: number, externalPortType: number): Promise<void>;
}

/**
 * A device the fleet can route, whatever it is underneath.
 *
 * The fleet used to be ATEM-shaped all the way down — it read an AtemState and
 * called atem-connection methods. A Videohub has neither, but it is a router in
 * every sense the grid cares about, so the ATEM knowledge moved down here: a
 * device builds its own matrix and applies its own crosspoints, and everything
 * above works in destinations and sources.
 */
export interface RoutableDevice extends EventEmitter {
  readonly id: string;
  readonly name: string;
  readonly address: string;
  readonly model: string;
  readonly connection: ConnectionState;

  /** Null while disconnected, or before the device has said enough. */
  buildMatrix(): MatrixModel | null;
  route(destination: Destination, source: number): Promise<void>;
  /** Rename a source on the device itself, where the device allows it. */
  setSourceLabel(sourceId: number, label: string): Promise<void>;

  /**
   * Assign an input to a physical plug or the network input, on devices that
   * have such a thing. Absent on a Videohub, whose inputs are its inputs.
   */
  setInputPort?(inputId: number, externalPortType: number): Promise<void>;

  /**
   * Locks, when the device owns them. A Videohub does — locks are part of its
   * protocol and shared with every other client on it. An ATEM does not, so the
   * fleet holds those itself.
   */
  locks?(): Record<string, string | null>;
  setLock?(destination: Destination, action: LockAction): Promise<void>;

  connect(): Promise<void>;
  disconnect(): Promise<void>;
}

/** Presents an ATEM — real, mock or replayed — as a routable device. */
export class AtemRoutable extends EventEmitter implements RoutableDevice {
  constructor(private runner: DeviceRunner) {
    super();
    runner.on('state', () => this.emit('state'));
    runner.on('connection', (status) => this.emit('connection', status));
  }

  get id(): string {
    return this.runner.id;
  }
  get name(): string {
    return this.runner.name;
  }
  get address(): string {
    return this.runner.address;
  }
  get model(): string {
    return this.runner.model;
  }
  get connection(): ConnectionState {
    return this.runner.connection;
  }

  buildMatrix(): MatrixModel | null {
    const state = this.runner.state;
    return state ? buildMatrix(state) : null;
  }

  async route(destination: Destination, source: number): Promise<void> {
    const commands = this.runner.commands;
    if (!commands) throw new Error(`${this.id} is not connected`);
    await applyRoute(commands, destination, source);
  }

  async setSourceLabel(sourceId: number, label: string): Promise<void> {
    // The ATEM keeps a long and a short name; the short one is what its own
    // multiviewer draws, so it gets the first few characters rather than being
    // left stale.
    await this.runner.setInputLabel(sourceId, label, label.slice(0, 4));
  }

  async setInputPort(inputId: number, externalPortType: number): Promise<void> {
    await this.runner.setInputPort(inputId, externalPortType);
  }

  connect(): Promise<void> {
    return this.runner.connect();
  }

  disconnect(): Promise<void> {
    return this.runner.disconnect();
  }
}
