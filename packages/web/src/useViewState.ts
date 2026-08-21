import { useCallback, useEffect, useState } from 'react';
import { SOURCE_GROUPS } from './sourceGroups';
import type { SectionId } from './types';

/**
 * Which source groups and destination sections are open. Kept in localStorage:
 * an operator folds the grid down to the rows and columns their show actually
 * uses, and having that survive a browser reload — or a server restart — is the
 * whole point of folding it.
 */
const KEY = 'atem-crosspoint.view.v1';

export interface ViewState {
  openGroups: Record<string, boolean>;
  closedSections: SectionId[];
}

function defaults(): ViewState {
  return {
    openGroups: Object.fromEntries(SOURCE_GROUPS.map((group) => [group.id, group.defaultOpen])),
    closedSections: [],
  };
}

function load(): ViewState {
  const base = defaults();
  try {
    const raw = window.localStorage.getItem(KEY);
    if (!raw) return base;
    const stored = JSON.parse(raw) as Partial<ViewState>;
    return {
      // Merged onto the defaults so a group added in a later version appears
      // rather than being silently absent from an old saved state.
      openGroups: { ...base.openGroups, ...(stored.openGroups ?? {}) },
      closedSections: stored.closedSections ?? [],
    };
  } catch {
    return base;
  }
}

export function useViewState() {
  const [view, setView] = useState<ViewState>(load);

  useEffect(() => {
    try {
      window.localStorage.setItem(KEY, JSON.stringify(view));
    } catch {
      /* private browsing, quota — folding still works, it just will not persist */
    }
  }, [view]);

  const toggleGroup = useCallback((id: string) => {
    setView((current) => ({
      ...current,
      openGroups: { ...current.openGroups, [id]: !current.openGroups[id] },
    }));
  }, []);

  const toggleSection = useCallback((id: SectionId) => {
    setView((current) => ({
      ...current,
      closedSections: current.closedSections.includes(id)
        ? current.closedSections.filter((candidate) => candidate !== id)
        : [...current.closedSections, id],
    }));
  }, []);

  const setAllGroups = useCallback((open: boolean) => {
    setView((current) => ({
      ...current,
      openGroups: Object.fromEntries(Object.keys(current.openGroups).map((id) => [id, open])),
    }));
  }, []);

  return { view, toggleGroup, toggleSection, setAllGroups };
}
