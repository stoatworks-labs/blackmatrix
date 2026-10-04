import { Enums } from 'atem-connection';
import { describe, expect, it } from 'vitest';
import { checkLinks, linkInto, planRoute, traceSource, type Link, type WiredDevice } from '../links.js';
import { buildMatrix } from '../model.js';
import { buildRouterMatrix } from '../router.js';
import { buildSimulatedState, type SwitcherProfile } from '../simulate.js';

/**
 * The rig these are written against is the one the feature was asked for on: a
 * router whose first outputs are cabled into a switcher's inputs, and whose
 * later inputs are cabled from the switcher's aux outputs. Smaller, same shape.
 */
const switcherProfile: SwitcherProfile = {
  product: 'Test 2 M/E',
  inputs: 8,
  mixEffects: 2,
  usksPerMe: 1,
  auxes: 4,
  dsks: 1,
  superSources: 0,
  ssrcBoxes: 0,
  multiviewers: 1,
  mvWindows: 4,
  mediaPlayers: 1,
  colourGenerators: 1,
  cleanFeeds: 0,
  inputPorts: () => ({ available: [Enums.ExternalPortType.SDI], current: Enums.ExternalPortType.SDI }),
};

function hub(routing: number[]): WiredDevice {
  return {
    id: 'hub',
    name: 'Hub',
    matrix: buildRouterMatrix({
      inputLabels: [
        'Patch In 1',
        'Patch In 2',
        'Patch In 3',
        'Patch In 4',
        'Switcher Aux 1',
        'Switcher Aux 2',
        'Spare 7',
        'Spare 8',
      ],
      outputLabels: [
        'Switcher In 1',
        'Switcher In 2',
        'Switcher In 3',
        'Switcher In 4',
        'Patch Out 1',
        'Patch Out 2',
        'Screen L',
        'Screen R',
      ],
      routing,
    }),
    locks: {},
  };
}

function atem(): WiredDevice {
  const matrix = buildMatrix(buildSimulatedState(switcherProfile, 0));
  // A known starting picture rather than whatever the simulator seeds.
  for (const destination of matrix.destinations) matrix.routes[destination.id] = 0;
  return { id: 'atem', name: 'ATEM', matrix, locks: {} };
}

/** Hub out 1-4 into switcher inputs 1-4; switcher aux 1-2 into hub inputs 5-6. */
const WIRING: Link[] = [
  { from: 'hub:out.0', to: 'atem:1' },
  { from: 'hub:out.1', to: 'atem:2' },
  { from: 'hub:out.2', to: 'atem:3' },
  { from: 'hub:out.3', to: 'atem:4' },
  { from: 'atem:aux.0', to: 'hub:4' },
  { from: 'atem:aux.1', to: 'hub:5' },
];

function fleet(routing = [0, 1, 2, 3, 0, 0, 0, 0]): WiredDevice[] {
  return [hub(routing), atem()];
}

describe('checkLinks', () => {
  const ids = ['hub', 'atem'];

  it('accepts the rig', () => {
    expect(checkLinks(WIRING, fleet(), ids)).toBeNull();
  });

  it('refuses a second cable into one input', () => {
    const twice = [...WIRING, { from: 'hub:out.4', to: 'atem:1' }];
    expect(checkLinks(twice, fleet(), ids)).toMatch(/fed twice/);
  });

  it('refuses a device wired to itself', () => {
    expect(checkLinks([{ from: 'hub:out.0', to: 'hub:3' }], fleet(), ids)).toMatch(/itself/);
  });

  it('refuses ends that do not exist on a connected device', () => {
    expect(checkLinks([{ from: 'hub:out.99', to: 'atem:1' }], fleet(), ids)).toMatch(/no output/);
    expect(checkLinks([{ from: 'hub:out.0', to: 'atem:999' }], fleet(), ids)).toMatch(/no input/);
  });

  it('takes a disconnected device on trust, but not an unknown one', () => {
    const offline = fleet().map((device) => (device.id === 'atem' ? { ...device, matrix: null } : device));
    expect(checkLinks([{ from: 'hub:out.0', to: 'atem:999' }], offline, ids)).toBeNull();
    expect(checkLinks([{ from: 'hub:out.0', to: 'nowhere:1' }], offline, ids)).toMatch(/no such device/);
  });

  it('refuses refs that are not refs', () => {
    expect(checkLinks([{ from: 'hub', to: 'atem:1' }], fleet(), ids)).toMatch(/not deviceId/);
    expect(checkLinks([{ from: 'hub:out.0', to: 'atem:one' }], fleet(), ids)).toMatch(/not deviceId/);
  });
});

describe('traceSource', () => {
  it('follows a switcher input back through the router', () => {
    // Hub output 3 (into switcher input 3) is taking Patch In 2.
    const trace = traceSource(fleet([0, 1, 1, 3, 0, 0, 0, 0]), WIRING, 'atem', 3);
    expect(trace.broken).toBeUndefined();
    expect(trace.hops.map((hop) => `${hop.deviceId}:${hop.source}`)).toEqual(['atem:3', 'hub:1']);
    expect(trace.hops.at(-1)?.label).toBe('Patch In 2');
  });

  it('follows a router input back through the switcher', () => {
    const devices = fleet();
    devices[1]!.matrix!.routes['aux.0'] = 2;
    devices[0]!.matrix!.routes['out.1'] = 0;
    // Hub input 5 is switcher aux 1, which takes switcher input 2, which is hub out 2, which takes Patch In 1.
    const trace = traceSource(devices, WIRING, 'hub', 4);
    expect(trace.hops.map((hop) => `${hop.deviceId}:${hop.source}`)).toEqual(['hub:4', 'atem:2', 'hub:0']);
  });

  it('is its own origin with no cable in', () => {
    expect(traceSource(fleet(), WIRING, 'atem', 7).hops).toHaveLength(1);
  });

  it('says why it stopped when the far end is offline', () => {
    const devices = fleet().map((device) => (device.id === 'hub' ? { ...device, matrix: null } : device));
    const trace = traceSource(devices, WIRING, 'atem', 1);
    expect(trace.hops).toHaveLength(1);
    expect(trace.broken).toMatch(/not connected/);
  });

  it('stops on a loop rather than going round it', () => {
    const devices = fleet([4, 1, 2, 3, 0, 0, 0, 0]);
    devices[1]!.matrix!.routes['aux.0'] = 1;
    // atem:1 <- hub out.0 <- hub in 4 <- atem aux.0 <- atem:1 ...
    const trace = traceSource(devices, WIRING, 'atem', 1);
    expect(trace.broken).toMatch(/loops/);
  });
});

describe('planRoute', () => {
  it('routes a router input through to a switcher input with one crosspoint', () => {
    const plan = planRoute(fleet(), WIRING, { deviceId: 'hub', source: 6 }, { deviceId: 'atem', source: 3 });
    expect(plan.ok).toBe(true);
    const best = plan.routes[0]!;
    expect(best.steps).toEqual([
      { deviceId: 'hub', destination: 'out.2', source: 6, done: false, link: { from: 'hub:out.2', to: 'atem:3' } },
    ]);
    expect(plan.routes).toHaveLength(1);
  });

  it('routes a switcher output through the router to a router output', () => {
    const plan = planRoute(fleet(), WIRING, { deviceId: 'atem', destination: 'aux.1' }, { deviceId: 'hub', destination: 'out.6' });
    expect(plan.ok).toBe(true);
    expect(plan.routes[0]!.steps).toEqual([{ deviceId: 'hub', destination: 'out.6', source: 5, done: false }]);
  });

  it('routes a switcher source through an aux and the router to a screen', () => {
    const plan = planRoute(fleet(), WIRING, { deviceId: 'atem', source: 7 }, { deviceId: 'hub', destination: 'out.7' });
    expect(plan.ok).toBe(true);
    // Two auxes are cabled to the hub, so there are two ways.
    expect(plan.routes).toHaveLength(2);
    for (const route of plan.routes) {
      expect(route.steps[0]!.deviceId).toBe('atem');
      expect(route.steps[0]!.destination).toMatch(/^aux\./);
      expect(route.steps[1]!.destination).toBe('out.7');
    }
  });

  it('prefers a cable that already carries the picture', () => {
    // Patch In 3 is already on hub out 2 -> switcher input 2.
    const plan = planRoute(
      fleet([0, 2, 0, 3, 0, 0, 0, 0]),
      WIRING,
      { deviceId: 'hub', source: 2 },
      { deviceId: 'atem', destination: 'aux.3' },
    );
    expect(plan.ok).toBe(true);
    const best = plan.routes[0]!;
    expect(best.steps.map((step) => [step.deviceId, step.destination, step.done])).toEqual([
      ['hub', 'out.1', true],
      ['atem', 'aux.3', false],
    ]);
    expect(best.affected).toEqual([]);
  });

  it('names what repointing a cable disturbs downstream', () => {
    const devices = fleet();
    // Program on ME 1 is taking switcher input 1, which is hub out 1.
    devices[1]!.matrix!.routes['me.0.program'] = 1;
    const plan = planRoute(devices, WIRING, { deviceId: 'hub', source: 6 }, { deviceId: 'atem', source: 1 });
    const best = plan.routes[0]!;
    expect(best.affected).toContainEqual({ deviceId: 'atem', destination: 'me.0.program' });
  });

  it('follows the disturbance on through a second cable', () => {
    const devices = fleet([0, 1, 2, 3, 0, 0, 4, 0]);
    // Switcher aux 1 takes input 1 (hub out 1); hub screen L takes hub input 5 (switcher aux 1).
    devices[1]!.matrix!.routes['aux.0'] = 1;
    const plan = planRoute(devices, WIRING, { deviceId: 'hub', source: 6 }, { deviceId: 'atem', source: 1 });
    expect(plan.routes[0]!.affected).toEqual(
      expect.arrayContaining([
        { deviceId: 'atem', destination: 'aux.0' },
        { deviceId: 'hub', destination: 'out.6' },
      ]),
    );
  });

  it('marks every step done when the route is already up', () => {
    const plan = planRoute(fleet([0, 1, 6, 3, 0, 0, 0, 0]), WIRING, { deviceId: 'hub', source: 6 }, { deviceId: 'atem', source: 3 });
    expect(plan.routes[0]!.steps.every((step) => step.done)).toBe(true);
  });

  it('reports a claim as blocking and sorts it last', () => {
    const devices = fleet();
    devices[1]!.locks['aux.0'] = '10.0.0.5';
    const plan = planRoute(devices, WIRING, { deviceId: 'atem', source: 7 }, { deviceId: 'hub', destination: 'out.7' });
    expect(plan.routes[0]!.blocked).toEqual([]);
    expect(plan.routes.at(-1)!.blocked[0]).toMatch(/claimed by 10\.0\.0\.5/);
  });

  it('never sends an aux back onto an aux', () => {
    // Hub input 5 is switcher aux 1. Through hub out 1 it would land on switcher input 1 —
    // fine — but asking for it on an aux bus directly is the switcher's own rule.
    const plan = planRoute(
      fleet(),
      WIRING,
      { deviceId: 'atem', source: 8001 },
      { deviceId: 'atem', destination: 'aux.2' },
    );
    expect(plan.ok).toBe(false);
    expect(plan.reason).toMatch(/not available/);
  });

  it('explains an input with no cable into it', () => {
    const plan = planRoute(fleet(), WIRING, { deviceId: 'hub', source: 0 }, { deviceId: 'atem', source: 7 });
    expect(plan.ok).toBe(false);
    expect(plan.reason).toMatch(/no cable into it/);
  });

  it('explains an output wired to nothing', () => {
    const plan = planRoute(fleet(), WIRING, { deviceId: 'atem', destination: 'aux.3' }, { deviceId: 'hub', destination: 'out.6' });
    expect(plan.ok).toBe(false);
    expect(plan.reason).toMatch(/not wired/);
  });

  it('routes within one device without touching the wiring', () => {
    const plan = planRoute(fleet(), WIRING, { deviceId: 'hub', source: 1 }, { deviceId: 'hub', destination: 'out.5' });
    expect(plan.routes).toHaveLength(1);
    expect(plan.routes[0]!.steps).toEqual([{ deviceId: 'hub', destination: 'out.5', source: 1, done: false }]);
  });
});

describe('linkInto', () => {
  it('finds the cable by its input', () => {
    expect(linkInto(WIRING, 'atem', 2)?.from).toBe('hub:out.1');
    expect(linkInto(WIRING, 'atem', 6)).toBeUndefined();
  });
});
