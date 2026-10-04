import { isLegal } from './validity.js';
import type { MatrixModel } from './types.js';

/**
 * A cable from one device's output into another device's input.
 *
 * This is the fact the app cannot read off anything: a Videohub knows it has an
 * output called "Switcher In 3" and the switcher knows it has an input 3, but
 * nothing on the wire says they are the same piece of SDI. Once it is written
 * down, a picture can be followed across boxes — upstream to say where an input
 * is really coming from, and downstream to route a source through a router into
 * a switcher, or out of a switcher through a router to a screen.
 *
 * Both ends are written the way ties are, `deviceId:id`: the output by its
 * destination id (`hub:out.2`, `atem:aux.0`), the input by its source id
 * (`atem:3`, `hub:20`). Those ids are stable for the same reason panel numbering
 * is — destinations and sources are appended, never inserted.
 */
export interface Link {
  /** `deviceId:destinationId` — the output the cable leaves from. */
  from: string;
  /** `deviceId:sourceId` — the input it plugs into. */
  to: string;
}

/** The part of a fleet device the wiring needs. The server's and the web's device views both fit. */
export interface WiredDevice {
  id: string;
  name: string;
  matrix: MatrixModel | null;
  locks: Record<string, string | null>;
}

export interface OutputRef {
  deviceId: string;
  destination: string;
}

export interface InputRef {
  deviceId: string;
  source: number;
}

export function outputRef(deviceId: string, destination: string): string {
  return `${deviceId}:${destination}`;
}

export function inputRef(deviceId: string, source: number): string {
  return `${deviceId}:${source}`;
}

/** Device ids cannot contain a colon, so the first one is the split. */
export function parseOutputRef(ref: string): OutputRef | null {
  const at = ref.indexOf(':');
  if (at <= 0 || at === ref.length - 1) return null;
  return { deviceId: ref.slice(0, at), destination: ref.slice(at + 1) };
}

export function parseInputRef(ref: string): InputRef | null {
  const at = ref.indexOf(':');
  if (at <= 0) return null;
  const text = ref.slice(at + 1);
  if (!/^-?\d+$/.test(text)) return null;
  return { deviceId: ref.slice(0, at), source: Number(text) };
}

/** The cable plugged into this input, if one is. An input takes one cable. */
export function linkInto(links: Link[], deviceId: string, source: number): Link | undefined {
  const ref = inputRef(deviceId, source);
  return links.find((link) => link.to === ref);
}

/** Every cable leaving this output. Usually one; more where a DA splits it. */
export function linksFrom(links: Link[], deviceId: string, destination: string): Link[] {
  const ref = outputRef(deviceId, destination);
  return links.filter((link) => link.from === ref);
}

/**
 * Why a set of links could not be wired as given, or null when it can.
 *
 * Checked against the devices' current shapes where a device is connected, and
 * only for form where it is not — a switcher that is off for the afternoon
 * should not stop somebody writing down how it is cabled.
 */
export function checkLinks(links: Link[], devices: WiredDevice[], knownDeviceIds: string[]): string | null {
  const seenInputs = new Set<string>();
  for (const link of links) {
    const from = parseOutputRef(link.from);
    const to = parseInputRef(link.to);
    if (!from) return `"${link.from}" is not deviceId:destinationId`;
    if (!to) return `"${link.to}" is not deviceId:sourceId`;
    if (!knownDeviceIds.includes(from.deviceId)) return `no such device: ${from.deviceId}`;
    if (!knownDeviceIds.includes(to.deviceId)) return `no such device: ${to.deviceId}`;
    // A loop back into the same box is a real thing on a router, and
    // a route through one is a puzzle nobody needs this app to solve.
    if (from.deviceId === to.deviceId) return `${link.from} → ${link.to} joins a device to itself`;
    if (seenInputs.has(link.to)) return `${link.to} is fed twice — an input takes one cable`;
    seenInputs.add(link.to);

    const fromMatrix = devices.find((device) => device.id === from.deviceId)?.matrix;
    if (fromMatrix && !fromMatrix.destinations.some((destination) => destination.id === from.destination)) {
      return `${from.deviceId} has no output ${from.destination}`;
    }
    const toMatrix = devices.find((device) => device.id === to.deviceId)?.matrix;
    if (toMatrix && !toMatrix.sources.some((source) => source.id === to.source)) {
      return `${to.deviceId} has no input ${to.source}`;
    }
  }
  return null;
}

// --- following a picture upstream -------------------------------------------

export interface TraceHop {
  deviceId: string;
  source: number;
  /** That source's own name on that device. */
  label: string;
}

export interface Trace {
  /** The input asked about first, then each input upstream of it; the last is where the picture starts. */
  hops: TraceHop[];
  /**
   * Why the walk stopped short, when it did: a device that is not connected, or
   * an output whose route nobody knows. The last hop is then not the origin.
   */
  broken?: string;
}

/** Hops are cables; a rig with more than this many in a row is a loop. */
const MAX_HOPS = 8;

/**
 * Where the picture on this input actually comes from.
 *
 * An input with no cable into it is its own origin. One with a cable is
 * whatever the output at the other end is routed to, and so on upstream.
 */
export function traceSource(devices: WiredDevice[], links: Link[], deviceId: string, source: number): Trace {
  const hops: TraceHop[] = [];
  const seen = new Set<string>();
  let current: InputRef = { deviceId, source };

  for (;;) {
    const device = devices.find((candidate) => candidate.id === current.deviceId);
    const found = device?.matrix?.sources.find((candidate) => candidate.id === current.source);
    hops.push({ deviceId: current.deviceId, source: current.source, label: found?.label ?? `input ${current.source}` });

    const ref = inputRef(current.deviceId, current.source);
    if (seen.has(ref)) return { hops, broken: 'the wiring loops back on itself' };
    seen.add(ref);
    if (hops.length > MAX_HOPS) return { hops, broken: 'too many cables in a row' };

    const link = links.find((candidate) => candidate.to === ref);
    if (!link) return { hops };
    const from = parseOutputRef(link.from);
    if (!from) return { hops, broken: `bad link ${link.from}` };

    const upstream = devices.find((candidate) => candidate.id === from.deviceId);
    if (!upstream?.matrix) return { hops, broken: `${upstream?.name ?? from.deviceId} is not connected` };
    const routed = upstream.matrix.routes[from.destination];
    if (routed === undefined || routed < 0) {
      const destination = upstream.matrix.destinations.find((candidate) => candidate.id === from.destination);
      return { hops, broken: `${upstream.name} ${destination?.label ?? from.destination} has no known route` };
    }
    current = { deviceId: from.deviceId, source: routed };
  }
}

// --- routing through ---------------------------------------------------------

/**
 * One end of a route through the wiring.
 *
 * As the start, a source is "this picture" and an output is "whatever that
 * output is carrying" — the route starts at the far end of its cable, and the
 * output itself is not touched. As the end, a destination is where the picture
 * goes, and an input is "the input at the far end of the cable": the route
 * stops at the output that feeds it.
 */
export type Endpoint = { deviceId: string; source: number } | { deviceId: string; destination: string };

export interface PathStep {
  deviceId: string;
  destination: string;
  source: number;
  /** Already routed this way, so nothing is sent for it. */
  done: boolean;
  /** The cable this step puts the picture onto, when it drives one. */
  link?: Link;
}

export interface Affected {
  deviceId: string;
  destination: string;
}

export interface PlannedRoute {
  /** In signal order: upstream first, so nothing downstream cuts to a cable before it carries the picture. */
  steps: PathStep[];
  /**
   * Destinations that change picture without being asked to: anything already
   * taking an input whose cable this route repoints, followed downstream. On a
   * switcher that is usually a multiview window, and sometimes it is program.
   */
  affected: Affected[];
  /** What would refuse this route — claims, mostly. Empty means it can go. */
  blocked: string[];
}

export interface PlanResult {
  ok: boolean;
  /** Why there is no route at all. */
  reason?: string;
  /** Best first. More than one when there is a choice of cable. */
  routes: PlannedRoute[];
}

export interface PlanOptions {
  /** Most cables a route may cross. */
  maxHops?: number;
  /** Most alternatives to return. */
  limit?: number;
}

interface RawPath {
  steps: Array<Omit<PathStep, 'done'>>;
}

/**
 * Every way through the wiring from one endpoint to another, best first.
 *
 * Best means: nothing refuses it, it disturbs the fewest destinations nobody
 * asked to change, it sends the fewest crosspoints, and it crosses the fewest
 * cables — so a cable already carrying the picture is always preferred to
 * repointing one, and a route that changes nothing at all comes first.
 *
 * Nothing here decides for the operator between two cables that both disturb
 * something; the alternatives are returned so a person can choose.
 */
export function planRoute(
  devices: WiredDevice[],
  links: Link[],
  from: Endpoint,
  to: Endpoint,
  options: PlanOptions = {},
): PlanResult {
  const maxHops = options.maxHops ?? 3;
  const limit = options.limit ?? 24;
  const byId = new Map(devices.map((device) => [device.id, device]));
  const nameOf = (deviceId: string): string => byId.get(deviceId)?.name ?? deviceId;

  // Where the picture starts.
  let starts: InputRef[];
  if ('source' in from) {
    starts = [{ deviceId: from.deviceId, source: from.source }];
  } else {
    starts = linksFrom(links, from.deviceId, from.destination)
      .map((link) => parseInputRef(link.to))
      .filter((ref): ref is InputRef => ref !== null);
    if (starts.length === 0) {
      return { ok: false, reason: `${describeOutput(byId, from)} is not wired to anything`, routes: [] };
    }
  }

  // Where it has to end up.
  let target: OutputRef;
  let finalLink: Link | undefined;
  if ('destination' in to) {
    target = { deviceId: to.deviceId, destination: to.destination };
  } else {
    const link = linkInto(links, to.deviceId, to.source);
    const upstream = link ? parseOutputRef(link.from) : null;
    if (!link || !upstream) {
      return { ok: false, reason: `${describeInput(byId, to)} has no cable into it from another device`, routes: [] };
    }
    target = upstream;
    finalLink = link;
  }

  const targetDevice = byId.get(target.deviceId);
  if (!targetDevice?.matrix) return { ok: false, reason: `${nameOf(target.deviceId)} is not connected`, routes: [] };
  if (!targetDevice.matrix.destinations.some((destination) => destination.id === target.destination)) {
    return { ok: false, reason: `${nameOf(target.deviceId)} has no destination ${target.destination}`, routes: [] };
  }

  const found: RawPath[] = [];
  const refusals: string[] = [];

  const walk = (at: InputRef, visited: Set<string>, steps: RawPath['steps']): void => {
    const device = byId.get(at.deviceId);
    const matrix = device?.matrix;
    if (!device || !matrix) {
      refusals.push(`${nameOf(at.deviceId)} is not connected`);
      return;
    }
    const source = matrix.sources.find((candidate) => candidate.id === at.source);
    if (!source) {
      refusals.push(`${device.name} has no input ${at.source}`);
      return;
    }

    if (at.deviceId === target.deviceId) {
      const destination = matrix.destinations.find((candidate) => candidate.id === target.destination);
      if (!destination) return;
      if (!isLegal(source, destination)) {
        refusals.push(`${source.label} is not available on ${device.name} ${destination.label}`);
        return;
      }
      found.push({
        steps: [
          ...steps,
          {
            deviceId: at.deviceId,
            destination: target.destination,
            source: at.source,
            ...(finalLink ? { link: finalLink } : {}),
          },
        ],
      });
      return;
    }

    if (visited.size > maxHops) return;
    for (const link of links) {
      const out = parseOutputRef(link.from);
      const next = parseInputRef(link.to);
      if (!out || !next || out.deviceId !== at.deviceId || visited.has(next.deviceId)) continue;
      const destination = matrix.destinations.find((candidate) => candidate.id === out.destination);
      if (!destination) continue;
      if (!isLegal(source, destination)) {
        refusals.push(`${source.label} is not available on ${device.name} ${destination.label}`);
        continue;
      }
      walk(next, new Set([...visited, next.deviceId]), [
        ...steps,
        { deviceId: at.deviceId, destination: out.destination, source: at.source, link },
      ]);
    }
  };

  for (const start of starts) walk(start, new Set([start.deviceId]), []);

  if (found.length === 0) {
    const origin = 'source' in from ? describeInput(byId, from) : describeOutput(byId, from);
    const destination = 'destination' in to ? describeOutput(byId, to) : describeInput(byId, to);
    const why = refusals[0] ? ` — ${refusals[0]}` : '';
    return { ok: false, reason: `No wired route from ${origin} to ${destination}${why}`, routes: [] };
  }

  const routes = found.map((path) => finish(path, byId, links, nameOf));
  routes.sort((a, b) => score(a) - score(b));
  return { ok: true, routes: routes.slice(0, limit) };
}

function finish(
  path: RawPath,
  byId: Map<string, WiredDevice>,
  links: Link[],
  nameOf: (deviceId: string) => string,
): PlannedRoute {
  const steps: PathStep[] = path.steps.map((step) => ({
    ...step,
    done: byId.get(step.deviceId)?.matrix?.routes[step.destination] === step.source,
  }));

  const intended = new Set(steps.map((step) => outputRef(step.deviceId, step.destination)));
  const affected = new Map<string, Affected>();
  for (const step of steps) {
    if (step.done) continue;
    collectDownstream(byId, links, step.deviceId, step.destination, intended, affected, new Set());
  }

  const blocked: string[] = [];
  for (const step of steps) {
    if (step.done) continue;
    const device = byId.get(step.deviceId);
    const owner = device?.locks[step.destination] ?? null;
    if (owner === null) continue;
    const label = device?.matrix?.destinations.find((candidate) => candidate.id === step.destination)?.label;
    blocked.push(`${nameOf(step.deviceId)} ${label ?? step.destination} is claimed by ${owner}`);
  }

  return { steps, affected: [...affected.values()], blocked };
}

/** Everything taking the picture that leaves this output, across every cable it feeds. */
function collectDownstream(
  byId: Map<string, WiredDevice>,
  links: Link[],
  deviceId: string,
  destination: string,
  intended: Set<string>,
  into: Map<string, Affected>,
  seen: Set<string>,
): void {
  const here = outputRef(deviceId, destination);
  if (seen.has(here)) return;
  seen.add(here);
  for (const link of linksFrom(links, deviceId, destination)) {
    const input = parseInputRef(link.to);
    const matrix = input ? byId.get(input.deviceId)?.matrix : null;
    if (!input || !matrix) continue;
    for (const consumer of matrix.destinations) {
      if (matrix.routes[consumer.id] !== input.source) continue;
      const key = outputRef(input.deviceId, consumer.id);
      if (!intended.has(key)) into.set(key, { deviceId: input.deviceId, destination: consumer.id });
      collectDownstream(byId, links, input.deviceId, consumer.id, intended, into, seen);
    }
  }
}

/** Lower is better. Blocked routes sink; then disturbance, then work, then length. */
function score(route: PlannedRoute): number {
  const pending = route.steps.filter((step) => !step.done).length;
  return (route.blocked.length > 0 ? 1_000_000 : 0) + route.affected.length * 1000 + pending * 10 + route.steps.length;
}

function describeOutput(byId: Map<string, WiredDevice>, ref: OutputRef): string {
  const device = byId.get(ref.deviceId);
  const label = device?.matrix?.destinations.find((candidate) => candidate.id === ref.destination)?.label;
  return `${device?.name ?? ref.deviceId} ${label ?? ref.destination}`;
}

function describeInput(byId: Map<string, WiredDevice>, ref: InputRef): string {
  const device = byId.get(ref.deviceId);
  const label = device?.matrix?.sources.find((candidate) => candidate.id === ref.source)?.label;
  return `${device?.name ?? ref.deviceId} ${label ?? `input ${ref.source}`}`;
}
