import { Fragment, memo, useMemo, useState } from 'react';
import { isLegal } from '../availability';
import type { DeviceView, Destination, Source } from '../types';

interface MatrixProps {
  device: DeviceView;
  onRoute: (destination: string, source: number) => void;
  onLock: (destination: string, action: 'lock' | 'unlock' | 'force') => void;
  onRename: (destination: string, label: string) => void;
  onAddToSalvo: ((destination: Destination) => void) | null;
  salvoMembers: Set<string>;
}

interface CellProps {
  routed: boolean;
  legal: boolean;
  crosshair: boolean;
  title: string;
  onClick: () => void;
}

/** Memoised so hovering redraws two lines of cells, not the whole grid. */
const Cell = memo(function Cell({ routed, legal, crosshair, title, onClick }: CellProps) {
  const classes = ['cell'];
  if (routed) classes.push('routed');
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
    </button>
  );
});

export function Matrix({ device, onRoute, onLock, onRename, onAddToSalvo, salvoMembers }: MatrixProps) {
  const [hoverColumn, setHoverColumn] = useState<number | null>(null);
  const [hoverRow, setHoverRow] = useState<string | null>(null);
  const matrix = device.matrix;

  const sourceById = useMemo(() => {
    const map = new Map<number, Source>();
    for (const source of matrix?.sources ?? []) map.set(source.id, source);
    return map;
  }, [matrix]);

  if (!matrix) {
    return (
      <div className="empty">
        <h2>{device.name} is {device.connection}</h2>
        <p>No matrix until the switcher answers. Its address is {device.address}.</p>
      </div>
    );
  }

  const columns = matrix.sources.length;
  const grouped = matrix.sections
    .map((section) => ({
      section,
      destinations: matrix.destinations.filter((destination) => destination.section === section.id),
    }))
    .filter((group) => group.destinations.length > 0);

  return (
    <div className="matrix-scroll">
      <div
        className="matrix"
        style={{ gridTemplateColumns: `var(--rowhead) repeat(${columns}, var(--cell))` }}
        onMouseLeave={() => {
          setHoverColumn(null);
          setHoverRow(null);
        }}
      >
        <div className="corner">
          <span>Destinations ↓ / Sources →</span>
        </div>
        {matrix.sources.map((source, columnIndex) => (
          <div
            key={source.id}
            className={`colhead${hoverColumn === columnIndex ? ' hot' : ''} kind-${source.kind}`}
            title={`${source.label} (source ${source.id})`}
          >
            <span className="colhead-text">{source.short || source.label}</span>
          </div>
        ))}

        {grouped.map(({ section, destinations }) => (
          <Fragment key={section.id}>
            <div className="section">
              <div className="section-inner">
                <strong>{section.label}</strong>
                <span>{section.hint}</span>
              </div>
            </div>
            {destinations.map((destination) => {
              const routedSourceId = matrix.routes[destination.id] ?? -1;
              const routedSource = sourceById.get(routedSourceId);
              return (
                <RowFragment
                  key={destination.id}
                  destination={destination}
                  sources={matrix.sources}
                  routedSourceId={routedSourceId}
                  routedLabel={
                    routedSource?.label ?? (routedSourceId < 0 ? 'unknown' : `source ${routedSourceId}`)
                  }
                  owner={device.locks[destination.id] ?? null}
                  rowHot={hoverRow === destination.id}
                  hoverColumn={hoverColumn}
                  inSalvo={salvoMembers.has(`${device.id}:${destination.id}`)}
                  onHover={(column) => {
                    setHoverRow(destination.id);
                    setHoverColumn(column);
                  }}
                  onRoute={onRoute}
                  onLock={onLock}
                  onRename={onRename}
                  onAddToSalvo={onAddToSalvo}
                />
              );
            })}
          </Fragment>
        ))}
      </div>
    </div>
  );
}

interface RowProps {
  destination: Destination;
  sources: Source[];
  routedSourceId: number;
  routedLabel: string;
  owner: string | null;
  rowHot: boolean;
  hoverColumn: number | null;
  inSalvo: boolean;
  onHover: (column: number) => void;
  onRoute: (destination: string, source: number) => void;
  onLock: (destination: string, action: 'lock' | 'unlock' | 'force') => void;
  onRename: (destination: string, label: string) => void;
  onAddToSalvo: ((destination: Destination) => void) | null;
}

function RowFragment({
  destination,
  sources,
  routedSourceId,
  routedLabel,
  owner,
  rowHot,
  hoverColumn,
  inSalvo,
  onHover,
  onRoute,
  onLock,
  onRename,
  onAddToSalvo,
}: RowProps) {
  const locked = owner !== null;
  return (
    <>
      <div className={`rowhead kind-${destination.kind}${rowHot ? ' hot' : ''}${locked ? ' locked' : ''}`}>
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
            {destination.caveat ? <span className="caveat" title={destination.caveat}>!</span> : null}
          </button>
          <span className="rowhead-source" title={`Currently taking ${routedLabel}`}>
            {routedLabel}
          </span>
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
      {sources.map((source, columnIndex) => (
        <div
          key={source.id}
          className="cellwrap"
          onMouseEnter={() => onHover(columnIndex)}
        >
          <Cell
            routed={source.id === routedSourceId}
            legal={isLegal(source, destination)}
            crosshair={rowHot || hoverColumn === columnIndex}
            title={`${source.label} → ${destination.label}`}
            onClick={() => onRoute(destination.id, source.id)}
          />
        </div>
      ))}
    </>
  );
}
