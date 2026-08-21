import { AtemStateUtil, Enums, type AtemState } from 'atem-connection';
import type { DeviceConfig } from '../config.js';
import { StateDevice } from './stateDevice.js';

const { InternalPortType, MeAvailability, SourceAvailability } = Enums;

/**
 * The shape of a simulated switcher. These are *plausible* shapes chosen to
 * exercise the matrix — a one-ME switcher, a four-ME one, and a small one — not
 * verified model tables. Nothing here should be read as "an ATEM Mini Extreme
 * has exactly this".
 */
interface MockProfile {
  product: string;
  inputs: number;
  mixEffects: number;
  usksPerMe: number;
  auxes: number;
  dsks: number;
  superSources: number;
  ssrcBoxes: number;
  multiviewers: number;
  mvWindows: number;
  mediaPlayers: number;
  colourGenerators: number;
  cleanFeeds: number;
  /**
   * The connectors each input accepts, by input number. Most switchers offer
   * one and no choice; the four-ME profile offers SDI/HDMI on its first inputs
   * and SDI/network on its last, so the source-routing tab has something real to
   * do without hardware. Invented shapes, like the rest of this file.
   */
  inputPorts: (input: number) => { available: Enums.ExternalPortType[]; current: Enums.ExternalPortType };
}

const PROFILES: MockProfile[] = [
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
      available: [Enums.ExternalPortType.HDMI],
      current: Enums.ExternalPortType.HDMI,
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
        ? { available: [Enums.ExternalPortType.SDI, Enums.ExternalPortType.RJ45], current: Enums.ExternalPortType.RJ45 }
        : { available: [Enums.ExternalPortType.SDI, Enums.ExternalPortType.HDMI], current: Enums.ExternalPortType.SDI },
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
      available: [Enums.ExternalPortType.HDMI],
      current: Enums.ExternalPortType.HDMI,
    }),
  },
];

/** ATEM source numbering, as used by the real protocol. */
const SOURCE_BLACK = 0;
const SOURCE_BARS = 1000;
const SOURCE_COLOUR = 2001;
const SOURCE_MEDIA_PLAYER = 3010;
const SOURCE_SUPERSOURCE = 6000;
const SOURCE_CLEAN_FEED = 7001;
const SOURCE_AUX = 8001;
const SOURCE_ME = 10010;

function addInput(
  state: AtemState,
  inputId: number,
  longName: string,
  shortName: string,
  internalPortType: Enums.InternalPortType,
  availability: number,
  meAvailability: number,
  ports?: { available: Enums.ExternalPortType[]; current: Enums.ExternalPortType },
): void {
  state.inputs[inputId] = {
    inputId,
    longName,
    shortName,
    areNamesDefault: true,
    externalPorts: ports?.available ?? null,
    externalPortType: ports?.current ?? Enums.ExternalPortType.Internal,
    internalPortType,
    sourceAvailability: availability,
    meAvailability,
  };
}

function buildState(profile: MockProfile, seed: number): AtemState {
  const state = AtemStateUtil.Create();
  state.info.model = Enums.Model.Unknown;
  state.info.productIdentifier = profile.product;
  state.info.apiVersion = Enums.ProtocolVersion.V8_1_1;
  state.settings.videoMode = Enums.VideoMode.P1080i50;
  state.info.capabilities = {
    mixEffects: profile.mixEffects,
    sources: profile.inputs,
    auxilliaries: profile.auxes,
    mixMinusOutputs: 0,
    mediaPlayers: profile.mediaPlayers,
    serialPorts: 0,
    maxHyperdecks: 0,
    DVEs: 1,
    stingers: 1,
    superSources: profile.superSources,
    talkbackChannels: 0,
    downstreamKeyers: profile.dsks,
    cameraControl: true,
    advancedChromaKeyers: true,
    onlyConfigurableOutputs: false,
  };
  state.info.mixEffects = Array.from({ length: profile.mixEffects }, () => ({
    keyCount: profile.usksPerMe,
  }));
  state.info.superSources = Array.from({ length: profile.superSources }, () => ({
    boxCount: profile.ssrcBoxes,
  }));
  state.info.multiviewer = { count: profile.multiviewers, windowCount: profile.mvWindows };

  const allMes = (1 << profile.mixEffects) - 1;

  addInput(state, SOURCE_BLACK, 'Black', 'Blk', InternalPortType.Black, SourceAvailability.All, allMes);
  for (let i = 1; i <= profile.inputs; i++) {
    addInput(
      state,
      i,
      `Camera ${i}`,
      `Cam${i}`,
      InternalPortType.External,
      SourceAvailability.All,
      allMes,
      profile.inputPorts(i),
    );
  }
  addInput(state, SOURCE_BARS, 'Bars', 'Bars', InternalPortType.ColorBars, SourceAvailability.All, allMes);
  for (let i = 0; i < profile.colourGenerators; i++) {
    addInput(
      state,
      SOURCE_COLOUR + i,
      `Color ${i + 1}`,
      `Col${i + 1}`,
      InternalPortType.ColorGenerator,
      SourceAvailability.All,
      allMes,
    );
  }
  for (let i = 0; i < profile.mediaPlayers; i++) {
    addInput(
      state,
      SOURCE_MEDIA_PLAYER + i * 10,
      `Media Player ${i + 1}`,
      `MP${i + 1}`,
      InternalPortType.MediaPlayerFill,
      SourceAvailability.All,
      allMes,
    );
    addInput(
      state,
      SOURCE_MEDIA_PLAYER + i * 10 + 1,
      `Media Player ${i + 1} Key`,
      `MP${i + 1}K`,
      InternalPortType.MediaPlayerKey,
      SourceAvailability.KeySource | SourceAvailability.Auxiliary | SourceAvailability.Multiviewer,
      allMes,
    );
  }
  for (let i = 0; i < profile.superSources; i++) {
    addInput(
      state,
      SOURCE_SUPERSOURCE + i,
      profile.superSources > 1 ? `SuperSource ${i + 1}` : 'SuperSource',
      `SSrc${profile.superSources > 1 ? i + 1 : ''}`,
      InternalPortType.SuperSource,
      // A SuperSource can go to air, an aux or a multiview window, but not into
      // itself.
      SourceAvailability.Auxiliary | SourceAvailability.Multiviewer | SourceAvailability.KeySource,
      allMes,
    );
  }
  for (let i = 0; i < profile.cleanFeeds; i++) {
    addInput(
      state,
      SOURCE_CLEAN_FEED + i,
      `Clean Feed ${i + 1}`,
      `Cln${i + 1}`,
      InternalPortType.MEOutput,
      SourceAvailability.Auxiliary | SourceAvailability.Multiviewer,
      MeAvailability.None,
    );
  }
  for (let i = 0; i < profile.auxes; i++) {
    addInput(
      state,
      SOURCE_AUX + i,
      `Aux ${i + 1}`,
      `Aux${i + 1}`,
      InternalPortType.Auxiliary,
      SourceAvailability.Multiviewer,
      MeAvailability.None,
    );
  }
  for (let me = 0; me < profile.mixEffects; me++) {
    // An ME output may feed a *higher* ME bus, an aux or a multiviewer — never
    // its own bus.
    const higherMes = allMes & ~((1 << (me + 1)) - 1);
    addInput(
      state,
      SOURCE_ME + me * 10,
      `ME ${me + 1} Program`,
      `M${me + 1}PG`,
      InternalPortType.MEOutput,
      SourceAvailability.Auxiliary | SourceAvailability.Multiviewer | SourceAvailability.KeySource,
      higherMes,
    );
    addInput(
      state,
      SOURCE_ME + me * 10 + 1,
      `ME ${me + 1} Preview`,
      `M${me + 1}PV`,
      InternalPortType.MEOutput,
      SourceAvailability.Auxiliary | SourceAvailability.Multiviewer,
      higherMes,
    );
  }

  for (let me = 0; me < profile.mixEffects; me++) {
    const mixEffect = AtemStateUtil.getMixEffect(state, me);
    mixEffect.programInput = ((me + seed) % profile.inputs) + 1;
    mixEffect.previewInput = ((me + seed + 1) % profile.inputs) + 1;
    for (let keyer = 0; keyer < profile.usksPerMe; keyer++) {
      mixEffect.upstreamKeyers[keyer] = {
        upstreamKeyerId: keyer,
        canFlyKey: true,
        mixEffectKeyType: Enums.MixEffectKeyType.Luma,
        flyEnabled: false,
        fillSource: SOURCE_MEDIA_PLAYER,
        cutSource: SOURCE_MEDIA_PLAYER + 1,
        onAir: false,
        maskSettings: { maskEnabled: false, maskTop: 0, maskBottom: 0, maskLeft: 0, maskRight: 0 },
        flyKeyframes: [undefined, undefined],
      };
    }
  }

  for (let key = 0; key < profile.dsks; key++) {
    state.video.downstreamKeyers[key] = {
      onAir: false,
      inTransition: false,
      remainingFrames: 0,
      isAuto: false,
      sources: { fillSource: SOURCE_MEDIA_PLAYER, cutSource: SOURCE_MEDIA_PLAYER + 1 },
    };
  }

  for (let bus = 0; bus < profile.auxes; bus++) {
    state.video.auxilliaries[bus] = ((bus + seed) % profile.inputs) + 1;
  }

  for (let ssrc = 0; ssrc < profile.superSources; ssrc++) {
    const superSource = AtemStateUtil.getSuperSource(state, ssrc);
    for (let box = 0; box < profile.ssrcBoxes; box++) {
      superSource.boxes[box as 0 | 1 | 2 | 3] = {
        enabled: box < 2,
        source: ((box + seed) % profile.inputs) + 1,
        x: 0,
        y: 0,
        size: 500,
        cropped: false,
        cropTop: 0,
        cropBottom: 0,
        cropLeft: 0,
        cropRight: 0,
      };
    }
    superSource.properties = {
      artFillSource: SOURCE_MEDIA_PLAYER,
      artCutSource: SOURCE_MEDIA_PLAYER + 1,
      artOption: Enums.SuperSourceArtOption.Background,
      artPreMultiplied: true,
      artClip: 0,
      artGain: 0,
      artInvertKey: false,
    };
  }

  for (let mv = 0; mv < profile.multiviewers; mv++) {
    const multiViewer = AtemStateUtil.getMultiViewer(state, mv);
    for (let win = 0; win < profile.mvWindows; win++) {
      multiViewer.windows[win] = {
        windowIndex: win,
        // Windows 1 and 2 are program and preview on most switchers.
        source: win === 0 ? SOURCE_ME : win === 1 ? SOURCE_ME + 1 : ((win + seed) % profile.inputs) + 1,
        supportsVuMeter: true,
        supportsSafeArea: win === 0,
      };
    }
    multiViewer.properties = { layout: Enums.MultiViewerLayout.Default, programPreviewSwapped: false };
  }

  return state;
}

/**
 * A synthetic switcher, for `--mock`. Its state is invented — plausible shapes
 * chosen to exercise the matrix, not model tables — and it honours the routing
 * commands through StateDevice, so the whole app runs end to end with no
 * hardware on the network.
 */
export class MockDevice extends StateDevice {
  private profile: MockProfile;

  constructor(config: DeviceConfig, index: number) {
    const profile = PROFILES[index % PROFILES.length] as MockProfile;
    super({
      id: config.id,
      name: config.name,
      address: config.address,
      model: profile.product,
      state: buildState(profile, index),
    });
    this.profile = profile;
  }

}

// This mock used to refuse routes to multiview windows 1 and 2, on the received
// wisdom that they are wired to program and preview. A probe of a real ATEM Mini
// Extreme ISO (2026-08-21) disproved it: both accepted every source their masks
// allowed, across all 16 windows, with no disagreements in 80 tests. The
// behaviour was removed rather than kept as a "safe" default — a mock that
// refuses what the hardware accepts teaches the wrong thing.
