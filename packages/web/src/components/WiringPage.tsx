import { useMemo, useState } from 'react';
import { parseInputRef, parseOutputRef } from '@av/atem-matrix';
import type { DeviceView, Destination, Link, Source } from '../types';
import {
  deviceName,
  describeFrom,
  describeTo,
  inputText,
  isPhysicalInput,
  isPhysicalOutput,
  outputText,
  pickDevice,
  rippleOf,
} from '../wiring';

interface WiringPageProps {
  devices: DeviceView[];
  links: Link[];
  onEdit: (change: { add?: Link[]; remove?: string[] }) => Promise<void>;
}

/**
 * Which output is cabled into which input, between devices.
 *
 * Nothing on the network says this. A router knows it has an output it calls
 * "Switcher In 3" and the switcher knows it has an input 3; only the person who
 * ran the cable knows they are the same one. Written down here, the matrix can
 * show what an input is really carrying, and a route can be made from a router
 * input straight through to a switcher bus, or from a switcher output through
 * the router to a screen.
 *
 * Cables are added as a run — "router outputs 1 to 20 into switcher inputs 1 to
 * 20" — because that is how a rig is cabled and how a patch sheet reads.
 */
export function WiringPage({ devices, links, onEdit }: WiringPageProps) {
  const connected = devices.filter((device) => device.matrix);

  if (devices.length < 2) {
    return (
      <div className="devices-page">
        <section>
          <header className="devices-head">
            <h2>Wiring</h2>
          </header>
          <p className="hint">
            Wiring is the cabling between two devices — a router's outputs into a switcher's inputs, a switcher's
            outputs back into the router. Add a second device first.
          </p>
          <div id="support-slot" />
        </section>
      </div>
    );
  }

  return (
    <div className="devices-page">
      <section>
        <header className="devices-head">
          <h2>Wiring</h2>
        </header>
        <p className="hint">
          Which output is cabled into which input. Nothing on the network says so, so it is written down here — and
          once it is, the routing grid shows what each cabled input is really carrying, and <strong>Route through</strong>{' '}
          can take a router input straight to a switcher bus, or a switcher output through the router to a screen.
        </p>
        <p className="hint">
          Adding cables changes nothing on any device. It is a drawing of the rig, kept in this app's config.
        </p>
        {connected.length < 2 ? (
          <p className="hint">
            <strong>Some devices are not connected</strong>, so their outputs and inputs cannot be listed yet. Existing
            cables to them are kept.
          </p>
        ) : (
          <AddRun devices={connected} links={links} onEdit={onEdit} />
        )}
      </section>

      <CableList devices={devices} links={links} onEdit={onEdit} />

      <div id="support-slot" />
    </div>
  );
}

function AddRun({ devices, links, onEdit }: WiringPageProps) {
  // A sensible first guess: from the first router to the first switcher, which
  // is the direction most rigs are cabled in first.
  const firstRouter = devices.find((device) => device.matrix?.destinations.some((d) => d.kind === 'routerOutput'));
  const [fromChoice, setFromDevice] = useState<string | null>(null);
  const [toChoice, setToDevice] = useState<string | null>(null);
  const fromDevice = pickDevice(devices, fromChoice, firstRouter?.id);
  const toDevice = pickDevice(devices, toChoice, devices.find((device) => device.id !== fromDevice)?.id);
  const [fromIndex, setFromIndex] = useState(0);
  const [toIndex, setToIndex] = useState(0);
  const [count, setCount] = useState(1);
  const [busy, setBusy] = useState(false);

  const outputs: Destination[] = useMemo(
    () => devices.find((device) => device.id === fromDevice)?.matrix?.destinations.filter(isPhysicalOutput) ?? [],
    [devices, fromDevice],
  );
  const inputs: Source[] = useMemo(
    () => devices.find((device) => device.id === toDevice)?.matrix?.sources.filter(isPhysicalInput) ?? [],
    [devices, toDevice],
  );

  const most = Math.max(0, Math.min(outputs.length - fromIndex, inputs.length - toIndex));
  const runLength = Math.max(1, Math.min(count, most));

  const run = useMemo(() => {
    const pairs: Array<{
      link: Link;
      output: Destination;
      input: Source;
      replaces: Link | undefined;
      /** This output already has a cable elsewhere — a DA, or more likely a slip. */
      alsoFeeds: Link[];
    }> = [];
    for (let offset = 0; offset < runLength; offset++) {
      const output = outputs[fromIndex + offset];
      const input = inputs[toIndex + offset];
      if (!output || !input) break;
      const link = { from: `${fromDevice}:${output.id}`, to: `${toDevice}:${input.id}` };
      const replaces = links.find((existing) => existing.to === link.to && existing.from !== link.from);
      const same = links.some((existing) => existing.to === link.to && existing.from === link.from);
      const alsoFeeds = links.filter((existing) => existing.from === link.from && existing.to !== link.to);
      if (!same) pairs.push({ link, output, input, replaces, alsoFeeds });
    }
    return pairs;
  }, [outputs, inputs, fromIndex, toIndex, runLength, fromDevice, toDevice, links]);

  const replacing = run.filter((pair) => pair.replaces);
  const sameDevice = fromDevice === toDevice;

  const submit = async (): Promise<void> => {
    if (run.length === 0 || sameDevice) return;
    if (
      replacing.length > 0 &&
      !window.confirm(
        `${replacing.length} input${replacing.length === 1 ? ' is' : 's are'} already cabled from somewhere else. Replace ${
          replacing.length === 1 ? 'that cable' : 'those cables'
        }?`,
      )
    ) {
      return;
    }
    setBusy(true);
    await onEdit({ remove: replacing.map((pair) => pair.link.to), add: run.map((pair) => pair.link) });
    setBusy(false);
    // Ready for the next run: carry on from where this one stopped, unless that
    // runs off the end of either side — clamping would land on a cable just made.
    if (fromIndex + runLength < outputs.length && toIndex + runLength < inputs.length) {
      setFromIndex(fromIndex + runLength);
      setToIndex(toIndex + runLength);
    }
  };

  return (
    <div className="device-form wiring-form">
      <label>
        From device
        <select
          value={fromDevice}
          onChange={(event) => {
            setFromDevice(event.target.value);
            setFromIndex(0);
          }}
        >
          {devices.map((device) => (
            <option key={device.id} value={device.id}>
              {device.name}
            </option>
          ))}
        </select>
      </label>
      <label>
        First output
        <select value={fromIndex} onChange={(event) => setFromIndex(Number(event.target.value))}>
          {outputs.map((output, index) => (
            <option key={output.id} value={index}>
              {outputText(output)}
            </option>
          ))}
        </select>
        <small>Outputs are the physical ones: router outputs and switcher auxes.</small>
      </label>
      <label>
        Into device
        <select
          value={toDevice}
          onChange={(event) => {
            setToDevice(event.target.value);
            setToIndex(0);
          }}
        >
          {devices.map((device) => (
            <option key={device.id} value={device.id}>
              {device.name}
            </option>
          ))}
        </select>
      </label>
      <label>
        First input
        <select value={toIndex} onChange={(event) => setToIndex(Number(event.target.value))}>
          {inputs.map((input, index) => (
            <option key={input.id} value={index}>
              {inputText(input)}
            </option>
          ))}
        </select>
      </label>
      <label>
        How many cables
        <input
          type="number"
          min={1}
          max={Math.max(1, most)}
          value={count}
          onChange={(event) => setCount(Math.max(1, Number(event.target.value) || 1))}
        />
        <small>
          Consecutive outputs into consecutive inputs. Up to {most} from here.
        </small>
      </label>

      <div className="wiring-preview">
        {sameDevice ? (
          <span className="device-meta">A cable joins two different devices.</span>
        ) : run.length === 0 ? (
          <span className="device-meta">Already cabled exactly like this.</span>
        ) : (
          <ol>
            {run.slice(0, 6).map((pair) => (
              <li key={pair.link.to}>
                {outputText(pair.output)} <span className="arrow">→</span> {inputText(pair.input)}
                {pair.replaces ? (
                  <em className="replaces"> replaces {describeFrom(devices, pair.replaces)}</em>
                ) : null}
                {pair.alsoFeeds.length > 0 ? (
                  <em className="replaces">
                    {' '}
                    — this output is already cabled to {pair.alsoFeeds.map((link) => describeTo(devices, link)).join(', ')}
                  </em>
                ) : null}
              </li>
            ))}
            {run.length > 6 ? (
              <li className="device-meta">
                … and {run.length - 6} more, to {outputText(run[run.length - 1]!.output)} →{' '}
                {inputText(run[run.length - 1]!.input)}
              </li>
            ) : null}
          </ol>
        )}
      </div>

      <div className="device-form-actions">
        <button type="button" className="primary" disabled={busy || sameDevice || run.length === 0} onClick={() => void submit()}>
          Add {run.length} cable{run.length === 1 ? '' : 's'}
        </button>
      </div>
    </div>
  );
}

function CableList({ devices, links, onEdit }: WiringPageProps) {
  /** Grouped by which two devices a cable joins, in the order a patch sheet would list them. */
  const groups = useMemo(() => {
    const byPair = new Map<string, { fromId: string; toId: string; links: Link[] }>();
    for (const link of links) {
      const from = parseOutputRef(link.from);
      const to = parseInputRef(link.to);
      if (!from || !to) continue;
      const key = `${from.deviceId}→${to.deviceId}`;
      const group = byPair.get(key) ?? { fromId: from.deviceId, toId: to.deviceId, links: [] };
      group.links.push(link);
      byPair.set(key, group);
    }
    const order = (link: Link): number => {
      const from = parseOutputRef(link.from);
      const matrix = devices.find((device) => device.id === from?.deviceId)?.matrix;
      const index = matrix?.destinations.findIndex((destination) => destination.id === from?.destination) ?? -1;
      return index < 0 ? Number.MAX_SAFE_INTEGER : index;
    };
    for (const group of byPair.values()) group.links.sort((a, b) => order(a) - order(b));
    return [...byPair.values()];
  }, [devices, links]);

  return (
    <section>
      <header className="devices-head">
        <h2>Cables</h2>
      </header>
      {groups.length === 0 ? (
        <p className="hint">None yet. Add a run above — each cable is one output into one input.</p>
      ) : null}
      {groups.map((group) => (
        <div key={`${group.fromId}→${group.toId}`} className="cable-group">
          <div className="cable-group-head">
            <strong>
              {deviceName(devices, group.fromId)} <span className="arrow">→</span> {deviceName(devices, group.toId)}
            </strong>
            <span className="device-meta">
              {group.links.length} cable{group.links.length === 1 ? '' : 's'}
            </span>
            <button
              type="button"
              className="danger"
              onClick={() => {
                if (
                  window.confirm(
                    `Remove all ${group.links.length} cables from ${deviceName(devices, group.fromId)} into ${deviceName(
                      devices,
                      group.toId,
                    )}? Nothing on either device changes.`,
                  )
                ) {
                  void onEdit({ remove: group.links.map((link) => link.to) });
                }
              }}
            >
              Remove all
            </button>
          </div>
          <ul className="device-list cable-list">
            {group.links.map((link) => {
              const to = parseInputRef(link.to);
              const ripple = to ? rippleOf(devices, links, to.deviceId, to.source) : null;
              return (
                <li key={link.to}>
                  <div className="device-main">
                    <span>
                      {describeFrom(devices, link)} <span className="arrow">→</span> {describeTo(devices, link)}
                    </span>
                    <span className="device-meta" title={ripple?.chain}>
                      {ripple
                        ? ripple.broken
                          ? `carrying: unknown — ${ripple.broken}`
                          : `carrying: ${ripple.originFull}`
                        : ''}
                    </span>
                  </div>
                  <div className="device-actions">
                    <button
                      type="button"
                      onClick={() => void onEdit({ remove: [link.to] })}
                      title="Forget this cable. Nothing on either device changes."
                    >
                      Remove
                    </button>
                  </div>
                </li>
              );
            })}
          </ul>
        </div>
      ))}
    </section>
  );
}
