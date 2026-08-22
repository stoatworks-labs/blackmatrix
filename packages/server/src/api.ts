import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import express, { type Request } from 'express';
import { normalizeAddress, type LockAction } from '@av/videohub';
import { withFailoverDefaults, type DeviceConfig, type FailoverWatch, type Salvo } from './config.js';
import type { Fleet } from './fleet.js';
import type { FailoverController } from './failover.js';
import { scan } from './discovery.js';

const here = path.dirname(fileURLToPath(import.meta.url));
/** The built UI, when there is one. In dev, Vite serves it instead. */
const WEB_DIST = path.resolve(here, '../../web/dist');

function clientOf(req: Request): string {
  return normalizeAddress(req.ip ?? req.socket.remoteAddress ?? undefined);
}

export function createApp(fleet: Fleet, port: number, failover?: FailoverController): express.Express {
  const app = express();
  app.use(express.json({ limit: '256kb' }));

  /**
   * Health, and enough identity to tell one server from another.
   *
   * The mobile app sweeps the network and finds a server once per address it
   * answers on — a machine with several interfaces is one server, listed many
   * times. `id` is what collapses those back into one, and `name` is what a
   * human recognises instead of an IP.
   */
  app.get('/api/health', (_req, res) => {
    const snapshot = fleet.snapshot();
    res.json({
      ok: true,
      id: `${os.hostname()}:${port}`,
      name: os.hostname().replace(/\.local$/, ''),
      devices: snapshot.devices.length,
      connected: snapshot.devices.filter((device) => device.connection === 'connected').length,
    });
  });

  app.get('/api/fleet', (_req, res) => {
    res.json(fleet.snapshot());
  });

  // --- managing the devices themselves ------------------------------------

  app.post('/api/devices', async (req, res) => {
    const device = req.body as DeviceConfig;
    const result = await fleet.addDevice({
      id: device?.id,
      name: device?.name,
      address: device?.address ?? '',
      type: device?.type,
      videohubPort: device?.videohubPort,
      capture: device?.capture,
      expectedModel: device?.expectedModel,
    });
    res.status(result.ok ? 200 : 400).json(result);
  });

  app.patch('/api/devices/:id', async (req, res) => {
    const result = await fleet.updateDevice(req.params.id, req.body as Partial<DeviceConfig>);
    res.status(result.ok ? 200 : 400).json(result);
  });

  app.delete('/api/devices/:id', async (req, res) => {
    const result = await fleet.removeDevice(req.params.id);
    res.status(result.ok ? 200 : 404).json(result);
  });

  app.post('/api/devices/:id/reconnect', async (req, res) => {
    const result = await fleet.reconnectDevice(req.params.id);
    res.status(result.ok ? 200 : 404).json(result);
  });

  /**
   * Sweep the local networks. Slow by nature — a few seconds per /24 — so it is
   * a POST that answers when it is done rather than something the UI polls.
   */
  app.post('/api/discover', async (req, res) => {
    const { subnets } = (req.body ?? {}) as { subnets?: string[] };
    try {
      const result = await scan({ subnets });
      const known = new Set(fleet.snapshot().devices.map((device) => device.address.split(':')[0]));
      res.json({
        ok: true,
        subnets: result.subnets,
        devices: result.devices.map((device) => ({ ...device, alreadyAdded: known.has(device.address) })),
      });
    } catch (error) {
      res.status(500).json({ ok: false, reason: String(error) });
    }
  });

  app.post('/api/devices/:id/route', async (req, res) => {
    const { destination, source } = req.body as { destination?: string; source?: number };
    if (typeof destination !== 'string' || typeof source !== 'number') {
      res.status(400).json({ ok: false, reason: 'expected { destination: string, source: number }' });
      return;
    }
    const result = await fleet.route(req.params.id, destination, source, clientOf(req));
    res.status(result.ok ? 200 : 409).json(result);
  });

  /** A take: several crosspoints, applied together. */
  app.post('/api/take', async (req, res) => {
    const { crosspoints } = req.body as {
      crosspoints?: Array<{ deviceId: string; destination: string; source: number }>;
    };
    if (!Array.isArray(crosspoints) || crosspoints.length === 0) {
      res.status(400).json({ ok: false, reason: 'expected { crosspoints: [{deviceId, destination, source}] }' });
      return;
    }
    const result = await fleet.routeBatch(crosspoints, clientOf(req));
    res.status(result.ok ? 200 : 409).json(result);
  });

  app.post('/api/devices/:id/lock', (req, res) => {
    const { destination, action } = req.body as { destination?: string; action?: LockAction };
    if (typeof destination !== 'string' || !['lock', 'unlock', 'force'].includes(action ?? '')) {
      res.status(400).json({ ok: false, reason: 'expected { destination: string, action: lock|unlock|force }' });
      return;
    }
    const result = fleet.lock(req.params.id, destination, action as LockAction, clientOf(req));
    res.status(result.ok ? 200 : 409).json(result);
  });

  app.post('/api/devices/:id/label', async (req, res) => {
    const { destination, source, label } = req.body as {
      destination?: string;
      source?: number;
      label?: string;
    };
    if (typeof label !== 'string') {
      res.status(400).json({ ok: false, reason: 'expected { label: string }' });
      return;
    }
    if (typeof destination === 'string') {
      res.json(fleet.setDestinationLabel(req.params.id, destination, label));
      return;
    }
    if (typeof source === 'number') {
      res.json(await fleet.setSourceLabel(req.params.id, source, label));
      return;
    }
    res.status(400).json({ ok: false, reason: 'expected a destination or a source' });
  });

  /** Assign an input to a physical plug or the network input. */
  app.post('/api/devices/:id/input', async (req, res) => {
    const { input, externalPortType } = req.body as { input?: number; externalPortType?: number };
    if (typeof input !== 'number' || typeof externalPortType !== 'number') {
      res.status(400).json({ ok: false, reason: 'expected { input: number, externalPortType: number }' });
      return;
    }
    const result = await fleet.setInputPort(req.params.id, input, externalPortType);
    res.status(result.ok ? 200 : 409).json(result);
  });

  app.get('/api/salvos', (_req, res) => {
    res.json(fleet.salvos);
  });

  app.post('/api/salvos', (req, res) => {
    const salvo = req.body as Salvo;
    if (!salvo?.name || !Array.isArray(salvo.crosspoints)) {
      res.status(400).json({ ok: false, reason: 'expected { name, crosspoints[] }' });
      return;
    }
    salvo.id ||= `salvo-${Date.now().toString(36)}`;
    fleet.saveSalvo(salvo);
    res.json({ ok: true, salvo });
  });

  app.delete('/api/salvos/:id', (req, res) => {
    fleet.deleteSalvo(req.params.id);
    res.json({ ok: true });
  });

  app.post('/api/salvos/:id/take', async (req, res) => {
    const result = await fleet.takeSalvo(req.params.id, clientOf(req));
    res.status(result.ok ? 200 : 409).json(result);
  });

  // --- failover -----------------------------------------------------------
  //
  // Every one of these has to be reachable by something that is not a browser:
  // a media server's control module, a show controller, a script in a rack. So
  // they are plain POSTs with no body required, which is the most a device with
  // a "send an HTTP request" action can usually manage.

  const noFailover = { ok: false, reason: 'failover is not available on this server' };

  app.get('/api/failover', (_req, res) => {
    res.json(failover?.view() ?? []);
  });

  app.post('/api/failover', (req, res) => {
    if (!failover) {
      res.status(503).json(noFailover);
      return;
    }
    const watch = withFailoverDefaults(req.body as Partial<FailoverWatch>);
    if (!watch.name.trim()) {
      res.status(400).json({ ok: false, reason: 'a watch needs a name' });
      return;
    }
    if (!watch.onLostSalvo || !fleet.salvos.some((salvo) => salvo.id === watch.onLostSalvo)) {
      // Refused rather than saved half-formed: a watch whose salvo does not
      // exist is one that will fire into nothing at the worst possible moment.
      res.status(400).json({ ok: false, reason: 'onLostSalvo must name a salvo that exists' });
      return;
    }
    if (watch.onRestoredSalvo && !fleet.salvos.some((salvo) => salvo.id === watch.onRestoredSalvo)) {
      res.status(400).json({ ok: false, reason: 'onRestoredSalvo must name a salvo that exists' });
      return;
    }
    failover.save(watch);
    res.json({ ok: true, watch });
  });

  app.delete('/api/failover/:id', (req, res) => {
    if (!failover) {
      res.status(503).json(noFailover);
      return;
    }
    failover.remove(req.params.id);
    res.json({ ok: true });
  });

  app.post('/api/failover/:id/arm', (req, res) => {
    if (!failover) {
      res.status(503).json(noFailover);
      return;
    }
    const { armed } = (req.body ?? {}) as { armed?: boolean };
    const ok = failover.arm(req.params.id, armed !== false);
    res.status(ok ? 200 : 404).json({ ok });
  });

  /**
   * The heartbeat a `heartbeat` probe waits for. Deliberately trivial: whatever
   * is proving it is alive should be able to do it with one line of anything.
   */
  app.post('/api/failover/:id/heartbeat', (req, res) => {
    if (!failover) {
      res.status(503).json(noFailover);
      return;
    }
    const ok = failover.heartbeat(req.params.id);
    res.status(ok ? 200 : 404).json({ ok });
  });

  app.post('/api/failover/:id/trigger', async (req, res) => {
    if (!failover) {
      res.status(503).json(noFailover);
      return;
    }
    const result = await failover.trigger(req.params.id, clientOf(req));
    res.status(result.ok ? 200 : 409).json(result);
  });

  app.post('/api/failover/:id/restore', async (req, res) => {
    if (!failover) {
      res.status(503).json(noFailover);
      return;
    }
    const result = await failover.restore(req.params.id, clientOf(req));
    res.status(result.ok ? 200 : 409).json(result);
  });

  app.use(express.static(WEB_DIST));
  app.get('*', (_req, res) => {
    res.sendFile(path.join(WEB_DIST, 'index.html'), (error) => {
      if (error) res.status(404).send('UI not built — run `npm run build` or use `npm run dev:web`.');
    });
  });

  return app;
}
