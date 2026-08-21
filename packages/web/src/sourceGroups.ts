import type { Source } from './types';

/**
 * Column groups for the source axis.
 *
 * The switcher reports every source in one flat list — cameras sit next to
 * colour generators, media player keys and its own aux outputs. On a 4 M/E
 * that is 56 columns, most of which an operator patching a camera never wants
 * to see. Grouping them by what they *are* lets the internal ones fold away.
 *
 * The kinds come from `internalPortType` on the switcher, via @av/atem-matrix.
 * Order here is the column order: physical inputs first, because that is what
 * a crosspoint is usually looking for.
 */
export interface SourceGroup {
  id: string;
  label: string;
  /** Vertical label used when the group is folded to a stub. */
  short: string;
  kinds: Array<Source['kind']>;
  /** Groups that are mostly noise start folded; the stub is always visible. */
  defaultOpen: boolean;
}

export const SOURCE_GROUPS: SourceGroup[] = [
  {
    id: 'inputs',
    label: 'Inputs',
    short: 'IN',
    kinds: ['input'],
    defaultOpen: true,
  },
  {
    id: 'internal',
    label: 'Internal',
    short: 'INT',
    kinds: ['black', 'bars', 'colour'],
    defaultOpen: true,
  },
  {
    id: 'media',
    label: 'Media players',
    short: 'MP',
    kinds: ['mediaPlayer', 'mediaPlayerKey'],
    defaultOpen: true,
  },
  {
    id: 'supersource',
    label: 'SuperSource',
    short: 'SSRC',
    kinds: ['supersource'],
    defaultOpen: true,
  },
  {
    id: 'returns',
    label: 'Switcher outputs',
    short: 'OUT',
    // ME and clean-feed outputs, aux outputs, multiviewer outputs — the
    // switcher's own feeds coming back round as sources. Legal in far fewer
    // places than they look, and the widest block on a big switcher.
    kinds: ['meOutput', 'aux', 'multiview'],
    defaultOpen: false,
  },
  {
    id: 'other',
    label: 'Other',
    short: 'OTH',
    kinds: ['other'],
    defaultOpen: true,
  },
];

export interface GroupedSources {
  group: SourceGroup;
  sources: Source[];
}

/** Sources bucketed by group, dropping groups this switcher has none of. */
export function groupSources(sources: Source[]): GroupedSources[] {
  return SOURCE_GROUPS.map((group) => ({
    group,
    sources: sources.filter((source) => group.kinds.includes(source.kind)),
  })).filter((entry) => entry.sources.length > 0);
}
