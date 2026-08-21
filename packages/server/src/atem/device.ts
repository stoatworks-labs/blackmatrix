import type { EventEmitter } from 'node:events';
import type { AtemState } from 'atem-connection';
import type { AtemRouterCommands } from '@av/atem-matrix';

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
}
