/**
 * A plain-text, one-line-in one-line-out control protocol for crosspoints.
 *
 * Why this exists at all, when there is already a Videohub emulation: the
 * systems that most want to drive a router on failover often cannot speak
 * Videohub, but can all send a string.
 *
 * - **disguise**'s Telnet Matrix device has no fixed command set. The operator
 *   types the route header, the route body and the route footer themselves,
 *   with `$1` standing for the input and `$2` for the output, and a separate
 *   preset command with `$1` standing for the preset — the one a machine's
 *   `DVI matrix preset` field fires on failover. So the useful thing is not to
 *   imitate a particular vendor, it is to accept a form simple enough to be
 *   typed into that box and be documented exactly.
 * - **PIXERA** sends whatever its TcpClient control module is told to send,
 *   from a `System Lost` trigger. Same conclusion.
 * - **7thSense** and most show controllers emit ASCII over TCP or UDP.
 *
 * Two families of line are accepted. The native one is unambiguous and is what
 * the documentation tells people to paste. The Extron SIS one is here because
 * it is what a generic "telnet matrix" driver is most often already set to.
 *
 * ## Numbering
 *
 * Lines are **one-based** by default, because every ASCII matrix worth
 * imitating is — `1*2!` means input 1 to output 2 — and Videohub's zero-based
 * numbering is the odd one out. `wireBase: 0` swaps it. Getting this wrong is
 * an off-by-one on every crosspoint, so the server says which base it is using
 * in its greeting.
 */

import type { AsciiMatrixBackend } from './types.js';

export type Command =
  | { kind: 'route'; deviceId: string | null; output: number; input: number; echo: EchoStyle }
  | { kind: 'device'; deviceId: string }
  | { kind: 'salvo'; salvo: string; echo: EchoStyle }
  | { kind: 'failover'; id: string; direction: 'lost' | 'restored' }
  | { kind: 'status'; deviceId: string | null }
  | { kind: 'list' }
  | { kind: 'ping' }
  | { kind: 'help' }
  | { kind: 'error'; reason: string };

/**
 * How to answer. An SIS-shaped request gets an SIS-shaped answer, because a
 * driver that sends `1*2!` is usually waiting for `Out2 In1 All` and will call
 * the router faulty if it gets anything else.
 */
export type EchoStyle = 'native' | 'sis-all' | 'sis-vid' | 'sis-aud' | 'sis-rgb' | 'sis-preset';

export interface ParseOptions {
  /** The first number on the wire. 1 by default; see the note above. */
  wireBase?: number;
}

/** Extron's tie terminators, and what each one is called in its reply. */
const SIS_TIE = new Map<string, EchoStyle>([
  ['!', 'sis-all'],
  ['&', 'sis-rgb'],
  ['%', 'sis-vid'],
  ['$', 'sis-aud'],
]);

const SIS_REPLY = new Map<EchoStyle, string>([
  ['sis-all', 'All'],
  ['sis-rgb', 'RGB'],
  ['sis-vid', 'Vid'],
  ['sis-aud', 'Aud'],
]);

/**
 * Turn one line into a command. Never throws: a line nobody can make sense of
 * is an `error` command, so the caller answers rather than dropping the
 * connection.
 */
export function parseLine(line: string, options: ParseOptions = {}): Command | null {
  const base = options.wireBase ?? 1;
  const trimmed = line.trim();
  if (trimmed === '') return null;

  // --- Extron SIS shapes, checked first because they have no keyword --------

  const tie = /^(\d{1,3})\s*\*\s*(\d{1,3})\s*([!&%$])$/.exec(trimmed);
  if (tie) {
    const echo = SIS_TIE.get(tie[3] as string) ?? 'sis-all';
    return {
      kind: 'route',
      deviceId: null,
      input: Number(tie[1]) - base,
      output: Number(tie[2]) - base,
      echo,
    };
  }

  // `3.` recalls preset 3 — an Extron preset recall, and the shape disguise's
  // preset command is usually set to. Presets here are salvos, by position.
  const preset = /^(\d{1,3})\s*\.$/.exec(trimmed);
  if (preset) return { kind: 'salvo', salvo: `#${Number(preset[1])}`, echo: 'sis-preset' };

  // --- The native shapes ---------------------------------------------------

  const words = trimmed.split(/\s+/);
  const verb = (words[0] ?? '').toUpperCase();
  const rest = words.slice(1);

  switch (verb) {
    case 'ROUTE':
    case 'X': {
      // ROUTE <output> <input>            on the connection's device
      // ROUTE <device> <output> <input>   naming one
      if (rest.length === 2) {
        const output = toIndex(rest[0], base);
        const input = toIndex(rest[1], base);
        if (output === null || input === null) return { kind: 'error', reason: 'ROUTE wants numbers' };
        return { kind: 'route', deviceId: null, output, input, echo: 'native' };
      }
      if (rest.length === 3) {
        const output = toIndex(rest[1], base);
        const input = toIndex(rest[2], base);
        if (output === null || input === null) return { kind: 'error', reason: 'ROUTE wants numbers' };
        return { kind: 'route', deviceId: rest[0] as string, output, input, echo: 'native' };
      }
      return { kind: 'error', reason: 'usage: ROUTE [device] <output> <input>' };
    }
    case 'DEVICE':
      if (rest.length !== 1) return { kind: 'error', reason: 'usage: DEVICE <id>' };
      return { kind: 'device', deviceId: rest[0] as string };
    case 'SALVO':
    case 'PRESET':
      if (rest.length === 0) return { kind: 'error', reason: 'usage: SALVO <id or name>' };
      return { kind: 'salvo', salvo: rest.join(' '), echo: 'native' };
    case 'FAILOVER':
      if (rest.length !== 1) return { kind: 'error', reason: 'usage: FAILOVER <watch id>' };
      return { kind: 'failover', id: rest[0] as string, direction: 'lost' };
    case 'RESTORE':
      if (rest.length !== 1) return { kind: 'error', reason: 'usage: RESTORE <watch id>' };
      return { kind: 'failover', id: rest[0] as string, direction: 'restored' };
    case 'STATUS':
      return { kind: 'status', deviceId: rest[0] ?? null };
    case 'LIST':
      return { kind: 'list' };
    case 'PING':
      return { kind: 'ping' };
    case 'HELP':
    case '?':
      return { kind: 'help' };
    default:
      return { kind: 'error', reason: `unknown command: ${words[0]}` };
  }
}

/** The reply to a route that was applied, in whichever dialect asked for it. */
export function routeReply(command: { output: number; input: number; echo: EchoStyle }, base: number): string {
  const output = command.output + base;
  const input = command.input + base;
  const sis = SIS_REPLY.get(command.echo);
  if (sis) return `Out${output} In${input} ${sis}`;
  return `OK ROUTE ${output} ${input}`;
}

function toIndex(word: string | undefined, base: number): number | null {
  if (word === undefined) return null;
  if (!/^\d{1,4}$/.test(word)) return null;
  const value = Number(word) - base;
  return value < 0 ? null : value;
}

/**
 * A salvo reference. `#3` is the third salvo in the list — how a preset recall
 * has to work, since a preset is a number — and anything else is matched
 * against ids first and then names, case-insensitively, so a person on telnet
 * can type what they see in the UI.
 */
export function resolveSalvo(reference: string, salvos: Array<{ id: string; name: string }>): string | null {
  const byPosition = /^#(\d+)$/.exec(reference);
  if (byPosition) {
    const salvo = salvos[Number(byPosition[1]) - 1];
    return salvo ? salvo.id : null;
  }
  const wanted = reference.trim().toLowerCase();
  const byId = salvos.find((salvo) => salvo.id.toLowerCase() === wanted);
  if (byId) return byId.id;
  const byName = salvos.find((salvo) => salvo.name.toLowerCase() === wanted);
  return byName ? byName.id : null;
}

export function helpText(
  backend: AsciiMatrixBackend,
  base: number,
  language = false,
): string[] {
  const devices = backend.listDevices();
  return [
    `# BlackMatrix line protocol. Numbers start at ${base}.`,
    '# ROUTE <output> <input>            route on this connection\'s device',
    '# ROUTE <device> <output> <input>   route on a named device',
    '# DEVICE <id>                       point this connection at a device',
    '# SALVO <id or name>                fire a salvo',
    '# <n>.                              fire the nth salvo (Extron preset recall)',
    '# <in>*<out>!                       route, Extron style (& % $ also accepted)',
    '# FAILOVER <watch id>               fire a failover watch\'s lost salvo',
    '# RESTORE <watch id>                fire its restored salvo',
    '# STATUS [device]                   what every output is taking',
    '# LIST                              devices, salvos and failover watches',
    '# PING                              answers PONG',
    `# devices: ${devices.map((device) => device.id).join(', ') || 'none'}`,
    ...(language
      ? [
          '# Anything else is read as a BlackMatrix command language line —',
          '#   the grammar, a state path, a wire code, JSON or OSC.',
          '#   "BM Help" lists it. (Plain HELP is this protocol\'s own, above.)',
        ]
      : []),
  ];
}
