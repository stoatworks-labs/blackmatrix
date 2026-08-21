import type { Server } from 'node:http';
import { WebSocketServer, type WebSocket } from 'ws';
import type { Fleet } from './fleet.js';
import { log } from './log.js';

/**
 * Pushes the whole fleet snapshot to browsers. Changes are coalesced so a burst
 * of switcher state updates becomes one message.
 */
export function attachWebsocket(server: Server, fleet: Fleet): WebSocketServer {
  const wss = new WebSocketServer({ server, path: '/ws' });
  let pending: NodeJS.Timeout | null = null;

  const send = (socket: WebSocket): void => {
    if (socket.readyState !== socket.OPEN) return;
    socket.send(JSON.stringify({ type: 'snapshot', ...fleet.snapshot() }));
  };

  wss.on('connection', (socket) => {
    log.info(`ui client connected (${wss.clients.size} open)`);
    send(socket);
    socket.on('error', () => socket.close());
  });

  fleet.on('change', () => {
    if (pending) return;
    pending = setTimeout(() => {
      pending = null;
      for (const socket of wss.clients) send(socket);
    }, 50);
  });

  return wss;
}
