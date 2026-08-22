import fs from 'node:fs';
import path from 'node:path';
import { log } from './log.js';

export type DeviceKind = 'atem' | 'videohub';

export interface DeviceConfig {
  id: string;
  name: string;
  /** Defaults to 'atem'. A 'videohub' is a real Blackmagic router on the network. */
  type?: DeviceKind;
  /** Hostname or IP of the switcher. Ignored in --mock, and when `capture` is set. */
  address: string;
  /**
   * TCP port for this device's Videohub protocol *server* — the emulation that
   * lets panels drive it. Videohub devices already are one, so they get no
   * emulation unless a port is named here explicitly.
   */
  videohubPort?: number;
  /**
   * Path to a capture file (see `npm run capture`). When set, this device is
   * replayed from that file instead of connecting to hardware — the way to keep
   * developing against a real switcher's exact shape once it has gone.
   */
  capture?: string;
  /**
   * What the operator expected this to be, chosen when adding it. Purely a
   * label and a check: the device reports its own model on connecting, and a
   * mismatch is surfaced rather than hidden — usually it means a typo'd address
   * reached a different box.
   */
  expectedModel?: string;
}

export interface Salvo {
  id: string;
  name: string;
  crosspoints: Array<{ deviceId: string; destination: string; source: number }>;
}

/**
 * A tie makes one destination follow another across boxes: route the leader,
 * and the follower goes to the matching source. The mapping is explicit because
 * nothing else could be — "camera 1" is input 1 on a switcher and whatever it
 * happens to be patched to on a router.
 */
export interface Tie {
  id: string;
  name: string;
  /** `deviceId:destinationId` — the destination an operator actually routes. */
  leader: string;
  /** `deviceId:destinationId` — the one that follows. */
  follower: string;
  /** Leader source id -> follower source id. */
  sourceMap: Record<string, number>;
}

/**
 * How the health of a redundant system is judged.
 *
 * `tcp` and `http` are polls: this app asks, and silence is the failure. Every
 * media server worth failing over has a port open — disguise's d3service, a
 * PIXERA API, a web UI — and a refused connection is a machine that is not
 * there. `heartbeat` is the other way round: something else must poke this app
 * on a schedule, and its silence is the failure. Use it when the thing being
 * watched can emit but cannot be asked, which covers show controllers and
 * anything behind a firewall.
 */
export type HealthProbe =
  | { kind: 'tcp'; host: string; port: number }
  | { kind: 'http'; url: string; expectStatus?: number }
  | { kind: 'heartbeat' };

/**
 * One redundant system: what to watch, and what to route when it goes away.
 *
 * The salvos are ordinary salvos, which is the whole point — a failover is not
 * a special kind of routing, it is a routing somebody else decided to fire. An
 * operator can take the same salvo by hand, and should, to prove the failover
 * before the show rather than during it.
 */
export interface FailoverWatch {
  id: string;
  name: string;
  probe: HealthProbe;
  /** How often to poll, or how long a heartbeat may be silent before it counts. */
  intervalMs: number;
  /** Consecutive bad results before the main system is called lost. */
  failAfter: number;
  /** Consecutive good results before it is called back. */
  restoreAfter: number;
  /** Salvo id fired when the main system is lost. */
  onLostSalvo: string;
  /**
   * Salvo id fired when it returns. Omitted means latch: the backup keeps the
   * outputs until a person says otherwise, which is what most shows want —
   * a machine that has failed once is not trusted back mid-act.
   */
  onRestoredSalvo?: string;
  /**
   * Armed watches fire. A disarmed one still probes and still reports, so the
   * health of a rig can be watched all day without anything switching.
   */
  armed: boolean;
  /**
   * A failover route is not refused by a lock.
   *
   * Locks exist to stop an operator or a panel changing a destination by
   * accident, and the destinations carrying a redundant feed are exactly the
   * ones somebody locks. Without this the failover is refused, and — because
   * the Videohub protocol answers a refusal with ACK and an unchanged status —
   * refused silently. Legality is never overridden: an illegal crosspoint stays
   * illegal, because the switcher would refuse it anyway.
   */
  overrideLocks: boolean;
  /**
   * Wait for the main system to be seen healthy once before anything can fire.
   *
   * On by default, and it matters at power-up: a rack where nothing has booted
   * yet looks exactly like a rack where the main system has died, and firing
   * the backup salvo into that is how a show starts on the wrong machine.
   */
  requireHealthyFirst: boolean;
}

export interface AppConfig {
  /** HTTP port for the UI and REST API. */
  port: number;
  /** Interface to bind. Undefined binds every interface. */
  host?: string;
  videohub: {
    enabled: boolean;
    /** First device gets this port, the next one basePort + 1, and so on. */
    basePort: number;
    host: string;
    /**
     * Addresses whose routes ignore locks, as a media server's would need to.
     *
     * A media server drives a matrix by firing crosspoints and moving on; it
     * never reads the status back, so a refusal it cannot see is a failover
     * that did not happen. Naming the server here says "this client is the
     * redundancy system, not an operator". Empty by default — an unknown
     * client on the network should not be able to walk through a lock.
     */
    failoverClients?: string[];
    /** Reported as `Model name`, when a client insists on seeing a Videohub. */
    modelName?: string;
    /** Reported in `PROTOCOL PREAMBLE`. Only raise it if a client demands it. */
    protocolVersion?: string;
  };
  /**
   * The plain-text line protocol, for control systems that cannot speak
   * Videohub but can send a string. Off unless a port is set.
   */
  ascii?: {
    enabled: boolean;
    port: number;
    host: string;
    /** As `videohub.failoverClients`, for this protocol. */
    failoverClients?: string[];
  };
  devices: DeviceConfig[];
  /** Per device, destination id -> operator's own name for it. */
  labels: Record<string, Record<string, string>>;
  salvos: Salvo[];
  ties: Tie[];
  failover: FailoverWatch[];
}

export const CONFIG_FILENAME = 'blackmatrix.config.json';
/** What this app was called before. Read, never written. */
const LEGACY_CONFIG_FILENAME = 'atem-crosspoint.config.json';

const DEFAULTS: AppConfig = {
  port: 8533,
  videohub: { enabled: true, basePort: 9990, host: '0.0.0.0' },
  // Off until asked for: a second control protocol listening on every interface
  // is not something to acquire by upgrading.
  ascii: { enabled: false, port: 9995, host: '0.0.0.0' },
  devices: [],
  labels: {},
  salvos: [],
  ties: [],
  failover: [],
};

/** A three-switcher fleet with deliberately different shapes, for --mock. */
export const MOCK_CONFIG: AppConfig = {
  ...DEFAULTS,
  // The line protocol is on in the mock so it gets exercised without anyone
  // having to turn it on — `telnet localhost 9995` and type at it.
  ascii: { enabled: true, port: 9995, host: '127.0.0.1' },
  devices: [
    { id: 'stage', name: 'Stage', address: 'mock://stage' },
    { id: 'studio', name: 'Studio', address: 'mock://studio' },
    { id: 'flypack', name: 'Flypack', address: 'mock://flypack' },
    // A real videohub device pointed at the simulated router --mock starts up,
    // so the client half of the protocol is exercised over actual TCP.
    { id: 'router', name: 'Router', type: 'videohub', address: '127.0.0.1:19990' },
  ],
  labels: { stage: { 'aux.0': 'FOH screens' } },
  salvos: [
    {
      id: 'salvo-house',
      name: 'House to wide',
      crosspoints: [
        { deviceId: 'stage', destination: 'aux.0', source: 1 },
        { deviceId: 'studio', destination: 'aux.0', source: 1 },
        { deviceId: 'router', destination: 'out.0', source: 0 },
      ],
    },
  ],
  ties: [
    {
      id: 'tie-house',
      name: 'House screen follows Stage aux 1',
      leader: 'stage:aux.0',
      follower: 'router:out.1',
      // Cameras 1-4 on the switcher are router inputs 5-8 in this imaginary rig.
      sourceMap: { '1': 4, '2': 5, '3': 6, '4': 7 },
    },
  ],
  failover: [
    {
      id: 'failover-main',
      name: 'Main media server',
      // Heartbeat rather than a poll, so the mock needs nothing else running:
      // POST /api/failover/failover-main/heartbeat a few times and the watch
      // goes healthy, stop for six seconds and it fires.
      probe: { kind: 'heartbeat' },
      intervalMs: 2000,
      failAfter: 3,
      restoreAfter: 3,
      onLostSalvo: 'salvo-house',
      armed: false,
      overrideLocks: true,
      requireHealthyFirst: true,
    },
  ],
};

/**
 * Fill in a hand-written watch.
 *
 * Every default here is the cautious one: disarmed, slow to fire, quick to
 * believe a recovery, latching rather than switching back, and refusing to fire
 * at all until the main system has been seen alive. A watch that appears in the
 * file half-written should not be the reason a show changes machines.
 */
export function withFailoverDefaults(watch: Partial<FailoverWatch>): FailoverWatch {
  return {
    id: watch.id ?? `failover-${Date.now().toString(36)}`,
    name: watch.name ?? 'Failover',
    probe: watch.probe ?? { kind: 'heartbeat' },
    intervalMs: Math.max(250, watch.intervalMs ?? 2000),
    failAfter: Math.max(1, watch.failAfter ?? 3),
    restoreAfter: Math.max(1, watch.restoreAfter ?? 3),
    onLostSalvo: watch.onLostSalvo ?? '',
    onRestoredSalvo: watch.onRestoredSalvo,
    armed: watch.armed ?? false,
    overrideLocks: watch.overrideLocks ?? true,
    requireHealthyFirst: watch.requireHealthyFirst ?? true,
  };
}

export function configPath(): string {
  // A --config path wins, then the environment, then the working directory.
  // The flag exists because a container is told where its config is by its
  // command line; relying on the working directory there is how a mounted
  // volume gets ignored in favour of an image default nobody can edit.
  const flag = process.argv.indexOf('--config');
  if (flag >= 0 && process.argv[flag + 1]) return path.resolve(process.argv[flag + 1] as string);

  const named = process.env.BLACKMATRIX_CONFIG ?? process.env.ATEM_CROSSPOINT_CONFIG;
  if (named) return named;

  const current = path.resolve(process.cwd(), CONFIG_FILENAME);
  if (fs.existsSync(current)) return current;

  // A `config/` directory beside the app. This is where the container's mounted
  // volume lands, and it keeps a local checkout tidy for the same reason.
  const inConfigDir = path.resolve(process.cwd(), 'config', CONFIG_FILENAME);
  if (fs.existsSync(inConfigDir)) return inConfigDir;

  // This app used to be called ATEM Crosspoint. An existing config keeps
  // working under its old name rather than the rename quietly emptying
  // somebody's fleet; it is read from there and saved back there.
  const legacy = path.resolve(process.cwd(), LEGACY_CONFIG_FILENAME);
  if (fs.existsSync(legacy)) {
    log.warn(`using ${LEGACY_CONFIG_FILENAME} — rename it to ${CONFIG_FILENAME} when convenient`);
    return legacy;
  }
  return current;
}

/**
 * The desktop launcher picks an interface and a port in its panel and passes
 * them in the environment, so those win over the file. Nothing else sets them,
 * and an unset variable leaves the file's values alone.
 */
export function applyEnvironmentOverrides(config: AppConfig): AppConfig {
  const port = Number(process.env.BLACKMATRIX_PORT);
  if (Number.isInteger(port) && port > 0 && port < 65536) config.port = port;
  const host = process.env.BLACKMATRIX_HOST?.trim();
  if (host) config.host = host;

  // The other two listeners, so a second copy can be started beside a running
  // one — for a screenshot, a demo, or a protocol experiment — without either
  // fighting the other for a port. Every one of these clashes is survivable,
  // but the survival is a warning in the log and a feature quietly missing.
  const videohubBase = Number(process.env.BLACKMATRIX_VIDEOHUB_BASE_PORT);
  if (Number.isInteger(videohubBase) && videohubBase > 0 && videohubBase < 65536) {
    config.videohub.basePort = videohubBase;
    // The per-device ports were written back from a previous run against the
    // old base; leaving them would ignore the override on every existing device.
    for (const device of config.devices) delete device.videohubPort;
  }
  const asciiPort = Number(process.env.BLACKMATRIX_ASCII_PORT);
  if (config.ascii && Number.isInteger(asciiPort) && asciiPort > 0 && asciiPort < 65536) {
    config.ascii.port = asciiPort;
  }
  return config;
}

export function loadConfig(): AppConfig {
  const file = configPath();
  if (!fs.existsSync(file)) {
    log.warn(`no config at ${file} — starting with an empty fleet. Add devices in the UI or the file.`);
    return applyEnvironmentOverrides(structuredClone(DEFAULTS));
  }
  try {
    const parsed = JSON.parse(fs.readFileSync(file, 'utf8')) as Partial<AppConfig>;
    return applyEnvironmentOverrides({
      ...DEFAULTS,
      ...parsed,
      videohub: { ...DEFAULTS.videohub, ...(parsed.videohub ?? {}) },
      ascii: { ...DEFAULTS.ascii!, ...(parsed.ascii ?? {}) },
      devices: parsed.devices ?? [],
      labels: parsed.labels ?? {},
      salvos: parsed.salvos ?? [],
      ties: parsed.ties ?? [],
      failover: (parsed.failover ?? []).map(withFailoverDefaults),
    });
  } catch (error) {
    log.error(`config at ${file} is not readable JSON: ${String(error)}`);
    return applyEnvironmentOverrides(structuredClone(DEFAULTS));
  }
}

export function saveConfig(config: AppConfig): void {
  const file = configPath();
  // The host and port may have come from the launcher's panel this run; writing
  // them back would make a one-off choice permanent and outlive the launcher.
  const { host: _host, ...persisted } = config;
  fs.writeFileSync(file, `${JSON.stringify(persisted, null, 2)}\n`, 'utf8');
}
