import dgram from 'node:dgram';
import net from 'node:net';
import os from 'node:os';
import { log } from './log.js';

export interface FoundDevice {
  address: string;
  /**
   * Which protocols answered. An ATEM Mini Extreme ISO answers BOTH: Blackmagic's
   * firmware serves the Videohub protocol on 9990 alongside the ATEM protocol on
   * 9910 (verified on one, 2026-08-21, protocol 2.7, presenting 23 inputs by 5
   * outputs). Adding such a device as a switcher is what you want — that gets
   * every bus, where its own router view gets the five outputs Blackmagic chose.
   */
  kinds: Array<'atem' | 'videohub'>;
  /** What the device calls itself, where it says so before being configured. */
  model: string;
}

/**
 * The ATEM protocol's opening packet. A switcher answers it whether or not it
 * answers ping — which matters, because a ping sweep can miss one entirely and
 * report an empty network with complete confidence.
 */
const ATEM_HELLO = Buffer.from([
  0x10, 0x14, 0x53, 0xab, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x01, 0x00, 0x00, 0x00,
  0x00, 0x00, 0x00, 0x00,
]);
const ATEM_PORT = 9910;
const VIDEOHUB_PORT = 9990;

/** Every IPv4 address this machine holds, so a scan does not find itself. */
export function localAddresses(): Set<string> {
  const addresses = new Set<string>();
  for (const entries of Object.values(os.networkInterfaces())) {
    for (const entry of entries ?? []) {
      if (entry.family === 'IPv4') addresses.add(entry.address);
    }
  }
  return addresses;
}

/** IPv4 /24s this machine is actually on. */
export function localSubnets(): string[] {
  const subnets = new Set<string>();
  for (const addresses of Object.values(os.networkInterfaces())) {
    for (const address of addresses ?? []) {
      if (address.family !== 'IPv4' || address.internal) continue;
      // Anything narrower than a /24 is unusual on a show network, and anything
      // wider is too many hosts to sweep politely.
      if (address.netmask !== '255.255.255.0') continue;
      subnets.add(address.address.split('.').slice(0, 3).join('.'));
    }
  }
  return [...subnets];
}

/** Every ATEM that answers a handshake on the given /24s. */
async function findAtems(subnets: string[], ms: number): Promise<FoundDevice[]> {
  const socket = dgram.createSocket('udp4');
  const found = new Map<string, FoundDevice>();

  socket.on('message', (_message, info) => {
    if (!found.has(info.address)) {
      // The handshake reply proves a switcher, not which one. The model comes
      // later, when the fleet connects to it properly.
      found.set(info.address, { address: info.address, kinds: ['atem'], model: 'ATEM' });
    }
  });
  socket.on('error', (error) => log.warn(`discovery: udp ${error.message}`));

  await new Promise<void>((resolve) => socket.bind(0, resolve));
  for (const subnet of subnets) {
    for (let host = 1; host <= 254; host++) {
      socket.send(ATEM_HELLO, ATEM_PORT, `${subnet}.${host}`, () => {});
    }
  }
  await new Promise((resolve) => setTimeout(resolve, ms));
  socket.close();
  return [...found.values()];
}

/** Anything answering the Videohub protocol, named by its own preamble. */
async function findVideohubs(subnets: string[], concurrency: number): Promise<FoundDevice[]> {
  const hosts: string[] = [];
  for (const subnet of subnets) for (let host = 1; host <= 254; host++) hosts.push(`${subnet}.${host}`);

  const found: FoundDevice[] = [];
  let next = 0;

  const worker = async (): Promise<void> => {
    while (next < hosts.length) {
      const host = hosts[next++];
      if (!host) return;
      const model = await probeVideohub(host);
      if (model) found.push({ address: host, kinds: ['videohub'], model });
    }
  };

  await Promise.all(Array.from({ length: concurrency }, () => worker()));
  return found;
}

/** A Videohub sends its state unprompted, so connecting is the whole probe. */
function probeVideohub(host: string): Promise<string | null> {
  return new Promise((resolve) => {
    const socket = net.connect({ host, port: VIDEOHUB_PORT });
    let buffer = '';
    const done = (result: string | null) => {
      socket.destroy();
      resolve(result);
    };
    socket.setTimeout(1500, () => done(null));
    socket.on('error', () => done(null));
    socket.setEncoding('utf8');
    socket.on('data', (chunk: string) => {
      buffer += chunk;
      if (!buffer.includes('PROTOCOL PREAMBLE')) {
        // Something is listening on 9990 but it is not a Videohub.
        if (buffer.length > 200) done(null);
        return;
      }
      const model = /^Model name:\s*(.+)$/m.exec(buffer)?.[1]?.trim();
      const friendly = /^Friendly name:\s*(.+)$/m.exec(buffer)?.[1]?.trim();
      if (buffer.includes('VIDEOHUB DEVICE')) {
        done(friendly && model ? `${model} (${friendly})` : (model ?? 'Videohub'));
      }
    });
  });
}

export interface ScanOptions {
  subnets?: string[];
  /** How long to listen for ATEM replies. */
  atemWaitMs?: number;
  concurrency?: number;
}

/**
 * Sweep the local networks for things this app can route.
 *
 * Both halves are needed and neither is redundant: an ATEM speaks UDP and a
 * Videohub speaks TCP, and neither answers the other's probe.
 */
export async function scan(options: ScanOptions = {}): Promise<{ subnets: string[]; devices: FoundDevice[] }> {
  // More than a few /24s is a machine with a lot of virtual interfaces, and
  // sweeping all of them is slow and rude.
  const subnets = (options.subnets ?? localSubnets()).slice(0, 4);
  if (subnets.length === 0) return { subnets, devices: [] };

  log.info(`discovery: sweeping ${subnets.map((subnet) => `${subnet}.0/24`).join(', ')}`);
  const [atems, videohubs] = await Promise.all([
    findAtems(subnets, options.atemWaitMs ?? 3000),
    findVideohubs(subnets, options.concurrency ?? 64),
  ]);

  // This machine's own addresses are dropped. Anything running a Videohub server
  // here — Companion's panel surface does, on every interface — would otherwise
  // appear once per local address as a device to add, which is noise at best and
  // a loop at worst.
  const mine = localAddresses();

  const merged = new Map<string, FoundDevice>();
  for (const device of [...atems, ...videohubs]) {
    if (mine.has(device.address)) continue;
    const existing = merged.get(device.address);
    if (!existing) {
      merged.set(device.address, { ...device });
      continue;
    }
    for (const kind of device.kinds) if (!existing.kinds.includes(kind)) existing.kinds.push(kind);
    // Prefer whichever answer actually names a model over a bare "ATEM".
    if (existing.model === 'ATEM' && device.model !== 'ATEM') existing.model = device.model;
  }

  const devices = [...merged.values()].sort((a, b) => a.address.localeCompare(b.address));
  log.info(`discovery: ${devices.length} device(s) found`);
  return { subnets, devices };
}
