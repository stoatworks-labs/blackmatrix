import { Enums, type AtemState } from 'atem-connection';
import {
  ATEM_SECTIONS,
  type Destination,
  type MatrixModel,
  type Source,
  type SourceKind,
} from './types.js';

/** Counts come from the switcher's reported capabilities, with the state arrays as a fallback. */
function counts(state: AtemState) {
  const caps = state.info.capabilities;
  const mixEffects = caps?.mixEffects ?? state.video.mixEffects.length;
  return {
    auxes: caps?.auxilliaries ?? state.video.auxilliaries.length,
    mixEffects,
    downstreamKeyers: caps?.downstreamKeyers ?? state.video.downstreamKeyers.length,
    superSources: caps?.superSources ?? state.video.superSources.length,
    multiviewers: state.info.multiviewer?.count ?? state.settings.multiViewers.length,
    multiviewWindows: state.info.multiviewer?.windowCount ?? 10,
  };
}

function classifySource(portType: Enums.InternalPortType): SourceKind {
  switch (portType) {
    case Enums.InternalPortType.External:
    case Enums.InternalPortType.ExternalDirect:
      return 'input';
    case Enums.InternalPortType.Black:
      return 'black';
    case Enums.InternalPortType.ColorBars:
      return 'bars';
    case Enums.InternalPortType.ColorGenerator:
      return 'colour';
    case Enums.InternalPortType.MediaPlayerFill:
      return 'mediaPlayer';
    case Enums.InternalPortType.MediaPlayerKey:
      return 'mediaPlayerKey';
    case Enums.InternalPortType.SuperSource:
      return 'supersource';
    case Enums.InternalPortType.MEOutput:
      return 'meOutput';
    case Enums.InternalPortType.Auxiliary:
      return 'aux';
    case Enums.InternalPortType.MultiViewer:
      return 'multiview';
    default:
      return 'other';
  }
}

/**
 * Every source the switcher reports, in ATEM source-id order. The position in
 * this array is the Videohub input number, so the order must stay stable.
 */
export function buildSources(state: AtemState): Source[] {
  const sources: Source[] = [];
  for (const key of Object.keys(state.inputs)) {
    const input = state.inputs[Number(key)];
    if (!input) continue;
    sources.push({
      id: input.inputId,
      label: input.longName || `Input ${input.inputId}`,
      short: input.shortName || String(input.inputId),
      kind: classifySource(input.internalPortType),
      availability: input.sourceAvailability,
      meAvailability: input.meAvailability,
    });
  }
  sources.sort((a, b) => a.id - b.id);
  return sources;
}

/**
 * Every routable destination, grouped into sections. The array order is the
 * Videohub output numbering, so sections are emitted in a fixed order and each
 * section counts up from unit 0.
 */
export function buildDestinations(state: AtemState): Destination[] {
  const c = counts(state);
  const destinations: Destination[] = [];
  const oneMe = c.mixEffects <= 1;
  const oneSsrc = c.superSources <= 1;
  const oneMv = c.multiviewers <= 1;
  const mePrefix = (me: number) => (oneMe ? '' : `ME ${me + 1} `);

  for (let bus = 0; bus < c.auxes; bus++) {
    destinations.push({
      id: `aux.${bus}`,
      kind: 'aux',
      section: 'outputs',
      label: `Aux ${bus + 1}`,
      short: `AUX ${bus + 1}`,
      address: { unit: bus },
    });
  }

  for (let me = 0; me < c.mixEffects; me++) {
    destinations.push({
      id: `me.${me}.program`,
      kind: 'program',
      section: 'buses',
      label: `${mePrefix(me)}Program`,
      short: oneMe ? 'PGM' : `M${me + 1} PGM`,
      address: { unit: me },
      caveat: 'Routing program cuts straight to air',
    });
    destinations.push({
      id: `me.${me}.preview`,
      kind: 'preview',
      section: 'buses',
      label: `${mePrefix(me)}Preview`,
      short: oneMe ? 'PVW' : `M${me + 1} PVW`,
      address: { unit: me },
    });
  }

  for (let me = 0; me < c.mixEffects; me++) {
    const keyCount =
      state.info.mixEffects[me]?.keyCount ?? state.video.mixEffects[me]?.upstreamKeyers.length ?? 0;
    for (let keyer = 0; keyer < keyCount; keyer++) {
      destinations.push({
        id: `me.${me}.usk.${keyer}.fill`,
        kind: 'uskFill',
        section: 'keyers',
        label: `${mePrefix(me)}USK ${keyer + 1} Fill`,
        short: `USK${keyer + 1} FIL`,
        address: { unit: me, slot: keyer },
      });
      destinations.push({
        id: `me.${me}.usk.${keyer}.key`,
        kind: 'uskKey',
        section: 'keyers',
        label: `${mePrefix(me)}USK ${keyer + 1} Key`,
        short: `USK${keyer + 1} KEY`,
        address: { unit: me, slot: keyer },
      });
    }
  }

  for (let key = 0; key < c.downstreamKeyers; key++) {
    destinations.push({
      id: `dsk.${key}.fill`,
      kind: 'dskFill',
      section: 'keyers',
      label: `DSK ${key + 1} Fill`,
      short: `DSK${key + 1} FIL`,
      address: { unit: key },
    });
    destinations.push({
      id: `dsk.${key}.key`,
      kind: 'dskKey',
      section: 'keyers',
      label: `DSK ${key + 1} Key`,
      short: `DSK${key + 1} KEY`,
      address: { unit: key },
    });
  }

  for (let ssrc = 0; ssrc < c.superSources; ssrc++) {
    const prefix = oneSsrc ? 'SuperSource ' : `SuperSource ${ssrc + 1} `;
    const boxCount = state.info.superSources[ssrc]?.boxCount ?? 4;
    for (let box = 0; box < boxCount; box++) {
      destinations.push({
        id: `ssrc.${ssrc}.box.${box}`,
        kind: 'ssrcBox',
        section: 'supersource',
        label: `${prefix}Box ${box + 1}`,
        short: oneSsrc ? `BOX ${box + 1}` : `S${ssrc + 1} BOX${box + 1}`,
        address: { unit: ssrc, slot: box },
      });
    }
    destinations.push({
      id: `ssrc.${ssrc}.art.fill`,
      kind: 'ssrcArtFill',
      section: 'supersource',
      label: `${prefix}Art Fill`,
      short: oneSsrc ? 'ART FIL' : `S${ssrc + 1} ARTF`,
      address: { unit: ssrc },
    });
    destinations.push({
      id: `ssrc.${ssrc}.art.key`,
      kind: 'ssrcArtKey',
      section: 'supersource',
      label: `${prefix}Art Key`,
      short: oneSsrc ? 'ART KEY' : `S${ssrc + 1} ARTK`,
      address: { unit: ssrc },
    });
  }

  for (let mv = 0; mv < c.multiviewers; mv++) {
    const windows = state.settings.multiViewers[mv]?.windows.length ?? c.multiviewWindows;
    for (let win = 0; win < windows; win++) {
      destinations.push({
        id: `mv.${mv}.window.${win}`,
        kind: 'mvWindow',
        section: 'multiview',
        label: oneMv ? `Multiview Window ${win + 1}` : `MV ${mv + 1} Window ${win + 1}`,
        short: oneMv ? `MV W${win + 1}` : `MV${mv + 1} W${win + 1}`,
        address: { unit: mv, slot: win },
        // On most ATEMs the first two windows are wired to program and preview
        // and the switcher simply ignores a route sent to them.
        caveat: win < 2 ? 'Usually fixed to Program/Preview — the switcher may ignore this' : undefined,
      });
    }
  }

  return destinations;
}

/** What each destination is taking right now, read straight out of the state. */
export function readRoutes(state: AtemState, destinations: Destination[]): Record<string, number> {
  const routes: Record<string, number> = {};
  for (const destination of destinations) {
    routes[destination.id] = readRoute(state, destination);
  }
  return routes;
}

export function readRoute(state: AtemState, destination: Destination): number {
  const { unit, slot } = destination.address;
  switch (destination.kind) {
    case 'aux':
      return state.video.auxilliaries[unit] ?? -1;
    case 'program':
      return state.video.mixEffects[unit]?.programInput ?? -1;
    case 'preview':
      return state.video.mixEffects[unit]?.previewInput ?? -1;
    case 'uskFill':
      return state.video.mixEffects[unit]?.upstreamKeyers[slot ?? 0]?.fillSource ?? -1;
    case 'uskKey':
      return state.video.mixEffects[unit]?.upstreamKeyers[slot ?? 0]?.cutSource ?? -1;
    case 'dskFill':
      return state.video.downstreamKeyers[unit]?.sources?.fillSource ?? -1;
    case 'dskKey':
      return state.video.downstreamKeyers[unit]?.sources?.cutSource ?? -1;
    case 'ssrcBox':
      return state.video.superSources[unit]?.boxes[slot ?? 0]?.source ?? -1;
    case 'ssrcArtFill':
      return state.video.superSources[unit]?.properties?.artFillSource ?? -1;
    case 'ssrcArtKey':
      return state.video.superSources[unit]?.properties?.artCutSource ?? -1;
    case 'mvWindow':
      return state.settings.multiViewers[unit]?.windows[slot ?? 0]?.source ?? -1;
    default:
      return -1;
  }
}

export function buildMatrix(state: AtemState): MatrixModel {
  const destinations = buildDestinations(state);
  return {
    sections: ATEM_SECTIONS,
    sources: buildSources(state),
    destinations,
    routes: readRoutes(state, destinations),
  };
}
