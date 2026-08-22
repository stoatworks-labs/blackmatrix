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
  /**
   * What to report in `PROTOCOL PREAMBLE`. Defaults to the version this
   * implementation was written against.
   *
   * Worth raising only if a client refuses to talk to an older router: the
   * number is a promise about which blocks exist, and claiming 2.7 while
   * serving 2.3's blocks is a lie a client is entitled to act on.
   */
  protocolVersion?: string;
  /**
   * Overrides the backend's `Model name`. A backend that is not a Videohub
   * reports what it actually is — an ATEM reports its own model — and some
   * third-party drivers check that string before they will drive the router at
   * all. This is the escape hatch for those, and it is off by default because
   * lying about the model in the general case makes every log harder to read.
   */
  modelName?: string;
  /**
   * Send `END PRELUDE:` after the opening status dump. On by default.
   *
   * It is not in the published v2.3 document, but real Blackmagic firmware
   * sends it — verified on an ATEM's own Videohub server, which reports
   * protocol 2.7 — and a client written against a real router may wait for it
   * before it considers itself connected. Clients that do not know it ignore
   * it, as the spec tells them to, so sending it is free.
   */
  endPrelude?: boolean;
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
const HEADER_END_PRELUDE = 'END PRELUDE';

/**
 * Blocks a real Videohub omits when it has none of that kind of port, which is
 * every one of them here: an ATEM has no monitoring outputs, serial ports,
 * processing units or frame buffers.
 *
 * They are answered rather than NAK'd. A client that probes for a section it
 * cannot see in the prelude is asking a reasonable question, and "that section
 * is empty" is a better answer than "I did not understand you" — a NAK reads as
 * a broken router, and at least one control system treats it as one.
 */
const EMPTY_SECTIONS = new Set([
  'MONITORING OUTPUT LABELS',
  'SERIAL PORT LABELS',
  'VIDEO MONITORING OUTPUT ROUTING',
  'SERIAL PORT ROUTING',
  'PROCESSING UNIT ROUTING',
  'FRAME LABELS',
  'FRAME BUFFER ROUTING',
  'MONITORING OUTPUT LOCKS',
  'SERIAL PORT LOCKS',
  'PROCESSING UNIT LOCKS',
  'FRAME BUFFER LOCKS',
  'SERIAL PORT DIRECTIONS',
  'VIDEO INPUT STATUS',
  'VIDEO OUTPUT STATUS',
  'SERIAL PORT STATUS',
]);

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
  private readonly protocolVersion: string;
  private readonly modelName: string | undefined;
  private readonly endPrelude: boolean;
  /** Outputs already complained about, so an unroutable one is logged once. */
  private warnedOutputs = new Set<number>();
  private server: net.Server | null = null;
  private clients = new Set<Client>();
  private unsubscribe: (() => void) | null = null;

  constructor(options: VideohubServerOptions) {
    this.backend = options.backend;
    this.port = options.port ?? 9990;
    this.host = options.host ?? '0.0.0.0';
    this.log = options.log ?? (() => {});
    this.protocolVersion = options.protocolVersion ?? PROTOCOL_VERSION;
    this.modelName = options.modelName;
    this.endPrelude = options.endPrelude ?? true;
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
    this.write(client, formatBlock(HEADER_PREAMBLE, [`Version: ${this.protocolVersion}`]));
    this.write(client, this.deviceBlock());
    this.write(client, formatBlock(HEADER_INPUT_LABELS, indexedLines(this.backend.getInputLabels())));
    this.write(client, formatBlock(HEADER_OUTPUT_LABELS, indexedLines(this.backend.getOutputLabels())));
    this.write(client, this.routingBlock());
    this.write(client, this.locksBlock(client));
    if (this.endPrelude) this.write(client, formatBlock(HEADER_END_PRELUDE));
  }

  private deviceBlock(): string {
    const info = this.backend.getInfo();
    const lines = ['Device present: true', `Model name: ${this.modelName ?? info.modelName}`];
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

  /**
   * `VIDEO OUTPUT ROUTING`, minus any output whose source this app cannot name.
   *
   * A backend reports -1 for "not routed", which the protocol has no way to
   * say: every line is an input index, and a real Videohub always has one.
   * Sending `0 -1` invites a client to parse it as input -1, or to reject the
   * block entirely. Leaving the line out is what the protocol already does for
   * anything unchanged, so a client is built to cope with its absence.
   */
  private routingBlock(outputs?: number[]): string {
    const routing = this.backend.getRouting();
    const wanted = outputs ?? routing.map((_, index) => index);
    const routable = wanted.filter((index) => {
      const input = routing[index];
      if (input !== undefined && input >= 0) return true;
      if (!this.warnedOutputs.has(index)) {
        this.warnedOutputs.add(index);
        this.log(`output ${index} is taking a source this app cannot name — left out of the routing block`);
      }
      return false;
    });
    return formatBlock(HEADER_ROUTING, indexedLines(routing.map(String), routable));
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
      if (EMPTY_SECTIONS.has(header)) {
        this.write(client, ACK);
        this.write(client, formatBlock(header));
        return;
      }
      switch (header) {
        case HEADER_PREAMBLE:
          this.write(client, ACK);
          this.write(client, formatBlock(HEADER_PREAMBLE, [`Version: ${this.protocolVersion}`]));
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
 * Lock ownership is per IP, as the Videohub spec has it. Two rewrites keep one
 * client from becoming two owners:
 *
 * - IPv4-mapped IPv6 (`::ffff:10.0.0.5`) is flattened to its IPv4 form.
 * - IPv6 loopback (`::1`) becomes `127.0.0.1`. A dual-stack client picks a
 *   family per connection — Node's own fetch does, request to request — so
 *   without this a process on the host can take a lock over one stack and then
 *   be refused its own unlock over the other. Loopback is one machine either
 *   way, which is the thing ownership is actually about.
 */
export function normalizeAddress(address: string | undefined): string {
  if (!address) return 'unknown';
  const flattened = address.startsWith('::ffff:') ? address.slice('::ffff:'.length) : address;
  return flattened === '::1' ? '127.0.0.1' : flattened;
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
