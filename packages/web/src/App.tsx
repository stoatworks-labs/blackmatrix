import { useMemo, useState } from 'react';
import { Matrix } from './components/Matrix';
import { SalvoPanel, type BuilderEntry } from './components/SalvoPanel';
import { useFleet } from './useFleet';
import type { Destination } from './types';

export function App() {
  const api = useFleet();
  const [selectedId, setSelectedId] = useState<string | null>(null);
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
      <header className="topbar">
        <div className="brand">
          <h1>ATEM Crosspoint</h1>
          <span className={`link${api.connected ? ' up' : ''}`}>
            {api.connected ? 'live' : 'reconnecting…'}
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
          {devices.length === 0 ? <span className="none">No switchers configured</span> : null}
        </nav>
      </header>

      {api.error ? <div className="error">{api.error}</div> : null}

      <main>
        {device ? (
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
              Add switchers to <code>atem-crosspoint.config.json</code>, or start the server with{' '}
              <code>--mock</code> for a simulated fleet.
            </p>
          </div>
        )}

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
      </main>
    </div>
  );
}
