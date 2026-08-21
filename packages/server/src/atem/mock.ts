import { ExternalPortType, buildSimulatedState, type SwitcherProfile } from '@av/atem-matrix';
import type { DeviceConfig } from '../config.js';
import { StateDevice } from './stateDevice.js';

/**
 * The shapes `--mock` stands up: a one-ME switcher, a four-ME one, and a small
 * one, chosen to exercise different corners of the matrix. Plausible shapes, not
 * model tables — nothing here should be read as "an ATEM Mini Extreme has
 * exactly this". The four-ME profile carries switchable input connectors so the
 * source-routing tab has something to do without hardware.
 */
const PROFILES: SwitcherProfile[] = [
  {
    product: 'Simulated 1 M/E switcher',
    inputs: 8,
    mixEffects: 1,
    usksPerMe: 4,
    auxes: 2,
    dsks: 2,
    superSources: 1,
    ssrcBoxes: 4,
    multiviewers: 1,
    mvWindows: 10,
    mediaPlayers: 2,
    colourGenerators: 2,
    cleanFeeds: 1,
    inputPorts: () => ({
      available: [ExternalPortType.HDMI],
      current: ExternalPortType.HDMI,
    }),
  },
  {
    product: 'Simulated 4 M/E switcher',
    inputs: 20,
    mixEffects: 4,
    usksPerMe: 4,
    auxes: 12,
    dsks: 4,
    superSources: 2,
    ssrcBoxes: 4,
    multiviewers: 2,
    mvWindows: 16,
    mediaPlayers: 4,
    colourGenerators: 2,
    cleanFeeds: 2,
    inputPorts: (input) =>
      input > 16
        ? { available: [ExternalPortType.SDI, ExternalPortType.RJ45], current: ExternalPortType.RJ45 }
        : { available: [ExternalPortType.SDI, ExternalPortType.HDMI], current: ExternalPortType.SDI },
  },
  {
    product: 'Simulated compact switcher',
    inputs: 4,
    mixEffects: 1,
    usksPerMe: 1,
    auxes: 1,
    dsks: 1,
    superSources: 0,
    ssrcBoxes: 0,
    multiviewers: 1,
    mvWindows: 10,
    mediaPlayers: 1,
    colourGenerators: 2,
    cleanFeeds: 1,
    inputPorts: () => ({
      available: [ExternalPortType.HDMI],
      current: ExternalPortType.HDMI,
    }),
  },
];

/**
 * A synthetic switcher, for `--mock`. Its state comes from the same builder the
 * browser simulator uses, and it honours routing commands through StateDevice,
 * so the whole app runs end to end with no hardware on the network.
 */
export class MockDevice extends StateDevice {
  constructor(config: DeviceConfig, index: number) {
    const profile = PROFILES[index % PROFILES.length] as SwitcherProfile;
    super({
      id: config.id,
      name: config.name,
      address: config.address,
      model: profile.product,
      state: buildSimulatedState(profile, index),
    });
  }
}

// This mock used to refuse routes to multiview windows 1 and 2, on the received
// wisdom that they are wired to program and preview. A probe of a real ATEM Mini
// Extreme ISO (2026-08-21) disproved it: both accepted every source their masks
// allowed, across all 16 windows, with no disagreements in 80 tests. The
// behaviour was removed rather than kept as a "safe" default — a mock that
// refuses what the hardware accepts teaches the wrong thing.
