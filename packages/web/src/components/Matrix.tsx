import { Fragment, memo, useMemo, useState } from 'react';
import { isLegal } from '@av/atem-matrix';
import { groupSources, type GroupedSources } from '../sourceGroups';
import { useViewState } from '../useViewState';
import type { Crosspoint, RouteMode } from '../takeState';
import type { DeviceView, Destination, Source } from '../types';

interface MatrixProps {
  device: DeviceView;
  /** Live routes on click; preset stages for the next take. */
  mode: RouteMode;
  /** Staged crosspoints across the whole fleet, keyed `deviceId:destination`. */
  staged: Record<string, Crosspoint>;
  onRoute: (destination: string, source: number) => void;
  onUnstage: (destination: string) => void;
  onLock: (destination: string, action: 'lock' | 'unlock' | 'force') => void;
  onRename: (destination: string, label: string) => void;
  onAddToSalvo: ((destination: Destination) => void) | null;
  salvoMembers: Set<string>;
}

/**
 * A column is either a source, or the stub a folded group leaves behind. The
 * stub is what makes folding safe: the group never disappears, it narrows to a
 * strip that says what is inside it and unfolds on a click.
 */
type Column = { kind: 'source'; source: Source; group: GroupedSources } | { kind: 'stub'; group: GroupedSources };

interface CellProps {
  routed: boolean;
  /** Waiting for a take. Outlined, never filled: it is not on air yet. */
  staged: boolean;
  legal: boolean;
  crosshair: boolean;
  title: string;
  onClick: () => void;
}

/** Memoised so hovering redraws two lines of cells, not the whole grid. */
const Cell = memo(function Cell({ routed, staged, legal, crosshair, title, onClick }: CellProps) {
  const classes = ['cell'];
  if (routed) classes.push('routed');
  if (staged) classes.push('staged');
  if (!legal) classes.push('blocked');
  if (crosshair) classes.push('crosshair');
  return (
    <button
      type="button"
      className={classes.join(' ')}
      title={title}
      disabled={!legal}
      onClick={onClick}
      aria-pressed={routed}
    >
      {routed ? <span className="tally" /> : null}
      {staged && !routed ? <span className="pending" /> : null}
    </button>
  );
});

export function Matrix({
  device,
  mode,
  staged,
  onRoute,
  onUnstage,
  onLock,
  onRename,
  onAddToSalvo,
  salvoMembers,
}: MatrixProps) {
  const [hoverColumn, setHoverColumn] = useState<number | null>(null);
  const [hoverRow, setHoverRow] = useState<string | null>(null);
  const { view, toggleGroup, toggleSection, setAllGroups } = useViewState();
  const matrix = device.matrix;

  const sourceById = useMemo(() => {
    const map = new Map<number, Source>();
    for (const source of matrix?.sources ?? []) map.set(source.id, source);
    return map;
  }, [matrix]);

  const groups = useMemo(() => groupSources(matrix?.sources ?? []), [matrix]);

  /** The visible column list, and the grid template that matches it. */
  const { columns, template } = useMemo(() => {
    const list: Column[] = [];
    const parts = ['var(--rowhead)'];
    for (const entry of groups) {
      if (view.openGroups[entry.group.id]) {
        for (const source of entry.sources) list.push({ kind: 'source', source, group: entry });
        parts.push(`repeat(${entry.sources.length}, var(--cell))`);
      } else {
        list.push({ kind: 'stub', group: entry });
        parts.push('var(--stub)');
      }
    }
    return { columns: list, template: parts.join(' ') };
  }, [groups, view.openGroups]);

  if (!matrix) {
    return (
      <div className="empty">
        <h2>
          {device.name} is {device.connection}
        </h2>
        <p>No matrix until the switcher answers. Its address is {device.address}.</p>
      </div>
    );
  }

  const grouped = matrix.sections
    .map((section) => ({
      section,
      destinations: matrix.destinations.filter((destination) => destination.section === section.id),
    }))
    .filter((entry) => entry.destinations.length > 0);

  const hiddenCount = groups
    .filter((entry) => !view.openGroups[entry.group.id])
    .reduce((total, entry) => total + entry.sources.length, 0);

  return (
    <div className={`matrix-scroll mode-${mode}`}>
      <div
        className="matrix"
        style={{ gridTemplateColumns: template }}
        onMouseLeave={() => {
          setHoverColumn(null);
          setHoverRow(null);
        }}
      >
        <div className="corner">
          <span className="corner-label">Destinations ↓ / Sources →</span>
          <div className="corner-tools">
            <button type="button" onClick={() => setAllGroups(true)} title="Unfold every source group">
              Expand all
            </button>
            <button type="button" onClick={() => setAllGroups(false)} title="Fold every source group">
              Collapse all
            </button>
          </div>
          {hiddenCount > 0 ? <span className="corner-note">{hiddenCount} sources folded away</span> : null}
        </div>

        {groups.map((entry) => {
          const open = view.openGroups[entry.group.id];
          return (
            <button
              type="button"
              key={entry.group.id}
              className={`grouphead${open ? '' : ' folded'}`}
              style={open ? { gridColumn: `span ${entry.sources.length}` } : undefined}
              onClick={() => toggleGroup(entry.group.id)}
              title={
                open
                  ? `Fold ${entry.group.label} away (${entry.sources.length} sources)`
                  : `Unfold ${entry.group.label} (${entry.sources.length} sources)`
              }
            >
              {open ? (
                <>
                  <span className="chev">▾</span>
                  <span className="grouphead-text">{entry.group.label}</span>
                  <span className="grouphead-count">{entry.sources.length}</span>
                </>
              ) : (
                <span className="chev">▸</span>
              )}
            </button>
          );
        })}

        {columns.map((column, columnIndex) =>
          column.kind === 'source' ? (
            <div
              key={`${column.group.group.id}-${column.source.id}`}
              className={`colhead${hoverColumn === columnIndex ? ' hot' : ''} kind-${column.source.kind}`}
              title={`${column.source.label} (source ${column.source.id})`}
            >
              <span className="colhead-text">{column.source.short || column.source.label}</span>
            </div>
          ) : (
            <button
              type="button"
              key={`stub-${column.group.group.id}`}
              className="colhead stubhead"
              onClick={() => toggleGroup(column.group.group.id)}
              title={`Unfold ${column.group.group.label} (${column.group.sources.length} sources)`}
            >
              <span className="colhead-text">
                {column.group.group.short} {column.group.sources.length}
              </span>
            </button>
          ),
        )}

        {grouped.map(({ section, destinations }) => {
          const closed = view.closedSections.includes(section.id);
          const lockedHere = destinations.filter((destination) => device.locks[destination.id]).length;
          return (
            <Fragment key={section.id}>
              <div className="section">
                <button type="button" className="section-inner" onClick={() => toggleSection(section.id)}>
                  <span className="chev">{closed ? '▸' : '▾'}</span>
                  <strong>{section.label}</strong>
                  <span className="section-count">{destinations.length}</span>
                  {/* Folding a section must not hide a lock — that is exactly
                      the state someone needs to know about before routing. */}
                  {lockedHere > 0 ? <span className="section-locked">{lockedHere} locked</span> : null}
                  <span className="section-hint">{section.hint}</span>
                </button>
              </div>
              {closed
                ? null
                : destinations.map((destination) => {
                    const routedSourceId = matrix.routes[destination.id] ?? -1;
                    const routedSource = sourceById.get(routedSourceId);
                    return (
                      <Row
                        key={destination.id}
                        destination={destination}
                        columns={columns}
                        routedSourceId={routedSourceId}
                        routedLabel={
                          routedSource?.label ?? (routedSourceId < 0 ? 'unknown' : `source ${routedSourceId}`)
                        }
                        owner={device.locks[destination.id] ?? null}
                        stagedSource={staged[`${device.id}:${destination.id}`]?.source ?? null}
                        stagedLabel={
                          sourceById.get(staged[`${device.id}:${destination.id}`]?.source ?? -1)?.label ?? null
                        }
                        onUnstage={onUnstage}
                        rowHot={hoverRow === destination.id}
                        hoverColumn={hoverColumn}
                        inSalvo={salvoMembers.has(`${device.id}:${destination.id}`)}
                        onHover={(column) => {
                          setHoverRow(destination.id);
                          setHoverColumn(column);
                        }}
                        onUnfold={toggleGroup}
                        onRoute={onRoute}
                        onLock={onLock}
                        onRename={onRename}
                        onAddToSalvo={onAddToSalvo}
                      />
                    );
                  })}
            </Fragment>
          );
        })}
      </div>
    </div>
  );
}

interface RowProps {
  destination: Destination;
  columns: Column[];
  routedSourceId: number;
  routedLabel: string;
  owner: string | null;
  stagedSource: number | null;
  stagedLabel: string | null;
  onUnstage: (destination: string) => void;
  rowHot: boolean;
  hoverColumn: number | null;
  inSalvo: boolean;
  onHover: (column: number) => void;
  onUnfold: (groupId: string) => void;
  onRoute: (destination: string, source: number) => void;
  onLock: (destination: string, action: 'lock' | 'unlock' | 'force') => void;
  onRename: (destination: string, label: string) => void;
  onAddToSalvo: ((destination: Destination) => void) | null;
}

function Row({
  destination,
  columns,
  routedSourceId,
  routedLabel,
  owner,
  stagedSource,
  stagedLabel,
  onUnstage,
  rowHot,
  hoverColumn,
  inSalvo,
  onHover,
  onUnfold,
  onRoute,
  onLock,
  onRename,
  onAddToSalvo,
}: RowProps) {
  const locked = owner !== null;
  return (
    <>
      <div
        className={`rowhead kind-${destination.kind}${rowHot ? ' hot' : ''}${locked ? ' locked' : ''}${
          stagedSource !== null ? ' has-staged' : ''
        }`}
      >
        <div className="rowhead-main">
          <button
            type="button"
            className="rowhead-label"
            title={`${destination.label} — double-click to rename${destination.caveat ? `\n${destination.caveat}` : ''}`}
            onDoubleClick={() => {
              const next = window.prompt(`Name for ${destination.label}`, destination.label);
              if (next !== null) onRename(destination.id, next);
            }}
          >
            {destination.label}
            {destination.caveat ? (
              <span className="caveat" title={destination.caveat}>
                !
              </span>
            ) : null}
          </button>
          {stagedSource !== null ? (
            <button
              type="button"
              className="rowhead-staged"
              title={`Staged: ${stagedLabel ?? stagedSource}. Click to drop it from the take.`}
              onClick={() => onUnstage(destination.id)}
            >
              {routedLabel} <span className="arrow">→</span> {stagedLabel ?? stagedSource}
            </button>
          ) : (
            <span className="rowhead-source" title={`Currently taking ${routedLabel}`}>
              {routedLabel}
            </span>
          )}
        </div>
        <div className="rowhead-tools">
          {onAddToSalvo ? (
            <button
              type="button"
              className={`tool${inSalvo ? ' on' : ''}`}
              title="Add this crosspoint to the salvo being built"
              onClick={() => onAddToSalvo(destination)}
            >
              +
            </button>
          ) : null}
          <button
            type="button"
            className={`tool${locked ? ' on' : ''}`}
            title={locked ? `Locked by ${owner} — click to unlock, shift-click to force` : 'Lock this destination'}
            onClick={(event) => onLock(destination.id, locked ? (event.shiftKey ? 'force' : 'unlock') : 'lock')}
          >
            {locked ? '🔒' : '🔓'}
          </button>
        </div>
      </div>

      {columns.map((column, columnIndex) => {
        if (column.kind === 'stub') {
          // A folded group still has to answer "is my route in there?", or
          // folding turns a visible crosspoint into a missing one.
          const holdsRoute = column.group.sources.some((source) => source.id === routedSourceId);
          const holdsStaged = column.group.sources.some((source) => source.id === stagedSource);
          return (
            <button
              type="button"
              key={`stub-${column.group.group.id}`}
              className={`cell stub${holdsRoute ? ' holds' : ''}${holdsStaged ? ' holds-staged' : ''}`}
              title={
                holdsRoute
                  ? `${routedLabel} is inside ${column.group.group.label} — click to unfold`
                  : `Unfold ${column.group.group.label}`
              }
              onClick={() => onUnfold(column.group.group.id)}
            >
              {holdsRoute ? <span className="tally small" /> : null}
              {holdsStaged && !holdsRoute ? <span className="pending small" /> : null}
            </button>
          );
        }
        return (
          <div
            key={`${column.group.group.id}-${column.source.id}`}
            className="cellwrap"
            onMouseEnter={() => onHover(columnIndex)}
          >
            <Cell
              routed={column.source.id === routedSourceId}
              staged={column.source.id === stagedSource}
              legal={isLegal(column.source, destination)}
              crosshair={rowHot || hoverColumn === columnIndex}
              title={`${column.source.label} → ${destination.label}`}
              onClick={() => onRoute(destination.id, column.source.id)}
            />
          </div>
        );
      })}
    </>
  );
}
