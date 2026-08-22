import http from 'node:http';
import { AsciiMatrixServer } from '@av/ascii-matrix';
import { applyEnvironmentOverrides, loadConfig, saveConfig, MOCK_CONFIG, type AppConfig } from './config.js';
import { Fleet } from './fleet.js';
import { FailoverController } from './failover.js';
import { AsciiFleetBackend } from './ascii/asciiBackend.js';
import { startMockRouter } from './videohub/mockRouter.js';
import { createApp } from './api.js';
import { attachWebsocket } from './ws.js';
import { log } from './log.js';

const mock = process.argv.includes('--mock');
// The mock takes the environment's ports too. It is the copy most likely to be
// started beside another one, and until it did, a second mock silently lost its
// UI port to the first.
const config: AppConfig = mock ? applyEnvironmentOverrides(structuredClone(MOCK_CONFIG)) : loadConfig();

const fleet = new Fleet(config, mock);
const failover = new FailoverController(fleet, config);
// The failover state rides along on the snapshot every client already watches,
// rather than being a second thing to poll.
fleet.setFailoverView(() => failover.view());
failover.on('change', () => fleet.emit('change'));
failover.on('configChanged', () => fleet.emit('configChanged'));

const ascii = config.ascii?.enabled
  ? new AsciiMatrixServer({
      backend: new AsciiFleetBackend(fleet, failover),
      port: config.ascii.port,
      host: config.ascii.host,
      udp: true,
      log: (message) => log.info(message),
    })
  : null;

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

const app = createApp(fleet, config.port, failover);
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
    // Overridable for the same reason as the other ports: two mocks at once.
    // The device's address is rewritten to match, since it is what the client
    // half of the protocol connects to.
    const override = Number(process.env.BLACKMATRIX_MOCK_ROUTER_PORT);
    const device = config.devices.find((candidate) => candidate.type === 'videohub');
    const port = Number.isInteger(override) && override > 0 ? override : Number(device?.address.split(':')[1] ?? 19990);
    if (device) device.address = `127.0.0.1:${port}`;
    await startMockRouter(port);
    log.info(`simulated videohub on 127.0.0.1:${port}`);
  }

  await fleet.start();

  if (ascii) {
    try {
      await ascii.start();
    } catch (error) {
      // Same treatment as a clashing Videohub port: the app is still useful
      // without this protocol, and a stack trace at startup is not.
      log.error(`line protocol port ${config.ascii?.port} unavailable — ${String(error)}`);
    }
  }

  // Started after the fleet, so a watch cannot probe and decide before the
  // devices it would route are connected.
  failover.start();

  server.listen(config.port, config.host, () => {
    log.info(
      `blackmatrix ${mock ? '(mock fleet) ' : ''}on http://${config.host ?? 'localhost'}:${config.port}`,
    );
    for (const device of fleet.snapshot().devices) {
      const where = device.videohubPort ? `videohub on :${device.videohubPort}` : 'videohub off';
      log.info(`  ${device.id} — ${device.name} (${device.connection}), ${where}`);
    }
    if (ascii) log.info(`  line protocol on :${ascii.port} (tcp and udp)`);
    for (const watch of failover.view()) {
      log.info(`  failover "${watch.name}" — ${watch.armed ? 'armed' : 'disarmed'}, ${watch.probe.kind} probe`);
    }
  });
}

async function shutdown(signal: string): Promise<void> {
  log.info(`${signal} — shutting down`);
  failover.stop();
  await ascii?.stop();
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
