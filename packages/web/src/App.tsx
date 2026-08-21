import { useMemo, useState } from 'react';
import { DevicesPage } from './components/DevicesPage';
import { SourcesPage } from './components/SourcesPage';
import { Matrix } from './components/Matrix';
import { SalvoPanel, type BuilderEntry } from './components/SalvoPanel';
import { useFleet } from './useFleet';
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
  const [building, setBuilding] = useState(false);
  const [builder, setBuilder] = useState<BuilderEntry[]>([]);

  const devices = api.snapshot?.devices ?? [];
  const device = devices.find((candidate) => candidate.id === selectedId) ?? devices[0] ?? null;

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
            onRoute={(destination, source) => void api.route(device.id, destination, source)}
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
