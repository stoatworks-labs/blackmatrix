import { useMemo, useState } from 'react';
import { linkInto, linksFrom, parseInputRef, parseOutputRef, planRoute, type Endpoint } from '@av/atem-matrix';
import type { Crosspoint } from '../takeState';
import type { DeviceView, Link, PlannedRoute } from '../types';
import {
  cabledTo,
  deviceName,
  describeFrom,
  describeTo,
  findInput,
  findOutput,
  inputText,
  outputText,
  pickDevice,
} from '../wiring';

interface RouteThroughPanelProps {
  devices: DeviceView[];
  links: Link[];
  /** Sends the steps upstream first, stopping at the first refusal. */
  onRouteThrough: (steps: Crosspoint[]) => Promise<void>;
  onOpenWiring: () => void;
}

/**
 * A route from one end of the rig to the other, through the cables between.
 *
 * Pick where the picture is — a router input, a switcher source, or a switcher
 * output whose cable runs into the router — and where it has to go — a switcher
 * bus, a router output, or an input at the far end of a cable. The panel works
 * out the crosspoints from the wiring and the live routes, says what else they
 * would change, and sends nothing until Take.
 *
 * It does not follow the Live/Preset switch on purpose: this is already a
 * preset. The plan on screen is the staging, and it re-plans as the rig moves
 * underneath it.
 */
export function RouteThroughPanel({ devices, links, onRouteThrough, onOpenWiring }: RouteThroughPanelProps) {
  const live = devices.filter((device) => device.matrix);
  // The first cable's two ends are the likeliest pair: in most rigs that is the
  // router and the switcher, in the direction the rig was cabled first.
  const cableFrom = parseOutputRef(links[0]?.from ?? '')?.deviceId;
  const cableTo = parseInputRef(links[0]?.to ?? '')?.deviceId;

  const [fromChoice, setFromDevice] = useState<string | null>(null);
  const [fromValue, setFromValue] = useState('');
  const [toChoice, setToDevice] = useState<string | null>(null);
  const [toValue, setToValue] = useState('');
  const fromDevice = pickDevice(live, fromChoice, cableFrom);
  const toDevice = pickDevice(live, toChoice, cableTo, live.find((device) => device.id !== fromDevice)?.id);
  const [choice, setChoice] = useState(0);
  const [busy, setBusy] = useState(false);

  // Re-planned on every snapshot, so the plan on screen is always against the
  // routes as they are now, not as they were when the endpoints were picked.
  const plan = useMemo(() => {
    const from = parseEndpoint(fromDevice, fromValue);
    const to = parseEndpoint(toDevice, toValue);
    return from && to ? planRoute(devices, links, from, to) : null;
  }, [devices, links, fromDevice, fromValue, toDevice, toValue]);
  const route: PlannedRoute | undefined = plan?.routes[Math.min(choice, (plan?.routes.length ?? 1) - 1)];
  const pending = route?.steps.filter((step) => !step.done) ?? [];

  if (links.length === 0) {
    return (
      <section className="through">
        <header>
          <h2>Route through</h2>
        </header>
        <p className="hint">
          Route from a router input straight to a switcher bus, or from a switcher output through the router to a
          screen. It needs to know how the devices are cabled —{' '}
          <button type="button" className="linkish" onClick={onOpenWiring}>
            set up the wiring
          </button>{' '}
          first.
        </p>
      </section>
    );
  }

  const take = async (): Promise<void> => {
    if (!route || pending.length === 0 || route.blocked.length > 0) return;
    const onAir = route.affected.filter((item) => findOutput(devices, item.deviceId, item.destination)?.kind === 'program');
    if (
      onAir.length > 0 &&
      !window.confirm(
        `This changes what is on program: ${onAir
          .map((item) => `${deviceName(devices, item.deviceId)} ${findOutput(devices, item.deviceId, item.destination)?.label}`)
          .join(', ')}. Take it anyway?`,
      )
    ) {
      return;
    }
    setBusy(true);
    await onRouteThrough(
      route.steps.map(({ deviceId, destination, source }) => ({ deviceId, destination, source })),
    );
    setBusy(false);
  };

  return (
    <section className="through">
      <header>
        <h2>Route through</h2>
        <button type="button" className="linkish" onClick={onOpenWiring} title="How the devices are cabled">
          Wiring
        </button>
      </header>

      <div className="through-form">
        <span className="through-label">From</span>
        <DeviceSelect devices={live} value={fromDevice} onChange={(id) => { setFromDevice(id); setFromValue(''); setChoice(0); }} />
        <select value={fromValue} onChange={(event) => { setFromValue(event.target.value); setChoice(0); }}>
          <option value="">Pick a source…</option>
          <FromOptions device={live.find((device) => device.id === fromDevice)} devices={devices} links={links} />
        </select>

        <span className="through-label">To</span>
        <DeviceSelect devices={live} value={toDevice} onChange={(id) => { setToDevice(id); setToValue(''); setChoice(0); }} />
        <select value={toValue} onChange={(event) => { setToValue(event.target.value); setChoice(0); }}>
          <option value="">Pick a destination…</option>
          <ToOptions device={live.find((device) => device.id === toDevice)} devices={devices} links={links} />
        </select>
      </div>

      {plan && !plan.ok ? <p className="through-refused">{plan.reason}</p> : null}

      {route ? (
        <>
          {plan && plan.routes.length > 1 ? (
            <label className="through-choice">
              <span>
                {plan.routes.length} ways through — pick the cable
              </span>
              <select value={Math.min(choice, plan.routes.length - 1)} onChange={(event) => setChoice(Number(event.target.value))}>
                {plan.routes.map((candidate, index) => (
                  <option key={index} value={index}>
                    {summarise(devices, candidate)}
                  </option>
                ))}
              </select>
            </label>
          ) : null}

          <ol className="through-steps">
            {route.steps.map((step) => {
              const destination = findOutput(devices, step.deviceId, step.destination);
              const source = findInput(devices, step.deviceId, step.source);
              return (
                <li key={`${step.deviceId}:${step.destination}`} className={step.done ? 'done' : ''}>
                  <div>
                    <em>{deviceName(devices, step.deviceId)}</em> {destination ? outputText(destination) : step.destination}
                  </div>
                  <div className="through-take">
                    ← {source ? inputText(source) : `input ${step.source}`}
                    {step.done ? <span className="through-already"> already</span> : null}
                  </div>
                  {step.link ? <div className="through-cable">⇢ cable to {describeTo(devices, step.link)}</div> : null}
                </li>
              );
            })}
          </ol>

          {route.affected.length > 0 ? (
            <div className="through-affected">
              <strong>Also changes</strong>
              <ul>
                {route.affected.map((item) => {
                  const destination = findOutput(devices, item.deviceId, item.destination);
                  return (
                    <li key={`${item.deviceId}:${item.destination}`} className={destination?.kind === 'program' ? 'onair' : ''}>
                      {deviceName(devices, item.deviceId)} {destination?.label ?? item.destination}
                    </li>
                  );
                })}
              </ul>
            </div>
          ) : null}

          {route.blocked.map((reason) => (
            <p key={reason} className="through-refused">
              {reason}
            </p>
          ))}

          <button
            type="button"
            className="primary"
            disabled={busy || pending.length === 0 || route.blocked.length > 0}
            onClick={() => void take()}
            title="Upstream first; stops at the first refusal so nothing cuts to a cable without the picture"
          >
            {pending.length === 0 ? 'Already routed' : `Take route (${pending.length} crosspoint${pending.length === 1 ? '' : 's'})`}
          </button>
        </>
      ) : null}
    </section>
  );
}

function DeviceSelect({
  devices,
  value,
  onChange,
}: {
  devices: DeviceView[];
  value: string;
  onChange: (id: string) => void;
}) {
  return (
    <select value={value} onChange={(event) => onChange(event.target.value)}>
      {devices.map((device) => (
        <option key={device.id} value={device.id}>
          {device.name}
        </option>
      ))}
    </select>
  );
}

/** A source, or an output whose cable carries the picture somewhere else. */
function FromOptions({ device, devices, links }: { device: DeviceView | undefined; devices: DeviceView[]; links: Link[] }) {
  if (!device?.matrix) return null;
  const wired = device.matrix.destinations.filter((destination) => linksFrom(links, device.id, destination.id).length > 0);
  return (
    <>
      {wired.length > 0 ? (
        <optgroup label="Cabled outputs — whatever they carry">
          {wired.map((destination) => (
            <option key={destination.id} value={`d:${destination.id}`}>
              {outputText(destination)} → {cabledTo(devices, links, device.id, destination.id).join(', ')}
            </option>
          ))}
        </optgroup>
      ) : null}
      <optgroup label="Sources">
        {device.matrix.sources.map((source) => (
          <option key={source.id} value={`s:${source.id}`}>
            {inputText(source)}
          </option>
        ))}
      </optgroup>
    </>
  );
}

/** A destination, or an input at the far end of a cable. */
function ToOptions({ device, devices, links }: { device: DeviceView | undefined; devices: DeviceView[]; links: Link[] }) {
  if (!device?.matrix) return null;
  const matrix = device.matrix;
  const wired = matrix.sources.filter((source) => linkInto(links, device.id, source.id));
  return (
    <>
      {wired.length > 0 ? (
        <optgroup label="Cabled inputs — route the cable that feeds it">
          {wired.map((source) => {
            const link = linkInto(links, device.id, source.id);
            return (
              <option key={source.id} value={`s:${source.id}`}>
                {inputText(source)} ← {link ? describeFrom(devices, link) : ''}
              </option>
            );
          })}
        </optgroup>
      ) : null}
      {matrix.sections.map((section) => {
        const destinations = matrix.destinations.filter((destination) => destination.section === section.id);
        if (destinations.length === 0) return null;
        return (
          <optgroup key={section.id} label={section.label}>
            {destinations.map((destination) => (
              <option key={destination.id} value={`d:${destination.id}`}>
                {outputText(destination)}
              </option>
            ))}
          </optgroup>
        );
      })}
    </>
  );
}

function parseEndpoint(deviceId: string, value: string): Endpoint | null {
  if (!deviceId || value.length < 3) return null;
  const rest = value.slice(2);
  if (value.startsWith('s:')) return { deviceId, source: Number(rest) };
  if (value.startsWith('d:')) return { deviceId, destination: rest };
  return null;
}

/**
 * One line per alternative: the cables it uses, and what it costs. A cable
 * already carrying the picture says so; one that would be repointed counts as
 * a crosspoint, even when nothing else is watching it.
 */
function summarise(devices: DeviceView[], route: PlannedRoute): string {
  const cables = route.steps
    .filter((step) => step.link)
    .map((step) => {
      const link = step.link!;
      return `${describeFrom(devices, link)} → ${describeTo(devices, link)}${step.done ? ' (already on it)' : ''}`;
    })
    .join('; ');
  const pending = route.steps.filter((step) => !step.done).length;
  const cost = [
    `${pending} crosspoint${pending === 1 ? '' : 's'}`,
    route.blocked.length > 0 ? 'claimed' : route.affected.length > 0 ? `also changes ${route.affected.length}` : '',
  ]
    .filter(Boolean)
    .join(', ');
  return `${cables || 'direct'} — ${cost}`;
}
