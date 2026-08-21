import { describe, expect, it } from 'vitest';
import {
  BlockParser,
  formatBlock,
  indexedLines,
  parseIndexedLine,
  parseRouteLine,
} from '../protocol.js';

describe('BlockParser', () => {
  it('reads a block terminated by a blank line', () => {
    const parser = new BlockParser();
    const blocks = parser.push('VIDEO OUTPUT ROUTING:\n7 2\n\n');
    expect(blocks).toEqual([{ header: 'VIDEO OUTPUT ROUTING', lines: ['7 2'] }]);
  });

  it('reassembles a block split across chunks, mid-line', () => {
    const parser = new BlockParser();
    expect(parser.push('VIDEO OUT')).toEqual([]);
    expect(parser.push('PUT ROUTING:\n7 ')).toEqual([]);
    expect(parser.push('2\n')).toEqual([]);
    expect(parser.push('\n')).toEqual([{ header: 'VIDEO OUTPUT ROUTING', lines: ['7 2'] }]);
  });

  it('tolerates CRLF, which telnet and some panels send', () => {
    const parser = new BlockParser();
    expect(parser.push('PING:\r\n\r\n')).toEqual([{ header: 'PING', lines: [] }]);
  });

  it('ignores blank lines between blocks', () => {
    const parser = new BlockParser();
    const blocks = parser.push('\n\nPING:\n\n\n\nPING:\n\n');
    expect(blocks).toHaveLength(2);
  });

  it('treats a header with no lines as a dump request', () => {
    const parser = new BlockParser();
    expect(parser.push('OUTPUT LABELS:\n\n')).toEqual([{ header: 'OUTPUT LABELS', lines: [] }]);
  });

  it('accepts a header typed without its colon, in any case', () => {
    const parser = new BlockParser();
    expect(parser.push('ping\n\n')).toEqual([{ header: 'PING', lines: [] }]);
  });
});

describe('line helpers', () => {
  it('keeps spaces inside a label', () => {
    expect(parseIndexedLine('7 New output 8 label')).toEqual({ index: 7, value: 'New output 8 label' });
  });

  it('reads an empty label as empty, not as a failure', () => {
    expect(parseIndexedLine('3 ')).toEqual({ index: 3, value: '' });
  });

  it('rejects a route line that is not two numbers', () => {
    expect(parseRouteLine('7 two')).toBeNull();
    expect(parseRouteLine('7 2')).toEqual({ output: 7, input: 2 });
  });

  it('numbers lines from zero and can emit a subset', () => {
    expect(indexedLines(['a', 'b', 'c'])).toEqual(['0 a', '1 b', '2 c']);
    expect(indexedLines(['a', 'b', 'c'], [2])).toEqual(['2 c']);
  });

  it('formats a block with a trailing blank line', () => {
    expect(formatBlock('ACKISH', ['0 U'])).toBe('ACKISH:\n0 U\n\n');
  });
});
