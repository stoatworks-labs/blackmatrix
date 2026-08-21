import { EventEmitter } from 'node:events';
import net from 'node:net';
import { BlockParser, formatBlock, parseIndexedLine, type Block } from './protocol.js';
import type { LockAction } from './types.js';

/** Everything a Videohub tells a client about itself. */
export interface VideohubState {
  present: boolean;
  protocolVersion: string;
  modelName: string;
  friendlyName: string;
  uniqueId: string;
  inputLabels: string[];
  outputLabels: string[];
  monitoringLabels: string[];
  /** Input index per output, -1 when the router has not said. */
  routing: number[];
  monitoringRouting: number[];
  /** As the protocol renders it for us: O (ours), L (someone else's), U. */
  locks: string[];
  monitoringLocks: string[];
}

export type ClientStatus = 'connecting' | 'connected' | 'disconnected';

export interface VideohubClientOptions {
  host: string;
  port?: number;
  log?: (message: string) => void;
  reconnectMs?: number;
}

function emptyState(): VideohubState {
  return {
    present: false,
    protocolVersion: '',
    modelName: '',
    friendlyName: '',
    uniqueId: '',
    inputLabels: [],
    outputLabels: [],
    monitoringLabels: [],
    routing: [],
    monitoringRouting: [],
    locks: [],
    monitoringLocks: [],
  };
}

/**
 * The other half of this package: a client for a real Blackmagic Videohub.
 *
 * The protocol's own rule shapes this class — **a client must never assume its
 * request happened.** Sending a route returns ACK on receipt, not on success;
 * the truth arrives afterwards as a status update, which may differ, may be
 * batched with someone else's changes, or may not come at all. So nothing here
 * writes to its own state: `route()` sends and returns, and every field of
 * `state` is only ever set from what the router said.
 */
export class VideohubClient extends EventEmitter {
  readonly host: string;
  readonly port: number;
  private socket: net.Socket | null = null;
  private parser = new BlockParser();
  private current: VideohubState = emptyState();
  private connectionStatus: ClientStatus = 'disconnected';
  private timer: NodeJS.Timeout | null = null;
  private closing = false;
  private log: (message: string) => void;
  private reconnectMs: number;

  constructor(options: VideohubClientOptions) {
    super();
    this.host = options.host;
    this.port = options.port ?? 9990;
    this.log = options.log ?? (() => {});
    this.reconnectMs = options.reconnectMs ?? 3000;
  }

  get status(): ClientStatus {
    return this.connectionStatus;
  }

  /** Null until the router has sent enough to be worth showing. */
  get state(): VideohubState | null {
    return this.connectionStatus === 'connected' && this.current.present ? this.current : null;
  }

  connect(): void {
    this.closing = false;
    this.open();
  }

  close(): void {
    this.closing = true;
    if (this.timer) clearTimeout(this.timer);
    this.timer = null;
    this.socket?.destroy();
    this.socket = null;
    this.setStatus('disconnected');
  }

  private open(): void {
    this.setStatus('connecting');
    this.parser = new BlockParser();
    this.current = emptyState();

    const socket = net.connect({ host: this.host, port: this.port });
    this.socket = socket;
    socket.setEncoding('utf8');
    socket.setNoDelay(true);
    // A Videohub sends nothing while idle, so a dead link looks identical to a
    // quiet one until TCP notices. Keepalive is what makes it notice.
    socket.setKeepAlive(true, 10000);

    socket.on('connect', () => {
      this.setStatus('connected');
      this.log(`videohub ${this.host}:${this.port} connected`);
    });

    socket.on('data', (chunk: string | Buffer) => {
      const text = typeof chunk === 'string' ? chunk : chunk.toString('utf8');
      for (const block of this.parser.push(text)) this.handle(block);
    });

    const drop = (why: string) => {
      if (this.socket !== socket) return;
      this.socket = null;
      this.setStatus('disconnected');
      this.log(`videohub ${this.host}:${this.port} ${why}`);
      this.retry();
    };
    socket.on('close', () => drop('closed'));
    socket.on('error', (error) => drop(`error: ${error.message}`));
  }

  private retry(): void {
    if (this.closing || this.timer) return;
    this.timer = setTimeout(() => {
      this.timer = null;
      this.open();
    }, this.reconnectMs);
  }

  private setStatus(status: ClientStatus): void {
    if (this.connectionStatus === status) return;
    this.connectionStatus = status;
    this.emit('status', status);
  }

  private handle(block: Block): void {
    switch (block.header) {
      case 'PROTOCOL PREAMBLE':
        this.current.protocolVersion = field(block, 'Version') ?? '';
        return;
      case 'VIDEOHUB DEVICE': {
        const present = (field(block, 'Device present') ?? 'false').trim();
        this.current.present = present === 'true';
        this.current.modelName = field(block, 'Model name') ?? '';
        this.current.friendlyName = field(block, 'Friendly name') ?? '';
        this.current.uniqueId = field(block, 'Unique ID') ?? '';
        if (!this.current.present) {
          // "false" or "needs_update": the router will send nothing further
          // until that is fixed, so say so rather than showing a stale matrix.
          this.log(`videohub ${this.host}: device present: ${present}`);
        }
        this.changed();
        return;
      }
      case 'INPUT LABELS':
        applyLabels(this.current.inputLabels, block);
        this.changed();
        return;
      case 'OUTPUT LABELS':
        applyLabels(this.current.outputLabels, block);
        this.changed();
        return;
      case 'MONITORING OUTPUT LABELS':
        applyLabels(this.current.monitoringLabels, block);
        this.changed();
        return;
      case 'VIDEO OUTPUT ROUTING':
        applyNumbers(this.current.routing, block);
        this.changed();
        return;
      case 'VIDEO MONITORING OUTPUT ROUTING':
        applyNumbers(this.current.monitoringRouting, block);
        this.changed();
        return;
      case 'VIDEO OUTPUT LOCKS':
        applyLabels(this.current.locks, block);
        this.changed();
        return;
      case 'MONITORING OUTPUT LOCKS':
        applyLabels(this.current.monitoringLocks, block);
        this.changed();
        return;
      case 'ACK':
        return;
      case 'NAK':
        // The router understood nothing of what we sent. Worth a line: it means
        // a port number out of range, or a block this router does not have.
        this.log(`videohub ${this.host} answered NAK`);
        return;
      default:
        // Unknown blocks are ignored up to their blank line, as the spec asks.
        return;
    }
  }

  private changed(): void {
    this.emit('state', this.current);
  }

  private send(header: string, lines: string[]): void {
    if (!this.socket || this.connectionStatus !== 'connected') {
      this.log(`videohub ${this.host}: dropped ${header} — not connected`);
      return;
    }
    this.socket.write(formatBlock(header, lines));
  }

  route(output: number, input: number, monitoring = false): void {
    this.send(monitoring ? 'VIDEO MONITORING OUTPUT ROUTING' : 'VIDEO OUTPUT ROUTING', [`${output} ${input}`]);
  }

  setLock(output: number, action: LockAction, monitoring = false): void {
    const letter = action === 'lock' ? 'O' : action === 'force' ? 'F' : 'U';
    this.send(monitoring ? 'MONITORING OUTPUT LOCKS' : 'VIDEO OUTPUT LOCKS', [`${output} ${letter}`]);
  }

  setInputLabel(input: number, label: string): void {
    this.send('INPUT LABELS', [`${input} ${label}`]);
  }

  setOutputLabel(output: number, label: string): void {
    this.send('OUTPUT LABELS', [`${output} ${label}`]);
  }

  ping(): void {
    this.send('PING', []);
  }
}

function field(block: Block, name: string): string | undefined {
  const prefix = `${name}:`;
  const line = block.lines.find((candidate) => candidate.startsWith(prefix));
  return line?.slice(prefix.length).trim();
}

/**
 * Status updates carry only what changed, so every apply is a sparse write into
 * the array we already have — never a replacement.
 */
function applyLabels(target: string[], block: Block): void {
  for (const line of block.lines) {
    const parsed = parseIndexedLine(line);
    if (parsed) target[parsed.index] = parsed.value;
  }
}

function applyNumbers(target: number[], block: Block): void {
  for (const line of block.lines) {
    const parsed = parseIndexedLine(line);
    if (!parsed) continue;
    const value = Number(parsed.value.trim());
    if (Number.isInteger(value)) target[parsed.index] = value;
  }
}
