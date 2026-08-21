/**
 * Types for the Blackmagic Videohub Ethernet Protocol server.
 *
 * Protocol reference: "Videohub Developer Information", Blackmagic Design,
 * May 2018 — Blackmagic Videohub Ethernet Protocol v2.3. TCP port 9990,
 * text based, blocks with an ALL-CAPS header ending in a colon, terminated
 * by a blank line.
 */

/** Values reported in the `VIDEOHUB DEVICE:` block. */
export interface VideohubDeviceInfo {
  /** `Model name:` — what a control panel shows as the router model. */
  modelName: string;
  /** `Friendly name:` — not in v2.3, added later. Clients ignore lines they do not know. */
  friendlyName?: string;
  /** `Unique ID:` — as above. Panels use it to tell two routers apart. */
  uniqueId?: string;
  inputCount: number;
  outputCount: number;
  /** Videohubs without monitoring outputs omit the related blocks entirely. */
  monitoringOutputCount?: number;
  serialPortCount?: number;
  processingUnitCount?: number;
}

/**
 * A destination's lock owner, or null when unlocked. The protocol renders this
 * per-client: "O" when the asking client owns it, "L" when someone else does,
 * "U" when nobody does.
 */
export type LockOwner = string | null;

export type LockAction = 'lock' | 'unlock' | 'force';

/** What changed, so only the affected lines get pushed to clients. */
export type RouterUpdate =
  | { type: 'routing'; outputs: number[] }
  | { type: 'locks'; outputs: number[] }
  | { type: 'inputLabels'; inputs: number[] }
  | { type: 'outputLabels'; outputs: number[] }
  /** Port counts or model changed — everything but the preamble is resent. */
  | { type: 'device' };

/**
 * The router behind the protocol. Implementations are free to be anything —
 * this package ships no ATEM knowledge.
 */
export interface RouterBackend {
  getInfo(): VideohubDeviceInfo;
  getInputLabels(): string[];
  getOutputLabels(): string[];
  /** Source index per output, or -1 for "not routed". */
  getRouting(): number[];
  getLocks(): LockOwner[];

  /**
   * Route `output` to `input`. Returning false means "understood but refused"
   * (illegal crosspoint, locked destination) — the protocol answers that with
   * an ACK followed by the unchanged routing, which is what the spec means by
   * "if the request could not be performed".
   */
  setRoute(output: number, input: number, client: string): boolean | Promise<boolean>;

  setLock(output: number, action: LockAction, client: string): boolean | Promise<boolean>;

  setInputLabel?(input: number, label: string): boolean | Promise<boolean>;
  setOutputLabel?(output: number, label: string): boolean | Promise<boolean>;

  /** Register for changes made by anyone. Returns an unsubscribe function. */
  subscribe(listener: (update: RouterUpdate) => void): () => void;
}
