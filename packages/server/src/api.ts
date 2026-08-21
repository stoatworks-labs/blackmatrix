import path from 'node:path';
import { fileURLToPath } from 'node:url';
import express, { type Request } from 'express';
import { normalizeAddress, type LockAction } from '@av/videohub';
import type { Salvo } from './config.js';
import type { Fleet } from './fleet.js';

const here = path.dirname(fileURLToPath(import.meta.url));
/** The built UI, when there is one. In dev, Vite serves it instead. */
const WEB_DIST = path.resolve(here, '../../web/dist');

function clientOf(req: Request): string {
  return normalizeAddress(req.ip ?? req.socket.remoteAddress ?? undefined);
}

export function createApp(fleet: Fleet): express.Express {
  const app = express();
  app.use(express.json({ limit: '256kb' }));

  app.get('/api/health', (_req, res) => {
    res.json({ ok: true, devices: fleet.snapshot().devices.length });
  });

  app.get('/api/fleet', (_req, res) => {
    res.json(fleet.snapshot());
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

  app.use(express.static(WEB_DIST));
  app.get('*', (_req, res) => {
    res.sendFile(path.join(WEB_DIST, 'index.html'), (error) => {
      if (error) res.status(404).send('UI not built — run `npm run build` or use `npm run dev:web`.');
    });
  });

  return app;
}
