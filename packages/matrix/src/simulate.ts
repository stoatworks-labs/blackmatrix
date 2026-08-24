import type { AtemState } from 'atem-connection';
import { ExternalPortType, InternalPortType, MeAvailability, SourceAvailability } from './enums.js';

/**
 * Building a plausible switcher out of nothing.
 *
 * Used by the mock fleet on the server and by the browser simulator, which is
 * the point: one definition of what a simulated switcher looks like, so the two
 * cannot drift into disagreeing about the thing they both claim to simulate.
 *
 * Everything here is a *shape*, not a model table. A profile says how many of
 * each thing a switcher has; it does not claim any particular product has those
 * numbers. Only a capture taken off hardware can say that.
 */

/**
 * The shape of a simulated switcher: how many of each thing it has, and which
 * connectors its inputs accept. A profile is a shape, never a claim about a
 * particular product.
 */
export interface SwitcherProfile {
  product: string;
  inputs: number;
  mixEffects: number;
  usksPerMe: number;
  auxes: number;
  dsks: number;
  superSources: number;
  ssrcBoxes: number;
  multiviewers: number;
  /**
   * Routable multiview windows per multiviewer, which is not the same as how
   * many windows the operator sees. Zero means a multiview whose windows take
   * no source — an ATEM Mini Pro's fixed ten-window layout — and zero
   * multiviewers means no multiview output at all, as on the base ATEM Mini.
   * Either way no destination is built, because a crosspoint the hardware would
   * ignore is worse than an absent one.
   */
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
  inputPorts: (input: number) => { available: ExternalPortType[]; current: ExternalPortType };
}



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
  internalPortType: InternalPortType,
  availability: number,
  meAvailability: number,
  ports?: { available: ExternalPortType[]; current: ExternalPortType },
): void {
  state.inputs[inputId] = {
    inputId,
    longName,
    shortName,
    areNamesDefault: true,
    externalPorts: ports?.available ?? null,
    externalPortType: ports?.current ?? ExternalPortType.Internal,
    internalPortType,
    sourceAvailability: availability,
    meAvailability,
  };
}

export function buildSimulatedState(profile: SwitcherProfile, seed: number): AtemState {
  const state = emptyState();
  state.info.model = 0;
  state.info.productIdentifier = profile.product;
  state.info.apiVersion = 131102;
  state.settings.videoMode = 13;
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
    const mixEffect = getMixEffect(state, me);
    mixEffect.programInput = ((me + seed) % profile.inputs) + 1;
    mixEffect.previewInput = ((me + seed + 1) % profile.inputs) + 1;
    for (let keyer = 0; keyer < profile.usksPerMe; keyer++) {
      mixEffect.upstreamKeyers[keyer] = {
        upstreamKeyerId: keyer,
        canFlyKey: true,
        mixEffectKeyType: 0,
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
    const superSource = getSuperSource(state, ssrc);
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
      artOption: 0,
      artPreMultiplied: true,
      artClip: 0,
      artGain: 0,
      artInvertKey: false,
    };
  }

  for (let mv = 0; mv < profile.multiviewers; mv++) {
    const multiViewer = getMultiViewer(state, mv);
    for (let win = 0; win < profile.mvWindows; win++) {
      multiViewer.windows[win] = {
        windowIndex: win,
        // Windows 1 and 2 are program and preview on most switchers.
        source: win === 0 ? SOURCE_ME : win === 1 ? SOURCE_ME + 1 : ((win + seed) % profile.inputs) + 1,
        supportsVuMeter: true,
        supportsSafeArea: win === 0,
      };
    }
    multiViewer.properties = { layout: 0, programPreviewSwapped: false };
  }

  return state;
}


/**
 * A blank AtemState and the three accessors this builder needs.
 *
 * atem-connection has all of these, but importing them costs the whole library
 * at runtime — sockets and worker threads — which cannot go in a browser bundle.
 * The shapes are its own; only the reach is different.
 */
function emptyState(): AtemState {
  return {
    info: { apiVersion: 0, model: 0, superSources: [], mixEffects: [], power: [] },
    video: { mixEffects: [], downstreamKeyers: [], auxilliaries: [], superSources: [] },
    media: { stillPool: [], clipPool: [], players: [] },
    inputs: {},
    macro: {
      macroPlayer: { isRunning: false, isWaiting: false, loop: false, macroIndex: 0 },
      macroRecorder: { isRecording: false, macroIndex: 0 },
      macroProperties: [],
    },
    settings: { multiViewers: [], videoMode: 0 },
  } as unknown as AtemState;
}

function getMixEffect(state: AtemState, index: number) {
  const existing = state.video.mixEffects[index];
  if (existing) return existing;
  const created = {
    index,
    programInput: 0,
    previewInput: 0,
    transitionPreview: false,
    transitionPosition: { inTransition: false, handlePosition: 0, remainingFrames: 0 },
    transitionProperties: { style: 0, selection: [0], nextStyle: 0, nextSelection: [0] },
    transitionSettings: {},
    upstreamKeyers: [],
  } as unknown as NonNullable<AtemState['video']['mixEffects'][number]>;
  state.video.mixEffects[index] = created;
  return created;
}

function getSuperSource(state: AtemState, index: number) {
  const existing = state.video.superSources[index];
  if (existing) return existing;
  const created = {
    index,
    boxes: [undefined, undefined, undefined, undefined],
  } as unknown as NonNullable<AtemState['video']['superSources'][number]>;
  state.video.superSources[index] = created;
  return created;
}

function getMultiViewer(state: AtemState, index: number) {
  const existing = state.settings.multiViewers[index];
  if (existing) return existing;
  const created = { index, windows: [] } as unknown as NonNullable<
    AtemState['settings']['multiViewers'][number]
  >;
  state.settings.multiViewers[index] = created;
  return created;
}
