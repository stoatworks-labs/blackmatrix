import { EventEmitter } from 'node:events';
import { Atem, type AtemState } from 'atem-connection';
import type { AtemRouterCommands } from '@av/atem-matrix';
import type { DeviceConfig } from '../config.js';
import { log } from '../log.js';
import type { ConnectionProblem, ConnectionState, DeviceRunner } from './device.js';
import { RefusalWatch } from './probe.js';

/** A live ATEM on the network, via atem-connection's UDP protocol client. */
export class RealDevice extends EventEmitter implements DeviceRunner {
  readonly id: string;
  readonly name: string;
  readonly address: string;
  private atem: Atem;
  private status: ConnectionState = 'disconnected';
  private watch: RefusalWatch;

  constructor(config: DeviceConfig) {
    super();
    this.id = config.id;
    this.name = config.name;
    this.address = config.address;
    this.atem = new Atem();
    this.watch = new RefusalWatch({
      address: this.address,
      onChange: (problem) => {
        if (problem) log.warn(`${this.id}: ${problem.message}`);
        this.emit('connection', this.status);
      },
    });

    this.atem.on('connected', () => {
      this.status = 'connected';
      log.info(`${this.id}: connected to ${this.address} (${this.model})`);
      this.watch.connected();
      this.emit('connection', this.status);
      this.emit('state');
    });
    this.atem.on('disconnected', () => {
      this.status = 'disconnected';
      log.warn(`${this.id}: disconnected from ${this.address}`);
      this.watch.notConnected();
      this.emit('connection', this.status);
    });
    this.atem.on('stateChanged', () => this.emit('state'));
    this.atem.on('error', (message) => log.error(`${this.id}: ${String(message)}`));
  }

  get connection(): ConnectionState {
    return this.status;
  }

  get problem(): ConnectionProblem | null {
    return this.status === 'connected' ? null : this.watch.problem;
  }

  get state(): AtemState | null {
    return this.atem.state ?? null;
  }

  get model(): string {
    return this.atem.state?.info.productIdentifier ?? this.name;
  }

  get commands(): AtemRouterCommands | null {
    return this.status === 'connected' ? this.atem : null;
  }

  get full(): Atem | null {
    return this.status === 'connected' ? this.atem : null;
  }

  async connect(): Promise<void> {
    this.status = 'connecting';
    this.watch.notConnected();
    this.emit('connection', this.status);
    await this.atem.connect(this.address);
  }

  async disconnect(): Promise<void> {
    this.watch.stop();
    await this.atem.disconnect();
    this.status = 'disconnected';
    this.emit('connection', this.status);
  }

  async setInputLabel(inputId: number, longName: string, shortName: string): Promise<void> {
    await this.atem.setInputSettings({ longName, shortName }, inputId);
  }

  async setInputPort(inputId: number, externalPortType: number): Promise<void> {
    await this.atem.setInputSettings({ externalPortType }, inputId);
  }
}
