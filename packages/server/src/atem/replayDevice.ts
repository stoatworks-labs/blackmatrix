import fs from 'node:fs';
import path from 'node:path';
import type { AtemState } from 'atem-connection';
import type { DeviceConfig } from '../config.js';
import { log } from '../log.js';
import { StateDevice } from './stateDevice.js';

/** What `npm run capture` writes. Version it: a capture outlives the code. */
export interface CaptureFile {
  format: 'atem-crosspoint-capture';
  version: 1;
  capturedAt: string;
  address: string;
  productIdentifier: string;
  protocolVersion: string | number;
  /** The switcher's full state, exactly as atem-connection assembled it. */
  state: AtemState;
  /**
   * The matrix derived from that state at capture time. Redundant — it can be
   * rebuilt from `state` — but it makes the file readable on its own, and a
   * diff against a rebuild is how you catch the model drifting away from what
   * the hardware actually said.
   */
  matrix?: unknown;
  probe?: unknown;
}

export function readCapture(file: string): CaptureFile {
  const parsed = JSON.parse(fs.readFileSync(file, 'utf8')) as CaptureFile;
  if (parsed.format !== 'atem-crosspoint-capture') {
    throw new Error(`${file} is not an ATEM Crosspoint capture`);
  }
  if (!parsed.state?.info) throw new Error(`${file} has no switcher state in it`);
  return parsed;
}

/**
 * A switcher that is a capture taken off real hardware. Routing works and the
 * state moves, but nothing leaves this process — so the exact shape of a real
 * ATEM stays available for development long after the switcher has gone.
 */
export class ReplayDevice extends StateDevice {
  readonly capturedAt: string;

  constructor(config: DeviceConfig, capture: CaptureFile) {
    super({
      id: config.id,
      name: config.name,
      address: `replay://${path.basename(config.capture ?? 'capture')}`,
      model: capture.productIdentifier,
      // Cloned: replay must never write back through to the file it came from.
      state: structuredClone(capture.state),
    });
    this.capturedAt = capture.capturedAt;
  }

  static fromFile(config: DeviceConfig, file: string): ReplayDevice {
    const capture = readCapture(file);
    log.info(
      `${config.id}: replaying ${capture.productIdentifier} captured ${capture.capturedAt} from ${capture.address}`,
    );
    return new ReplayDevice(config, capture);
  }
}
