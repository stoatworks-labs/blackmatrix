import net from 'node:net';
import dgram from 'node:dgram';
import { helpText, parseLine, resolveSalvo, routeReply, type Command } from './protocol.js';
import type { AsciiMatrixBackend } from './types.js';

export interface AsciiMatrixServerOptions {
  backend: AsciiMatrixBackend;
  port?: number;
  host?: string;
  /** The first number on the wire. See the note in protocol.ts. */
  wireBase?: number;
  /**
   * Also listen for datagrams on the same port. Off by default.
   *
   * A datagram has no connection, so it has no `DEVICE` of its own and no
   * reply worth waiting for — it is here because some show controllers only
   * send UDP, and for those the point is that the crosspoint happens, not that
   * anything is said back.
   */
  udp?: boolean;
  log?: (message: string) => void;
}

interface Connection {
  socket: net.Socket;
  address: string;
  buffer: string;
  /** Which device this connection routes on when a line does not say. */
  deviceId: string | null;
  /** Serialises a connection's lines, since applying a route is async. */
  queue: Promise<void>;
}

/**
 * The line protocol on a TCP port (and optionally the same port over UDP).
 *
 * One line in, one line out, and every answer starts with `OK`, `ERR` or the
 * dialect the request asked for. A control system that ignores replies loses
 * nothing by them; a person on telnet gets something readable; and a driver
 * waiting for an Extron-shaped acknowledgement gets one.
 */
export class AsciiMatrixServer {
  port: number;
  private readonly host: string;
  private readonly backend: AsciiMatrixBackend;
  private readonly base: number;
  private readonly wantUdp: boolean;
  private readonly log: (message: string) => void;
  private server: net.Server | null = null;
  private udp: dgram.Socket | null = null;
  private connections = new Set<Connection>();

  constructor(options: AsciiMatrixServerOptions) {
    this.backend = options.backend;
    this.port = options.port ?? 9995;
    this.host = options.host ?? '0.0.0.0';
    this.base = options.wireBase ?? 1;
    this.wantUdp = options.udp ?? false;
    this.log = options.log ?? (() => {});
  }

  get clientCount(): number {
    return this.connections.size;
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

    server.on('error', (error) => this.log(`line protocol error: ${error.message}`));

    if (this.wantUdp) await this.startUdp();
    this.log(`line protocol listening on ${this.host}:${this.port}${this.wantUdp ? ' (tcp and udp)' : ''}`);
  }

  private async startUdp(): Promise<void> {
    const socket = dgram.createSocket({ type: 'udp4', reuseAddr: true });
    this.udp = socket;
    socket.on('message', (message, from) => {
      const address = normalize(from.address);
      for (const line of message.toString('utf8').split(/\r?\n/)) {
        if (line.trim() === '') continue;
        void this.run(line, address, null).then((replies) => {
          // Answered to the sender's port, best effort. A controller that is
          // not listening simply gets an ICMP nobody reads.
          const text = `${replies.join('\n')}\n`;
          socket.send(text, from.port, from.address, () => {});
        });
      }
    });
    await new Promise<void>((resolve, reject) => {
      socket.once('error', reject);
      socket.bind(this.port, this.host, () => resolve());
    });
  }

  async stop(): Promise<void> {
    for (const connection of this.connections) connection.socket.destroy();
    this.connections.clear();
    const udp = this.udp;
    this.udp = null;
    if (udp) await new Promise<void>((resolve) => udp.close(() => resolve()));
    const server = this.server;
    this.server = null;
    if (!server) return;
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }

  private accept(socket: net.Socket): void {
    socket.setNoDelay(true);
    socket.setEncoding('utf8');
    const connection: Connection = {
      socket,
      address: normalize(socket.remoteAddress),
      buffer: '',
      deviceId: this.backend.listDevices()[0]?.id ?? null,
      queue: Promise.resolve(),
    };
    this.connections.add(connection);
    this.log(`line protocol client connected: ${connection.address}`);

    socket.on('data', (chunk: string | Buffer) => {
      connection.buffer += typeof chunk === 'string' ? chunk : chunk.toString('utf8');
      let index: number;
      while ((index = connection.buffer.indexOf('\n')) >= 0) {
        const line = connection.buffer.slice(0, index);
        connection.buffer = connection.buffer.slice(index + 1);
        connection.queue = connection.queue
          .then(async () => {
            const replies = await this.run(line, connection.address, connection);
            for (const reply of replies) this.write(connection, reply);
          })
          .catch((error) => this.log(`line protocol failed: ${String(error)}`));
      }
    });

    const drop = () => {
      this.connections.delete(connection);
      this.log(`line protocol client gone: ${connection.address}`);
    };
    socket.on('close', drop);
    socket.on('error', drop);

    // A greeting that says which base the numbers use, because that is the one
    // thing an integrator cannot discover by trying it without moving a
    // crosspoint on somebody's show.
    this.write(connection, `OK BlackMatrix line protocol, numbers start at ${this.base}. HELP for commands.`);
  }

  /** Run one line. Returns the lines to answer with. */
  private async run(line: string, address: string, connection: Connection | null): Promise<string[]> {
    const command = parseLine(line, { wireBase: this.base });
    if (!command) return [];

    switch (command.kind) {
      case 'error':
        return [`ERR ${command.reason}`];
      case 'ping':
        return ['PONG'];
      case 'help':
        return helpText(this.backend, this.base);
      case 'list':
        return this.listReply();
      case 'device': {
        const device = this.backend.listDevices().find((candidate) => candidate.id === command.deviceId);
        if (!device) return [`ERR no such device: ${command.deviceId}`];
        if (!connection) return ['ERR DEVICE needs a connection — name the device in the ROUTE instead'];
        connection.deviceId = device.id;
        return [`OK DEVICE ${device.id}`];
      }
      case 'status':
        return this.statusReply(command.deviceId ?? connection?.deviceId ?? null);
      case 'route':
        return this.routeReply(command, address, connection);
      case 'salvo':
        return this.salvoReply(command, address);
      case 'failover':
        return this.failoverReply(command, address);
    }
  }

  private async routeReply(
    command: Extract<Command, { kind: 'route' }>,
    address: string,
    connection: Connection | null,
  ): Promise<string[]> {
    const deviceId = command.deviceId ?? connection?.deviceId ?? this.backend.listDevices()[0]?.id ?? null;
    if (!deviceId) return ['ERR no devices'];

    const device = this.backend.listDevices().find((candidate) => candidate.id === deviceId);
    if (!device) return [`ERR no such device: ${deviceId}`];
    if (command.output >= device.outputCount) return [`ERR output out of range on ${deviceId}`];
    if (command.input >= device.inputCount) return [`ERR input out of range on ${deviceId}`];

    const ok = await this.backend.route(deviceId, command.output, command.input, address);
    if (!ok) return [`ERR route refused on ${deviceId}`];
    return [routeReply(command, this.base)];
  }

  private async salvoReply(
    command: Extract<Command, { kind: 'salvo' }>,
    address: string,
  ): Promise<string[]> {
    const salvos = this.backend.listSalvos();
    const id = resolveSalvo(command.salvo, salvos);
    if (!id) return [`ERR no such salvo: ${command.salvo}`];

    const result = await this.backend.takeSalvo(id, address);
    if (command.echo === 'sis-preset') {
      // Extron answers a preset recall with `Rpr<n>`. A driver expecting that
      // gets it whether or not every crosspoint landed, because the protocol it
      // is imitating has no way to say otherwise — the failures are in the log.
      const position = salvos.findIndex((salvo) => salvo.id === id) + 1;
      return [`Rpr${position}`];
    }
    if (!result.ok) return [`ERR salvo ${id} partly failed: ${result.failures.join('; ')}`];
    return [`OK SALVO ${id}`];
  }

  private async failoverReply(
    command: Extract<Command, { kind: 'failover' }>,
    address: string,
  ): Promise<string[]> {
    if (!this.backend.fireFailover) return ['ERR failover is not available on this server'];
    const result = await this.backend.fireFailover(command.id, command.direction, address);
    if (!result.ok) return [`ERR ${command.direction} ${command.id}: ${result.failures.join('; ')}`];
    return [`OK ${command.direction.toUpperCase()} ${command.id}`];
  }

  private listReply(): string[] {
    const lines: string[] = [];
    for (const device of this.backend.listDevices()) {
      lines.push(`DEVICE ${device.id} ${device.inputCount}x${device.outputCount} ${device.name}`);
    }
    this.backend.listSalvos().forEach((salvo, index) => {
      lines.push(`SALVO ${index + 1} ${salvo.id} ${salvo.name}`);
    });
    for (const watch of this.backend.listFailover?.() ?? []) {
      lines.push(`FAILOVER ${watch.id} ${watch.state} ${watch.armed ? 'armed' : 'disarmed'} ${watch.name}`);
    }
    return lines.length > 0 ? lines : ['OK nothing configured'];
  }

  private statusReply(deviceId: string | null): string[] {
    if (!deviceId) return ['ERR no devices'];
    const routing = this.backend.routing(deviceId);
    const outputs = this.backend.outputLabels(deviceId);
    const inputs = this.backend.inputLabels(deviceId);
    if (routing.length === 0) return [`ERR no such device: ${deviceId}`];
    return routing.map((input, output) => {
      const outLabel = outputs[output] ?? '';
      // -1 means the source is one this app cannot name; saying so beats
      // reporting a number that is not true.
      if (input < 0) return `${output + this.base} - ${outLabel} <- unknown`;
      return `${output + this.base} ${input + this.base} ${outLabel} <- ${inputs[input] ?? ''}`;
    });
  }

  private write(connection: Connection, text: string): void {
    if (connection.socket.destroyed) return;
    connection.socket.write(`${text}\r\n`);
  }
}

/** As the Videohub server does, and for the same reason: one machine, one identity. */
function normalize(address: string | undefined): string {
  if (!address) return 'unknown';
  const flattened = address.startsWith('::ffff:') ? address.slice('::ffff:'.length) : address;
  return flattened === '::1' ? '127.0.0.1' : flattened;
}
