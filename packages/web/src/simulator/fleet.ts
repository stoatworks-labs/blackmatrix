import {
  applyRouteToState,
  buildMatrix,
  buildRouterMatrix,
  buildSimulatedState,
  isLegal,
  type MatrixModel,
} from '@av/atem-matrix';
import type { AtemState } from 'atem-connection';
import type { DeviceView, FleetSnapshot, Salvo } from '../types';
import { CATALOGUE, type CatalogueEntry } from './catalogue';

/**
 * A fleet that exists only in this tab.
 *
 * Nothing here opens a socket, and nothing can: a browser cannot speak the ATEM
 * protocol (UDP) or the Videohub protocol (raw TCP), and cannot listen for a
 * panel at all. That is not a limitation being worked around — it is the reason
 * this is a simulator rather than the app.
 */
interface SimDevice {
  id: string;
  name: string;
  entry: CatalogueEntry;
  /** Switchers hold a whole AtemState, exactly as the real code path expects. */
  state?: AtemState;
  /** Routers hold labels and a routing table, which is all a router is. */
  router?: { inputLabels: string[]; outputLabels: string[]; routing: number[] };
  locks: Record<string, string | null>;
}

const STORE_KEY = 'blackmatrix.simulator.v1';

export class SimulatedFleet {
  private devices: SimDevice[] = [];
  private salvoList: Salvo[] = [];
  private listeners = new Set<() => void>();
  private counter = 0;

  constructor() {
    this.restore();
  }

  subscribe(listener: () => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  private changed(): void {
    this.persist();
    for (const listener of this.listeners) listener();
  }

  /** The device list survives a reload; routing deliberately does not. */
  private persist(): void {
    try {
      window.localStorage.setItem(
        STORE_KEY,
        JSON.stringify({
          devices: this.devices.map((device) => ({ id: device.id, name: device.name, entry: device.entry.id })),
          salvos: this.salvoList,
        }),
      );
    } catch {
      /* private browsing — the demo still works, it just will not persist */
    }
  }

  private restore(): void {
    try {
      const raw = window.localStorage.getItem(STORE_KEY);
      if (!raw) return;
      const stored = JSON.parse(raw) as {
        devices?: Array<{ id: string; name: string; entry: string }>;
        salvos?: Salvo[];
      };
      for (const device of stored.devices ?? []) {
        const entry = CATALOGUE.find((candidate) => candidate.id === device.entry);
        if (entry) this.create(entry, device.name, device.id);
      }
      this.salvoList = stored.salvos ?? [];
    } catch {
      /* a corrupt store is not worth failing over — start empty */
    }
  }

  private create(entry: CatalogueEntry, name: string, id?: string): SimDevice {
    const deviceId = id ?? `${entry.id}-${++this.counter}`;
    const device: SimDevice = { id: deviceId, name, entry, locks: {} };

    if (entry.kind === 'atem' && entry.profile) {
      device.state = buildSimulatedState(entry.profile, this.devices.length);
    } else if (entry.router) {
      const { inputs, outputs } = entry.router;
      device.router = {
        inputLabels: Array.from({ length: inputs }, (_, index) => `Input ${index + 1}`),
        outputLabels: Array.from({ length: outputs }, (_, index) => `Output ${index + 1}`),
        routing: Array.from({ length: outputs }, (_, index) => index % inputs),
      };
    }

    this.devices.push(device);
    return device;
  }

  addFromCatalogue(entryId: string, name?: string): { ok: boolean; reason?: string } {
    const entry = CATALOGUE.find((candidate) => candidate.id === entryId);
    if (!entry) return { ok: false, reason: `no such model: ${entryId}` };
    this.create(entry, name?.trim() || entry.name);
    this.changed();
    return { ok: true };
  }

  removeDevice(id: string): void {
    this.devices = this.devices.filter((device) => device.id !== id);
    this.changed();
  }

  renameDevice(id: string, name: string): void {
    const device = this.find(id);
    if (device) device.name = name;
    this.changed();
  }

  private find(id: string): SimDevice | undefined {
    return this.devices.find((device) => device.id === id);
  }

  private matrixOf(device: SimDevice): MatrixModel | null {
    if (device.state) return buildMatrix(device.state);
    if (device.router) {
      return buildRouterMatrix({
        inputLabels: device.router.inputLabels,
        outputLabels: device.router.outputLabels,
        routing: device.router.routing,
      });
    }
    return null;
  }

  route(deviceId: string, destinationId: string, source: number): { ok: boolean; reason?: string } {
    const device = this.find(deviceId);
    if (!device) return { ok: false, reason: `no such device: ${deviceId}` };

    const matrix = this.matrixOf(device);
    const destination = matrix?.destinations.find((candidate) => candidate.id === destinationId);
    if (!matrix || !destination) return { ok: false, reason: `no such destination: ${destinationId}` };

    const owner = device.locks[destinationId];
    if (owner) return { ok: false, reason: `${destination.label} is locked` };

    const sourceEntry = matrix.sources.find((candidate) => candidate.id === source);
    if (!sourceEntry) return { ok: false, reason: `no such source: ${source}` };
    // The same rule the real thing applies, from the same code.
    if (!isLegal(sourceEntry, destination)) {
      return { ok: false, reason: `${sourceEntry.label} is not available on ${destination.label}` };
    }

    if (device.state) applyRouteToState(device.state, destination, source);
    else if (device.router) device.router.routing[destination.address.unit] = source;

    this.changed();
    return { ok: true };
  }

  lock(deviceId: string, destinationId: string, action: 'lock' | 'unlock' | 'force'): void {
    const device = this.find(deviceId);
    if (!device) return;
    device.locks[destinationId] = action === 'lock' ? 'this tab' : null;
    this.changed();
  }

  setSourceLabel(deviceId: string, sourceId: number, label: string): void {
    const device = this.find(deviceId);
    if (!device) return;
    if (device.state) {
      const input = device.state.inputs[sourceId];
      if (input) {
        input.longName = label;
        input.shortName = label.slice(0, 4);
      }
    } else if (device.router) {
      device.router.inputLabels[sourceId] = label;
    }
    this.changed();
  }

  setInputPort(deviceId: string, inputId: number, port: number): { ok: boolean; reason?: string } {
    const device = this.find(deviceId);
    const input = device?.state?.inputs[inputId];
    if (!input) return { ok: false, reason: 'no such input' };
    if (!(input.externalPorts ?? []).includes(port)) {
      return { ok: false, reason: `${input.longName} does not accept that connector` };
    }
    input.externalPortType = port;
    this.changed();
    return { ok: true };
  }

  get salvos(): Salvo[] {
    return this.salvoList;
  }

  saveSalvo(salvo: Salvo): void {
    salvo.id ||= `salvo-${Date.now().toString(36)}`;
    const at = this.salvoList.findIndex((candidate) => candidate.id === salvo.id);
    if (at >= 0) this.salvoList[at] = salvo;
    else this.salvoList.push(salvo);
    this.changed();
  }

  deleteSalvo(id: string): void {
    this.salvoList = this.salvoList.filter((salvo) => salvo.id !== id);
    this.changed();
  }

  takeSalvo(id: string): { ok: boolean; failures: string[] } {
    const salvo = this.salvoList.find((candidate) => candidate.id === id);
    if (!salvo) return { ok: false, failures: [`no such salvo: ${id}`] };
    const failures: string[] = [];
    for (const crosspoint of salvo.crosspoints) {
      const result = this.route(crosspoint.deviceId, crosspoint.destination, crosspoint.source);
      if (!result.ok) failures.push(`${crosspoint.deviceId}/${crosspoint.destination}: ${result.reason}`);
    }
    return { ok: failures.length === 0, failures };
  }

  snapshot(): FleetSnapshot {
    return {
      devices: this.devices.map<DeviceView>((device) => ({
        id: device.id,
        name: device.name,
        address: `simulated://${device.entry.id}`,
        model: `${device.entry.name} (simulated)`,
        connection: 'connected',
        videohubPort: null,
        videohubClients: 0,
        matrix: this.matrixOf(device),
        locks: device.locks,
      })),
      salvos: this.salvoList,
    };
  }
}
