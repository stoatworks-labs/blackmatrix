import http from 'node:http';
import { loadConfig, saveConfig, MOCK_CONFIG, type AppConfig } from './config.js';
import { Fleet } from './fleet.js';
import { startMockRouter } from './videohub/mockRouter.js';
import { createApp } from './api.js';
import { attachWebsocket } from './ws.js';
import { log } from './log.js';

const mock = process.argv.includes('--mock');
const config: AppConfig = mock ? structuredClone(MOCK_CONFIG) : loadConfig();

const fleet = new Fleet(config, mock);

// In --mock nothing is persisted; a simulated fleet must never overwrite a real
// operator's config file.
if (!mock) {
  let pending: NodeJS.Timeout | null = null;
  fleet.on('configChanged', () => {
    if (pending) return;
    pending = setTimeout(() => {
      pending = null;
      try {
        saveConfig(config);
      } catch (error) {
        log.error(`could not save config: ${String(error)}`);
      }
    }, 500);
  });
}

const app = createApp(fleet);
const server = http.createServer(app);
attachWebsocket(server, fleet);

// Without this, a port clash is an unhandled 'error' event and a stack trace.
server.on('error', (error: NodeJS.ErrnoException) => {
  if (error.code === 'EADDRINUSE') {
    log.error(`port ${config.port} is already in use — is another copy running?`);
  } else {
    log.error(`http server error: ${error.message}`);
  }
  process.exit(1);
});

async function main(): Promise<void> {
  // The simulated router has to be listening before the fleet's videohub device
  // tries to connect to it.
  if (mock) {
    const port = Number(config.devices.find((device) => device.type === 'videohub')?.address.split(':')[1] ?? 19990);
    await startMockRouter(port);
    log.info(`simulated videohub on 127.0.0.1:${port}`);
  }

  await fleet.start();
  server.listen(config.port, () => {
    log.info(`atem-crosspoint ${mock ? '(mock fleet) ' : ''}on http://localhost:${config.port}`);
    for (const device of fleet.snapshot().devices) {
      const where = device.videohubPort ? `videohub on :${device.videohubPort}` : 'videohub off';
      log.info(`  ${device.id} — ${device.name} (${device.connection}), ${where}`);
    }
  });
}

async function shutdown(signal: string): Promise<void> {
  log.info(`${signal} — shutting down`);
  await fleet.stop();
  server.close(() => process.exit(0));
  setTimeout(() => process.exit(0), 2000).unref();
}

process.on('SIGINT', () => void shutdown('SIGINT'));
process.on('SIGTERM', () => void shutdown('SIGTERM'));

main().catch((error) => {
  log.error(String(error));
  process.exit(1);
});
