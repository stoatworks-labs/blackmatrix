import { EventEmitter } from 'node:events';
import net from 'node:net';
import type { AppConfig, FailoverWatch, HealthProbe } from './config.js';
import type { Fleet } from './fleet.js';
import { log } from './log.js';

/**
 * Automatic failover: watch a redundant system, and fire a salvo when it goes.
 *
 * This is the same job a media server does for itself when it can — disguise
 * sends matrix routing from the understudy the moment it takes over a failed
 * machine's role, and PIXERA fires a control action at a matrix switcher from
 * its System Lost trigger. Both of those need to be told about the router.
 * This is the other half: for a rig whose media server cannot drive a matrix,
 * or where the thing that might fail is not a media server at all, the router
 * watches and decides for itself.
 *
 * Nothing here is a new kind of routing. A watch fires an ordinary salvo, which
 * means the failover can be rehearsed by pressing Take on it, and that is the
 * point — a redundancy plan nobody has fired once is a guess.
 */

export type WatchState =
  /** No result yet. */
  | 'unknown'
  /** Answering. */
  | 'healthy'
  /** Missing results, but not enough of them yet. */
  | 'failing'
  /** Fired, and the main system is still not answering. */
  | 'failed'
  /** Fired, the main system is back, and nobody has said to go back to it. */
  | 'returned';

export interface FailoverView extends FailoverWatch {
  state: WatchState;
  /** Consecutive results the current state is built on. */
  goodRun: number;
  badRun: number;
  /** Seen answering at least once, which `requireHealthyFirst` waits for. */
  everHealthy: boolean;
  lastProbeAt: string | null;
  lastChangeAt: string | null;
  firedAt: string | null;
  /** Why the last probe failed, when it did. */
  lastReason: string | null;
}

interface WatchRuntime {
  watch: FailoverWatch;
  state: WatchState;
  goodRun: number;
  badRun: number;
  everHealthy: boolean;
  lastProbeAt: number | null;
  lastChangeAt: number | null;
  firedAt: number | null;
  lastReason: string | null;
  /** Last heartbeat received, for `heartbeat` probes. */
  lastHeartbeatAt: number | null;
  timer: NodeJS.Timeout | null;
  /** A probe or a salvo already in flight; ticks that land on it are dropped. */
  busy: boolean;
}

export class FailoverController extends EventEmitter {
  private runtimes = new Map<string, WatchRuntime>();

  constructor(
    private fleet: Fleet,
    private config: AppConfig,
  ) {
    super();
  }

  start(): void {
    for (const watch of this.config.failover) this.install(watch);
  }

  stop(): void {
    for (const runtime of this.runtimes.values()) {
      if (runtime.timer) clearInterval(runtime.timer);
      runtime.timer = null;
    }
    this.runtimes.clear();
  }

  /** Every watch, for the snapshot the UI already receives. */
  view(): FailoverView[] {
    return this.config.failover.map((watch) => {
      const runtime = this.runtimes.get(watch.id);
      return {
        ...watch,
        state: runtime?.state ?? 'unknown',
        goodRun: runtime?.goodRun ?? 0,
        badRun: runtime?.badRun ?? 0,
        everHealthy: runtime?.everHealthy ?? false,
        lastProbeAt: iso(runtime?.lastProbeAt ?? null),
        lastChangeAt: iso(runtime?.lastChangeAt ?? null),
        firedAt: iso(runtime?.firedAt ?? null),
        lastReason: runtime?.lastReason ?? null,
      };
    });
  }

  save(watch: FailoverWatch): void {
    const index = this.config.failover.findIndex((candidate) => candidate.id === watch.id);
    if (index >= 0) this.config.failover[index] = watch;
    else this.config.failover.push(watch);

    // A rewritten watch starts again: its interval, its probe and its salvos
    // may all have changed, and a run of failures counted against the old one
    // says nothing about the new one.
    this.uninstall(watch.id);
    this.install(watch);
    this.changed(true);
  }

  remove(id: string): void {
    this.config.failover = this.config.failover.filter((watch) => watch.id !== id);
    this.uninstall(id);
    this.changed(true);
  }

  /**
   * Arm or disarm. A disarmed watch keeps probing and keeps reporting — the
   * health of a rig is worth seeing on a day when nothing should switch.
   */
  arm(id: string, armed: boolean): boolean {
    const watch = this.config.failover.find((candidate) => candidate.id === id);
    if (!watch) return false;
    watch.armed = armed;
    const runtime = this.runtimes.get(id);
    if (runtime) runtime.watch = watch;
    log.info(`failover "${watch.name}": ${armed ? 'armed' : 'disarmed'}`);
    this.changed(true);
    return true;
  }

  /** A heartbeat probe's poke. Anything that can make an HTTP request can. */
  heartbeat(id: string): boolean {
    const runtime = this.runtimes.get(id);
    if (!runtime) return false;
    runtime.lastHeartbeatAt = Date.now();
    return true;
  }

  /**
   * Fire the lost salvo by hand.
   *
   * The equivalent of disguise's failover API or its replace button: somebody
   * can see that the main system is no good for a reason no probe would catch,
   * and wants the backup now. It works on a disarmed watch, because disarming
   * means "do not decide for me", not "do not switch".
   */
  async trigger(id: string, client: string): Promise<{ ok: boolean; failures: string[] }> {
    const runtime = this.runtimes.get(id);
    if (!runtime) return { ok: false, failures: [`no such failover watch: ${id}`] };
    return this.fire(runtime, 'lost', `triggered by ${client}`);
  }

  /** Go back to the main system by hand, and clear the latch. */
  async restore(id: string, client: string): Promise<{ ok: boolean; failures: string[] }> {
    const runtime = this.runtimes.get(id);
    if (!runtime) return { ok: false, failures: [`no such failover watch: ${id}`] };
    return this.fire(runtime, 'restored', `restored by ${client}`);
  }

  private install(watch: FailoverWatch): void {
    const runtime: WatchRuntime = {
      watch,
      state: 'unknown',
      goodRun: 0,
      badRun: 0,
      everHealthy: false,
      lastProbeAt: null,
      lastChangeAt: null,
      firedAt: null,
      lastReason: null,
      lastHeartbeatAt: null,
      timer: null,
      busy: false,
    };
    runtime.timer = setInterval(() => void this.tick(runtime), watch.intervalMs);
    runtime.timer.unref();
    this.runtimes.set(watch.id, runtime);
  }

  private uninstall(id: string): void {
    const runtime = this.runtimes.get(id);
    if (!runtime) return;
    if (runtime.timer) clearInterval(runtime.timer);
    this.runtimes.delete(id);
  }

  private async tick(runtime: WatchRuntime): Promise<void> {
    // A probe slower than the interval must not stack up, and a salvo in flight
    // must not be interrupted by the next tick deciding the same thing again.
    if (runtime.busy) return;
    runtime.busy = true;
    try {
      const result = await this.probe(runtime);
      runtime.lastProbeAt = Date.now();
      runtime.lastReason = result.ok ? null : result.reason;
      await this.record(runtime, result.ok);
    } catch (error) {
      log.error(`failover "${runtime.watch.name}": probe threw — ${String(error)}`);
    } finally {
      runtime.busy = false;
    }
  }

  /** Fold one result into the state machine, and fire if that is what it means. */
  private async record(runtime: WatchRuntime, ok: boolean): Promise<void> {
    const { watch } = runtime;
    const before = runtime.state;

    if (ok) {
      runtime.goodRun++;
      runtime.badRun = 0;
      runtime.everHealthy = true;
    } else {
      runtime.badRun++;
      runtime.goodRun = 0;
    }

    const fired = runtime.firedAt !== null;

    if (!fired) {
      if (ok) {
        runtime.state = 'healthy';
      } else if (runtime.badRun < watch.failAfter) {
        runtime.state = 'failing';
      } else {
        // Enough failures to call it. Every reason not to switch anyway,
        // checked in the order a person would check them.
        runtime.state = 'failing';
        // Only as the threshold is crossed. A watch left disarmed against a
        // machine that is switched off would otherwise fill the log for days.
        const first = runtime.badRun === watch.failAfter;
        if (!watch.armed) {
          this.note(runtime, before, first ? 'is down, but the watch is disarmed' : null);
          return;
        }
        if (watch.requireHealthyFirst && !runtime.everHealthy) {
          this.note(
            runtime,
            before,
            first ? 'has never answered — not firing, nothing has been seen working yet' : null,
          );
          return;
        }
        // `fire` sets the state and does its own logging; leaving it as
        // "failing" until then keeps the transition it reports honest.
        await this.fire(runtime, 'lost', `${runtime.badRun} consecutive failures`);
        return;
      }
    } else {
      // Already fired. Coming back does not switch back on its own unless a
      // restored salvo says what "back" means.
      if (ok && runtime.goodRun >= watch.restoreAfter) {
        if (watch.onRestoredSalvo) {
          await this.fire(runtime, 'restored', `${runtime.goodRun} consecutive good results`);
          return;
        }
        runtime.state = 'returned';
      } else if (!ok) {
        runtime.state = 'failed';
      }
    }

    this.note(runtime, before, null);
  }

  /**
   * Take one of the watch's salvos.
   *
   * Both directions come through here so that a fire by hand and a fire by
   * probe are the same operation with the same logging — the difference between
   * them belongs in the reason, not in the code path.
   */
  private async fire(
    runtime: WatchRuntime,
    direction: 'lost' | 'restored',
    why: string,
  ): Promise<{ ok: boolean; failures: string[] }> {
    const { watch } = runtime;
    const salvoId = direction === 'lost' ? watch.onLostSalvo : watch.onRestoredSalvo;
    if (!salvoId) {
      return { ok: false, failures: [`failover "${watch.name}" has no ${direction} salvo`] };
    }

    const before = runtime.state;
    log.warn(`failover "${watch.name}": ${direction} — ${why}; taking salvo ${salvoId}`);

    const result = await this.fleet.takeSalvo(salvoId, `failover:${watch.id}`, {
      overrideLocks: watch.overrideLocks,
    });

    if (direction === 'lost') {
      runtime.firedAt = Date.now();
      runtime.state = 'failed';
    } else {
      runtime.firedAt = null;
      runtime.state = runtime.badRun > 0 ? 'failing' : 'healthy';
      runtime.goodRun = 0;
      runtime.badRun = 0;
    }

    if (result.ok) {
      log.info(`failover "${watch.name}": salvo ${salvoId} applied`);
    } else {
      // The half that did not happen is the whole story afterwards, so it is
      // named rather than counted.
      log.error(`failover "${watch.name}": salvo ${salvoId} did not fully apply — ${result.failures.join('; ')}`);
    }

    this.note(runtime, before, null);
    return result;
  }

  /** Record a state change, log the interesting ones, and tell the UI. */
  private note(runtime: WatchRuntime, before: WatchState, message: string | null): void {
    const changed = runtime.state !== before;
    if (changed) {
      runtime.lastChangeAt = Date.now();
      const detail = runtime.lastReason ? ` (${runtime.lastReason})` : '';
      log.info(`failover "${runtime.watch.name}": ${before} -> ${runtime.state}${detail}`);
    }
    if (message) log.warn(`failover "${runtime.watch.name}": ${message}`);
    if (changed || message) this.changed(false);
    else this.emit('tick');
  }

  private changed(persist: boolean): void {
    this.emit('change');
    if (persist) this.emit('configChanged');
  }

  private async probe(runtime: WatchRuntime): Promise<{ ok: boolean; reason: string }> {
    const { probe, intervalMs } = runtime.watch;
    switch (probe.kind) {
      case 'tcp':
        return probeTcp(probe, Math.min(intervalMs, 2000));
      case 'http':
        return probeHttp(probe, Math.min(intervalMs, 4000));
      case 'heartbeat': {
        const last = runtime.lastHeartbeatAt;
        if (last === null) return { ok: false, reason: 'no heartbeat received yet' };
        const age = Date.now() - last;
        // One interval of grace: a heartbeat sent on the same period as the
        // poll would otherwise race the poll and fail every other time.
        return age <= intervalMs * 2
          ? { ok: true, reason: '' }
          : { ok: false, reason: `last heartbeat ${Math.round(age / 1000)}s ago` };
      }
    }
  }
}

/**
 * A completed TCP handshake, nothing more.
 *
 * Deliberately not a read: a media server that has accepted the connection is
 * running, and asking it to say something useful means knowing its protocol,
 * which is a different and much larger promise. What this catches is the case
 * that actually happens — the machine is off, has crashed, or has fallen off
 * the network.
 */
function probeTcp(probe: { host: string; port: number }, timeoutMs: number): Promise<{ ok: boolean; reason: string }> {
  return new Promise((resolve) => {
    const socket = net.createConnection({ host: probe.host, port: probe.port });
    const done = (ok: boolean, reason: string): void => {
      socket.removeAllListeners();
      socket.destroy();
      resolve({ ok, reason });
    };
    socket.setTimeout(timeoutMs);
    socket.once('connect', () => done(true, ''));
    socket.once('timeout', () => done(false, `no answer from ${probe.host}:${probe.port} in ${timeoutMs}ms`));
    socket.once('error', (error: NodeJS.ErrnoException) => done(false, `${probe.host}:${probe.port} ${error.code ?? error.message}`));
  });
}

async function probeHttp(
  probe: { url: string; expectStatus?: number },
  timeoutMs: number,
): Promise<{ ok: boolean; reason: string }> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const response = await fetch(probe.url, { signal: controller.signal });
    if (probe.expectStatus !== undefined && response.status !== probe.expectStatus) {
      return { ok: false, reason: `${probe.url} answered ${response.status}, expected ${probe.expectStatus}` };
    }
    // Without an expected status, any answer at all is a live machine — a 404
    // from a web server still means the web server is there.
    return { ok: true, reason: '' };
  } catch (error) {
    return { ok: false, reason: `${probe.url}: ${error instanceof Error ? error.message : String(error)}` };
  } finally {
    clearTimeout(timer);
  }
}

function iso(at: number | null): string | null {
  return at === null ? null : new Date(at).toISOString();
}

export type { FailoverWatch, HealthProbe };
