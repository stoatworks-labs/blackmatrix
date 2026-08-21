import { useCallback, useRef, useState } from 'react';
import type { FleetSnapshot } from './types';

/**
 * Live or preset, and what is waiting to happen.
 *
 * A router gives an operator two ways to work. **Live** is a crosspoint per
 * click, straight to air. **Preset** is the one that matters before a take:
 * stage a set of changes, look at them, then make them happen together. A
 * sequence of visible single cuts is not the same event as one take, and on a
 * screen someone is watching, the difference is the whole point.
 *
 * Staging is per browser, not shared. Two operators each build their own take
 * rather than fighting over one pending set — which is how a panel behaves, and
 * the alternative would need a shared preset bus the protocol has no notion of.
 */
export type RouteMode = 'live' | 'preset';

export interface Crosspoint {
  deviceId: string;
  destination: string;
  source: number;
}

/** What a change was, so it can be put back. */
export interface UndoEntry extends Crosspoint {
  /** What the destination held before. */
  from: number;
}

const UNDO_DEPTH = 25;

export function useTakeState(snapshot: FleetSnapshot | null) {
  const [mode, setMode] = useState<RouteMode>('live');
  const [staged, setStaged] = useState<Record<string, Crosspoint>>({});
  // The stack itself lives in a ref because undo has to read it synchronously
  // when the button is pressed; the depth is mirrored into state purely so the
  // button can render as enabled or disabled.
  const undoStack = useRef<UndoEntry[][]>([]);
  const [undoDepth, setUndoDepth] = useState(0);

  /** What a destination is taking right now, or -1. */
  const liveSource = useCallback(
    (deviceId: string, destination: string): number => {
      const device = snapshot?.devices.find((candidate) => candidate.id === deviceId);
      return device?.matrix?.routes[destination] ?? -1;
    },
    [snapshot],
  );

  const stage = useCallback(
    (deviceId: string, destination: string, source: number) => {
      const key = `${deviceId}:${destination}`;
      setStaged((current) => {
        // Staging what is already live means the operator has changed their
        // mind back, so the entry goes rather than queuing a no-op take.
        if (liveSource(deviceId, destination) === source) {
          const { [key]: _removed, ...rest } = current;
          return rest;
        }
        return { ...current, [key]: { deviceId, destination, source } };
      });
    },
    [liveSource],
  );

  const unstage = useCallback((deviceId: string, destination: string) => {
    setStaged((current) => {
      const { [`${deviceId}:${destination}`]: _removed, ...rest } = current;
      return rest;
    });
  }, []);

  const clear = useCallback(() => setStaged({}), []);

  /**
   * Remember a change so it can be undone, recording what it replaced.
   *
   * A crosspoint whose previous source is unknown (-1) is dropped: undoing to
   * "unknown" would mean routing something arbitrary, which is worse than
   * having no undo for it.
   */
  const remember = useCallback((entries: UndoEntry[]) => {
    const real = entries.filter((entry) => entry.from >= 0 && entry.from !== entry.source);
    if (real.length === 0) return;
    undoStack.current = [...undoStack.current, real].slice(-UNDO_DEPTH);
    setUndoDepth(undoStack.current.length);
  }, []);

  const popUndo = useCallback((): UndoEntry[] | null => {
    const batch = undoStack.current[undoStack.current.length - 1] ?? null;
    if (!batch) return null;
    undoStack.current = undoStack.current.slice(0, -1);
    setUndoDepth(undoStack.current.length);
    return batch;
  }, []);

  return {
    mode,
    setMode,
    staged,
    stagedList: Object.values(staged),
    stage,
    unstage,
    clear,
    liveSource,
    remember,
    popUndo,
    undoDepth,
  };
}
