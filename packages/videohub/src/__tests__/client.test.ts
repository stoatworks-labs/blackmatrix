import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { VideohubClient } from '../client.js';
import { VideohubServer } from '../server.js';
import type { LockAction, RouterBackend, RouterUpdate } from '../types.js';

/**
 * The two halves of this package driven against each other over real TCP. That
 * pairing is the point: the server is written from the specification and the
 * client is written to talk to real hardware, so anywhere they disagree, one of
 * them has the protocol wrong.
 */
class Router implements RouterBackend {
  inputs = ['In 1', 'In 2', 'In 3', 'In 4'];
  outputs = ['Out 1', 'Out 2', 'Out 3'];
  routing = [0, 1, 2];
  locks: Array<string | null> = [null, null, null];
  private listeners = new Set<(update: RouterUpdate) => void>();

  getInfo() {
    return {
      modelName: 'Test Videohub',
      friendlyName: 'Bench',
      uniqueId: 'bench-1',
      inputCount: this.inputs.length,
      outputCount: this.outputs.length,
    };
  }
  getInputLabels() { return this.inputs; }
  getOutputLabels() { return this.outputs; }
  getRouting() { return this.routing; }
  getLocks() { return this.locks; }

  setRoute(output: number, input: number): boolean {
    this.routing[output] = input;
    this.emit({ type: 'routing', outputs: [output] });
    return true;
  }
  setLock(output: number, action: LockAction, client: string): boolean {
    this.locks[output] = action === 'lock' ? client : null;
    this.emit({ type: 'locks', outputs: [output] });
    return true;
  }
  setInputLabel(input: number, label: string): boolean {
    this.inputs[input] = label;
    this.emit({ type: 'inputLabels', inputs: [input] });
    return true;
  }
  setOutputLabel(output: number, label: string): boolean {
    this.outputs[output] = label;
    this.emit({ type: 'outputLabels', outputs: [output] });
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

async function until(predicate: () => boolean, what: string): Promise<void> {
  const deadline = Date.now() + 2000;
  while (Date.now() < deadline) {
    if (predicate()) return;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  throw new Error(`timed out waiting for ${what}`);
}

describe('VideohubClient', () => {
  let router: Router;
  let server: VideohubServer;
  let client: VideohubClient;

  beforeEach(async () => {
    router = new Router();
    server = new VideohubServer({ backend: router, port: 0, host: '127.0.0.1' });
    await server.start();
    client = new VideohubClient({ host: '127.0.0.1', port: server.port, reconnectMs: 50 });
    client.connect();
    await until(() => client.state !== null, 'the initial status dump');
  });

  afterEach(async () => {
    client.close();
    await server.stop();
  });

  it('reads the router out of its opening dump', () => {
    const state = client.state!;
    expect(state.present).toBe(true);
    expect(state.protocolVersion).toBe('2.3');
    expect(state.modelName).toBe('Test Videohub');
    expect(state.friendlyName).toBe('Bench');
    expect(state.uniqueId).toBe('bench-1');
    expect(state.inputLabels).toEqual(['In 1', 'In 2', 'In 3', 'In 4']);
    expect(state.outputLabels).toEqual(['Out 1', 'Out 2', 'Out 3']);
    expect(state.routing).toEqual([0, 1, 2]);
    expect(state.locks).toEqual(['U', 'U', 'U']);
  });

  it('routes, and takes the new crosspoint from the update rather than assuming', async () => {
    client.route(1, 3);
    await until(() => client.state?.routing[1] === 3, 'the routing update');
    expect(router.routing[1]).toBe(3);
  });

  it('applies a sparse update without disturbing the rest', async () => {
    router.routing[2] = 3;
    router.emit({ type: 'routing', outputs: [2] });
    await until(() => client.state?.routing[2] === 3, 'the pushed update');
    // The update named output 2 only; 0 and 1 must survive it.
    expect(client.state?.routing).toEqual([0, 1, 3]);
  });

  it('sees a change made by somebody else', async () => {
    router.inputs[0] = 'Wide';
    router.emit({ type: 'inputLabels', inputs: [0] });
    await until(() => client.state?.inputLabels[0] === 'Wide', 'the label push');
    expect(client.state?.inputLabels[1]).toBe('In 2');
  });

  it('takes a lock and sees it as its own', async () => {
    client.setLock(0, 'lock');
    await until(() => client.state?.locks[0] === 'O', 'the lock update');
    expect(router.locks[0]).toBe('127.0.0.1');
  });

  it('renames an input on the router', async () => {
    client.setInputLabel(2, 'Presenter cam');
    await until(() => router.inputs[2] === 'Presenter cam', 'the rename');
    expect(client.state?.inputLabels[2]).toBe('Presenter cam');
  });

  it('keeps labels that contain spaces intact', async () => {
    client.setOutputLabel(0, 'Front of house left');
    await until(() => router.outputs[0] === 'Front of house left', 'the rename');
    expect(client.state?.outputLabels[0]).toBe('Front of house left');
  });

  it('reports itself disconnected when the router goes away', async () => {
    await server.stop();
    await until(() => client.status !== 'connected', 'the disconnect');
    // No stale matrix: a router that is not answering has no state to show.
    expect(client.state).toBeNull();
  });
});
