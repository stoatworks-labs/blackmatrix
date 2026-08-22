import { useState } from 'react';
import type { FailoverView, FailoverWatch, HealthProbe, Salvo } from '../types';

interface FailoverPanelProps {
  watches: FailoverView[];
  salvos: Salvo[];
  onSave: (watch: FailoverWatch) => void;
  onDelete: (id: string) => void;
  onArm: (id: string, armed: boolean) => void;
  onTrigger: (id: string) => void;
  onRestore: (id: string) => void;
}

/** What each state is called to somebody looking at it during a show. */
const STATE_LABEL: Record<FailoverView['state'], string> = {
  unknown: 'no answer yet',
  healthy: 'main is up',
  failing: 'missing replies',
  failed: 'switched to backup',
  returned: 'main is back',
};

function probeSummary(probe: HealthProbe): string {
  switch (probe.kind) {
    case 'tcp':
      return `tcp ${probe.host}:${probe.port}`;
    case 'http':
      return `http ${probe.url}`;
    case 'heartbeat':
      return 'waiting to be poked';
  }
}

/**
 * Automatic failover: watch something, and fire a salvo when it goes away.
 *
 * Deliberately sitting under the salvos rather than on a page of its own, so
 * the thing a watch fires is the same list an operator can take by hand. That
 * is the whole safety story: rehearse the failover by pressing Take, then arm
 * the watch that presses it for you.
 */
export function FailoverPanel({
  watches,
  salvos,
  onSave,
  onDelete,
  onArm,
  onTrigger,
  onRestore,
}: FailoverPanelProps) {
  const [adding, setAdding] = useState(false);

  return (
    <section className="failover">
      <header>
        <h2>Failover</h2>
        <button
          type="button"
          className={`build${adding ? ' on' : ''}`}
          disabled={salvos.length === 0}
          title={salvos.length === 0 ? 'Build a salvo first — a watch fires one' : 'Watch something'}
          onClick={() => setAdding((current) => !current)}
        >
          {adding ? 'Adding…' : 'Watch'}
        </button>
      </header>

      {adding ? (
        <WatchForm
          salvos={salvos}
          onCancel={() => setAdding(false)}
          onSave={(watch) => {
            onSave(watch);
            setAdding(false);
          }}
        />
      ) : null}

      <ul className="watch-list">
        {watches.map((watch) => (
          <li key={watch.id} className={`watch ${watch.state}`}>
            <div>
              <strong>{watch.name}</strong>
              <span>
                {STATE_LABEL[watch.state]} · {probeSummary(watch.probe)}
              </span>
              {watch.lastReason ? <span className="why">{watch.lastReason}</span> : null}
            </div>
            <div className="watch-actions">
              <button
                type="button"
                className={watch.armed ? 'primary' : ''}
                onClick={() => onArm(watch.id, !watch.armed)}
                title={
                  watch.armed
                    ? 'Armed: this watch will switch on its own'
                    : 'Disarmed: it watches and reports, and switches nothing'
                }
              >
                {watch.armed ? 'Armed' : 'Disarmed'}
              </button>
              {watch.firedAt ? (
                <button
                  type="button"
                  disabled={!watch.onRestoredSalvo}
                  title={
                    watch.onRestoredSalvo
                      ? 'Take the restored salvo and clear the latch'
                      : 'This watch has no restored salvo — route back by hand'
                  }
                  onClick={() => onRestore(watch.id)}
                >
                  Restore
                </button>
              ) : (
                <button type="button" onClick={() => onTrigger(watch.id)} title="Fire the lost salvo now">
                  Take over
                </button>
              )}
              <button type="button" onClick={() => onDelete(watch.id)} title="Delete this watch">
                ×
              </button>
            </div>
          </li>
        ))}
        {watches.length === 0 ? (
          <li className="empty">
            {salvos.length === 0
              ? 'Build a salvo first — a watch fires one.'
              : 'Nothing watched. A watch fires a salvo when a machine stops answering.'}
          </li>
        ) : null}
      </ul>
    </section>
  );
}

interface WatchFormProps {
  salvos: Salvo[];
  onSave: (watch: FailoverWatch) => void;
  onCancel: () => void;
}

function WatchForm({ salvos, onSave, onCancel }: WatchFormProps) {
  const [name, setName] = useState('Main media server');
  const [kind, setKind] = useState<HealthProbe['kind']>('tcp');
  const [host, setHost] = useState('');
  const [port, setPort] = useState('80');
  const [url, setUrl] = useState('');
  const [onLostSalvo, setOnLostSalvo] = useState(salvos[0]?.id ?? '');
  const [onRestoredSalvo, setOnRestoredSalvo] = useState('');
  const [intervalMs, setIntervalMs] = useState('2000');
  const [failAfter, setFailAfter] = useState('3');

  const probe = (): HealthProbe => {
    if (kind === 'tcp') return { kind: 'tcp', host: host.trim(), port: Number(port) || 80 };
    if (kind === 'http') return { kind: 'http', url: url.trim() };
    return { kind: 'heartbeat' };
  };

  const ready =
    name.trim() !== '' &&
    onLostSalvo !== '' &&
    (kind === 'heartbeat' || (kind === 'tcp' ? host.trim() !== '' : url.trim() !== ''));

  return (
    <div className="watch-form">
      <label>
        Name
        <input value={name} onChange={(event) => setName(event.target.value)} />
      </label>

      <label>
        Watch
        <select value={kind} onChange={(event) => setKind(event.target.value as HealthProbe['kind'])}>
          <option value="tcp">A port that should accept</option>
          <option value="http">A URL that should answer</option>
          <option value="heartbeat">Something that pokes us</option>
        </select>
      </label>

      {kind === 'tcp' ? (
        <div className="pair">
          <label>
            Host
            <input value={host} onChange={(event) => setHost(event.target.value)} placeholder="10.0.0.20" />
          </label>
          <label>
            Port
            <input value={port} onChange={(event) => setPort(event.target.value)} inputMode="numeric" />
          </label>
        </div>
      ) : null}

      {kind === 'http' ? (
        <label>
          URL
          <input value={url} onChange={(event) => setUrl(event.target.value)} placeholder="http://10.0.0.20/" />
        </label>
      ) : null}

      {kind === 'heartbeat' ? (
        <p className="hint">
          Nothing is polled. Something must POST to <code>/api/failover/&lt;id&gt;/heartbeat</code> at least
          as often as the interval below, and its silence is the failure.
        </p>
      ) : null}

      <label>
        Fire this salvo
        <select value={onLostSalvo} onChange={(event) => setOnLostSalvo(event.target.value)}>
          {salvos.map((salvo) => (
            <option key={salvo.id} value={salvo.id}>
              {salvo.name}
            </option>
          ))}
        </select>
      </label>

      <label>
        And this one when it comes back
        <select value={onRestoredSalvo} onChange={(event) => setOnRestoredSalvo(event.target.value)}>
          <option value="">Nothing — stay on the backup</option>
          {salvos.map((salvo) => (
            <option key={salvo.id} value={salvo.id}>
              {salvo.name}
            </option>
          ))}
        </select>
      </label>

      <div className="pair">
        <label>
          Every (ms)
          <input value={intervalMs} onChange={(event) => setIntervalMs(event.target.value)} inputMode="numeric" />
        </label>
        <label>
          After (misses)
          <input value={failAfter} onChange={(event) => setFailAfter(event.target.value)} inputMode="numeric" />
        </label>
      </div>

      <p className="hint">
        It will not fire until the main system has answered at least once, and it starts disarmed. Take the
        salvo by hand first to prove it does what you meant.
      </p>

      <div className="watch-actions">
        <button
          type="button"
          className="primary"
          disabled={!ready}
          onClick={() =>
            onSave({
              id: `failover-${Date.now().toString(36)}`,
              name: name.trim(),
              probe: probe(),
              intervalMs: Math.max(250, Number(intervalMs) || 2000),
              failAfter: Math.max(1, Number(failAfter) || 3),
              restoreAfter: 3,
              onLostSalvo,
              onRestoredSalvo: onRestoredSalvo || undefined,
              armed: false,
              overrideLocks: true,
              requireHealthyFirst: true,
            })
          }
        >
          Save watch
        </button>
        <button type="button" onClick={onCancel}>
          Cancel
        </button>
      </div>
    </div>
  );
}
