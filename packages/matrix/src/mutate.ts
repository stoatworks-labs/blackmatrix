import type { AtemState } from 'atem-connection';
import type { Destination } from './types.js';

/**
 * Apply a crosspoint straight to a state object.
 *
 * This is what a switcher does to itself when it accepts a route, and it is
 * used by everything that has a state but no hardware behind it: the mock
 * fleet, a replayed capture, and the browser simulator. The real device path
 * does not come through here — it sends a command and waits to be told.
 *
 * Silently does nothing where the state has no such slot, matching hardware:
 * a switcher ignores a route to a keyer it does not have rather than erroring.
 */
export function applyRouteToState(state: AtemState, destination: Destination, source: number): void {
  const { unit, slot } = destination.address;
  switch (destination.kind) {
    case 'aux':
      state.video.auxilliaries[unit] = source;
      return;
    case 'program': {
      const mixEffect = state.video.mixEffects[unit];
      if (mixEffect) mixEffect.programInput = source;
      return;
    }
    case 'preview': {
      const mixEffect = state.video.mixEffects[unit];
      if (mixEffect) mixEffect.previewInput = source;
      return;
    }
    case 'uskFill': {
      const keyer = state.video.mixEffects[unit]?.upstreamKeyers[slot ?? 0];
      if (keyer) keyer.fillSource = source;
      return;
    }
    case 'uskKey': {
      const keyer = state.video.mixEffects[unit]?.upstreamKeyers[slot ?? 0];
      if (keyer) keyer.cutSource = source;
      return;
    }
    case 'dskFill': {
      const sources = state.video.downstreamKeyers[unit]?.sources;
      if (sources) sources.fillSource = source;
      return;
    }
    case 'dskKey': {
      const sources = state.video.downstreamKeyers[unit]?.sources;
      if (sources) sources.cutSource = source;
      return;
    }
    case 'ssrcBox': {
      const box = state.video.superSources[unit]?.boxes[(slot ?? 0) as 0 | 1 | 2 | 3];
      if (box) box.source = source;
      return;
    }
    case 'ssrcArtFill': {
      const properties = state.video.superSources[unit]?.properties;
      if (properties) properties.artFillSource = source;
      return;
    }
    case 'ssrcArtKey': {
      const properties = state.video.superSources[unit]?.properties;
      if (properties) properties.artCutSource = source;
      return;
    }
    case 'mvWindow': {
      const window = state.settings.multiViewers[unit]?.windows[slot ?? 0];
      if (window) window.source = source;
      return;
    }
    default:
      return;
  }
}
