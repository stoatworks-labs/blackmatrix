import { describe, expect, it } from 'vitest';
import type { AppConfig } from '../config.js';
import { Fleet } from '../fleet.js';

/**
 * Who a lock stops.
 *
 * Ownership is per address, which is Videohub's rule and the reason a panel may
 * still route through a lock it holds. The browser and the phone app sit at an
 * address too, so under that rule alone the operator who claimed a destination
 * is the one client it would not stop — which is what "the lock button does
 * nothing" looked like from the outside. `ownLockHolds`, which the HTTP API
 * asks for and no protocol client does, is the difference; in the app's own
 * language that is a claim rather than a lock.
 */

function configFor(): AppConfig {
  return {
    port: 0,
    videohub: { enabled: false, basePort: 9990, host: '127.0.0.1' },
    devices: [{ id: 'mock', name: 'Mock', address: 'mock' }],
    labels: {},
    salvos: [],
    ties: [],
    failover: [],
  };
}

async function mockFleet(): Promise<Fleet> {
  const fleet = new Fleet(configFor(), true);
  await fleet.start();
  return fleet;
}

/** A destination every simulated switcher has, and a source it will accept. */
const DEST = 'aux.0';
const SOURCE = 2;

describe('locks', () => {
  it('lets the owner route through its own lock on a protocol path', async () => {
    const fleet = await mockFleet();
    expect(fleet.lock('mock', DEST, 'lock', '10.0.0.9').ok).toBe(true);

    const result = await fleet.route('mock', DEST, SOURCE, '10.0.0.9');
    expect(result.ok).toBe(true);
  });

  it('holds against the owner when the caller asks it to', async () => {
    const fleet = await mockFleet();
    expect(fleet.lock('mock', DEST, 'lock', '10.0.0.9').ok).toBe(true);

    const result = await fleet.route('mock', DEST, SOURCE, '10.0.0.9', { ownLockHolds: true });
    expect(result.ok).toBe(false);
    expect(result.reason).toMatch(/release it/);
  });

  it('refuses another client either way, and names the owner', async () => {
    const fleet = await mockFleet();
    expect(fleet.lock('mock', DEST, 'lock', '10.0.0.9').ok).toBe(true);

    const result = await fleet.route('mock', DEST, SOURCE, '10.0.0.20');
    expect(result.ok).toBe(false);
    expect(result.reason).toContain('10.0.0.9');
  });

  it('routes again once the lock comes off', async () => {
    const fleet = await mockFleet();
    fleet.lock('mock', DEST, 'lock', '10.0.0.9');
    fleet.lock('mock', DEST, 'unlock', '10.0.0.9');

    const result = await fleet.route('mock', DEST, SOURCE, '10.0.0.9', { ownLockHolds: true });
    expect(result.ok).toBe(true);
  });

  it('still lets failover through a lock it did not set', async () => {
    const fleet = await mockFleet();
    fleet.lock('mock', DEST, 'lock', '10.0.0.9');

    const result = await fleet.route('mock', DEST, SOURCE, 'failover:main', {
      ownLockHolds: true,
      overrideLocks: true,
    });
    expect(result.ok).toBe(true);
  });
});
