import { VideohubServer, type LockAction, type RouterBackend, type RouterUpdate } from '@av/videohub';
import { log } from '../log.js';

/**
 * A synthetic Videohub, for `--mock`.
 *
 * The emulation server and the client are two halves of the same protocol, and
 * this is what lets them be tested against each other with no hardware: the
 * mock fleet stands one up, and a `videohub` device connects to it exactly as
 * it would to a real router. Every route, label and lock in the UI then makes a
 * real round trip over TCP.
 */
class SyntheticRouter implements RouterBackend {
  private inputs: string[];
  private outputs: string[];
  private routes: number[];
  private owners: Array<string | null>;
  private listeners = new Set<(update: RouterUpdate) => void>();

  constructor(size: number) {
    this.inputs = Array.from({ length: size }, (_, index) => `Router In ${index + 1}`);
    this.outputs = Array.from({ length: size }, (_, index) => `Router Out ${index + 1}`);
    this.routes = Array.from({ length: size }, (_, index) => index % size);
    this.owners = Array.from({ length: size }, () => null);
  }

  getInfo() {
    return {
      modelName: 'Simulated Videohub',
      friendlyName: 'Bench router',
      uniqueId: 'mock-videohub',
      inputCount: this.inputs.length,
      outputCount: this.outputs.length,
      monitoringOutputCount: 0,
      serialPortCount: 0,
      processingUnitCount: 0,
    };
  }

  getInputLabels(): string[] {
    return this.inputs;
  }
  getOutputLabels(): string[] {
    return this.outputs;
  }
  getRouting(): number[] {
    return this.routes;
  }
  getLocks(): Array<string | null> {
    return this.owners;
  }

  setRoute(output: number, input: number, client: string): boolean {
    const owner = this.owners[output];
    if (owner && owner !== client) return false;
    this.routes[output] = input;
    this.emit({ type: 'routing', outputs: [output] });
    return true;
  }

  setLock(output: number, action: LockAction, client: string): boolean {
    const owner = this.owners[output] ?? null;
    if (action === 'force') this.owners[output] = null;
    else if (action === 'lock') {
      if (owner && owner !== client) return false;
      this.owners[output] = client;
    } else {
      if (owner && owner !== client) return false;
      this.owners[output] = null;
    }
    this.emit({ type: 'locks', outputs: [output] });
    return true;
  }

  setInputLabel(input: number, label: string): boolean {
    this.inputs[input] = label;
    this.emit({ type: 'inputLabels', inputs: [input] });
    return true;
  }

  setOutputLabel(output: number, label: string): boolean {
    this.outputs[output] = label;
    this.emit({ type: 'outputLabels', outputs: [output] });
    return true;
  }

  subscribe(listener: (update: RouterUpdate) => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  private emit(update: RouterUpdate): void {
    for (const listener of this.listeners) listener(update);
  }
}

/** Start a simulated Videohub. Returns the server so it can be stopped again. */
export async function startMockRouter(port: number, size = 12): Promise<VideohubServer> {
  const server = new VideohubServer({
    backend: new SyntheticRouter(size),
    port,
    host: '127.0.0.1',
    log: (message) => log.info(`mock router: ${message}`),
  });
  await server.start();
  return server;
}
