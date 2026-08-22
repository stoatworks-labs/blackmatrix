/**
 * The router behind the line protocol.
 *
 * Deliberately not `RouterBackend` from `@av/videohub`: that interface is the
 * shape of one Videohub, and this protocol is fleet-wide — it can name a
 * device, fire a salvo across several, and trigger a failover, none of which a
 * Videohub has any idea about. Two small interfaces the server package
 * implements twice is cheaper than one interface that has to mean both.
 *
 * Every index here is **zero-based**, like the rest of this codebase. The
 * translation to and from the numbers on the wire happens in the parser, in one
 * place, because it is the single thing most likely to be got wrong.
 */

export interface AsciiDeviceView {
  id: string;
  name: string;
  inputCount: number;
  outputCount: number;
}

export interface AsciiSalvoView {
  id: string;
  name: string;
}

export interface AsciiFailoverView {
  id: string;
  name: string;
  state: string;
  armed: boolean;
}

export interface AsciiMatrixBackend {
  /** In configuration order. The first is what a connection starts pointed at. */
  listDevices(): AsciiDeviceView[];
  inputLabels(deviceId: string): string[];
  outputLabels(deviceId: string): string[];
  /** Input index per output, or -1 where this app cannot name the source. */
  routing(deviceId: string): number[];
  route(deviceId: string, output: number, input: number, client: string): boolean | Promise<boolean>;

  /** Salvos are fleet-wide, which is why this protocol is too. */
  listSalvos(): AsciiSalvoView[];
  takeSalvo(id: string, client: string): Promise<{ ok: boolean; failures: string[] }>;

  /** Optional: a build with no failover controller simply refuses those verbs. */
  listFailover?(): AsciiFailoverView[];
  fireFailover?(
    id: string,
    direction: 'lost' | 'restored',
    client: string,
  ): Promise<{ ok: boolean; failures: string[] }>;
}
