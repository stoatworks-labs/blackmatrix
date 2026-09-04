import net from 'node:net';
import dgram from 'node:dgram';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { AsciiMatrixServer } from '../server.js';
import type { AsciiMatrixBackend } from '../types.js';

/** Two devices and two salvos, with enough memory to check what was asked of it. */
class FakeFleet implements AsciiMatrixBackend {
  routes = new Map<string, number[]>([
    ['stage', [0, 1, 2]],
    ['studio', [0, 0]],
  ]);
  taken: string[] = [];
  fired: Array<{ id: string; direction: string }> = [];
  /** Set to refuse the next route, standing in for a lock or an illegal source. */
  refuse = false;

  listDevices() {
    return [
      { id: 'stage', name: 'Stage', inputCount: 4, outputCount: 3 },
      { id: 'studio', name: 'Studio', inputCount: 2, outputCount: 2 },
    ];
  }
  inputLabels() {
    return ['Cam 1', 'Cam 2', 'Cam 3', 'Cam 4'];
  }
  outputLabels() {
    return ['Aux 1', 'Aux 2', 'Program'];
  }
  routing(deviceId: string) {
    return this.routes.get(deviceId) ?? [];
  }
  route(deviceId: string, output: number, input: number): boolean {
    if (this.refuse) return false;
    const routing = this.routes.get(deviceId);
    if (!routing) return false;
    routing[output] = input;
    return true;
  }
  listSalvos() {
    return [
      { id: 'salvo-a', name: 'House to wide' },
      { id: 'salvo-b', name: 'Backup server' },
    ];
  }
  async takeSalvo(id: string) {
    this.taken.push(id);
    return { ok: true, failures: [] };
  }
  listFailover() {
    return [{ id: 'main', name: 'Main media server', state: 'healthy', armed: true }];
  }
  async fireFailover(id: string, direction: 'lost' | 'restored') {
    this.fired.push({ id, direction });
    return { ok: true, failures: [] };
  }
}

interface Client {
  send(line: string): void;
  next(): Promise<string>;
  close(): void;
}

async function connect(port: number): Promise<Client> {
  const socket = net.connect({ port, host: '127.0.0.1' });
  socket.setEncoding('utf8');
  const lines: string[] = [];
  let buffer = '';
  socket.on('data', (chunk: string) => {
    buffer += chunk;
    let index: number;
    while ((index = buffer.indexOf('\n')) >= 0) {
      lines.push(buffer.slice(0, index).replace(/\r$/, ''));
      buffer = buffer.slice(index + 1);
    }
  });
  await new Promise<void>((resolve, reject) => {
    socket.once('connect', resolve);
    socket.once('error', reject);
  });

  return {
    send: (line) => socket.write(`${line}\r\n`),
    close: () => socket.destroy(),
    next: async () => {
      const deadline = Date.now() + 2000;
      while (Date.now() < deadline) {
        const line = lines.shift();
        if (line !== undefined) return line;
        await new Promise((resolve) => setTimeout(resolve, 5));
      }
      throw new Error('timed out waiting for a line');
    },
  };
}

describe('AsciiMatrixServer', () => {
  let fleet: FakeFleet;
  let server: AsciiMatrixServer;
  let client: Client;

  beforeEach(async () => {
    fleet = new FakeFleet();
    server = new AsciiMatrixServer({ backend: fleet, port: 0, host: '127.0.0.1' });
    await server.start();
    client = await connect(server.port);
    // The greeting says which base the numbers are, which is the trap.
    expect(await client.next()).toContain('numbers start at 1');
  });

  afterEach(async () => {
    client.close();
    await server.stop();
  });

  it('routes with an Extron tie and answers in the same dialect', async () => {
    client.send('2*1!');
    expect(await client.next()).toBe('Out1 In2 All');
    // Input 2 output 1 on the wire is input index 1, output index 0.
    expect(fleet.routes.get('stage')?.[0]).toBe(1);
  });

  it('routes with the native form on the connection\'s device', async () => {
    client.send('ROUTE 2 3');
    expect(await client.next()).toBe('OK ROUTE 2 3');
    expect(fleet.routes.get('stage')?.[1]).toBe(2);
  });

  it('follows DEVICE for later lines that do not name one', async () => {
    client.send('DEVICE studio');
    expect(await client.next()).toBe('OK DEVICE studio');
    client.send('ROUTE 2 2');
    expect(await client.next()).toBe('OK ROUTE 2 2');
    expect(fleet.routes.get('studio')?.[1]).toBe(1);
    expect(fleet.routes.get('stage')).toEqual([0, 1, 2]);
  });

  it('names a device inline without changing the connection', async () => {
    client.send('ROUTE studio 1 2');
    expect(await client.next()).toBe('OK ROUTE 1 2');
    client.send('ROUTE 1 2');
    await client.next();
    expect(fleet.routes.get('studio')?.[0]).toBe(1);
    expect(fleet.routes.get('stage')?.[0]).toBe(1);
  });

  it('refuses a port past the end of the device rather than routing something else', async () => {
    client.send('ROUTE 9 1');
    expect(await client.next()).toContain('ERR output out of range');
    client.send('ROUTE 1 9');
    expect(await client.next()).toContain('ERR input out of range');
  });

  it('says so when the fleet refuses the route', async () => {
    fleet.refuse = true;
    client.send('ROUTE 1 1');
    expect(await client.next()).toContain('ERR route refused');
  });

  it('fires a salvo by name, by id and by preset number', async () => {
    client.send('SALVO Backup server');
    expect(await client.next()).toBe('OK SALVO salvo-b');
    client.send('SALVO salvo-a');
    expect(await client.next()).toBe('OK SALVO salvo-a');
    // A preset recall answers the way Extron does, since that is the shape a
    // disguise machine's `DVI matrix preset` field fires on failover.
    client.send('2.');
    expect(await client.next()).toBe('Rpr2');
    expect(fleet.taken).toEqual(['salvo-b', 'salvo-a', 'salvo-b']);
  });

  it('triggers and restores a failover watch', async () => {
    client.send('FAILOVER main');
    expect(await client.next()).toBe('OK LOST main');
    client.send('RESTORE main');
    expect(await client.next()).toBe('OK RESTORED main');
    expect(fleet.fired).toEqual([
      { id: 'main', direction: 'lost' },
      { id: 'main', direction: 'restored' },
    ]);
  });

  it('answers PING, LIST and STATUS', async () => {
    client.send('PING');
    expect(await client.next()).toBe('PONG');

    // LIST is the one multi-line answer: two devices, two salvos, one watch.
    client.send('LIST');
    const listed: string[] = [];
    for (let index = 0; index < 5; index++) listed.push(await client.next());
    expect(listed).toEqual([
      'DEVICE stage 4x3 Stage',
      'DEVICE studio 2x2 Studio',
      'SALVO 1 salvo-a House to wide',
      'SALVO 2 salvo-b Backup server',
      'FAILOVER main healthy armed Main media server',
    ]);

    client.send('STATUS');
    expect(await client.next()).toBe('1 1 Aux 1 <- Cam 1');
  });

  it('says what it did not understand instead of dropping the connection', async () => {
    client.send('make it work');
    expect(await client.next()).toContain('ERR unknown command');
    client.send('PING');
    expect(await client.next()).toBe('PONG');
  });
});

/*
 * The language fallback.
 *
 * The rule that matters is that it changes nothing about the routing verbs.
 * Existing disguise and PIXERA configurations are typed into a box by hand and
 * cannot be re-tested when this package is upgraded, so "unchanged" has to be
 * asserted rather than assumed.
 */
describe('the command language fallback', () => {
  let fleet: FakeFleet;
  let server: AsciiMatrixServer;
  let client: Client;
  let seen: string[];

  async function open(options: { languageOverUdp?: boolean; decline?: boolean } = {}) {
    fleet = new FakeFleet();
    seen = [];
    server = new AsciiMatrixServer({
      backend: fleet,
      port: 0,
      host: '127.0.0.1',
      udp: true,
      languageOverUdp: options.languageOverUdp ?? false,
      language: (line) => {
        seen.push(line);
        return options.decline ? null : [`OK saw ${line}`];
      },
    });
    await server.start();
    client = await connect(server.port);
    expect(await client.next()).toContain('numbers start at 1');
  }

  afterEach(async () => {
    client?.close();
    await server?.stop();
  });

  it('never sees a line the routing verbs understand', async () => {
    await open();
    client.send('ROUTE 2 3');
    expect(await client.next()).toBe('OK ROUTE 2 3');
    client.send('PING');
    expect(await client.next()).toBe('PONG');
    client.send('1*3!');
    expect(await client.next()).toBe('Out3 In1 All');
    expect(seen).toEqual([]);
  });

  /* A malformed ROUTE keeps its own message: the language would complain about
     something else entirely, and the operator needs the one about ROUTE. */
  it("keeps a known verb's own error rather than offering it to the language", async () => {
    await open();
    client.send('ROUTE x y');
    expect(await client.next()).toBe('ERR ROUTE wants numbers');
    expect(seen).toEqual([]);
  });

  it('hands an unrecognised first word over', async () => {
    await open();
    client.send('Cut ME 1');
    expect(await client.next()).toBe('OK saw Cut ME 1');
    expect(seen).toEqual(['Cut ME 1']);
  });

  it('falls back to the ordinary error when the language declines', async () => {
    await open({ decline: true });
    client.send('Cut ME 1');
    expect(await client.next()).toBe('ERR unknown command: Cut');
  });

  /* Moving a crosspoint from a forged datagram is what this port is for.
     Cutting a programme from one is not. */
  it('refuses the language on a datagram unless it is turned on', async () => {
    await open();
    const socket = dgram.createSocket('udp4');
    try {
      socket.send('Cut ME 1\n', server.port, '127.0.0.1');
      await new Promise((resolve) => setTimeout(resolve, 150));
      expect(seen).toEqual([]);
    } finally {
      socket.close();
    }
  });

  it('lets a datagram through when it is', async () => {
    await open({ languageOverUdp: true });
    const socket = dgram.createSocket('udp4');
    try {
      socket.send('Cut ME 1\n', server.port, '127.0.0.1');
      await new Promise((resolve) => setTimeout(resolve, 150));
      expect(seen).toEqual(['Cut ME 1']);
    } finally {
      socket.close();
    }
  });
});
