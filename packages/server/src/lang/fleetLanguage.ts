import { run, type DeviceView, type Op, type RunContext, type RunResult } from '@av/atem-lang';
import type { Atem } from 'atem-connection';
import type { Fleet } from '../fleet.js';
import { log } from '../log.js';
import { execute } from './execute.js';

export interface LanguageOptions {
  /** Which switcher an unqualified line means, when the caller has one in mind. */
  device?: string | null;
  /** Who is asking, for the log. */
  client?: string;
}

export interface LanguageOutcome {
  ok: boolean;
  /** Lines to answer with, already formatted for a text transport. */
  replies: string[];
}

/**
 * The command language, pointed at this app's fleet.
 *
 * The language package is pure — it turns a line into ops and knows nothing
 * about sockets, switchers or this app. This is the half that knows all three:
 * it tells the language what the fleet looks like, runs what comes back, and
 * says what happened in a shape a text protocol can send.
 *
 * ## Counts come from the switcher, not from a model table
 *
 * The same rule crosspoint legality already follows here. `video.mixEffects`
 * is four long on a Constellation and one on a Mini, and the switcher says so
 * in its own state — so `Cut ME 3` is refused on the Mini before anything is
 * sent, and refused with the number it actually has. A device that cannot say
 * gets no bounds checked and the switcher does the refusing, which is the
 * honest fallback rather than a guess.
 */
export class FleetLanguage {
  constructor(private fleet: Fleet) {}

  /** What the languages need to know about the fleet right now. */
  private context(options: LanguageOptions): RunContext {
    const devices: DeviceView[] = this.fleet.listRunners().map(({ id, name, runner }) => {
      const state = runner.full?.()?.state ?? null;
      const counts: Record<string, number> = {};
      if (state) {
        counts['video.mixEffects'] = state.video.mixEffects.length;
        counts['video.downstreamKeyers'] = state.video.downstreamKeyers.length;
        counts['video.superSources'] = state.video.superSources.length;
        counts['video.auxilliaries'] = state.video.auxilliaries.length;
        counts['settings.multiViewers'] = state.settings.multiViewers.length;
        counts['media.players'] = state.media.players.length;
      }
      return { id, name, counts };
    });

    return {
      devices,
      ...(options.device ? { device: options.device } : {}),
    };
  }

  /** Parse, compile and run one line. Never throws. */
  async runLine(line: string, options: LanguageOptions = {}): Promise<LanguageOutcome> {
    let result: RunResult;
    try {
      result = run(line, this.context(options));
    } catch (error) {
      return { ok: false, replies: [`ERR ${String(error)}`] };
    }

    if (!result.ok) {
      return { ok: false, replies: result.errors.map((problem) => `ERR ${problem.message}`) };
    }

    const replies: string[] = [];
    let failed = false;

    for (const read of result.reads) {
      const value = this.read(read.device, read.path);
      if (value.ok) replies.push(`OK ${read.device} ${read.path} ${JSON.stringify(value.value)}`);
      else {
        replies.push(`ERR ${value.reason}`);
        failed = true;
      }
    }

    for (const op of result.ops) {
      const problem = await this.apply(op, options.client ?? 'unknown');
      if (problem) {
        replies.push(`ERR ${problem}`);
        failed = true;
      } else {
        replies.push(`OK ${op.describe}`);
      }
    }

    if (!result.ops.length && !result.reads.length) {
      /* Help is a summary that is already several lines; anything else is one.
         Splitting here keeps the transport's one-line-per-reply contract. */
      const lines = result.summary.split('\n');
      if (lines.length > 1) replies.push(...lines);
      else replies.push(`OK ${result.summary}`);
    }
    return { ok: !failed, replies };
  }

  /**
   * Run one op, or say why not.
   *
   * The three refusals are deliberately different sentences. "Not connected",
   * "that is a Videohub" and "that is a simulated switcher" are three different
   * problems and only one of them is worth waiting out.
   */
  private async apply(op: Op, client: string): Promise<string | null> {
    const entry = this.fleet.listRunners().find((candidate) => candidate.id === op.device);
    if (!entry) return `no switcher called ${op.device}`;

    if (typeof entry.runner.full !== 'function') {
      return `${op.device} is a Videohub — it has crosspoints, and "${op.describe}" is not one`;
    }
    const atem = entry.runner.full();
    if (!atem) {
      return entry.runner.connection === 'connected'
        ? `${op.device} is a simulated switcher — only its crosspoints are simulated`
        : `${op.device} is not connected`;
    }

    try {
      await execute(op, atem);
      log.info(`lang(${client}): ${op.describe}`);
      return null;
    } catch (error) {
      return `${op.describe} — ${(error as Error).message}`;
    }
  }

  /**
   * Look one state path up on a device.
   *
   * The refusals match `apply`'s, word for word where the cause is the same.
   * A read that said "not connected" about a switcher the UI shows as
   * connected sends someone to check a network that is fine.
   */
  private read(deviceId: string, path: string): { ok: true; value: unknown } | { ok: false; reason: string } {
    const entry = this.fleet.listRunners().find((candidate) => candidate.id === deviceId);
    if (!entry) return { ok: false, reason: `no switcher called ${deviceId}` };
    if (typeof entry.runner.full !== 'function') {
      return { ok: false, reason: `${deviceId} is a Videohub — it has no state tree to read` };
    }
    const atem = entry.runner.full();
    if (!atem?.state) {
      return {
        ok: false,
        reason:
          entry.runner.connection === 'connected'
            ? `${deviceId} is a simulated switcher — only its crosspoints are simulated`
            : `${deviceId} is not connected`,
      };
    }

    let node: unknown = atem.state;
    for (const segment of path.split('.')) {
      if (node === null || node === undefined) {
        return { ok: false, reason: `${deviceId} has nothing at ${path}` };
      }
      node = (node as Record<string, unknown>)[segment];
    }
    return { ok: true, value: node };
  }
}
