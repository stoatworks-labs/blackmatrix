import { useState } from 'react';
import { CATALOGUE, FAMILIES } from '../simulator/catalogue';
import type { DeviceInput, DeviceView, DiscoverResult, FoundDevice } from '../types';

interface DevicesPageProps {
  devices: DeviceView[];
  /** Present in the simulator: devices are chosen from a model list. */
  onAddFromCatalogue?: (entryId: string, name?: string) => Promise<void>;
  onAdd: (device: DeviceInput) => Promise<void>;
  onUpdate: (id: string, patch: Partial<DeviceInput>) => Promise<void>;
  onRemove: (id: string) => Promise<string[]>;
  onReconnect: (id: string) => Promise<void>;
  onDiscover: () => Promise<DiscoverResult>;
}

const BLANK: DeviceInput = { id: '', name: '', address: '', type: 'atem' };

/**
 * Everything about a device that is not a crosspoint.
 *
 * This page exists because the alternative was editing a JSON file — which is a
 * poor answer on a laptop and no answer at all inside a container, where the
 * config lives on a mounted volume the operator may not have a shell on.
 */
export function DevicesPage({
  devices,
  onAdd,
  onUpdate,
  onRemove,
  onReconnect,
  onDiscover,
  onAddFromCatalogue,
}: DevicesPageProps) {
  const simulated = Boolean(onAddFromCatalogue);
  const [editing, setEditing] = useState<string | null>(null);
  const [adding, setAdding] = useState(false);
  const [scanning, setScanning] = useState(false);
  const [scan, setScan] = useState<DiscoverResult | null>(null);

  const runScan = async (): Promise<void> => {
    setScanning(true);
    try {
      setScan(await onDiscover());
    } finally {
      setScanning(false);
    }
  };

  /** A found device, pre-filled into the add form rather than added blind. */
  const adopt = (found: FoundDevice, as: 'atem' | 'videohub'): void => {
    setAdding(true);
    setPrefill({
      id: suggestId(found, as),
      name: as === 'videohub' ? 'Router' : 'Switcher',
      address: found.address,
      type: as,
    });
  };

  const [prefill, setPrefill] = useState<DeviceInput>(BLANK);

  return (
    <div className="devices-page">
      <section>
        <header className="devices-head">
          <h2>Devices</h2>
          <div>
            {simulated ? null : (
              <button type="button" onClick={runScan} disabled={scanning}>
                {scanning ? 'Scanning…' : 'Scan network'}
              </button>
            )}
            <button
              type="button"
              className="primary"
              onClick={() => {
                setPrefill(BLANK);
                setAdding((current) => !current);
              }}
            >
              {adding ? 'Cancel' : 'Add device'}
            </button>
          </div>
        </header>

        {adding && simulated ? (
          <CatalogueForm
            onCancel={() => setAdding(false)}
            onAdd={async (entryId, name) => {
              await onAddFromCatalogue?.(entryId, name);
              setAdding(false);
            }}
          />
        ) : adding ? (
          <DeviceForm
            key={prefill.address || 'blank'}
            initial={prefill}
            isNew
            onCancel={() => setAdding(false)}
            onSave={async (device) => {
              await onAdd(device);
              setAdding(false);
            }}
          />
        ) : null}

        <ul className="device-list">
          {devices.map((device) => (
            <li key={device.id} className={device.connection}>
              {editing === device.id ? (
                <DeviceForm
                  initial={{
                    id: device.id,
                    name: device.name,
                    address: device.address,
                    type: device.address.startsWith('replay://') ? 'atem' : undefined,
                    videohubPort: device.videohubPort ?? undefined,
                  }}
                  onCancel={() => setEditing(null)}
                  onSave={async (device_) => {
                    await onUpdate(device.id, {
                      name: device_.name,
                      address: device_.address,
                      videohubPort: device_.videohubPort,
                    });
                    setEditing(null);
                  }}
                />
              ) : (
                <>
                  <div className="device-main">
                    <strong>{device.name}</strong>
                    <span className="device-model">{device.model}</span>
                    <span className="device-meta">
                      <code>{device.id}</code> · {device.address || 'no address'} ·{' '}
                      {device.videohubPort ? `videohub :${device.videohubPort}` : 'no videohub port'}
                      {device.videohubClients > 0 ? ` · ${device.videohubClients} panel connected` : ''}
                    </span>
                  </div>
                  <div className="device-state">
                    <span className={`pill ${device.connection}`}>{device.connection}</span>
                    <span className="device-meta">
                      {device.matrix
                        ? `${device.matrix.sources.length} sources · ${device.matrix.destinations.length} destinations`
                        : 'no matrix'}
                    </span>
                  </div>
                  <div className="device-actions">
                    {simulated ? null : (
                      <button type="button" onClick={() => void onReconnect(device.id)}>
                        Reconnect
                      </button>
                    )}
                    <button type="button" onClick={() => setEditing(device.id)}>
                      Edit
                    </button>
                    <button
                      type="button"
                      className="danger"
                      onClick={() => {
                        if (window.confirm(`Remove ${device.name}? Salvos and ties that use it are left alone.`)) {
                          void onRemove(device.id);
                        }
                      }}
                    >
                      Remove
                    </button>
                  </div>
                </>
              )}
            </li>
          ))}
          {devices.length === 0 ? (
            <li className="empty">
              {simulated
                ? 'No virtual devices yet — add one from the model list.'
                : 'No devices yet — scan, or add one by address.'}
            </li>
          ) : null}
        </ul>
      </section>

      {scan ? (
        <section>
          <h2>Found on the network</h2>
          <p className="hint">
            Swept {scan.subnets.map((subnet) => `${subnet}.0/24`).join(', ') || 'nothing — no /24 interfaces'}. A
            switcher answers on UDP 9910 and a router on TCP 9990, so each is looked for in its own way.
          </p>
          <ul className="found-list">
            {scan.devices.map((found) => {
              const isAtem = found.kinds.includes('atem');
              const both = found.kinds.length > 1;
              return (
                <li key={found.address}>
                  <span>
                    <strong>{found.address}</strong> <em>{isAtem ? 'ATEM' : 'Videohub'}</em> {found.model}
                    {both ? (
                      <span className="device-meta">
                        {' '}
                        — also serves the Videohub protocol, with the handful of outputs Blackmagic exposes. Adding
                        it as a switcher gets every bus.
                      </span>
                    ) : null}
                  </span>
                  {found.alreadyAdded ? (
                    <span className="device-meta">already added</span>
                  ) : (
                    <span className="found-actions">
                      <button type="button" className="primary" onClick={() => adopt(found, isAtem ? 'atem' : 'videohub')}>
                        Add as {isAtem ? 'switcher' : 'router'}
                      </button>
                      {both ? (
                        <button type="button" onClick={() => adopt(found, 'videohub')}>
                          as router
                        </button>
                      ) : null}
                    </span>
                  )}
                </li>
              );
            })}
            {scan.devices.length === 0 ? <li className="empty">Nothing answered.</li> : null}
          </ul>
        </section>
      ) : null}
    </div>
  );
}

/**
 * Picking a virtual device. The model list carries where its numbers came from,
 * because "ATEM Constellation 8K" in a demo is a shape of roughly that size, not
 * a specification — and the one entry that *was* read off hardware should be
 * distinguishable from the ones that were not.
 */
function CatalogueForm({
  onAdd,
  onCancel,
}: {
  onAdd: (entryId: string, name?: string) => Promise<void>;
  onCancel: () => void;
}) {
  const [entryId, setEntryId] = useState(CATALOGUE[0]?.id ?? '');
  const [name, setName] = useState('');
  const entry = CATALOGUE.find((candidate) => candidate.id === entryId);

  return (
    <form
      className="device-form"
      onSubmit={async (event) => {
        event.preventDefault();
        await onAdd(entryId, name);
      }}
    >
      <label>
        <span>Model</span>
        <select value={entryId} onChange={(event) => setEntryId(event.target.value)}>
          {FAMILIES.map((family) => (
            <optgroup key={family} label={family}>
              {CATALOGUE.filter((candidate) => candidate.family === family).map((candidate) => (
                <option key={candidate.id} value={candidate.id}>
                  {candidate.name}
                </option>
              ))}
            </optgroup>
          ))}
        </select>
        <small>
          {entry?.provenance === 'capture'
            ? '✓ Shape read off real hardware.'
            : 'Approximate shape for this class of device — not a specification.'}
          {entry?.note ? ` ${entry.note}` : ''}
        </small>
      </label>
      <label>
        <span>Name it</span>
        <input value={name} onChange={(event) => setName(event.target.value)} placeholder={entry?.name ?? ''} />
      </label>
      <div className="device-form-actions">
        <button type="submit" className="primary">
          Add
        </button>
        <button type="button" onClick={onCancel}>
          Cancel
        </button>
      </div>
    </form>
  );
}

function suggestId(found: FoundDevice, as: 'atem' | 'videohub'): string {
  return `${as === 'videohub' ? 'hub' : 'atem'}-${found.address.split('.').pop()}`;
}

interface DeviceFormProps {
  initial: DeviceInput;
  isNew?: boolean;
  onSave: (device: DeviceInput) => Promise<void>;
  onCancel: () => void;
}

function DeviceForm({ initial, isNew, onSave, onCancel }: DeviceFormProps) {
  const [device, setDevice] = useState<DeviceInput>(initial);
  const [busy, setBusy] = useState(false);

  const set = (patch: Partial<DeviceInput>): void => setDevice((current) => ({ ...current, ...patch }));

  return (
    <form
      className="device-form"
      onSubmit={async (event) => {
        event.preventDefault();
        setBusy(true);
        try {
          await onSave({ ...device, id: device.id.trim(), name: device.name.trim(), address: device.address.trim() });
        } finally {
          setBusy(false);
        }
      }}
    >
      <label>
        <span>Name</span>
        <input value={device.name} onChange={(event) => set({ name: event.target.value })} required />
      </label>
      <label>
        <span>Id</span>
        <input
          value={device.id}
          onChange={(event) => set({ id: event.target.value })}
          disabled={!isNew}
          required
          pattern="[a-zA-Z0-9_-]+"
          title={
            isNew
              ? 'Letters, numbers, dash or underscore'
              : 'An id cannot change — salvos, ties and labels are keyed on it'
          }
        />
      </label>
      <label>
        <span>Type</span>
        <select
          value={device.type ?? 'atem'}
          onChange={(event) => set({ type: event.target.value as 'atem' | 'videohub' })}
          disabled={!isNew}
        >
          <option value="atem">ATEM switcher</option>
          <option value="videohub">Blackmagic Videohub</option>
        </select>
      </label>
      <label>
        <span>Address</span>
        <input
          value={device.address}
          onChange={(event) => set({ address: event.target.value })}
          placeholder={device.type === 'videohub' ? '192.168.1.60 or host:9990' : '192.168.1.14'}
        />
      </label>
      <label>
        <span>Videohub port</span>
        <input
          type="number"
          value={device.videohubPort ?? ''}
          onChange={(event) =>
            set({ videohubPort: event.target.value ? Number(event.target.value) : undefined })
          }
          placeholder="auto"
          min={1}
          max={65535}
        />
        <small>
          {device.type === 'videohub'
            ? 'A router already speaks this protocol — leave empty unless you want an emulation in front of it.'
            : 'The port a router panel connects to for this switcher. Empty picks the next free one.'}
        </small>
      </label>
      <div className="device-form-actions">
        <button type="submit" className="primary" disabled={busy}>
          {isNew ? 'Add' : 'Save'}
        </button>
        <button type="button" onClick={onCancel}>
          Cancel
        </button>
      </div>
    </form>
  );
}
