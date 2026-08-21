import { useEffect, useMemo, useRef, useState } from 'react';
import { DevicesPage } from './components/DevicesPage';
import { SourcesPage } from './components/SourcesPage';
import { Matrix } from './components/Matrix';
import { SalvoPanel, type BuilderEntry } from './components/SalvoPanel';
import { useFleet } from './useFleet';
import { useTakeState, type UndoEntry } from './takeState';
import { useSimulatorFleet } from './simulator/useSimulatorFleet';
import type { Destination } from './types';

/**
 * Chosen at build time, so the simulator build contains no client for a server
 * it will never have, and the real build contains no simulator. Constant across
 * every render, which is what makes picking a hook like this legitimate.
 */
const SIMULATOR = import.meta.env.VITE_SIMULATOR === '1';
const useFleetImpl = SIMULATOR ? useSimulatorFleet : useFleet;

export function App() {
  const api = useFleetImpl();
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [view, setView] = useState<'matrix' | 'devices' | 'sources'>('matrix');
  const [staleNotice, setStaleNotice] = useState<string | null>(null);
  const [building, setBuilding] = useState(false);
  const [builder, setBuilder] = useState<BuilderEntry[]>([]);

  const devices = api.snapshot?.devices ?? [];
  const device = devices.find((candidate) => candidate.id === selectedId) ?? devices[0] ?? null;

  // The support footer appends itself to <body>, which for a full-viewport
  // control surface means the page grows past 100vh and scrolling it drags the
  // top bar off screen. It belongs on a page that scrolls anyway.
  //
  // The node is held rather than re-found each time: moving it into a page's
  // slot makes it a child of that page, so React removes it from the document
  // when that page unmounts, and a fresh querySelector then finds nothing.
  const footerRef = useRef<HTMLElement | null>(null);
  useEffect(() => {
    let cancelled = false;
    const place = (): void => {
      if (cancelled) return;
      footerRef.current ??= document.querySelector<HTMLElement>('.sw-support');
      const footer = footerRef.current;
      if (!footer) {
        // The script is deferred and may not have run yet.
        window.setTimeout(place, 120);
        return;
      }
      const slot = document.getElementById('support-slot');
      const home = slot ?? document.body;
      if (footer.parentElement !== home) home.appendChild(footer);
    };
    place();
    return () => {
      cancelled = true;
    };
  }, [view]);

  const take = useTakeState(api.snapshot);

  /**
   * A crosspoint click. In live mode it goes now; in preset mode it joins the
   * take. Either way what it replaced is recorded, so undo has somewhere to
   * put things back to.
   */
  const onRoute = (destination: string, source: number): void => {
    if (!device) return;
    if (take.mode === 'preset') {
      take.stage(device.id, destination, source);
      return;
    }
    const from = take.liveSource(device.id, destination);
    void api.route(device.id, destination, source);
    take.remember([{ deviceId: device.id, destination, source, from }]);
  };

  const onTake = async (): Promise<void> => {
    const entries = take.stagedList;
    if (entries.length === 0) return;
    const undo: UndoEntry[] = entries.map((entry) => ({
      ...entry,
      from: take.liveSource(entry.deviceId, entry.destination),
    }));
    await api.take(entries);
    take.remember(undo);
    take.clear();
  };

  /**
   * Undo puts back what the last change replaced — but only where that change
   * is still the thing on air. If a destination has moved since, by another
   * operator or a panel, undoing would be overwriting a decision nobody asked
   * about, so those are skipped and named.
   */
  const onUndo = async (): Promise<void> => {
    const batch = take.popUndo();
    if (!batch) return;
    const nameOf = (deviceId: string, destinationId: string): string => {
      const target = devices.find((candidate) => candidate.id === deviceId);
      const destination = target?.matrix?.destinations.find((candidate) => candidate.id === destinationId);
      return destination?.label ?? destinationId;
    };

    const stale: string[] = [];
    const restore = batch.filter((entry) => {
      if (take.liveSource(entry.deviceId, entry.destination) === entry.source) return true;
      stale.push(nameOf(entry.deviceId, entry.destination));
      return false;
    });
    if (restore.length > 0) {
      await api.take(restore.map((entry) => ({ ...entry, source: entry.from })));
    }
    if (stale.length > 0) {
      setStaleNotice(`Left alone, changed since: ${stale.join(', ')}`);
      window.setTimeout(() => setStaleNotice(null), 6000);
    }
  };

  const salvoMembers = useMemo(
    () => new Set(builder.map((entry) => `${entry.deviceId}:${entry.destination}`)),
    [builder],
  );

  const addToSalvo = (destination: Destination): void => {
    if (!device?.matrix) return;
    const source = device.matrix.routes[destination.id] ?? -1;
    if (source < 0) return;
    const key = `${device.id}:${destination.id}`;
    setBuilder((current) =>
      current.some((entry) => `${entry.deviceId}:${entry.destination}` === key)
        ? current.filter((entry) => `${entry.deviceId}:${entry.destination}` !== key)
        : [...current, { deviceId: device.id, destination: destination.id, source, label: destination.label }],
    );
  };

  return (
    <div className="app">
      {SIMULATOR ? (
        <div className="demo-banner">
          <strong>Demo.</strong> Every device here is simulated in this browser tab. Nothing is on a network, nothing
          is being controlled, and no switcher or router can be reached from a web page —{' '}
          <span className="demo-why">
            the ATEM protocol is UDP and the Videohub protocol is raw TCP, neither of which a browser can open
          </span>
          . To route real hardware, run the app on the show network.
        </div>
      ) : null}

      <header className="topbar">
        <div className="brand">
          <h1>BlackMatrix{SIMULATOR ? ' — Demo' : ''}</h1>
          <span className={`link${api.connected ? ' up' : ''}`}>
            {SIMULATOR ? 'simulated' : api.connected ? 'live' : 'reconnecting…'}
          </span>
        </div>
        <nav className="devices">
          {devices.map((candidate) => (
            <button
              type="button"
              key={candidate.id}
              className={`device${candidate.id === device?.id ? ' active' : ''} ${candidate.connection}`}
              onClick={() => setSelectedId(candidate.id)}
              title={`${candidate.model} at ${candidate.address}`}
            >
              <strong>{candidate.name}</strong>
              <span>
                {candidate.connection}
                {candidate.videohubPort ? ` · videohub :${candidate.videohubPort}` : ''}
                {candidate.videohubClients > 0 ? ` · ${candidate.videohubClients} panel` : ''}
              </span>
            </button>
          ))}
          {devices.length === 0 ? <span className="none">No devices yet</span> : null}
        </nav>
        {view === 'matrix' ? (
          <div className={`take-bar ${take.mode}`}>
            <div className="mode-switch" role="group" aria-label="Routing mode">
              <button
                type="button"
                className={take.mode === 'live' ? 'on live' : ''}
                onClick={() => take.setMode('live')}
                title="Every crosspoint happens the moment you click it"
              >
                Live
              </button>
              <button
                type="button"
                className={take.mode === 'preset' ? 'on preset' : ''}
                onClick={() => take.setMode('preset')}
                title="Stage crosspoints and apply them together on Take"
              >
                Preset
              </button>
            </div>
            <button
              type="button"
              className="take-button"
              disabled={take.stagedList.length === 0}
              onClick={() => void onTake()}
              title="Apply every staged crosspoint at once"
            >
              Take{take.stagedList.length > 0 ? ` ${take.stagedList.length}` : ''}
            </button>
            <button
              type="button"
              disabled={take.stagedList.length === 0}
              onClick={take.clear}
              title="Discard everything staged"
            >
              Clear
            </button>
            <button
              type="button"
              disabled={take.undoDepth === 0}
              onClick={() => void onUndo()}
              title="Put back what the last change replaced"
            >
              Undo{take.undoDepth > 0 ? ` ${take.undoDepth}` : ''}
            </button>
          </div>
        ) : null}

        <div className="view-tabs">
          <button
            type="button"
            className={`view-toggle${view === 'matrix' ? ' on' : ''}`}
            onClick={() => setView('matrix')}
          >
            Routing
          </button>
          <button
            type="button"
            className={`view-toggle${view === 'sources' ? ' on' : ''}`}
            onClick={() => setView('sources')}
            title="Which connector feeds each input channel"
          >
            Source routing
          </button>
          <button
            type="button"
            className={`view-toggle${view === 'devices' ? ' on' : ''}`}
            onClick={() => setView('devices')}
            title="Add, edit and remove devices"
          >
            Devices
          </button>
        </div>
      </header>

      {api.error ? <div className="error">{api.error}</div> : null}
      {staleNotice ? (
        <div className="notice" onClick={() => setStaleNotice(null)} role="status">
          {staleNotice}
        </div>
      ) : null}
      {api.notice ? (
        <div className="notice" onClick={api.clearNotice} role="status">
          {api.notice}
        </div>
      ) : null}

      <main>
        {view === 'sources' ? (
          <SourcesPage
            device={device}
            onSetPort={async (input, port) => {
              if (device) await api.setInputPort(device.id, input, port);
            }}
            onRename={async (input, label) => {
              if (device) await api.setSourceLabel(device.id, input, label);
            }}
          />
        ) : view === 'devices' ? (
          <DevicesPage
            devices={devices}
            onAdd={api.addDevice}
            onUpdate={api.updateDevice}
            onRemove={api.removeDevice}
            onReconnect={api.reconnectDevice}
            onDiscover={api.discover}
            onAddFromCatalogue={api.addFromCatalogue}
          />
        ) : device ? (
          <Matrix
            device={device}
            salvoMembers={salvoMembers}
            mode={take.mode}
            staged={take.staged}
            onRoute={onRoute}
            onUnstage={(destination) => take.unstage(device.id, destination)}
            onLock={(destination, action) => void api.lock(device.id, destination, action)}
            onRename={(destination, label) => void api.labelDestination(device.id, destination, label)}
            onAddToSalvo={building ? addToSalvo : null}
          />
        ) : (
          <div className="empty">
            <h2>Nothing to route yet</h2>
            <p>
              Open <button type="button" className="linkish" onClick={() => setView('devices')}>Devices</button>{' '}
              {SIMULATOR
                ? 'and add a virtual switcher or router from the model list.'
                : 'to scan the network or add one by address.'}
            </p>
          </div>
        )}

        {view === 'matrix' ? (
          <SalvoPanel
          salvos={api.snapshot?.salvos ?? []}
          devices={devices}
          building={building}
          builder={builder}
          onToggleBuilding={() => setBuilding((current) => !current)}
          onRemove={(index) => setBuilder((current) => current.filter((_, i) => i !== index))}
          onSave={(name) => {
            void api.saveSalvo({
              name,
              crosspoints: builder.map(({ deviceId, destination, source }) => ({
                deviceId,
                destination,
                source,
              })),
            });
            setBuilder([]);
            setBuilding(false);
          }}
          onTake={(id) => void api.takeSalvo(id)}
            onDelete={(id) => void api.deleteSalvo(id)}
          />
        ) : null}
      </main>
    </div>
  );
}
