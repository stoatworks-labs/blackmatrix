import { useCallback, useEffect, useRef, useState } from 'react';
import type { DeviceInput, DiscoverResult, FailoverWatch, FleetSnapshot } from './types';

export interface FleetApi {
  snapshot: FleetSnapshot | null;
  connected: boolean;
  error: string | null;
  /**
   * This client's own address, as the server sees it — which is the name every
   * claim it makes is held under. Null until it answers, and on an older server
   * that has no `/api/whoami`; the UI then falls back to showing the address.
   */
  address: string | null;
  route: (deviceId: string, destination: string, source: number) => Promise<void>;
  lock: (deviceId: string, destination: string, action: 'lock' | 'unlock' | 'force') => Promise<void>;
  labelDestination: (deviceId: string, destination: string, label: string) => Promise<void>;
  saveSalvo: (salvo: { id?: string; name: string; crosspoints: FleetSnapshot['salvos'][number]['crosspoints'] }) => Promise<void>;
  deleteSalvo: (id: string) => Promise<void>;
  takeSalvo: (id: string) => Promise<void>;
  saveWatch: (watch: FailoverWatch) => Promise<void>;
  deleteWatch: (id: string) => Promise<void>;
  armWatch: (id: string, armed: boolean) => Promise<void>;
  /** Fire the lost salvo by hand — the "replace this machine now" button. */
  triggerWatch: (id: string) => Promise<void>;
  restoreWatch: (id: string) => Promise<void>;
  addDevice: (device: DeviceInput) => Promise<void>;
  updateDevice: (id: string, patch: Partial<DeviceInput>) => Promise<void>;
  removeDevice: (id: string) => Promise<string[]>;
  reconnectDevice: (id: string) => Promise<void>;
  setInputPort: (deviceId: string, input: number, externalPortType: number) => Promise<void>;
  /** Apply several crosspoints as one take. */
  take: (crosspoints: Array<{ deviceId: string; destination: string; source: number }>) => Promise<void>;
  setSourceLabel: (deviceId: string, source: number, label: string) => Promise<void>;
  discover: () => Promise<DiscoverResult>;
  notice: string | null;
  clearNotice: () => void;
  /** Simulator only: devices come from a model list, not from an address. */
  addFromCatalogue?: (entryId: string, name?: string) => Promise<void>;
}

async function request<T>(path: string, method: string, body?: unknown): Promise<T> {
  const response = await fetch(path, {
    method,
    headers: { 'content-type': 'application/json' },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const payload = (await response.json().catch(() => ({}))) as T & { reason?: string; failures?: string[] };
  if (!response.ok) {
    throw new Error(payload.reason ?? payload.failures?.join('; ') ?? `request failed (${response.status})`);
  }
  return payload;
}

async function post(path: string, body?: unknown): Promise<void> {
  const response = await fetch(path, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  if (!response.ok) {
    const payload = (await response.json().catch(() => ({}))) as { reason?: string; failures?: string[] };
    throw new Error(payload.reason ?? payload.failures?.join('; ') ?? `request failed (${response.status})`);
  }
}

/** One websocket, one snapshot. The server is the only authority on state. */
export function useFleet(): FleetApi {
  const [snapshot, setSnapshot] = useState<FleetSnapshot | null>(null);
  const [connected, setConnected] = useState(false);
  const [error, setError] = useState<string | null>(null);
  /** Something worth saying that is not a failure — a removal's loose ends. */
  const [notice, setNotice] = useState<string | null>(null);
  const socketRef = useRef<WebSocket | null>(null);
  const [address, setAddress] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    void fetch('/api/whoami')
      .then((response) => (response.ok ? (response.json() as Promise<{ address?: string }>) : null))
      .then((payload) => {
        if (!cancelled && typeof payload?.address === 'string') setAddress(payload.address);
      })
      .catch(() => {});
    return () => {
      cancelled = true;
    };
  }, []);

  useEffect(() => {
    let closed = false;
    let retry: ReturnType<typeof setTimeout>;

    const open = (): void => {
      const url = `${location.protocol === 'https:' ? 'wss' : 'ws'}://${location.host}/ws`;
      const socket = new WebSocket(url);
      socketRef.current = socket;

      socket.onopen = () => setConnected(true);
      socket.onmessage = (event) => {
        const message = JSON.parse(event.data as string) as FleetSnapshot & { type: string };
        if (message.type === 'snapshot') {
          setSnapshot({
            devices: message.devices,
            salvos: message.salvos,
            // An older server sends no failover at all; an empty list reads the
            // same way in the UI as "none configured", which is the truth.
            failover: message.failover ?? [],
          });
        }
      };
      socket.onclose = () => {
        setConnected(false);
        if (!closed) retry = setTimeout(open, 1500);
      };
      socket.onerror = () => socket.close();
    };

    open();
    return () => {
      closed = true;
      clearTimeout(retry);
      socketRef.current?.close();
    };
  }, []);

  const guard = useCallback(async (work: () => Promise<void>) => {
    try {
      await work();
      setError(null);
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : String(caught));
    }
  }, []);

  return {
    snapshot,
    connected,
    error,
    address,
    route: (deviceId, destination, source) =>
      guard(() => post(`/api/devices/${deviceId}/route`, { destination, source })),
    lock: (deviceId, destination, action) =>
      guard(() => post(`/api/devices/${deviceId}/lock`, { destination, action })),
    labelDestination: (deviceId, destination, label) =>
      guard(() => post(`/api/devices/${deviceId}/label`, { destination, label })),
    saveSalvo: (salvo) => guard(() => post('/api/salvos', salvo)),
    deleteSalvo: (id) =>
      guard(async () => {
        const response = await fetch(`/api/salvos/${id}`, { method: 'DELETE' });
        if (!response.ok) throw new Error('could not delete salvo');
      }),
    takeSalvo: (id) => guard(() => post(`/api/salvos/${id}/take`)),
    saveWatch: (watch) => guard(() => post('/api/failover', watch)),
    deleteWatch: (id) =>
      guard(async () => {
        const response = await fetch(`/api/failover/${id}`, { method: 'DELETE' });
        if (!response.ok) throw new Error('could not delete that watch');
      }),
    armWatch: (id, armed) => guard(() => post(`/api/failover/${id}/arm`, { armed })),
    triggerWatch: (id) => guard(() => post(`/api/failover/${id}/trigger`)),
    restoreWatch: (id) => guard(() => post(`/api/failover/${id}/restore`)),
    addDevice: (device) => guard(() => post('/api/devices', device)),
    updateDevice: (id, patch) => guard(() => request(`/api/devices/${id}`, 'PATCH', patch)),
    removeDevice: async (id) => {
      let orphaned: string[] = [];
      await guard(async () => {
        const result = await request<{ orphaned?: string[] }>(`/api/devices/${id}`, 'DELETE');
        orphaned = result.orphaned ?? [];
      });
      if (orphaned.length > 0) {
        setNotice(`Removed. Still referring to it: ${orphaned.join(', ')} — they will work again if it comes back.`);
      }
      return orphaned;
    },
    reconnectDevice: (id) => guard(() => post(`/api/devices/${id}/reconnect`)),
    setInputPort: (deviceId, input, externalPortType) =>
      guard(() => post(`/api/devices/${deviceId}/input`, { input, externalPortType })),
    take: (crosspoints) => guard(() => post('/api/take', { crosspoints })),
    setSourceLabel: (deviceId, source, label) =>
      guard(() => post(`/api/devices/${deviceId}/label`, { source, label })),
    discover: async () => {
      try {
        const result = await request<DiscoverResult>('/api/discover', 'POST', {});
        setError(null);
        return result;
      } catch (caught) {
        setError(caught instanceof Error ? caught.message : String(caught));
        return { ok: false, subnets: [], devices: [] };
      }
    },
    notice,
    clearNotice: () => setNotice(null),
  };
}
