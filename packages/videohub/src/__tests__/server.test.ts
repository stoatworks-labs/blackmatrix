import net from 'node:net';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { VideohubServer, normalizeAddress } from '../server.js';
import type { LockAction, RouterBackend, RouterUpdate } from '../types.js';

/** A four-output router. Output 3 always refuses, standing in for an illegal crosspoint. */
class FakeRouter implements RouterBackend {
  inputs = ['Cam 1', 'Cam 2', 'Cam 3'];
  outputs = ['Aux 1', 'Aux 2', 'Program', 'Refuses'];
  routing = [0, 1, 2, -1];
  locks: Array<string | null> = [null, null, null, null];
  private listeners = new Set<(update: RouterUpdate) => void>();

  getInfo() {
    return {
      modelName: 'Fake',
      friendlyName: 'Bench',
      uniqueId: 'fake-1',
      inputCount: this.inputs.length,
      outputCount: this.outputs.length,
    };
  }
  getInputLabels() { return this.inputs; }
  getOutputLabels() { return this.outputs; }
  getRouting() { return this.routing; }
  getLocks() { return this.locks; }

  setRoute(output: number, input: number, client: string): boolean {
    if (output === 3) return false;
    const owner = this.locks[output];
    if (owner && owner !== client) return false;
    this.routing[output] = input;
    this.emit({ type: 'routing', outputs: [output] });
    return true;
  }

  setLock(output: number, action: LockAction, client: string): boolean {
    const owner = this.locks[output] ?? null;
    if (action === 'lock') {
      if (owner && owner !== client) return false;
      this.locks[output] = client;
    } else if (action === 'force') {
      this.locks[output] = null;
    } else {
      if (owner && owner !== client) return false;
      this.locks[output] = null;
    }
    this.emit({ type: 'locks', outputs: [output] });
    return true;
  }

  setInputLabel(input: number, label: string): boolean {
    this.inputs[input] = label;
    this.emit({ type: 'inputLabels', inputs: [input] });
    return true;
  }

  subscribe(listener: (update: RouterUpdate) => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  emit(update: RouterUpdate): void {
    for (const listener of this.listeners) listener(update);
  }
}

interface Client {
  send(text: string): void;
  wait(predicate: (text: string) => boolean, label: string): Promise<string>;
  clear(): void;
  close(): void;
}

async function connect(port: number): Promise<Client> {
  const socket = net.connect({ port, host: '127.0.0.1' });
  socket.setEncoding('utf8');
  let buffer = '';
  socket.on('data', (chunk: string) => {
    buffer += chunk;
  });
  await new Promise<void>((resolve, reject) => {
    socket.once('connect', resolve);
    socket.once('error', reject);
  });

  return {
    send: (text) => socket.write(text),
    clear: () => {
      buffer = '';
    },
    close: () => socket.destroy(),
    wait: async (predicate, label) => {
      const deadline = Date.now() + 2000;
      while (Date.now() < deadline) {
        if (predicate(buffer)) return buffer;
        await new Promise((resolve) => setTimeout(resolve, 10));
      }
      throw new Error(`timed out waiting for ${label}; saw:\n${buffer}`);
    },
  };
}

describe('normalizeAddress', () => {
  it('flattens an IPv4-mapped IPv6 address', () => {
    expect(normalizeAddress('::ffff:10.0.0.5')).toBe('10.0.0.5');
  });

  it('treats both loopbacks as one owner, since a dual-stack client flips between them', () => {
    expect(normalizeAddress('::1')).toBe('127.0.0.1');
    expect(normalizeAddress('127.0.0.1')).toBe('127.0.0.1');
  });

  it('leaves an ordinary address alone', () => {
    expect(normalizeAddress('10.0.0.5')).toBe('10.0.0.5');
    expect(normalizeAddress(undefined)).toBe('unknown');
  });
});

describe('VideohubServer', () => {
  let router: FakeRouter;
  let server: VideohubServer;
  let client: Client;

  beforeEach(async () => {
    router = new FakeRouter();
    server = new VideohubServer({ backend: router, port: 0, host: '127.0.0.1' });
    await server.start();
    client = await connect(server.port);
    await client.wait((text) => text.includes('VIDEO OUTPUT LOCKS:'), 'prelude');
  });

  afterEach(async () => {
    client.close();
    await server.stop();
  });

  it('opens with the full status dump, in protocol order', async () => {
    const text = await client.wait((t) => t.includes('VIDEO OUTPUT LOCKS:'), 'prelude');
    const order = [
      'PROTOCOL PREAMBLE:',
      'VIDEOHUB DEVICE:',
      'INPUT LABELS:',
      'OUTPUT LABELS:',
      'VIDEO OUTPUT ROUTING:',
      'VIDEO OUTPUT LOCKS:',
    ].map((header) => text.indexOf(header));
    expect(order.every((position) => position >= 0)).toBe(true);
    expect([...order].sort((a, b) => a - b)).toEqual(order);

    expect(text).toContain('Version: 2.3');
    expect(text).toContain('Device present: true');
    expect(text).toContain('Video inputs: 3');
    expect(text).toContain('Video outputs: 4');
    expect(text).toContain('0 Cam 1');
    expect(text).toContain('0 Aux 1');
    expect(text).toContain('3 -1');
    expect(text).toContain('0 U');
  });

  it('routes on request and reports the new crosspoint', async () => {
    client.clear();
    client.send('VIDEO OUTPUT ROUTING:\n1 2\n\n');
    const text = await client.wait((t) => t.includes('VIDEO OUTPUT ROUTING:'), 'routing echo');
    expect(text.startsWith('ACK\n\n')).toBe(true);
    expect(text).toContain('VIDEO OUTPUT ROUTING:\n1 2\n');
    expect(router.routing[1]).toBe(2);
  });

  it('acknowledges a refused route but reports the unchanged state', async () => {
    client.clear();
    client.send('VIDEO OUTPUT ROUTING:\n3 1\n\n');
    const text = await client.wait((t) => t.includes('VIDEO OUTPUT ROUTING:'), 'routing echo');
    expect(text.startsWith('ACK\n\n')).toBe(true);
    expect(text).toContain('VIDEO OUTPUT ROUTING:\n3 -1\n');
    expect(router.routing[3]).toBe(-1);
  });

  it('NAKs a route to a port that does not exist', async () => {
    client.clear();
    client.send('VIDEO OUTPUT ROUTING:\n9 1\n\n');
    const text = await client.wait((t) => t.includes('NAK'), 'nak');
    expect(text).toBe('NAK\n\n');
  });

  it('answers PING with ACK', async () => {
    client.clear();
    client.send('PING:\n\n');
    expect(await client.wait((t) => t.includes('ACK'), 'ack')).toBe('ACK\n\n');
  });

  it('NAKs a header it does not know', async () => {
    client.clear();
    client.send('VIDEO MONITORING OUTPUT ROUTING:\n0 1\n\n');
    expect(await client.wait((t) => t.includes('NAK'), 'nak')).toBe('NAK\n\n');
  });

  it('re-dumps a block when asked for it by header alone', async () => {
    client.clear();
    client.send('OUTPUT LABELS:\n\n');
    const text = await client.wait((t) => t.includes('OUTPUT LABELS:'), 'labels');
    expect(text).toContain('ACK\n\n');
    expect(text).toContain('0 Aux 1');
    expect(text).toContain('3 Refuses');
  });

  it('shows a lock as O to the client that owns it', async () => {
    client.clear();
    client.send('VIDEO OUTPUT LOCKS:\n0 O\n\n');
    const mine = await client.wait((t) => t.includes('VIDEO OUTPUT LOCKS:'), 'lock echo');
    expect(mine).toContain('VIDEO OUTPUT LOCKS:\n0 O\n');
    expect(router.locks[0]).toBe('127.0.0.1');
  });

  it('locks by IP, so a second connection from the same machine still owns it', async () => {
    client.send('VIDEO OUTPUT LOCKS:\n0 O\n\n');
    await client.wait((t) => t.includes('VIDEO OUTPUT LOCKS:'), 'lock echo');

    const second = await connect(server.port);
    const theirs = await second.wait((t) => t.includes('VIDEO OUTPUT LOCKS:'), 'their prelude');
    expect(theirs).toContain('0 O');
    second.close();
  });

  it('shows a lock held by another address as L', async () => {
    router.locks[0] = '10.0.0.9';
    const other = await connect(server.port);
    const theirs = await other.wait((t) => t.includes('VIDEO OUTPUT LOCKS:'), 'their prelude');
    expect(theirs).toContain('0 L');
    other.close();
  });

  it('refuses to route a destination another address has locked', async () => {
    router.locks[1] = '10.0.0.9';
    client.clear();
    client.send('VIDEO OUTPUT ROUTING:\n1 2\n\n');
    const text = await client.wait((t) => t.includes('VIDEO OUTPUT ROUTING:'), 'routing echo');
    expect(text).toContain('VIDEO OUTPUT ROUTING:\n1 1\n');
    expect(router.routing[1]).toBe(1);
  });

  it('lets a forced unlock take a lock off another address', async () => {
    router.locks[2] = '10.0.0.9';
    client.clear();
    client.send('VIDEO OUTPUT LOCKS:\n2 F\n\n');
    const text = await client.wait((t) => t.includes('VIDEO OUTPUT LOCKS:'), 'lock echo');
    expect(text).toContain('VIDEO OUTPUT LOCKS:\n2 U\n');
    expect(router.locks[2]).toBeNull();
  });

  it('pushes changes made by anyone else', async () => {
    client.clear();
    router.routing[0] = 2;
    router.emit({ type: 'routing', outputs: [0] });
    const text = await client.wait((t) => t.includes('VIDEO OUTPUT ROUTING:'), 'push');
    expect(text).toBe('VIDEO OUTPUT ROUTING:\n0 2\n\n');
  });

  it('renames an input on request', async () => {
    client.clear();
    client.send('INPUT LABELS:\n1 Wide shot\n\n');
    await client.wait((t) => t.includes('INPUT LABELS:'), 'label echo');
    expect(router.inputs[1]).toBe('Wide shot');
  });

  it('NAKs an output label change when the backend cannot take one', async () => {
    client.clear();
    client.send('OUTPUT LABELS:\n1 Nope\n\n');
    expect(await client.wait((t) => t.includes('NAK'), 'nak')).toBe('NAK\n\n');
  });
});
