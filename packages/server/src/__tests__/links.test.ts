import { describe, expect, it } from 'vitest';
import { planRoute } from '@av/atem-matrix';
import type { AppConfig } from '../config.js';
import { Fleet } from '../fleet.js';

/**
 * The wiring as the fleet holds it, and a route through it.
 *
 * Two simulated switchers stand in for a router and a switcher: what matters
 * here is the cable between them and the order things happen in, and a mock
 * ATEM answers a route with its state the way a Videohub answers with a status
 * update.
 */

function configFor(): AppConfig {
  return {
    port: 0,
    videohub: { enabled: false, basePort: 9990, host: '127.0.0.1' },
    devices: [
      { id: 'up', name: 'Upstream', address: 'mock' },
      { id: 'down', name: 'Downstream', address: 'mock' },
    ],
    labels: {},
    salvos: [],
    ties: [],
    // Upstream's first aux is cabled into downstream input 1.
    links: [{ from: 'up:aux.0', to: 'down:1' }],
    failover: [],
  };
}

async function mockFleet(): Promise<Fleet> {
  const fleet = new Fleet(configFor(), true);
  await fleet.start();
  return fleet;
}

function routeOf(fleet: Fleet, deviceId: string, destination: string): number | undefined {
  return fleet.snapshot().devices.find((device) => device.id === deviceId)?.matrix?.routes[destination];
}

describe('wiring', () => {
  it('rides on the snapshot', async () => {
    const fleet = await mockFleet();
    expect(fleet.snapshot().links).toEqual([{ from: 'up:aux.0', to: 'down:1' }]);
  });

  it('adds cables, and refuses a second one into the same input', async () => {
    const fleet = await mockFleet();
    expect(fleet.editLinks({ add: [{ from: 'up:aux.1', to: 'down:2' }] }).ok).toBe(true);
    const twice = fleet.editLinks({ add: [{ from: 'down:aux.0', to: 'up:2' }, { from: 'down:aux.1', to: 'up:2' }] });
    expect(twice.ok).toBe(false);
    expect(fleet.links).toHaveLength(2);
  });

  it('re-plugs an input in one edit', async () => {
    const fleet = await mockFleet();
    const result = fleet.editLinks({ remove: ['down:1'], add: [{ from: 'up:aux.1', to: 'down:1' }] });
    expect(result.ok).toBe(true);
    expect(fleet.links).toEqual([{ from: 'up:aux.1', to: 'down:1' }]);
  });

  it('refuses a cable to an output that does not exist, and changes nothing', async () => {
    const fleet = await mockFleet();
    const result = fleet.editLinks({ remove: ['down:1'], add: [{ from: 'up:aux.99', to: 'down:1' }] });
    expect(result.ok).toBe(false);
    expect(fleet.links).toEqual([{ from: 'up:aux.0', to: 'down:1' }]);
  });

  it('names the cables a removed device leaves behind', async () => {
    const fleet = await mockFleet();
    const result = await fleet.removeDevice('up');
    expect(result.orphaned).toContain('1 cable on the wiring page');
  });
});

describe('routeThrough', () => {
  it('routes upstream then downstream, as planned from the snapshot', async () => {
    const fleet = await mockFleet();
    const snapshot = fleet.snapshot();
    const plan = planRoute(snapshot.devices, snapshot.links, { deviceId: 'up', source: 3 }, { deviceId: 'down', destination: 'aux.0' });
    expect(plan.ok).toBe(true);
    const steps = plan.routes[0]!.steps.map(({ deviceId, destination, source }) => ({ deviceId, destination, source }));
    expect(steps).toEqual([
      { deviceId: 'up', destination: 'aux.0', source: 3 },
      { deviceId: 'down', destination: 'aux.0', source: 1 },
    ]);

    const result = await fleet.routeThrough(steps, '10.0.0.9', { ownLockHolds: true });
    expect(result).toEqual({ ok: true, applied: 2, failures: [] });
    expect(routeOf(fleet, 'up', 'aux.0')).toBe(3);
    expect(routeOf(fleet, 'down', 'aux.0')).toBe(1);
  });

  it('stops at a refusal rather than cutting to a cable without the picture', async () => {
    const fleet = await mockFleet();
    const before = routeOf(fleet, 'down', 'aux.0');
    expect(fleet.lock('up', 'aux.0', 'lock', '10.0.0.5').ok).toBe(true);

    const result = await fleet.routeThrough(
      [
        { deviceId: 'up', destination: 'aux.0', source: 3 },
        { deviceId: 'down', destination: 'aux.0', source: 1 },
      ],
      '10.0.0.9',
      { ownLockHolds: true },
    );
    expect(result.ok).toBe(false);
    expect(result.applied).toBe(0);
    expect(result.failures[0]).toMatch(/claimed by 10\.0\.0\.5/);
    expect(result.failures[1]).toMatch(/stopped before down\/aux\.0/);
    expect(routeOf(fleet, 'down', 'aux.0')).toBe(before);
  });

  it('sends nothing for a step that is already up', async () => {
    const fleet = await mockFleet();
    await fleet.route('up', 'aux.0', 3, 'x');
    // Claimed, but already right: nothing to send, so nothing to refuse.
    expect(fleet.lock('up', 'aux.0', 'lock', '10.0.0.5').ok).toBe(true);
    const result = await fleet.routeThrough(
      [
        { deviceId: 'up', destination: 'aux.0', source: 3 },
        { deviceId: 'down', destination: 'aux.0', source: 1 },
      ],
      '10.0.0.9',
      { ownLockHolds: true },
    );
    expect(result).toEqual({ ok: true, applied: 1, failures: [] });
  });
});

describe('a Videohub claim', () => {
  it('reaches the browsers when only the lock moved', async () => {
    const { startMockRouter } = await import('../videohub/mockRouter.js');
    const router = await startMockRouter(0, 4);
    const fleet = new Fleet(
      {
        ...configFor(),
        devices: [{ id: 'hub', name: 'Hub', type: 'videohub', address: `127.0.0.1:${router.port}` }],
        links: [],
      },
      false,
    );
    try {
      await fleet.start();
      const deadline = Date.now() + 3000;
      while (!fleet.snapshot().devices[0]?.matrix && Date.now() < deadline) await new Promise((r) => setTimeout(r, 20));

      const pushed = new Promise<string | null>((resolve) => {
        const onChange = (): void => {
          const owner = fleet.snapshot().devices[0]?.locks['out.1'] ?? null;
          if (owner !== null) {
            fleet.off('change', onChange);
            resolve(owner);
          }
        };
        fleet.on('change', onChange);
        setTimeout(() => resolve(null), 2000);
      });
      expect(fleet.lock('hub', 'out.1', 'lock', '10.0.0.9').ok).toBe(true);
      expect(await pushed).toBe('this app');
    } finally {
      await fleet.stop();
      await router.stop();
    }
  });
});
