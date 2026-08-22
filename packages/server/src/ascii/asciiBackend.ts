import type { AsciiDeviceView, AsciiFailoverView, AsciiMatrixBackend, AsciiSalvoView } from '@av/ascii-matrix';
import type { FailoverController } from '../failover.js';
import type { Fleet } from '../fleet.js';
import { log } from '../log.js';

/**
 * The fleet, seen through the line protocol.
 *
 * The Videohub emulation is one server per device, because that is what a
 * Videohub is. This one is fleet-wide: a line can name any device, fire a salvo
 * across all of them, or trigger a failover watch, none of which belongs to a
 * single switcher. Both end up in the same `Fleet.route`, so a crosspoint moved
 * from here is the same operation as one moved from a panel or the browser.
 */
export class AsciiFleetBackend implements AsciiMatrixBackend {
  constructor(
    private fleet: Fleet,
    private failover: FailoverController | null,
  ) {}

  listDevices(): AsciiDeviceView[] {
    return this.fleet.snapshot().devices.map((device) => ({
      id: device.id,
      name: device.name,
      inputCount: device.matrix?.sources.length ?? 0,
      outputCount: device.matrix?.destinations.length ?? 0,
    }));
  }

  inputLabels(deviceId: string): string[] {
    const device = this.fleet.snapshot().devices.find((candidate) => candidate.id === deviceId);
    return device?.matrix?.sources.map((source) => source.label) ?? [];
  }

  outputLabels(deviceId: string): string[] {
    const device = this.fleet.snapshot().devices.find((candidate) => candidate.id === deviceId);
    return device?.matrix?.destinations.map((destination) => destination.label) ?? [];
  }

  routing(deviceId: string): number[] {
    const device = this.fleet.snapshot().devices.find((candidate) => candidate.id === deviceId);
    const matrix = device?.matrix;
    if (!matrix) return [];
    return matrix.destinations.map((destination) => {
      const sourceId = matrix.routes[destination.id] ?? -1;
      return matrix.sources.findIndex((source) => source.id === sourceId);
    });
  }

  async route(deviceId: string, output: number, input: number, client: string): Promise<boolean> {
    const device = this.fleet.snapshot().devices.find((candidate) => candidate.id === deviceId);
    const matrix = device?.matrix;
    if (!matrix) return false;
    const destination = matrix.destinations[output];
    const source = matrix.sources[input];
    if (!destination || !source) return false;

    const result = await this.fleet.route(deviceId, destination.id, source.id, client, {
      overrideLocks: this.fleet.isFailoverClient(client, 'ascii'),
    });
    if (!result.ok) log.warn(`${deviceId}: line protocol route refused — ${result.reason}`);
    return result.ok;
  }

  listSalvos(): AsciiSalvoView[] {
    return this.fleet.salvos.map((salvo) => ({ id: salvo.id, name: salvo.name }));
  }

  takeSalvo(id: string, client: string): Promise<{ ok: boolean; failures: string[] }> {
    return this.fleet.takeSalvo(id, client, {
      overrideLocks: this.fleet.isFailoverClient(client, 'ascii'),
    });
  }

  listFailover(): AsciiFailoverView[] {
    return (this.failover?.view() ?? []).map((watch) => ({
      id: watch.id,
      name: watch.name,
      state: watch.state,
      armed: watch.armed,
    }));
  }

  async fireFailover(
    id: string,
    direction: 'lost' | 'restored',
    client: string,
  ): Promise<{ ok: boolean; failures: string[] }> {
    if (!this.failover) return { ok: false, failures: ['no failover controller'] };
    return direction === 'lost'
      ? this.failover.trigger(id, client)
      : this.failover.restore(id, client);
  }
}
