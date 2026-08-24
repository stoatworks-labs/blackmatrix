import { useMemo, useState } from 'react';
import { isLegal } from '@av/atem-matrix';
import { groupSources } from '../sourceGroups';
import type { Crosspoint, RouteMode } from '../takeState';
import type { DeviceView, Destination } from '../types';
import { ownerName } from '../claims';

interface MobileRouterProps {
  devices: DeviceView[];
  device: DeviceView | null;
  onSelectDevice: (id: string) => void;
  mode: RouteMode;
  onSetMode: (mode: RouteMode) => void;
  staged: Record<string, Crosspoint>;
  stagedCount: number;
  undoDepth: number;
  onRoute: (destination: string, source: number) => void;
  onUnstage: (destination: string) => void;
  onTake: () => void;
  onClear: () => void;
  onUndo: () => void;
  /** This client's own address, so its own claims read as "you". */
  self: string | null;
}

/**
 * The router on a phone: pick a destination, then pick a source.
 *
 * Not a smaller grid — a different interface. A grid works because you can see
 * a hundred crosspoints at once, which a phone cannot do at any density worth
 * touching. X-Y is what every hardware panel does for the same reason, and it
 * is the shape the Companion module already uses.
 *
 * Preset is the default here (set by the app on first load at this width): a
 * mis-tap on a phone in live mode is a crosspoint on air.
 */
export function MobileRouter({
  devices,
  device,
  onSelectDevice,
  mode,
  onSetMode,
  staged,
  stagedCount,
  undoDepth,
  onRoute,
  onUnstage,
  onTake,
  onClear,
  onUndo,
  self,
}: MobileRouterProps) {
  const [selected, setSelected] = useState<Destination | null>(null);

  const matrix = device?.matrix ?? null;
  const sourceById = useMemo(() => {
    const map = new Map<number, string>();
    for (const source of matrix?.sources ?? []) map.set(source.id, source.label);
    return map;
  }, [matrix]);

  if (!device || !matrix) {
    return (
      <div className="mobile">
        <div className="mobile-empty">
          <h2>No device</h2>
          <p>Add a switcher or router on the Devices page.</p>
        </div>
      </div>
    );
  }

  const stagedFor = (destination: string): number | null =>
    staged[`${device.id}:${destination}`]?.source ?? null;

  const sections = matrix.sections
    .map((section) => ({
      section,
      destinations: matrix.destinations.filter((destination) => destination.section === section.id),
    }))
    .filter((group) => group.destinations.length > 0);

  return (
    <div className="mobile">
      <div className="mobile-bar">
        <select
          className="mobile-device"
          value={device.id}
          onChange={(event) => {
            onSelectDevice(event.target.value);
            setSelected(null);
          }}
          aria-label="Device"
        >
          {devices.map((candidate) => (
            <option key={candidate.id} value={candidate.id}>
              {candidate.name}
            </option>
          ))}
        </select>
        <div className="mobile-mode" role="group" aria-label="Routing mode">
          <button type="button" className={mode === 'live' ? 'on live' : ''} onClick={() => onSetMode('live')}>
            Live
          </button>
          <button type="button" className={mode === 'preset' ? 'on preset' : ''} onClick={() => onSetMode('preset')}>
            Preset
          </button>
        </div>
      </div>

      {selected ? (
        <SourcePicker
          device={device}
          destination={selected}
          liveSource={matrix.routes[selected.id] ?? -1}
          stagedSource={stagedFor(selected.id)}
          onBack={() => setSelected(null)}
          onPick={(source) => {
            onRoute(selected.id, source);
            // In live mode the change has happened and there is nothing more to
            // say; in preset it joins the take and you carry on staging.
            if (mode === 'live') setSelected(null);
          }}
        />
      ) : (
        <ol className="mobile-list">
          {sections.map(({ section, destinations }) => (
            <li key={section.id} className="mobile-section">
              <span>{section.label}</span>
              <ol>
                {destinations.map((destination) => {
                  const live = matrix.routes[destination.id] ?? -1;
                  const stage = stagedFor(destination.id);
                  const owner = device.locks[destination.id] ?? null;
                  return (
                    <li key={destination.id}>
                      <button
                        type="button"
                        className={`mobile-dest${stage !== null ? ' staged' : ''}${owner ? ' claimed' : ''}`}
                        // A claim holds here too, whoever made it. A phone has
                        // no claim button of its own — a claim is released where
                        // it was made — so this simply refuses to open.
                        disabled={owner !== null}
                        title={owner ? `Claimed by ${ownerName(owner, self)}` : undefined}
                        onClick={() => setSelected(destination)}
                      >
                        <span className="mobile-dest-name">
                          {destination.label}
                          {owner ? <span className="mobile-claim">claimed</span> : null}
                        </span>
                        <span className="mobile-dest-source">
                          {sourceById.get(live) ?? 'unknown'}
                          {stage !== null ? (
                            <>
                              <span className="arrow"> → </span>
                              <span className="mobile-staged">{sourceById.get(stage) ?? stage}</span>
                            </>
                          ) : null}
                        </span>
                      </button>
                      {stage !== null ? (
                        <button
                          type="button"
                          className="mobile-drop"
                          onClick={() => onUnstage(destination.id)}
                          aria-label={`Drop ${destination.label} from the take`}
                        >
                          ×
                        </button>
                      ) : null}
                    </li>
                  );
                })}
              </ol>
            </li>
          ))}
        </ol>
      )}

      {/* Take controls sit at the bottom, where a thumb is. */}
      <div className={`mobile-take ${mode}`}>
        <button
          type="button"
          className="mobile-take-go"
          disabled={stagedCount === 0}
          onClick={onTake}
        >
          Take{stagedCount > 0 ? ` ${stagedCount}` : ''}
        </button>
        <button type="button" disabled={stagedCount === 0} onClick={onClear}>
          Clear
        </button>
        <button type="button" disabled={undoDepth === 0} onClick={onUndo}>
          Undo
        </button>
      </div>
    </div>
  );
}

interface SourcePickerProps {
  device: DeviceView;
  destination: Destination;
  liveSource: number;
  stagedSource: number | null;
  onBack: () => void;
  onPick: (source: number) => void;
}

/** Only what the switcher will accept here, grouped the way the grid groups columns. */
function SourcePicker({ device, destination, liveSource, stagedSource, onBack, onPick }: SourcePickerProps) {
  const legal = (device.matrix?.sources ?? []).filter((source) => isLegal(source, destination));
  const groups = groupSources(legal);

  return (
    <div className="mobile-picker">
      <div className="mobile-picker-head">
        <button type="button" className="mobile-back" onClick={onBack}>
          ‹ Destinations
        </button>
        <div>
          <strong>{destination.label}</strong>
          <span>{legal.length} sources available</span>
        </div>
      </div>
      <ol className="mobile-list">
        {groups.map((group) => (
          <li key={group.group.id} className="mobile-section">
            <span>{group.group.label}</span>
            <ol>
              {group.sources.map((source) => {
                const isLive = source.id === liveSource;
                const isStaged = source.id === stagedSource;
                return (
                  <li key={source.id}>
                    <button
                      type="button"
                      className={`mobile-source${isLive ? ' live' : ''}${isStaged ? ' staged' : ''}`}
                      onClick={() => onPick(source.id)}
                    >
                      <span>{source.label}</span>
                      {isLive ? <span className="tag on-air">on air</span> : null}
                      {isStaged && !isLive ? <span className="tag pending">staged</span> : null}
                    </button>
                  </li>
                );
              })}
            </ol>
          </li>
        ))}
      </ol>
    </div>
  );
}
