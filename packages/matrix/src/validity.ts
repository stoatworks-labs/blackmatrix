import { Enums } from 'atem-connection';
import type { Destination, Source } from './types.js';

const { MeAvailability, SourceAvailability } = Enums;

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
    case 'aux':
      // Bits 32/64 mark sources restricted to the first or second aux bus on
      // models that have that restriction. Read from the enum, not verified
      // against hardware here.
      return (
        has(source, SourceAvailability.Auxiliary) ||
        (unit === 0 && has(source, SourceAvailability.Auxiliary1)) ||
        (unit === 1 && has(source, SourceAvailability.Auxiliary2))
      );
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
