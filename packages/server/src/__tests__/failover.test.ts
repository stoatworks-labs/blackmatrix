import net from 'node:net';
import { afterEach, describe, expect, it } from 'vitest';
import type { AppConfig, FailoverWatch } from '../config.js';
import { FailoverController } from '../failover.js';
import type { Fleet } from '../fleet.js';

/**
 * The state machine, at speeds a test can watch.
 *
 * Everything here runs on real timers with tiny intervals rather than fake
 * ones, because the thing being tested is a race — a probe, a counter and a
 * salvo that takes time to apply — and fake timers would test the arithmetic
 * while stepping over the part that goes wrong.
 */

interface Taken {
  salvoId: string;
  client: string;
  overrideLocks: boolean | undefined;
}

function fakeFleet(taken: Taken[], failures: string[] = []): Fleet {
  return {
    async takeSalvo(salvoId: string, client: string, options?: { overrideLocks?: boolean }) {
      taken.push({ salvoId, client, overrideLocks: options?.overrideLocks });
      return { ok: failures.length === 0, failures };
    },
  } as unknown as Fleet;
}

function watchFor(overrides: Partial<FailoverWatch> = {}): FailoverWatch {
  return {
    id: 'main',
    name: 'Main media server',
    probe: { kind: 'heartbeat' },
    intervalMs: 20,
    failAfter: 2,
    restoreAfter: 2,
    onLostSalvo: 'salvo-backup',
    armed: true,
    overrideLocks: true,
    requireHealthyFirst: true,
    ...overrides,
  };
}

function configFor(watch: FailoverWatch): AppConfig {
  return {
    port: 0,
    videohub: { enabled: false, basePort: 9990, host: '127.0.0.1' },
    devices: [],
    labels: {},
    salvos: [],
    ties: [],
    failover: [watch],
  };
}

async function eventually(check: () => boolean, label: string, ms = 1500): Promise<void> {
  const deadline = Date.now() + ms;
  while (Date.now() < deadline) {
    if (check()) return;
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
  throw new Error(`timed out waiting for ${label}`);
}

describe('FailoverController', () => {
  let controller: FailoverController | null = null;

  afterEach(() => {
    controller?.stop();
    controller = null;
  });

  function run(watch: FailoverWatch, taken: Taken[] = []): { controller: FailoverController; taken: Taken[] } {
    const config = configFor(watch);
    controller = new FailoverController(fakeFleet(taken), config);
    controller.start();
    return { controller, taken };
  }

  const state = (c: FailoverController): string => c.view()[0]!.state;

  it('will not fire before it has ever seen the main system working', async () => {
    const { controller: c, taken } = run(watchFor());
    // The rack at power-up: nothing has answered, and nothing should switch.
    await new Promise((resolve) => setTimeout(resolve, 150));
    expect(taken).toEqual([]);
    expect(state(c)).toBe('failing');
    expect(c.view()[0]!.everHealthy).toBe(false);
  });

  it('fires the lost salvo once the main system has been seen and then goes', async () => {
    const { controller: c, taken } = run(watchFor());

    const beating = setInterval(() => c.heartbeat('main'), 10);
    await eventually(() => state(c) === 'healthy', 'healthy');
    clearInterval(beating);

    await eventually(() => taken.length === 1, 'the salvo');
    expect(taken[0]).toEqual({ salvoId: 'salvo-backup', client: 'failover:main', overrideLocks: true });
    expect(state(c)).toBe('failed');
    expect(c.view()[0]!.firedAt).not.toBeNull();
  });

  it('fires once and not again while the main system stays down', async () => {
    const { controller: c, taken } = run(watchFor());
    const beating = setInterval(() => c.heartbeat('main'), 10);
    await eventually(() => state(c) === 'healthy', 'healthy');
    clearInterval(beating);
    await eventually(() => taken.length === 1, 'the salvo');

    await new Promise((resolve) => setTimeout(resolve, 200));
    expect(taken).toHaveLength(1);
  });

  it('latches when there is no restored salvo: the backup keeps it until a person says otherwise', async () => {
    const { controller: c, taken } = run(watchFor());
    const beating = setInterval(() => c.heartbeat('main'), 10);
    await eventually(() => state(c) === 'healthy', 'healthy');
    clearInterval(beating);
    await eventually(() => taken.length === 1, 'the salvo');

    const again = setInterval(() => c.heartbeat('main'), 10);
    await eventually(() => state(c) === 'returned', 'returned');
    clearInterval(again);
    // The main system is back and nothing switched back on its own.
    expect(taken).toHaveLength(1);
  });

  it('switches back on its own when a restored salvo says what back means', async () => {
    const { controller: c, taken } = run(watchFor({ onRestoredSalvo: 'salvo-main' }));
    const beating = setInterval(() => c.heartbeat('main'), 10);
    await eventually(() => state(c) === 'healthy', 'healthy');
    clearInterval(beating);
    await eventually(() => taken.length === 1, 'the lost salvo');

    const again = setInterval(() => c.heartbeat('main'), 10);
    await eventually(() => taken.length === 2, 'the restored salvo');
    clearInterval(again);
    expect(taken[1]?.salvoId).toBe('salvo-main');
    expect(c.view()[0]!.firedAt).toBeNull();
  });

  it('a disarmed watch reports but does not switch', async () => {
    const { controller: c, taken } = run(watchFor({ armed: false }));
    const beating = setInterval(() => c.heartbeat('main'), 10);
    await eventually(() => state(c) === 'healthy', 'healthy');
    clearInterval(beating);

    await new Promise((resolve) => setTimeout(resolve, 200));
    expect(taken).toEqual([]);
    expect(state(c)).toBe('failing');
  });

  it('can still be fired and restored by hand while disarmed', async () => {
    const { controller: c, taken } = run(watchFor({ armed: false, onRestoredSalvo: 'salvo-main' }));

    expect(await c.trigger('main', 'operator')).toMatchObject({ ok: true });
    // The crosspoints are attributed to the watch, not to whoever pressed it:
    // a failover by hand has to behave exactly like a failover by probe, and
    // the route client is what lock ownership is compared against. Who asked
    // for it is in the log line, which is where that question gets answered.
    expect(taken[0]).toEqual({ salvoId: 'salvo-backup', client: 'failover:main', overrideLocks: true });
    expect(state(c)).toBe('failed');

    expect(await c.restore('main', 'operator')).toMatchObject({ ok: true });
    expect(taken[1]?.salvoId).toBe('salvo-main');
    expect(c.view()[0]!.firedAt).toBeNull();
  });

  it('leaves locks alone when the watch says not to override them', async () => {
    const { controller: c, taken } = run(watchFor({ overrideLocks: false }));
    await c.trigger('main', 'operator');
    expect(taken[0]?.overrideLocks).toBe(false);
  });

  it('refuses to restore a watch with no restored salvo, rather than doing something else', async () => {
    const { controller: c } = run(watchFor());
    const result = await c.restore('main', 'operator');
    expect(result.ok).toBe(false);
    expect(result.failures[0]).toContain('no restored salvo');
  });

  it('names an unknown watch instead of failing silently', async () => {
    const { controller: c } = run(watchFor());
    expect(await c.trigger('nope', 'operator')).toMatchObject({ ok: false });
  });
});

describe('FailoverController, TCP probe', () => {
  let controller: FailoverController | null = null;
  let listener: net.Server | null = null;

  afterEach(async () => {
    controller?.stop();
    controller = null;
    if (listener) await new Promise<void>((resolve) => listener!.close(() => resolve()));
    listener = null;
  });

  it('calls a machine healthy while its port accepts, and lost when it stops', async () => {
    listener = net.createServer((socket) => socket.destroy());
    await new Promise<void>((resolve) => listener!.listen(0, '127.0.0.1', () => resolve()));
    const address = listener.address();
    const port = typeof address === 'object' && address ? address.port : 0;

    const taken: Taken[] = [];
    const watch = watchFor({ probe: { kind: 'tcp', host: '127.0.0.1', port }, intervalMs: 30 });
    controller = new FailoverController(fakeFleet(taken), configFor(watch));
    controller.start();

    await eventually(() => controller!.view()[0]!.state === 'healthy', 'healthy');

    await new Promise<void>((resolve) => listener!.close(() => resolve()));
    listener = null;

    await eventually(() => taken.length === 1, 'the salvo after the port went away', 3000);
    expect(taken[0]?.salvoId).toBe('salvo-backup');
  });
});
