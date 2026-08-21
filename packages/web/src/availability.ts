import type { Destination, Source } from './types';

/**
 * The same legality rules the server applies, repeated here so a cell can be
 * drawn as unavailable without asking. The server stays the authority — it
 * refuses an illegal route regardless of what the UI drew.
 */
const AUXILIARY = 1;
const MULTIVIEWER = 2;
const SUPERSOURCE_ART = 4;
const SUPERSOURCE_BOX = 8;
const KEY_SOURCE = 16;
const AUXILIARY_1 = 32;
const AUXILIARY_2 = 64;

const has = (source: Source, flag: number): boolean => (source.availability & flag) !== 0;
const onMe = (source: Source, me: number): boolean => (source.meAvailability & (1 << me)) !== 0;

export function isLegal(source: Source, destination: Destination): boolean {
  const unit = destination.address.unit;
  switch (destination.kind) {
    case 'aux':
      return (
        has(source, AUXILIARY) ||
        (unit === 0 && has(source, AUXILIARY_1)) ||
        (unit === 1 && has(source, AUXILIARY_2))
      );
    case 'program':
    case 'preview':
    case 'uskFill':
      return onMe(source, unit);
    case 'uskKey':
      return onMe(source, unit) && has(source, KEY_SOURCE);
    case 'dskFill':
      return onMe(source, 0);
    case 'dskKey':
      return onMe(source, 0) && has(source, KEY_SOURCE);
    case 'ssrcBox':
      return has(source, SUPERSOURCE_BOX);
    case 'ssrcArtFill':
      return has(source, SUPERSOURCE_ART);
    case 'ssrcArtKey':
      return has(source, SUPERSOURCE_ART) && has(source, KEY_SOURCE);
    case 'mvWindow':
      return has(source, MULTIVIEWER);
    default:
      return false;
  }
}
