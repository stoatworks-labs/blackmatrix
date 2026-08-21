import { useCallback, useEffect, useMemo, useState } from 'react';
import type { FleetApi } from '../useFleet';
import type { FleetSnapshot } from '../types';
import { SimulatedFleet } from './fleet';

/**
 * The simulator's stand-in for the live fleet hook. Same surface, so every view
 * — the grid, source routing, salvos — works unchanged and there is no second
 * version of any of them to keep in step.
 */
export function useSimulatorFleet(): FleetApi {
  const fleet = useMemo(() => new SimulatedFleet(), []);
  const [snapshot, setSnapshot] = useState<FleetSnapshot>(() => fleet.snapshot());
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);

  useEffect(() => fleet.subscribe(() => setSnapshot(fleet.snapshot())), [fleet]);

  const report = useCallback((result: { ok: boolean; reason?: string }) => {
    setError(result.ok ? null : (result.reason ?? 'refused'));
  }, []);

  return {
    snapshot,
    connected: true,
    error,
    notice,
    clearNotice: () => setNotice(null),
    route: async (deviceId, destination, source) => report(fleet.route(deviceId, destination, source)),
    lock: async (deviceId, destination, action) => fleet.lock(deviceId, destination, action),
    labelDestination: async () => {
      setNotice('Renaming a destination is stored by the server, which a demo does not have.');
    },
    saveSalvo: async (salvo) => fleet.saveSalvo({ id: '', ...salvo }),
    deleteSalvo: async (id) => fleet.deleteSalvo(id),
    takeSalvo: async (id) => {
      const result = fleet.takeSalvo(id);
      setError(result.ok ? null : result.failures.join('; '));
    },
    addDevice: async () => {
      setNotice('In the demo, devices are picked from the model list rather than found by address.');
    },
    updateDevice: async (id, patch) => {
      if (patch.name) fleet.renameDevice(id, patch.name);
    },
    removeDevice: async (id) => {
      fleet.removeDevice(id);
      return [];
    },
    reconnectDevice: async () => {
      setNotice('Nothing to reconnect to — these devices are simulated in this tab.');
    },
    setInputPort: async (deviceId, input, port) => report(fleet.setInputPort(deviceId, input, port)),
    setSourceLabel: async (deviceId, source, label) => fleet.setSourceLabel(deviceId, source, label),
    // A demo must not sweep somebody's network, and from a browser it could not
    // anyway: there is no raw socket to sweep with.
    discover: async () => ({ ok: true, subnets: [], devices: [] }),
    addFromCatalogue: async (entryId: string, name?: string) => report(fleet.addFromCatalogue(entryId, name)),
  } as FleetApi;
}
