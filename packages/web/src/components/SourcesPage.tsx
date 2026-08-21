import { useState } from 'react';
import { portLabel, type DeviceView, type Source } from '../types';

interface SourcesPageProps {
  device: DeviceView | null;
  onSetPort: (input: number, externalPortType: number) => Promise<void>;
  onRename: (input: number, label: string) => Promise<void>;
}

/**
 * Which plug feeds each input channel.
 *
 * The switcher decides what is on offer: every input reports the connectors it
 * will accept, and most models accept exactly one. An input with a single option
 * is shown as a fact rather than as a control that cannot do anything.
 *
 * What is NOT here, because the protocol does not carry it: SRT URLs, stream
 * keys, NDI source selection. An input can be pointed at its network connector;
 * what arrives on that connector is configured in ATEM Setup.
 */
export function SourcesPage({ device, onSetPort, onRename }: SourcesPageProps) {
  const [editing, setEditing] = useState<number | null>(null);
  const [draft, setDraft] = useState('');

  if (!device) {
    return (
      <div className="empty">
        <h2>No device selected</h2>
      </div>
    );
  }

  if (!device.matrix) {
    return (
      <div className="empty">
        <h2>
          {device.name} is {device.connection}
        </h2>
        <p>Its inputs are unknown until it answers.</p>
      </div>
    );
  }

  const inputs = device.matrix.sources.filter((source) => source.ports);

  if (inputs.length === 0) {
    return (
      <div className="empty">
        <h2>Nothing to assign on {device.name}</h2>
        <p>
          A Videohub's inputs are its inputs — there is no plug to choose. This tab is for switchers whose input
          channels can be fed from different connectors.
        </p>
      </div>
    );
  }

  const assignable = inputs.filter((source) => (source.ports?.available.length ?? 0) > 1);

  return (
    <div className="devices-page">
      <section>
        <header className="devices-head">
          <h2>Source routing — {device.name}</h2>
        </header>
        <p className="hint">
          Which connector feeds each input channel. The switcher reports what each input will accept, so the choices
          below are its own, not a guess from the model name.{' '}
          {assignable.length === 0
            ? 'This switcher offers one connector per input, so there is nothing to change here — which is the answer for every ATEM Mini.'
            : `${assignable.length} of ${inputs.length} inputs can be reassigned.`}
        </p>
        <p className="hint">
          <strong>Not here:</strong> SRT URLs, stream keys and NDI source selection. The protocol carries which
          connector an input uses, and nothing about what is arriving on it — that stays in ATEM Setup.
        </p>

        <ul className="device-list">
          {inputs.map((source) => (
            <li key={source.id} className={(source.ports?.available.length ?? 0) > 1 ? 'connected' : ''}>
              <div className="device-main">
                {editing === source.id ? (
                  <form
                    className="rename-form"
                    onSubmit={async (event) => {
                      event.preventDefault();
                      await onRename(source.id, draft.trim());
                      setEditing(null);
                    }}
                  >
                    <input value={draft} onChange={(event) => setDraft(event.target.value)} autoFocus />
                    <button type="submit" className="primary">
                      Save
                    </button>
                    <button type="button" onClick={() => setEditing(null)}>
                      Cancel
                    </button>
                  </form>
                ) : (
                  <>
                    <strong>{source.label}</strong>
                    <span className="device-meta">
                      input {source.id} · short name <code>{source.short}</code>
                    </span>
                  </>
                )}
              </div>

              <PortChoice source={source} onSetPort={onSetPort} />

              {editing === source.id ? null : (
                <div className="device-actions">
                  <button
                    type="button"
                    onClick={() => {
                      setDraft(source.label);
                      setEditing(source.id);
                    }}
                  >
                    Rename
                  </button>
                </div>
              )}
            </li>
          ))}
        </ul>
      </section>
    </div>
  );
}

function PortChoice({
  source,
  onSetPort,
}: {
  source: Source;
  onSetPort: (input: number, externalPortType: number) => Promise<void>;
}) {
  const ports = source.ports;
  if (!ports) return null;

  if (ports.available.length <= 1) {
    return (
      <div className="port-choice single">
        <span className="pill">{portLabel(ports.current)}</span>
        <span className="device-meta">only option</span>
      </div>
    );
  }

  return (
    <div className="port-choice">
      {ports.available.map((port) => (
        <button
          type="button"
          key={port}
          className={port === ports.current ? 'primary' : ''}
          onClick={() => void onSetPort(source.id, port)}
          title={port === ports.current ? 'In use' : `Feed this input from ${portLabel(port)}`}
        >
          {portLabel(port)}
        </button>
      ))}
    </div>
  );
}
