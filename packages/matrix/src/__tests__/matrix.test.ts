import { AtemStateUtil, Enums, type AtemState } from 'atem-connection';
import { describe, expect, it } from 'vitest';
import { applyRoute, type AtemRouterCommands } from '../apply.js';
import { buildDestinations, buildMatrix, buildSources, readRoute, readRoutes } from '../model.js';
import { buildSimulatedState, type SwitcherProfile } from '../simulate.js';
import { applyRouteToState } from '../mutate.js';
import { isLegal } from '../validity.js';
import * as Local from '../enums.js';
import type { Destination, Source } from '../types.js';

const { InternalPortType, MeAvailability, SourceAvailability } = Enums;

function input(
  state: AtemState,
  inputId: number,
  longName: string,
  internalPortType: Enums.InternalPortType,
  sourceAvailability: number,
  meAvailability: number,
): void {
  state.inputs[inputId] = {
    inputId,
    longName,
    shortName: longName.slice(0, 4),
    areNamesDefault: true,
    externalPorts: null,
    externalPortType: Enums.ExternalPortType.Unknown,
    internalPortType,
    sourceAvailability,
    meAvailability,
  };
}

/** A two-ME switcher: 2 auxes, 2 USKs per ME, 1 DSK, 1 SuperSource, 1 multiviewer. */
function twoMeState(): AtemState {
  const state = AtemStateUtil.Create();
  state.info.productIdentifier = 'Test switcher';
  state.info.capabilities = {
    mixEffects: 2,
    sources: 4,
    auxilliaries: 2,
    mixMinusOutputs: 0,
    mediaPlayers: 1,
    serialPorts: 0,
    maxHyperdecks: 0,
    DVEs: 1,
    stingers: 1,
    superSources: 1,
    talkbackChannels: 0,
    downstreamKeyers: 1,
    cameraControl: false,
    advancedChromaKeyers: false,
    onlyConfigurableOutputs: false,
  };
  state.info.mixEffects = [{ keyCount: 2 }, { keyCount: 2 }];
  state.info.superSources = [{ boxCount: 4 }];
  state.info.multiviewer = { count: 1, windowCount: 4 };

  input(state, 1, 'Camera 1', InternalPortType.External, SourceAvailability.All, MeAvailability.All);
  input(state, 2, 'Camera 2', InternalPortType.External, SourceAvailability.All, MeAvailability.All);
  input(state, 3011, 'MP 1 Key', InternalPortType.MediaPlayerKey, SourceAvailability.KeySource, MeAvailability.All);
  // Aux outputs, which double as sources so they can be watched on a
  // multiviewer and nowhere else. Their names are the switcher's own names for
  // those outputs, which is where the aux destinations get their labels.
  input(state, 8001, 'Output 1', InternalPortType.Auxiliary, SourceAvailability.Multiviewer, MeAvailability.None);
  input(state, 8002, 'Output 2', InternalPortType.Auxiliary, SourceAvailability.Multiviewer, MeAvailability.None);
  // An HDMI passthrough: allowed on an aux, but only on its own one. Taken from
  // a real ATEM Mini Extreme ISO, where "Camera 1 Direct" reports exactly this.
  input(
    state,
    11001,
    'Camera 1 Direct',
    InternalPortType.ExternalDirect,
    SourceAvailability.Auxiliary | SourceAvailability.Auxiliary1,
    MeAvailability.None,
  );
  // An ME 1 output may feed ME 2, an aux or a multiviewer — never ME 1.
  input(
    state,
    10010,
    'ME 1 Program',
    InternalPortType.MEOutput,
    SourceAvailability.Auxiliary | SourceAvailability.Multiviewer,
    MeAvailability.Me2,
  );

  state.video.auxilliaries[0] = 1;
  state.video.auxilliaries[1] = 2;
  for (const me of [0, 1]) {
    const mixEffect = AtemStateUtil.getMixEffect(state, me);
    mixEffect.programInput = me === 0 ? 1 : 2;
    mixEffect.previewInput = me === 0 ? 2 : 1;
  }
  // Keyers and SuperSource boxes exist in the state as well as in the
  // capabilities, so a route has somewhere to land. SuperSource *properties* are
  // deliberately left unset — that is the "the switcher has not said" case.
  for (const me of [0, 1]) {
    const mixEffect = AtemStateUtil.getMixEffect(state, me);
    for (const keyer of [0, 1]) {
      mixEffect.upstreamKeyers[keyer] = {
        upstreamKeyerId: keyer,
        canFlyKey: false,
        mixEffectKeyType: Enums.MixEffectKeyType.Luma,
        flyEnabled: false,
        fillSource: 1,
        cutSource: 3011,
        onAir: false,
        maskSettings: { maskEnabled: false, maskTop: 0, maskBottom: 0, maskLeft: 0, maskRight: 0 },
        flyKeyframes: [undefined, undefined],
      };
    }
  }
  state.video.downstreamKeyers[0] = {
    onAir: false,
    inTransition: false,
    remainingFrames: 0,
    isAuto: false,
    sources: { fillSource: 1, cutSource: 3011 },
  };
  const superSource = AtemStateUtil.getSuperSource(state, 0);
  for (const box of [0, 1, 2, 3] as const) {
    superSource.boxes[box] = {
      enabled: true,
      source: 1,
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

  const multiViewer = AtemStateUtil.getMultiViewer(state, 0);
  for (let win = 0; win < 4; win++) {
    multiViewer.windows[win] = {
      windowIndex: win,
      source: win + 1,
      supportsVuMeter: false,
      supportsSafeArea: false,
    };
  }
  return state;
}

const find = (destinations: Destination[], id: string): Destination => {
  const destination = destinations.find((candidate) => candidate.id === id);
  if (!destination) throw new Error(`no destination ${id}`);
  return destination;
};

const source = (sources: Source[], id: number): Source => {
  const found = sources.find((candidate) => candidate.id === id);
  if (!found) throw new Error(`no source ${id}`);
  return found;
};

describe('buildSources', () => {
  it('lists every source in ATEM id order, since that order is the panel numbering', () => {
    const sources = buildSources(twoMeState());
    expect(sources.map((candidate) => candidate.id)).toEqual([1, 2, 3011, 8001, 8002, 10010, 11001]);
    expect(sources[0]?.kind).toBe('input');
    expect(sources[3]?.kind).toBe('aux');
  });
});

describe('buildDestinations', () => {
  const destinations = buildDestinations(twoMeState());

  it('covers every routable bus on the switcher', () => {
    expect(destinations.map((destination) => destination.id)).toEqual([
      'aux.0',
      'aux.1',
      'me.0.program',
      'me.0.preview',
      'me.1.program',
      'me.1.preview',
      'me.0.usk.0.fill',
      'me.0.usk.0.key',
      'me.0.usk.1.fill',
      'me.0.usk.1.key',
      'me.1.usk.0.fill',
      'me.1.usk.0.key',
      'me.1.usk.1.fill',
      'me.1.usk.1.key',
      'dsk.0.fill',
      'dsk.0.key',
      'ssrc.0.box.0',
      'ssrc.0.box.1',
      'ssrc.0.box.2',
      'ssrc.0.box.3',
      'ssrc.0.art.fill',
      'ssrc.0.art.key',
      'mv.0.window.0',
      'mv.0.window.1',
      'mv.0.window.2',
      'mv.0.window.3',
    ]);
  });

  it('groups them into sections, outputs first', () => {
    expect(find(destinations, 'aux.0').section).toBe('outputs');
    expect(find(destinations, 'me.0.program').section).toBe('buses');
    expect(find(destinations, 'dsk.0.key').section).toBe('keyers');
    expect(find(destinations, 'ssrc.0.art.fill').section).toBe('supersource');
    expect(find(destinations, 'mv.0.window.2').section).toBe('multiview');
  });

  it('names the ME when there is more than one', () => {
    expect(find(destinations, 'me.1.program').label).toBe('ME 2 Program');
    const single = buildDestinations(oneMeState());
    expect(find(single, 'me.0.program').label).toBe('Program');
  });

  it('warns that a program route cuts to air', () => {
    expect(find(destinations, 'me.0.program').caveat).toMatch(/cuts/);
  });

  it('does not warn about the first multiview windows', () => {
    // Received wisdom says windows 1 and 2 are wired to program and preview. A
    // probe of a real ATEM Mini Extreme ISO (2026-08-21) says otherwise: both
    // accepted every source their masks allowed, 80 tests, no disagreements.
    expect(find(destinations, 'mv.0.window.0').caveat).toBeUndefined();
    expect(find(destinations, 'mv.0.window.1').caveat).toBeUndefined();
  });

  it('builds no multiview windows for a switcher whose multiview is fixed', () => {
    // An ATEM Mini Pro shows ten multiview windows and routes none of them; the
    // base Mini has no multiview output at all. A profile says so with zero
    // windows, or zero multiviewers, and either way the grid must not offer a
    // crosspoint the hardware would ignore.
    const fixed = buildDestinations(
      buildSimulatedState({ ...miniProfile(), multiviewers: 1, mvWindows: 0 }, 0),
    );
    expect(fixed.filter((destination) => destination.kind === 'mvWindow')).toHaveLength(0);

    const none = buildDestinations(
      buildSimulatedState({ ...miniProfile(), multiviewers: 0, mvWindows: 0 }, 0),
    );
    expect(none.filter((destination) => destination.section === 'multiview')).toHaveLength(0);

    // And a switcher that does route its windows still gets them.
    const extreme = buildDestinations(
      buildSimulatedState({ ...miniProfile(), multiviewers: 1, mvWindows: 16 }, 0),
    );
    expect(extreme.filter((destination) => destination.kind === 'mvWindow')).toHaveLength(16);
  });

  it('labels aux destinations with the switcher’s own names for those outputs', () => {
    expect(find(destinations, 'aux.0').label).toBe('Output 1');
    expect(find(destinations, 'aux.1').label).toBe('Output 2');
  });
});

/** A Mini-shaped profile, as the browser simulator's model list declares one. */
function miniProfile(): SwitcherProfile {
  return {
    product: 'ATEM Mini Pro',
    inputs: 4,
    mixEffects: 1,
    usksPerMe: 1,
    auxes: 1,
    dsks: 1,
    superSources: 0,
    ssrcBoxes: 4,
    multiviewers: 1,
    mvWindows: 0,
    mediaPlayers: 1,
    colourGenerators: 2,
    cleanFeeds: 1,
    inputPorts: () => ({ available: [Enums.ExternalPortType.HDMI], current: Enums.ExternalPortType.HDMI }),
  };
}

function oneMeState(): AtemState {
  const state = twoMeState();
  state.info.capabilities = { ...state.info.capabilities!, mixEffects: 1 };
  state.info.mixEffects = [{ keyCount: 1 }];
  return state;
}

describe('isLegal', () => {
  const state = twoMeState();
  const sources = buildSources(state);
  const destinations = buildDestinations(state);

  it('keeps an aux output off an aux bus, but allows it on a multiviewer', () => {
    const auxOutput = source(sources, 8001);
    expect(isLegal(auxOutput, find(destinations, 'aux.0'))).toBe(false);
    expect(isLegal(auxOutput, find(destinations, 'mv.0.window.2'))).toBe(true);
  });

  it('keeps an ME output off its own bus but allows it on the next one', () => {
    const meProgram = source(sources, 10010);
    expect(isLegal(meProgram, find(destinations, 'me.0.program'))).toBe(false);
    expect(isLegal(meProgram, find(destinations, 'me.1.program'))).toBe(true);
    expect(isLegal(meProgram, find(destinations, 'aux.0'))).toBe(true);
  });

  it('allows a key-only source on a key input and nowhere else', () => {
    const keyOnly = source(sources, 3011);
    expect(isLegal(keyOnly, find(destinations, 'me.0.usk.0.key'))).toBe(true);
    expect(isLegal(keyOnly, find(destinations, 'dsk.0.key'))).toBe(true);
    expect(isLegal(keyOnly, find(destinations, 'aux.0'))).toBe(false);
    expect(isLegal(keyOnly, find(destinations, 'ssrc.0.box.0'))).toBe(false);
  });

  it('keeps a passthrough source on its own aux and off the others', () => {
    // Aux|Aux1 and nothing else: the general bit says "an aux", bit 32 says
    // which one. Reading the general bit as sufficient would put Camera 1 Direct
    // on every output.
    const direct = source(sources, 11001);
    expect(isLegal(direct, find(destinations, 'aux.0'))).toBe(true);
    expect(isLegal(direct, find(destinations, 'aux.1'))).toBe(false);
    expect(isLegal(direct, find(destinations, 'mv.0.window.2'))).toBe(false);
  });

  it('lets an ordinary camera go anywhere', () => {
    // A camera reports every availability bit, including all three aux-bus ones,
    // so the restriction rule must not catch it.
    const camera = source(sources, 1);
    for (const destination of destinations) {
      expect(isLegal(camera, destination), destination.id).toBe(true);
    }
  });
});

describe('readRoutes', () => {
  it('reads what each destination is taking out of the switcher state', () => {
    const state = twoMeState();
    const matrix = buildMatrix(state);
    expect(matrix.routes['aux.0']).toBe(1);
    expect(matrix.routes['aux.1']).toBe(2);
    expect(matrix.routes['me.1.program']).toBe(2);
    expect(matrix.routes['me.0.preview']).toBe(2);
    expect(matrix.routes['mv.0.window.3']).toBe(4);
  });

  it('reports -1 rather than guessing when the state has nothing to say', () => {
    const state = twoMeState();
    const destinations = buildDestinations(state);
    const routes = readRoutes(state, destinations);
    expect(routes['ssrc.0.art.fill']).toBe(-1);
  });
});

describe('applyRoute', () => {
  function spyCommands() {
    const calls: string[] = [];
    const commands: AtemRouterCommands = {
      setAuxSource: async (source, bus) => void calls.push(`aux ${source} ${bus}`),
      changeProgramInput: async (input, me) => void calls.push(`pgm ${input} ${me}`),
      changePreviewInput: async (input, me) => void calls.push(`pvw ${input} ${me}`),
      setUpstreamKeyerFillSource: async (fill, me, keyer) => void calls.push(`uskFill ${fill} ${me} ${keyer}`),
      setUpstreamKeyerCutSource: async (cut, me, keyer) => void calls.push(`uskKey ${cut} ${me} ${keyer}`),
      setDownstreamKeyFillSource: async (input, key) => void calls.push(`dskFill ${input} ${key}`),
      setDownstreamKeyCutSource: async (input, key) => void calls.push(`dskKey ${input} ${key}`),
      setSuperSourceBoxSettings: async (props, box, ssrc) =>
        void calls.push(`box ${props.source} ${box} ${ssrc}`),
      setSuperSourceProperties: async (props, ssrc) =>
        void calls.push(`art ${JSON.stringify(props)} ${ssrc}`),
      setMultiViewerWindowSource: async (source, mv, window) => void calls.push(`mv ${source} ${mv} ${window}`),
    };
    return { calls, commands };
  }

  const destinations = buildDestinations(twoMeState());

  it('sends each kind of destination to the right command, with the right indexes', async () => {
    const { calls, commands } = spyCommands();
    await applyRoute(commands, find(destinations, 'aux.1'), 5);
    await applyRoute(commands, find(destinations, 'me.1.program'), 5);
    await applyRoute(commands, find(destinations, 'me.1.usk.1.key'), 5);
    await applyRoute(commands, find(destinations, 'dsk.0.fill'), 5);
    await applyRoute(commands, find(destinations, 'ssrc.0.box.2'), 5);
    await applyRoute(commands, find(destinations, 'ssrc.0.art.key'), 5);
    await applyRoute(commands, find(destinations, 'mv.0.window.3'), 5);

    expect(calls).toEqual([
      'aux 5 1',
      'pgm 5 1',
      'uskKey 5 1 1',
      'dskFill 5 0',
      'box 5 2 0',
      'art {"artCutSource":5} 0',
      'mv 5 0 3',
    ]);
  });
});

describe('the inlined enums', () => {
  // This package inlines a few of atem-connection's enum values so it can be
  // bundled for a browser — importing them for real pulls in UDP sockets and
  // worker threads. Inlining is only safe while the values still match, so this
  // asserts exactly that, against the library itself.
  it('still matches atem-connection', () => {
    expect(Local.InternalPortType.Auxiliary).toBe(Enums.InternalPortType.Auxiliary);
    expect(Local.InternalPortType.ExternalDirect).toBe(Enums.InternalPortType.ExternalDirect);
    expect(Local.InternalPortType.MEOutput).toBe(Enums.InternalPortType.MEOutput);
    expect(Local.SourceAvailability.All).toBe(Enums.SourceAvailability.All);
    expect(Local.SourceAvailability.Auxiliary1).toBe(Enums.SourceAvailability.Auxiliary1);
    expect(Local.SourceAvailability.WebcamOut).toBe(Enums.SourceAvailability.WebcamOut);
    expect(Local.SourceAvailability.KeySource).toBe(Enums.SourceAvailability.KeySource);
    expect(Local.MeAvailability.All).toBe(Enums.MeAvailability.All);
    expect(Local.MeAvailability.Me4).toBe(Enums.MeAvailability.Me4);
    expect(Local.ExternalPortType.RJ45).toBe(Enums.ExternalPortType.RJ45);
    expect(Local.ExternalPortType.SDI).toBe(Enums.ExternalPortType.SDI);
    expect(Local.ExternalPortType.HDMI).toBe(Enums.ExternalPortType.HDMI);
  });
});

describe('applyRouteToState', () => {
  // The browser simulator has no hardware to ask, so this is what "the switcher
  // accepted it" means there. It must move exactly the field the reader reads.
  it('moves what readRoute then reports, for every kind of destination', () => {
    const state = twoMeState();
    const destinations = buildDestinations(state);
    for (const destination of destinations) {
      // The SuperSource art sources are the fixture's deliberate gap: the state
      // has no properties block, which the next case covers.
      if (destination.kind === 'ssrcArtFill' || destination.kind === 'ssrcArtKey') continue;
      applyRouteToState(state, destination, 2);
      expect(readRoute(state, destination), destination.id).toBe(2);
    }
  });

  it('ignores a destination the state has no slot for, as a switcher does', () => {
    const state = twoMeState();
    const phantom = { ...find(buildDestinations(state), 'dsk.0.fill'), address: { unit: 9 } };
    expect(() => applyRouteToState(state, phantom, 2)).not.toThrow();
  });
});
