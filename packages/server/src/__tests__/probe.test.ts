import { createSocket, type Socket } from 'node:dgram';
import { afterEach, describe, expect, it } from 'vitest';
import { ATEM_HELLO, RefusalWatch, problemFor, sayHello, type HelloOutcome } from '../atem/probe.js';
import type { ConnectionProblem } from '../atem/device.js';

/**
 * Asking a switcher why it won't connect.
 *
 * A fake switcher on localhost answers the hello the way a real one does: a
 * 20-byte reply with the SYN flag and a code in byte 12. Code 3 is what an
 * ATEM Mini Extreme ISO with every client slot taken sent on 2026-11-09, and
 * then nothing else.
 */

function helloReply(code: number): Buffer {
  const reply = Buffer.alloc(20);
  reply[0] = 0x10;
  reply[1] = 0x14;
  reply[2] = 0x53;
  reply[3] = 0xab;
  reply[12] = code;
  return reply;
}

const sockets: Socket[] = [];
afterEach(() => {
  for (const socket of sockets.splice(0)) socket.close();
});

/** A UDP listener that answers each packet with `answer`, and remembers what it got. */
async function fakeSwitcher(answer: (packet: Buffer) => Buffer[]): Promise<{ port: number; received: Buffer[] }> {
  const socket = createSocket('udp4');
  sockets.push(socket);
  const received: Buffer[] = [];
  socket.on('message', (packet, rinfo) => {
    received.push(packet);
    for (const reply of answer(packet)) socket.send(reply, rinfo.port, rinfo.address);
  });
  await new Promise<void>((resolve) => socket.bind(0, '127.0.0.1', resolve));
  return { port: socket.address().port, received };
}

describe('sayHello', () => {
  it('sends the hello atem-connection sends', async () => {
    const atem = await fakeSwitcher(() => [helloReply(2)]);
    await sayHello('127.0.0.1', { port: atem.port });
    expect(atem.received).toHaveLength(1);
    expect(atem.received[0].equals(ATEM_HELLO)).toBe(true);
  });

  it('reads code 2 as a session the switcher would take', async () => {
    const atem = await fakeSwitcher(() => [helloReply(2)]);
    expect(await sayHello('127.0.0.1', { port: atem.port })).toEqual({ kind: 'accepted' });
  });

  it('reads code 3 as a refusal', async () => {
    const atem = await fakeSwitcher(() => [helloReply(3)]);
    expect(await sayHello('127.0.0.1', { port: atem.port })).toEqual({ kind: 'refused', code: 3 });
  });

  it('skips packets that are not a hello reply', async () => {
    const notHello = Buffer.alloc(20);
    notHello[0] = 0x08; // ACK request, no SYN
    notHello[1] = 0x14;
    notHello[12] = 2;
    const atem = await fakeSwitcher(() => [notHello, helloReply(3)]);
    expect(await sayHello('127.0.0.1', { port: atem.port })).toEqual({ kind: 'refused', code: 3 });
  });

  it('says nothing answered when nothing does', async () => {
    const atem = await fakeSwitcher(() => []);
    const started = Date.now();
    expect(await sayHello('127.0.0.1', { port: atem.port, timeoutMs: 200 })).toEqual({ kind: 'no-answer' });
    expect(Date.now() - started).toBeLessThan(1000);
  });
});

describe('problemFor', () => {
  it('names the full switcher and what to do about it', () => {
    const problem = problemFor({ kind: 'refused', code: 3 }, '192.168.8.70');
    expect(problem?.kind).toBe('refused');
    expect(problem?.message).toMatch(/client slots/);
    expect(problem?.message).toMatch(/ATEM Software Control/);
  });

  it('keeps an unknown refusal code', () => {
    expect(problemFor({ kind: 'refused', code: 9 }, 'x')?.message).toMatch(/code 9/);
  });

  it('names the address when nothing answers', () => {
    expect(problemFor({ kind: 'no-answer' }, '192.168.12.104')?.message).toMatch(/192\.168\.12\.104/);
  });

  it('has nothing to say about a switcher that would take the session', () => {
    expect(problemFor({ kind: 'accepted' }, 'x')).toBeNull();
  });
});

describe('RefusalWatch', () => {
  function setup(outcomes: HelloOutcome[]) {
    let clock = 0;
    const probes: number[] = [];
    const changes: Array<ConnectionProblem | null> = [];
    const watch = new RefusalWatch({
      address: '192.168.8.70',
      now: () => clock,
      probe: async () => {
        probes.push(clock);
        return outcomes.length > 1 ? outcomes.shift()! : outcomes[0];
      },
      onChange: (problem) => changes.push(problem),
      stuckAfterMs: 7000,
      probeEveryMs: 30_000,
      acceptedBackoffMs: 300_000,
      tickEveryMs: 0,
    });
    return {
      watch,
      probes,
      changes,
      at(ms: number) {
        clock = ms;
        return watch.tick();
      },
    };
  }

  it('waits for the library to give up a try before asking', async () => {
    const { watch, probes, at } = setup([{ kind: 'refused', code: 3 }]);
    watch.notConnected();
    await at(6999);
    expect(probes).toEqual([]);
    await at(7000);
    expect(probes).toEqual([7000]);
    expect(watch.problem?.kind).toBe('refused');
  });

  it('asks again every so often, and reports only changes', async () => {
    const { watch, probes, changes, at } = setup([{ kind: 'refused', code: 3 }]);
    watch.notConnected();
    await at(7000);
    await at(20_000);
    expect(probes).toEqual([7000]);
    await at(37_000);
    expect(probes).toEqual([7000, 37_000]);
    expect(changes).toHaveLength(1);
  });

  it('notices when the reason changes', async () => {
    const { watch, changes, at } = setup([{ kind: 'refused', code: 3 }, { kind: 'no-answer' }]);
    watch.notConnected();
    await at(7000);
    await at(37_000);
    expect(changes.map((problem) => problem?.kind)).toEqual(['refused', 'no-answer']);
  });

  it('clears the problem and stops asking once connected', async () => {
    const { watch, probes, changes, at } = setup([{ kind: 'refused', code: 3 }]);
    watch.notConnected();
    await at(7000);
    watch.connected();
    expect(watch.problem).toBeNull();
    expect(changes.at(-1)).toBeNull();
    await at(100_000);
    expect(probes).toEqual([7000]);
  });

  it('starts the clock again on the next disconnect', async () => {
    const { watch, probes, at } = setup([{ kind: 'refused', code: 3 }]);
    watch.notConnected();
    await at(7000);
    watch.connected();
    await at(50_000);
    watch.notConnected();
    await at(56_000);
    expect(probes).toEqual([7000]);
    await at(57_000);
    expect(probes).toEqual([7000, 57_000]);
  });

  it('waits much longer after a hello the switcher took, since that holds a slot', async () => {
    const { watch, probes, at } = setup([{ kind: 'accepted' }]);
    watch.notConnected();
    await at(7000);
    expect(watch.problem).toBeNull();
    await at(37_000);
    expect(probes).toEqual([7000]);
    await at(307_000);
    expect(probes).toEqual([7000, 307_000]);
  });

  it('drops an answer that arrives after the device connected', async () => {
    let release: (outcome: HelloOutcome) => void = () => {};
    const changes: Array<ConnectionProblem | null> = [];
    let clock = 0;
    const watch = new RefusalWatch({
      address: 'x',
      now: () => clock,
      probe: () => new Promise((resolve) => (release = resolve)),
      onChange: (problem) => changes.push(problem),
      tickEveryMs: 0,
    });
    watch.notConnected();
    clock = 10_000;
    const pending = watch.tick();
    watch.connected();
    release({ kind: 'refused', code: 3 });
    await pending;
    expect(watch.problem).toBeNull();
    expect(changes.filter((problem) => problem !== null)).toEqual([]);
  });

  it('turns a probe that throws into a problem, not an unhandled rejection', async () => {
    let clock = 0;
    const watch = new RefusalWatch({
      address: 'x',
      now: () => clock,
      probe: async () => {
        throw new Error('boom');
      },
      onChange: () => {},
      tickEveryMs: 0,
    });
    watch.notConnected();
    clock = 10_000;
    await watch.tick();
    expect(watch.problem).toEqual({ kind: 'unreachable', message: "Can't reach x: boom" });
  });
});
