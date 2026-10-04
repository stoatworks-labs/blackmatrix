import { linkInto, linksFrom, parseInputRef, parseOutputRef, traceSource } from '@av/atem-matrix';
import type { DeviceView, Destination, Link, Source } from './types';

/**
 * Naming things across the wiring, for every view that shows it.
 *
 * Kept apart from the components because the matrix, the wiring page and the
 * route-through panel all have to say the same thing about the same cable, and
 * three slightly different spellings of "router out 3" is how an operator ends
 * up doubting which one is right.
 */

/** A destination that is a socket on the back of the box — the only kind a cable can leave. */
export function isPhysicalOutput(destination: Destination): boolean {
  return destination.kind === 'aux' || destination.kind === 'routerOutput' || destination.kind === 'routerMonitoring';
}

/** A source that is a socket on the back of the box — the only kind a cable can arrive at. */
export function isPhysicalInput(source: Source): boolean {
  return source.kind === 'input' || source.kind === 'router';
}

/** The number printed on the chassis, where there is one. Router numbering is zero-based on the wire only. */
export function outputNumber(destination: Destination): string {
  switch (destination.kind) {
    case 'routerOutput':
      return `Out ${destination.address.unit + 1}`;
    case 'routerMonitoring':
      return `Mon ${destination.address.unit + 1}`;
    case 'aux':
      return `Aux ${destination.address.unit + 1}`;
    default:
      return '';
  }
}

export function inputNumber(source: Source): string {
  if (source.kind === 'router') return `In ${source.id + 1}`;
  if (source.kind === 'input') return `In ${source.id}`;
  return '';
}

/**
 * "Out 3 · Switcher In 3", or the label alone where there is no number to give
 * or the label already says it ("Router Out 3" needs no "Out 3 ·" in front).
 */
export function outputText(destination: Destination): string {
  return numbered(outputNumber(destination), destination.label);
}

export function inputText(source: Source): string {
  return numbered(inputNumber(source), source.label);
}

function numbered(number: string, label: string): string {
  if (!number) return label;
  // Word-bounded, so "Out 1" is not found inside "Router Out 12".
  const said = new RegExp(`\\b${number.replace(/ /g, '\\s+')}\\b`, 'i').test(label);
  return said ? label : `${number} · ${label}`;
}

/**
 * The device a picker should show: the one chosen, while it is still there;
 * otherwise a preferred one; otherwise the first. Worked out on every render
 * rather than fixed in initial state, because the first render has no snapshot
 * — a picker that captured "" then would show a device it is not using.
 */
export function pickDevice(devices: DeviceView[], chosen: string | null, ...preferred: Array<string | undefined>): string {
  for (const id of [chosen, ...preferred]) {
    if (id && devices.some((device) => device.id === id)) return id;
  }
  return devices[0]?.id ?? '';
}

export function deviceName(devices: DeviceView[], deviceId: string): string {
  return devices.find((device) => device.id === deviceId)?.name ?? deviceId;
}

export function findOutput(devices: DeviceView[], deviceId: string, destination: string): Destination | undefined {
  return devices.find((device) => device.id === deviceId)?.matrix?.destinations.find((d) => d.id === destination);
}

export function findInput(devices: DeviceView[], deviceId: string, source: number): Source | undefined {
  return devices.find((device) => device.id === deviceId)?.matrix?.sources.find((s) => s.id === source);
}

/** The output end of a cable, named; falls back to the raw ref while the device is away. */
export function describeFrom(devices: DeviceView[], link: Link): string {
  const ref = parseOutputRef(link.from);
  if (!ref) return link.from;
  const destination = findOutput(devices, ref.deviceId, ref.destination);
  return `${deviceName(devices, ref.deviceId)} ${destination ? outputText(destination) : ref.destination}`;
}

export function describeTo(devices: DeviceView[], link: Link): string {
  const ref = parseInputRef(link.to);
  if (!ref) return link.to;
  const source = findInput(devices, ref.deviceId, ref.source);
  return `${deviceName(devices, ref.deviceId)} ${source ? inputText(source) : `input ${ref.source}`}`;
}

/** What an input is really showing, when a cable feeds it. */
export interface Ripple {
  /** The name of the picture where it starts. */
  origin: string;
  /** "Router · Patch Panel In 7" — the origin with its device. */
  originFull: string;
  /** The output at the other end of this input's own cable. */
  via: string;
  /** Every hop, upstream, for a tooltip. */
  chain: string;
  /** Set when the walk could not reach the start. */
  broken?: string;
}

export function rippleOf(devices: DeviceView[], links: Link[], deviceId: string, source: number): Ripple | null {
  const link = linkInto(links, deviceId, source);
  if (!link) return null;
  const trace = traceSource(devices, links, deviceId, source);
  const origin = trace.hops[trace.hops.length - 1];
  if (!origin) return null;
  const chain = trace.hops.map((hop) => `${deviceName(devices, hop.deviceId)} · ${hop.label}`).join(' ← ');
  return {
    origin: origin.label,
    originFull: `${deviceName(devices, origin.deviceId)} · ${origin.label}`,
    via: describeFrom(devices, link),
    chain: trace.broken ? `${chain} ← ? (${trace.broken})` : chain,
    broken: trace.broken,
  };
}

/** Where this output's cables go, named. */
export function cabledTo(devices: DeviceView[], links: Link[], deviceId: string, destination: string): string[] {
  return linksFrom(links, deviceId, destination).map((link) => describeTo(devices, link));
}

/** The same, without the device name — for a grid row, where the width is the problem. */
export function cabledToShort(devices: DeviceView[], links: Link[], deviceId: string, destination: string): string[] {
  return linksFrom(links, deviceId, destination).map((link) => {
    const ref = parseInputRef(link.to);
    const source = ref ? findInput(devices, ref.deviceId, ref.source) : undefined;
    return source ? inputText(source) : link.to;
  });
}
