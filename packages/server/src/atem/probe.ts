import { createSocket } from 'node:dgram';
import type { ConnectionProblem } from './device.js';

/**
 * Why a switcher is not connecting, asked of the switcher itself.
 *
 * atem-connection never says. When a switcher answers its hello with a
 * refusal, the library takes the answer as a session, waits five seconds for
 * state that never comes, and reports `disconnected`. Then it does the same
 * again, for ever. An ATEM that is out of client slots, an address with nothing
 * on it and a host that isn't an ATEM all look the same from the outside:
 * "disconnected".
 *
 * The library runs its socket in a worker thread, so its packets can't be
 * watched from here. Instead this sends one hello of its own from its own
 * socket and reads the answer. The answer is a code in byte 12 of the reply:
 * 2 when the switcher takes the session, 3 when it turns it away.
 */

/** The same opening packet atem-connection sends, byte for byte. */
export const ATEM_HELLO = Buffer.from([
  0x10, 0x14, 0x53, 0xab, 0x00, 0x00, 0x00, 0x00, 0x00, 0x3a, 0x00, 0x00, 0x01, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00,
  0x00,
]);

export const ATEM_PORT = 9910;

const SYN_FLAG = 0x02;
const HELLO_ACCEPTED = 0x02;

export type HelloOutcome =
  | { kind: 'accepted' }
  | { kind: 'refused'; code: number }
  | { kind: 'no-answer' }
  | { kind: 'unreachable'; message: string };

export interface HelloOptions {
  port?: number;
  timeoutMs?: number;
}

/** Send one hello and say what came back. Never rejects. */
export function sayHello(address: string, options: HelloOptions = {}): Promise<HelloOutcome> {
  const port = options.port ?? ATEM_PORT;
  const timeoutMs = options.timeoutMs ?? 1500;

  return new Promise((resolve) => {
    const socket = createSocket('udp4');
    let settled = false;
    const finish = (outcome: HelloOutcome): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      try {
        socket.close();
      } catch {
        // Already closed.
      }
      resolve(outcome);
    };
    const timer = setTimeout(() => finish({ kind: 'no-answer' }), timeoutMs);

    socket.on('error', (error) => finish({ kind: 'unreachable', message: error.message }));
    socket.on('message', (packet) => {
      // Anything other than a hello reply is not an answer to this hello.
      if (packet.length < 13 || !((packet.readUInt8(0) >> 3) & SYN_FLAG)) return;
      const code = packet.readUInt8(12);
      finish(code === HELLO_ACCEPTED ? { kind: 'accepted' } : { kind: 'refused', code });
    });
    try {
      socket.send(ATEM_HELLO, port, address, (error) => {
        if (error) finish({ kind: 'unreachable', message: error.message });
      });
    } catch (error) {
      finish({ kind: 'unreachable', message: error instanceof Error ? error.message : String(error) });
    }
  });
}

/** The problem an outcome describes, or null when the switcher would take a session. */
export function problemFor(outcome: HelloOutcome, address: string): ConnectionProblem | null {
  switch (outcome.kind) {
    case 'accepted':
      return null;
    case 'refused':
      return {
        kind: 'refused',
        message:
          outcome.code === 3
            ? 'The switcher is turning new connections away, most likely because all its client slots are in use. ' +
              'Close another app connected to it (ATEM Software Control, Companion, another BlackMatrix) and this ' +
              'connects on its own.'
            : `The switcher refused the connection (code ${outcome.code}).`,
      };
    case 'no-answer':
      return {
        kind: 'no-answer',
        message: `Nothing answers on UDP ${ATEM_PORT} at ${address}. Check the address and that the device is an ATEM.`,
      };
    case 'unreachable':
      return { kind: 'unreachable', message: `Can't reach ${address}: ${outcome.message}` };
  }
}

export interface RefusalWatchOptions {
  address: string;
  onChange: (problem: ConnectionProblem | null) => void;
  probe?: (address: string) => Promise<HelloOutcome>;
  now?: () => number;
  /** How long a device may try before it is asked why. atem-connection gives up a try after 5 s. */
  stuckAfterMs?: number;
  /** How often to ask again while it stays stuck. */
  probeEveryMs?: number;
  /**
   * How long to wait after the switcher said it would take a session.
   *
   * A hello it accepts opens a session that this never uses, and it holds a
   * client slot until the switcher times it out. That is the one cost of
   * asking, so after an accepted hello this waits much longer before asking
   * again. A refused hello costs nothing.
   */
  acceptedBackoffMs?: number;
  /** How often to look. 0 starts no timer, for tests that call `tick` themselves. */
  tickEveryMs?: number;
}

/**
 * Asks a stuck switcher why, now and then, until it connects.
 *
 * The device tells it when it stops being connected and when it connects
 * again. In between, once the device has been trying for `stuckAfterMs`, it
 * sends a hello every `probeEveryMs` and reports the problem when it changes.
 */
export class RefusalWatch {
  private readonly options: Required<Omit<RefusalWatchOptions, 'onChange' | 'address'>> &
    Pick<RefusalWatchOptions, 'onChange' | 'address'>;
  private notConnectedSince: number | null = null;
  private nextProbeAt = 0;
  private probing = false;
  private timer: NodeJS.Timeout | null = null;
  private current: ConnectionProblem | null = null;

  constructor(options: RefusalWatchOptions) {
    this.options = {
      probe: (address) => sayHello(address),
      now: () => Date.now(),
      stuckAfterMs: 7000,
      probeEveryMs: 30_000,
      acceptedBackoffMs: 5 * 60_000,
      tickEveryMs: 1000,
      ...options,
    };
  }

  get problem(): ConnectionProblem | null {
    return this.current;
  }

  /** The device is trying to connect, or has just lost its session. */
  notConnected(): void {
    if (this.notConnectedSince === null) this.notConnectedSince = this.options.now();
    if (!this.timer && this.options.tickEveryMs > 0) {
      this.timer = setInterval(() => void this.tick(), this.options.tickEveryMs);
      this.timer.unref();
    }
  }

  /** The device has its session. */
  connected(): void {
    this.reset();
  }

  /** The device was told to stop. */
  stop(): void {
    this.reset();
  }

  /** One look. The interval calls it; tests call it directly. */
  async tick(): Promise<void> {
    const since = this.notConnectedSince;
    if (since === null || this.probing) return;
    const now = this.options.now();
    if (now - since < this.options.stuckAfterMs || now < this.nextProbeAt) return;

    this.probing = true;
    let outcome: HelloOutcome;
    try {
      outcome = await this.options.probe(this.options.address);
    } catch (error) {
      outcome = { kind: 'unreachable', message: error instanceof Error ? error.message : String(error) };
    } finally {
      this.probing = false;
    }
    // It may have connected, or been stopped, while the hello was out.
    if (this.notConnectedSince === null) return;

    this.nextProbeAt =
      this.options.now() + (outcome.kind === 'accepted' ? this.options.acceptedBackoffMs : this.options.probeEveryMs);
    this.set(problemFor(outcome, this.options.address));
  }

  private reset(): void {
    this.notConnectedSince = null;
    this.nextProbeAt = 0;
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = null;
    }
    this.set(null);
  }

  private set(problem: ConnectionProblem | null): void {
    if (problem?.kind === this.current?.kind && problem?.message === this.current?.message) return;
    this.current = problem;
    this.options.onChange(problem);
  }
}
