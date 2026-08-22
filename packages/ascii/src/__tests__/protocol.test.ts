import { describe, expect, it } from 'vitest';
import { parseLine, resolveSalvo, routeReply } from '../protocol.js';

describe('parseLine, Extron shapes', () => {
  it('reads a tie and converts it to zero-based indices', () => {
    // `1*2!` is input 1 to output 2, one-based, which is output 1 input 0 here.
    expect(parseLine('1*2!')).toEqual({ kind: 'route', deviceId: null, input: 0, output: 1, echo: 'sis-all' });
  });

  it('accepts the other tie terminators and remembers which was used', () => {
    expect(parseLine('2*3&')).toMatchObject({ kind: 'route', echo: 'sis-rgb' });
    expect(parseLine('2*3%')).toMatchObject({ kind: 'route', echo: 'sis-vid' });
    expect(parseLine('2*3$')).toMatchObject({ kind: 'route', echo: 'sis-aud' });
  });

  it('accepts the padded forms a three-digit matrix sends', () => {
    expect(parseLine('003*004!')).toMatchObject({ kind: 'route', input: 2, output: 3 });
  });

  it('reads a preset recall as a salvo by position', () => {
    expect(parseLine('3.')).toEqual({ kind: 'salvo', salvo: '#3', echo: 'sis-preset' });
  });

  it('answers a tie in the dialect it was asked in', () => {
    const command = { output: 1, input: 0, echo: 'sis-all' as const };
    expect(routeReply(command, 1)).toBe('Out2 In1 All');
    expect(routeReply({ ...command, echo: 'sis-vid' }, 1)).toBe('Out2 In1 Vid');
    expect(routeReply({ ...command, echo: 'native' }, 1)).toBe('OK ROUTE 2 1');
  });
});

describe('parseLine, native shapes', () => {
  it('reads a two-argument route as output then input', () => {
    expect(parseLine('ROUTE 2 1')).toEqual({ kind: 'route', deviceId: null, output: 1, input: 0, echo: 'native' });
  });

  it('reads a three-argument route as device, output, input', () => {
    expect(parseLine('route stage 2 1')).toEqual({
      kind: 'route',
      deviceId: 'stage',
      output: 1,
      input: 0,
      echo: 'native',
    });
  });

  it('refuses a route with a number below the base rather than wrapping it', () => {
    // One-based on the wire, so 0 is not an output — and silently turning it
    // into -1 would route something nobody asked for.
    expect(parseLine('ROUTE 0 1')).toMatchObject({ kind: 'error' });
  });

  it('honours a zero-based server', () => {
    expect(parseLine('ROUTE 0 0', { wireBase: 0 })).toMatchObject({ output: 0, input: 0 });
    expect(parseLine('1*2!', { wireBase: 0 })).toMatchObject({ input: 1, output: 2 });
  });

  it('reads the salvo and failover verbs', () => {
    expect(parseLine('SALVO house to wide')).toEqual({ kind: 'salvo', salvo: 'house to wide', echo: 'native' });
    expect(parseLine('FAILOVER main')).toEqual({ kind: 'failover', id: 'main', direction: 'lost' });
    expect(parseLine('RESTORE main')).toEqual({ kind: 'failover', id: 'main', direction: 'restored' });
  });

  it('ignores blank lines and complains about anything else', () => {
    expect(parseLine('   ')).toBeNull();
    expect(parseLine('do the thing')).toMatchObject({ kind: 'error' });
  });
});

describe('resolveSalvo', () => {
  const salvos = [
    { id: 'salvo-a', name: 'House to wide' },
    { id: 'salvo-b', name: 'Backup server' },
  ];

  it('resolves a preset number by position, one-based', () => {
    expect(resolveSalvo('#2', salvos)).toBe('salvo-b');
    expect(resolveSalvo('#3', salvos)).toBeNull();
  });

  it('resolves an id before a name, and either case-insensitively', () => {
    expect(resolveSalvo('SALVO-A', salvos)).toBe('salvo-a');
    expect(resolveSalvo('backup server', salvos)).toBe('salvo-b');
    expect(resolveSalvo('nothing', salvos)).toBeNull();
  });
});
