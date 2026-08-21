/**
 * Take a capture off a real ATEM.
 *
 *   npm run capture -- <address> [--name "Stage"] [--out captures] [--probe] [--probe-aux] [--yes]
 *
 * Why this exists: every rule in @av/atem-matrix about which source is legal on
 * which bus is read from the switcher's own `sourceAvailability` and
 * `meAvailability` masks — and those masks live only in the protocol. They are
 * not in an ATEM Software Control autosave, or in any other file a switcher
 * leaves behind. Ten seconds with the hardware puts them on disk permanently;
 * without that, they cannot be recovered once the unit is gone.
 *
 * The capture is read-only. `--probe` is not: see below.
 */
import fs from 'node:fs';
import path from 'node:path';
import { Atem, type AtemState } from 'atem-connection';
import { buildMatrix, isLegal, type Destination, type Source } from '@av/atem-matrix';

interface Options {
  address: string;
  name: string;
  out: string;
  probe: boolean;
  probeAux: boolean;
  confirmed: boolean;
}

function parseArgs(argv: string[]): Options | null {
  const positional = argv.filter((arg) => !arg.startsWith('--'));
  const address = positional[0];
  if (!address) return null;
  const value = (flag: string): string | undefined => {
    const at = argv.indexOf(flag);
    return at >= 0 ? argv[at + 1] : undefined;
  };
  return {
    address,
    name: value('--name') ?? address,
    out: value('--out') ?? 'captures',
    probe: argv.includes('--probe') || argv.includes('--probe-aux'),
    probeAux: argv.includes('--probe-aux'),
    confirmed: argv.includes('--yes'),
  };
}

function slug(text: string): string {
  return text.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '');
}

/** Connect and wait for the state to settle, not merely for the socket. */
async function connect(address: string): Promise<Atem> {
  const atem = new Atem();
  atem.on('error', (message) => console.error(`  atem: ${String(message)}`));

  await new Promise<void>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`no answer from ${address} after 15s`)), 15000);
    atem.once('connected', () => {
      clearTimeout(timer);
      resolve();
    });
    atem.connect(address).catch(reject);
  });

  // The initial dump arrives as many commands; 'connected' fires part-way
  // through on some models. A second of quiet is cheap insurance against
  // capturing a half-built state.
  await new Promise((resolve) => setTimeout(resolve, 1500));
  return atem;
}

interface ProbeResult {
  destination: string;
  source: number;
  sourceLabel: string;
  maskSays: 'legal' | 'illegal';
  switcherAccepted: boolean;
  agrees: boolean;
}

/**
 * Test the masks against the hardware.
 *
 * THIS WRITES TO THE SWITCHER. Each test routes a destination, reads back what
 * happened, and puts the original source back. Program, preview, keyers and
 * SuperSource are never touched — only multiview windows, and aux buses if you
 * ask for them, because an aux may well be feeding a screen someone is looking
 * at.
 *
 * What it settles, and nothing else can: whether `sourceAvailability` and
 * `meAvailability` mean what this project reads them to mean, and whether the
 * first two multiview windows really are fixed to program and preview.
 */
async function probe(atem: Atem, state: AtemState, includeAux: boolean): Promise<ProbeResult[]> {
  const matrix = buildMatrix(state);
  const results: ProbeResult[] = [];

  const targets = matrix.destinations.filter(
    (destination) =>
      destination.kind === 'mvWindow' || (includeAux && destination.kind === 'aux'),
  );

  for (const destination of targets) {
    const original = matrix.routes[destination.id] ?? -1;
    if (original < 0) continue;

    const legal = matrix.sources.filter((source) => isLegal(source, destination));
    const illegal = matrix.sources.filter((source) => !isLegal(source, destination));
    // A couple of each is enough to catch a mask that is wrong in one direction,
    // and keeps the number of writes to a switcher small.
    const sample = [
      ...pick(legal, 2, original),
      ...pick(illegal, 3, original),
    ];

    for (const source of sample) {
      const accepted = await tryRoute(atem, destination, source, original);
      results.push({
        destination: destination.id,
        source: source.id,
        sourceLabel: source.label,
        maskSays: isLegal(source, destination) ? 'legal' : 'illegal',
        switcherAccepted: accepted,
        agrees: accepted === isLegal(source, destination),
      });
    }

    await route(atem, destination, original);
  }

  return results;
}

function pick(sources: Source[], count: number, exclude: number): Source[] {
  return sources.filter((source) => source.id !== exclude).slice(0, count);
}

async function route(atem: Atem, destination: Destination, source: number): Promise<void> {
  const { unit, slot } = destination.address;
  if (destination.kind === 'aux') await atem.setAuxSource(source, unit);
  else await atem.setMultiViewerWindowSource(source, unit, slot ?? 0);
}

async function tryRoute(
  atem: Atem,
  destination: Destination,
  source: Source,
  original: number,
): Promise<boolean> {
  await route(atem, destination, source.id);
  await new Promise((resolve) => setTimeout(resolve, 300));
  const now = atem.state ? (buildMatrix(atem.state).routes[destination.id] ?? -1) : -1;
  const accepted = now === source.id;
  if (accepted) {
    await route(atem, destination, original);
    await new Promise((resolve) => setTimeout(resolve, 200));
  }
  return accepted;
}

async function main(): Promise<void> {
  const options = parseArgs(process.argv.slice(2));
  if (!options) {
    console.error(
      'usage: npm run capture -- <address> [--name "Stage"] [--out captures] [--probe] [--probe-aux] [--yes]',
    );
    process.exit(1);
  }

  if (options.probe && !options.confirmed) {
    console.error(
      [
        'A probe WRITES TO THE SWITCHER: it routes multiview windows' +
          (options.probeAux ? ' and aux buses' : '') +
          ', reads back what happened, and restores the original source.',
        '',
        'Program, preview, keyers and SuperSource are never touched.',
        options.probeAux
          ? 'An aux may be feeding a screen someone is looking at. Do this off-air.'
          : '',
        '',
        'Re-run with --yes when the switcher is safe to route.',
      ]
        .filter(Boolean)
        .join('\n'),
    );
    process.exit(1);
  }

  console.log(`connecting to ${options.address} ...`);
  const atem = await connect(options.address);
  const state = atem.state;
  if (!state) throw new Error('connected, but the switcher sent no state');

  const matrix = buildMatrix(state);
  console.log(
    `  ${state.info.productIdentifier ?? 'unknown model'} — ${matrix.sources.length} sources, ${matrix.destinations.length} destinations`,
  );

  let probeResults: ProbeResult[] | undefined;
  if (options.probe) {
    console.log(`probing${options.probeAux ? ' multiview windows and aux buses' : ' multiview windows'} ...`);
    probeResults = await probe(atem, state, options.probeAux);
    const disagreements = probeResults.filter((result) => !result.agrees);
    console.log(`  ${probeResults.length} tests, ${disagreements.length} disagreed with the masks`);
    for (const result of disagreements) {
      console.log(
        `  ! ${result.destination}: ${result.sourceLabel} — mask says ${result.maskSays}, switcher ${result.switcherAccepted ? 'accepted' : 'refused'} it`,
      );
    }
  }

  const capture = {
    format: 'atem-crosspoint-capture' as const,
    version: 1 as const,
    capturedAt: new Date().toISOString(),
    address: options.address,
    productIdentifier: state.info.productIdentifier ?? 'unknown',
    protocolVersion: state.info.apiVersion,
    state,
    matrix,
    probe: probeResults,
  };

  fs.mkdirSync(options.out, { recursive: true });
  const file = path.join(
    options.out,
    `${slug(options.name)}-${capture.capturedAt.replace(/[:.]/g, '-')}.json`,
  );
  fs.writeFileSync(file, `${JSON.stringify(capture, null, 2)}\n`, 'utf8');
  console.log(`\nwritten: ${file}`);
  console.log('replay it by putting  "capture": "<that path>"  on a device in your config.');

  await atem.disconnect();
  process.exit(0);
}

main().catch((error) => {
  console.error(String(error));
  process.exit(1);
});
