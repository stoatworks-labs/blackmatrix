/**
 * Wire format for the Videohub Ethernet Protocol: a block is an ALL-CAPS
 * header ending in ':', zero or more lines, then a blank line.
 *
 * A block with no lines is a request for a full dump of that block (or, for
 * `PING:`, a no-op). A block with lines is a status update, in both
 * directions — clients ask for changes using exactly the form the server uses
 * to report them.
 */

export const PROTOCOL_VERSION = '2.3';

export interface Block {
  /** Header without the trailing colon, e.g. `VIDEO OUTPUT ROUTING`. */
  header: string;
  lines: string[];
}

/**
 * Feed bytes in, get whole blocks out. Tolerates CRLF, which real clients
 * (and telnet) send even though the spec only calls for a newline.
 */
export class BlockParser {
  private buffer = '';
  private header: string | null = null;
  private lines: string[] = [];

  push(chunk: string): Block[] {
    this.buffer += chunk;
    const out: Block[] = [];

    let index: number;
    while ((index = this.buffer.indexOf('\n')) >= 0) {
      const raw = this.buffer.slice(0, index);
      this.buffer = this.buffer.slice(index + 1);
      const line = raw.endsWith('\r') ? raw.slice(0, -1) : raw;

      if (this.header === null) {
        // Between blocks: ignore blank lines, take the next non-blank as a header.
        if (line.trim() === '') continue;
        this.header = normalizeHeader(line);
        this.lines = [];
        continue;
      }

      if (line.trim() === '') {
        out.push({ header: this.header, lines: this.lines });
        this.header = null;
        this.lines = [];
        continue;
      }

      this.lines.push(line);
    }

    return out;
  }
}

/**
 * A header may arrive with or without its colon. Case is normalised to upper
 * so a hand-typed telnet session behaves like a panel.
 */
function normalizeHeader(line: string): string {
  const trimmed = line.trim();
  const withoutColon = trimmed.endsWith(':') ? trimmed.slice(0, -1) : trimmed;
  return withoutColon.toUpperCase();
}

export function formatBlock(header: string, lines: string[] = []): string {
  return `${header}:\n${lines.map((l) => `${l}\n`).join('')}\n`;
}

/** `ACK` and `NAK` are themselves blocks — header only, then a blank line. */
export const ACK = 'ACK\n\n';
export const NAK = 'NAK\n\n';

/** Lines of the form `<index> <value>`; the value may contain spaces (labels). */
export function parseIndexedLine(line: string): { index: number; value: string } | null {
  const match = /^\s*(\d+)\s?(.*)$/.exec(line);
  if (!match) return null;
  const index = Number(match[1]);
  if (!Number.isInteger(index)) return null;
  return { index, value: match[2] ?? '' };
}

/** Lines of the form `<output> <input>`, both non-negative integers. */
export function parseRouteLine(line: string): { output: number; input: number } | null {
  const match = /^\s*(\d+)\s+(-?\d+)\s*$/.exec(line);
  if (!match) return null;
  return { output: Number(match[1]), input: Number(match[2]) };
}

export function indexedLines(values: string[], indexes?: number[]): string[] {
  const wanted = indexes ?? values.map((_, i) => i);
  return wanted
    .filter((i) => i >= 0 && i < values.length)
    .map((i) => `${i} ${values[i]}`);
}
