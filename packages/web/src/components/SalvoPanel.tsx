import type { DeviceView, Salvo } from '../types';

export interface BuilderEntry {
  deviceId: string;
  destination: string;
  source: number;
  label: string;
}

interface SalvoPanelProps {
  salvos: Salvo[];
  devices: DeviceView[];
  building: boolean;
  builder: BuilderEntry[];
  onToggleBuilding: () => void;
  onRemove: (index: number) => void;
  onSave: (name: string) => void;
  onTake: (id: string) => void;
  onDelete: (id: string) => void;
}

/**
 * Salvos are the fleet-wide part: one press sets a list of crosspoints across
 * every switcher at once. They live in the app's config, not on any switcher.
 */
export function SalvoPanel({
  salvos,
  devices,
  building,
  builder,
  onToggleBuilding,
  onRemove,
  onSave,
  onTake,
  onDelete,
}: SalvoPanelProps) {
  const deviceName = (id: string): string => devices.find((device) => device.id === id)?.name ?? id;

  return (
    <aside className="salvos">
      <header>
        <h2>Salvos</h2>
        <button type="button" className={`build${building ? ' on' : ''}`} onClick={onToggleBuilding}>
          {building ? 'Building…' : 'Build new'}
        </button>
      </header>

      {building ? (
        <div className="builder">
          <p className="hint">
            Press <strong>+</strong> on any destination to capture what it is taking right now. Works
            across every switcher.
          </p>
          <ol>
            {builder.map((entry, index) => (
              <li key={`${entry.deviceId}:${entry.destination}`}>
                <span>
                  <em>{deviceName(entry.deviceId)}</em> {entry.label}
                </span>
                <button type="button" onClick={() => onRemove(index)} title="Remove">
                  ×
                </button>
              </li>
            ))}
            {builder.length === 0 ? <li className="empty">Nothing captured yet</li> : null}
          </ol>
          <button
            type="button"
            className="primary"
            disabled={builder.length === 0}
            onClick={() => {
              const name = window.prompt('Name this salvo', `Salvo ${salvos.length + 1}`);
              if (name) onSave(name);
            }}
          >
            Save salvo
          </button>
        </div>
      ) : null}

      <ul className="salvo-list">
        {salvos.map((salvo) => (
          <li key={salvo.id}>
            <div>
              <strong>{salvo.name}</strong>
              <span>
                {salvo.crosspoints.length} crosspoint{salvo.crosspoints.length === 1 ? '' : 's'} across{' '}
                {new Set(salvo.crosspoints.map((crosspoint) => crosspoint.deviceId)).size} switcher
                {new Set(salvo.crosspoints.map((crosspoint) => crosspoint.deviceId)).size === 1 ? '' : 's'}
              </span>
            </div>
            <div className="salvo-actions">
              <button type="button" className="primary" onClick={() => onTake(salvo.id)}>
                Take
              </button>
              <button type="button" onClick={() => onDelete(salvo.id)} title="Delete salvo">
                ×
              </button>
            </div>
          </li>
        ))}
        {salvos.length === 0 ? <li className="empty">No salvos yet</li> : null}
      </ul>
    </aside>
  );
}
