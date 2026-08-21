import { MeAvailability, SourceAvailability } from './enums.js';
import type { Destination, Source } from './types.js';

function onMe(source: Source, me: number): boolean {
  const bit = 1 << me;
  return (source.meAvailability & bit) !== 0 || source.meAvailability === MeAvailability.All;
}

function has(source: Source, flag: number): boolean {
  return (source.availability & flag) !== 0;
}

/**
 * Whether the switcher will accept this source on this destination.
 *
 * The switcher tells us this itself: every input carries a `sourceAvailability`
 * bitmask (aux, multiviewer, SuperSource art, SuperSource box, key source) and
 * a `meAvailability` bitmask (which ME buses it may appear on). Gating on those
 * rather than on a model table is what keeps this correct across the range —
 * an ATEM will not, for example, put an aux output back on an aux bus.
 */
export function isLegal(source: Source, destination: Destination): boolean {
  // A plain router crosspoint takes anything; only an ATEM has opinions.
  if (destination.accepts === 'any') return true;

  const { unit } = destination.address;
  switch (destination.kind) {
    case 'aux': {
      // Bit 1 says "can go to an aux at all". Bits 32/64/128 say WHICH.
      //
      // Read off an ATEM Mini Extreme ISO (capture, 2026-08-21): every ordinary
      // source carries Aux|Aux1|Aux2|Webcam, while "Camera 1 Direct" carries
      // Aux|Aux1 and "Camera 2 Direct" carries Aux|Aux2 — the HDMI passthroughs,
      // each of which may only reach its own output. Treating the general bit as
      // sufficient would put Camera 1 Direct on all three outputs.
      if (!has(source, SourceAvailability.Auxiliary)) return false;
      const specific = [
        SourceAvailability.Auxiliary1,
        SourceAvailability.Auxiliary2,
        SourceAvailability.WebcamOut,
      ];
      const restricted = specific.some((flag) => has(source, flag));
      // A switcher that does not use these bits at all — anything with more than
      // a handful of auxes — falls back to the general bit.
      if (!restricted) return true;
      const wanted = specific[unit];
      return wanted === undefined ? true : has(source, wanted);
    }
    case 'program':
    case 'preview':
    case 'uskFill':
      return onMe(source, unit);
    case 'uskKey':
      return onMe(source, unit) && has(source, SourceAvailability.KeySource);
    case 'dskFill':
      // Downstream keyers sit after ME 1, so they take what ME 1 takes.
      return onMe(source, 0);
    case 'dskKey':
      return onMe(source, 0) && has(source, SourceAvailability.KeySource);
    case 'ssrcBox':
      return has(source, SourceAvailability.SuperSourceBox);
    case 'ssrcArtFill':
      return has(source, SourceAvailability.SuperSourceArt);
    case 'ssrcArtKey':
      return has(source, SourceAvailability.SuperSourceArt) && has(source, SourceAvailability.KeySource);
    case 'mvWindow':
      return has(source, SourceAvailability.Multiviewer);
    default:
      return false;
  }
}

export function legalSources(sources: Source[], destination: Destination): Source[] {
  return sources.filter((source) => isLegal(source, destination));
}
