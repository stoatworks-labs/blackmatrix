import net from 'node:net';
import {
  ACK,
  BlockParser,
  NAK,
  PROTOCOL_VERSION,
  formatBlock,
  indexedLines,
  parseIndexedLine,
  parseRouteLine,
  type Block,
} from './protocol.js';
import type { LockAction, RouterBackend, RouterUpdate } from './types.js';

export interface VideohubServerOptions {
  backend: RouterBackend;
  port?: number;
  host?: string;
  /** Called with human-readable progress; defaults to silence. */
  log?: (message: string) => void;
}

interface Client {
  socket: net.Socket;
  parser: BlockParser;
  /** Lock owner identity. The spec locks per IP address, not per connection. */
  id: string;
  /** Serialises the blocks from one client, since applying a route is async. */
  queue: Promise<void>;
}

const HEADER_DEVICE = 'VIDEOHUB DEVICE';
const HEADER_INPUT_LABELS = 'INPUT LABELS';
const HEADER_OUTPUT_LABELS = 'OUTPUT LABELS';
const HEADER_ROUTING = 'VIDEO OUTPUT ROUTING';
const HEADER_LOCKS = 'VIDEO OUTPUT LOCKS';
const HEADER_PREAMBLE = 'PROTOCOL PREAMBLE';
const HEADER_PING = 'PING';

/**
 * Serves the Videohub Ethernet Protocol on TCP 9990 (by default) for whatever
 * router the backend describes. Panels, Companion's videohub module and
 * Blackmagic's own software all speak this.
 */
export class VideohubServer {
  /** The bound port. When 0 is requested, this becomes the port the OS chose. */
  port: number;
  private readonly host: string;
  private readonly backend: RouterBackend;
  private readonly log: (message: string) => void;
  private server: net.Server | null = null;
  private clients = new Set<Client>();
  private unsubscribe: (() => void) | null = null;

  constructor(options: VideohubServerOptions) {
    this.backend = options.backend;
    this.port = options.port ?? 9990;
    this.host = options.host ?? '0.0.0.0';
    this.log = options.log ?? (() => {});
  }

  get clientCount(): number {
    return this.clients.size;
  }

  async start(): Promise<void> {
    if (this.server) return;
    const server = net.createServer((socket) => this.accept(socket));
    this.server = server;

    await new Promise<void>((resolve, reject) => {
      const onError = (error: Error) => {
        this.server = null;
        reject(error);
      };
      server.once('error', onError);
      server.listen(this.port, this.host, () => {
        server.off('error', onError);
        const address = server.address();
        if (address && typeof address === 'object') this.port = address.port;
        resolve();
      });
    });

    server.on('error', (error) => this.log(`videohub server error: ${error.message}`));
    this.unsubscribe = this.backend.subscribe((update) => this.broadcast(update));
    this.log(`videohub protocol listening on ${this.host}:${this.port}`);
  }

  async stop(): Promise<void> {
    this.unsubscribe?.();
    this.unsubscribe = null;
    for (const client of this.clients) client.socket.destroy();
    this.clients.clear();
    const server = this.server;
    this.server = null;
    if (!server) return;
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }

  private accept(socket: net.Socket): void {
    socket.setNoDelay(true);
    socket.setEncoding('utf8');
    const client: Client = {
      socket,
      parser: new BlockParser(),
      id: normalizeAddress(socket.remoteAddress),
      queue: Promise.resolve(),
    };
    this.clients.add(client);
    this.log(`videohub client connected: ${client.id}`);

    socket.on('data', (chunk: string | Buffer) => {
      const blocks = client.parser.push(typeof chunk === 'string' ? chunk : chunk.toString('utf8'));
      for (const block of blocks) {
        client.queue = client.queue.then(() => this.handleBlock(client, block)).catch((error) => {
          this.log(`videohub block failed: ${String(error)}`);
        });
      }
    });

    const drop = () => {
      this.clients.delete(client);
      this.log(`videohub client gone: ${client.id}`);
    };
    socket.on('close', drop);
    socket.on('error', drop);

    this.sendPrelude(client);
  }

  /** The full state dump every client gets on connect. */
  private sendPrelude(client: Client): void {
    this.write(client, formatBlock(HEADER_PREAMBLE, [`Version: ${PROTOCOL_VERSION}`]));
    this.write(client, this.deviceBlock());
    this.write(client, formatBlock(HEADER_INPUT_LABELS, indexedLines(this.backend.getInputLabels())));
    this.write(client, formatBlock(HEADER_OUTPUT_LABELS, indexedLines(this.backend.getOutputLabels())));
    this.write(client, this.routingBlock());
    this.write(client, this.locksBlock(client));
  }

  private deviceBlock(): string {
    const info = this.backend.getInfo();
    const lines = ['Device present: true', `Model name: ${info.modelName}`];
    if (info.friendlyName) lines.push(`Friendly name: ${info.friendlyName}`);
    if (info.uniqueId) lines.push(`Unique ID: ${info.uniqueId}`);
    lines.push(
      `Video inputs: ${info.inputCount}`,
      `Video processing units: ${info.processingUnitCount ?? 0}`,
      `Video outputs: ${info.outputCount}`,
      `Video monitoring outputs: ${info.monitoringOutputCount ?? 0}`,
      `Serial ports: ${info.serialPortCount ?? 0}`,
    );
    return formatBlock(HEADER_DEVICE, lines);
  }

  private routingBlock(outputs?: number[]): string {
    const routing = this.backend.getRouting();
    return formatBlock(HEADER_ROUTING, indexedLines(routing.map(String), outputs));
  }

  private locksBlock(client: Client, outputs?: number[]): string {
    const locks = this.backend.getLocks();
    const rendered = locks.map((owner) => (owner === null ? 'U' : owner === client.id ? 'O' : 'L'));
    return formatBlock(HEADER_LOCKS, indexedLines(rendered, outputs));
  }

  private async handleBlock(client: Client, block: Block): Promise<void> {
    const { header, lines } = block;

    if (header === HEADER_PING) {
      this.write(client, ACK);
      return;
    }

    // A header with no lines is a request to re-dump that block.
    if (lines.length === 0) {
      switch (header) {
        case HEADER_PREAMBLE:
          this.write(client, ACK);
          this.write(client, formatBlock(HEADER_PREAMBLE, [`Version: ${PROTOCOL_VERSION}`]));
          return;
        case HEADER_DEVICE:
          this.write(client, ACK);
          this.write(client, this.deviceBlock());
          return;
        case HEADER_INPUT_LABELS:
          this.write(client, ACK);
          this.write(client, formatBlock(HEADER_INPUT_LABELS, indexedLines(this.backend.getInputLabels())));
          return;
        case HEADER_OUTPUT_LABELS:
          this.write(client, ACK);
          this.write(client, formatBlock(HEADER_OUTPUT_LABELS, indexedLines(this.backend.getOutputLabels())));
          return;
        case HEADER_ROUTING:
          this.write(client, ACK);
          this.write(client, this.routingBlock());
          return;
        case HEADER_LOCKS:
          this.write(client, ACK);
          this.write(client, this.locksBlock(client));
          return;
        default:
          this.write(client, NAK);
          return;
      }
    }

    switch (header) {
      case HEADER_ROUTING:
        await this.applyRouting(client, lines);
        return;
      case HEADER_LOCKS:
        await this.applyLocks(client, lines);
        return;
      case HEADER_INPUT_LABELS:
        await this.applyLabels(client, lines, 'input');
        return;
      case HEADER_OUTPUT_LABELS:
        await this.applyLabels(client, lines, 'output');
        return;
      default:
        // Includes the hardware status blocks, which per the spec a client may
        // not set — ignoring them is the documented behaviour, but an unknown
        // header is a NAK.
        this.write(client, NAK);
    }
  }

  private async applyRouting(client: Client, lines: string[]): Promise<void> {
    const outputCount = this.backend.getRouting().length;
    const inputCount = this.backend.getInputLabels().length;
    const requests: Array<{ output: number; input: number }> = [];

    for (const line of lines) {
      const parsed = parseRouteLine(line);
      if (!parsed || parsed.output >= outputCount || parsed.input >= inputCount) {
        this.write(client, NAK);
        return;
      }
      requests.push(parsed);
    }

    // Syntax is good, so acknowledge before doing the work; the status update
    // that follows is what tells the client whether it actually happened.
    this.write(client, ACK);
    for (const request of requests) {
      await this.backend.setRoute(request.output, request.input, client.id);
    }
    this.write(client, this.routingBlock(requests.map((r) => r.output)));
  }

  private async applyLocks(client: Client, lines: string[]): Promise<void> {
    const outputCount = this.backend.getLocks().length;
    const requests: Array<{ output: number; action: LockAction }> = [];

    for (const line of lines) {
      const parsed = parseIndexedLine(line);
      if (!parsed || parsed.index >= outputCount) {
        this.write(client, NAK);
        return;
      }
      const action = lockAction(parsed.value);
      if (!action) {
        this.write(client, NAK);
        return;
      }
      requests.push({ output: parsed.index, action });
    }

    this.write(client, ACK);
    for (const request of requests) {
      await this.backend.setLock(request.output, request.action, client.id);
    }
    this.write(client, this.locksBlock(client, requests.map((r) => r.output)));
  }

  private async applyLabels(client: Client, lines: string[], kind: 'input' | 'output'): Promise<void> {
    const setter = kind === 'input' ? this.backend.setInputLabel : this.backend.setOutputLabel;
    const count = (kind === 'input' ? this.backend.getInputLabels() : this.backend.getOutputLabels()).length;
    if (!setter) {
      this.write(client, NAK);
      return;
    }

    const requests: Array<{ index: number; value: string }> = [];
    for (const line of lines) {
      const parsed = parseIndexedLine(line);
      if (!parsed || parsed.index >= count) {
        this.write(client, NAK);
        return;
      }
      requests.push(parsed);
    }

    this.write(client, ACK);
    for (const request of requests) {
      await setter.call(this.backend, request.index, request.value);
    }
    const labels = kind === 'input' ? this.backend.getInputLabels() : this.backend.getOutputLabels();
    const header = kind === 'input' ? HEADER_INPUT_LABELS : HEADER_OUTPUT_LABELS;
    this.write(client, formatBlock(header, indexedLines(labels, requests.map((r) => r.index))));
  }

  /** Push a change made by anyone — a client, the web UI, or the device itself. */
  private broadcast(update: RouterUpdate): void {
    for (const client of this.clients) {
      switch (update.type) {
        case 'routing':
          this.write(client, this.routingBlock(update.outputs));
          break;
        case 'locks':
          this.write(client, this.locksBlock(client, update.outputs));
          break;
        case 'inputLabels':
          this.write(
            client,
            formatBlock(HEADER_INPUT_LABELS, indexedLines(this.backend.getInputLabels(), update.inputs)),
          );
          break;
        case 'outputLabels':
          this.write(
            client,
            formatBlock(HEADER_OUTPUT_LABELS, indexedLines(this.backend.getOutputLabels(), update.outputs)),
          );
          break;
        case 'device':
          // The spec's own remedy for a changed device: resend everything but
          // the preamble so the client can rebuild its cache.
          this.write(client, this.deviceBlock());
          this.write(client, formatBlock(HEADER_INPUT_LABELS, indexedLines(this.backend.getInputLabels())));
          this.write(client, formatBlock(HEADER_OUTPUT_LABELS, indexedLines(this.backend.getOutputLabels())));
          this.write(client, this.routingBlock());
          this.write(client, this.locksBlock(client));
          break;
      }
    }
  }

  private write(client: Client, text: string): void {
    if (client.socket.destroyed) return;
    client.socket.write(text);
  }
}

/**
 * Lock ownership is per IP. IPv4-mapped IPv6 addresses are flattened so a
 * client that connects over one stack matches itself over the other.
 */
export function normalizeAddress(address: string | undefined): string {
  if (!address) return 'unknown';
  return address.startsWith('::ffff:') ? address.slice('::ffff:'.length) : address;
}

function lockAction(value: string): LockAction | null {
  switch (value.trim().toUpperCase()) {
    case 'O':
      return 'lock';
    case 'U':
      return 'unlock';
    case 'F':
      return 'force';
    default:
      return null;
  }
}
