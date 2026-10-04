#!/usr/bin/env node
/**
 * Boot smoke-test: start the built server the way the packaged app does, and
 * prove it actually serves.
 *
 * `npm run typecheck`, `npm test` and `npm run build` cannot see this class of
 * failure. `app.get('*')` is a perfectly good TypeScript string; under Express
 * 5 / path-to-regexp 8 it throws while the route is being registered, so the
 * server died before it ever listened — and v0.3.1 through v0.3.3 all shipped
 * an app that could not start. Every assertion below exists because that
 * shipped. (atem-overseer shipped the same bug, and this is its test, ported.)
 *
 *   node scripts/smoke-boot.mjs        # after npm run build
 */
import { spawn } from 'node:child_process';
import { existsSync, mkdtempSync } from 'node:fs';
import { createServer } from 'node:net';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const HOST = '127.0.0.1';

const BOOT_TIMEOUT_MS = 30_000;
const SHUTDOWN_TIMEOUT_MS = 15_000;
const POLL_MS = 250;

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
/**
 * Spawn node on this file directly rather than going through `npm start`:
 * it is what the desktop bundle does (launcher/src-tauri/launcher.toml) and
 * what the container does (Dockerfile CMD), and npm brings an environment of
 * its own — see startServer.
 */
const entry = join(root, 'packages', 'server', 'dist', 'index.js');

/** What must answer, and what a failure of each one would mean. */
const CHECKS = [
  { path: '/', kind: 'html', what: 'the routing grid' },
  { path: '/any/deep/path', kind: 'html', what: 'a deep path, served by the SPA fallback' },
  { path: '/api/health', kind: 'json', what: 'the API' },
];

async function main() {
  if (!existsSync(entry)) {
    throw new Error(`${entry} does not exist. Run \`npm run build\` first.`);
  }

  // A port the OS hands out, passed in the way the launcher passes its own
  // (launcher.toml's [inject.env]). A copy of BlackMatrix already running on
  // this machine cannot then fail the boot for a reason that is not the build.
  const port = await freePort();

  // A scratch directory to run in, fresh and empty, with no config file in it:
  // the fresh-install case, an empty fleet that dials no hardware, and nothing
  // the server saves lands in the working copy.
  const runDir = mkdtempSync(join(tmpdir(), 'blackmatrix-smoke-'));
  say(`run dir ${runDir}`);

  const server = startServer(runDir, port);
  try {
    await waitForBoot(server, port);
    say(`listening on ${HOST}:${port}`);
    await checkRoutes(server, port);
    await shutdownCleanly(server);
    say('shut down cleanly on SIGTERM');
  } catch (err) {
    if (!server.exited) server.child.kill('SIGKILL');
    throw err;
  }
  say('OK');
}

function freePort() {
  return new Promise((done, fail) => {
    const probe = createServer();
    probe.once('error', fail);
    probe.listen(0, HOST, () => {
      const { port } = probe.address();
      probe.close(() => done(port));
    });
  });
}

function startServer(runDir, port) {
  /*
   * A deliberately assembled environment, not an inherited one:
   *
   *  - npm_* is stripped because npm brings variables of its own, and running
   *    this through `npm run smoke` must not quietly test something other than
   *    what a packaged build runs.
   *  - BLACKMATRIX_* and ATEM_CROSSPOINT_* are dropped wholesale and rebuilt
   *    here, so a developer's own port, host or config file cannot move the
   *    server out from under the assertions above.
   */
  const env = Object.fromEntries(
    Object.entries(process.env).filter(
      ([k]) => !k.startsWith('npm_') && !k.startsWith('BLACKMATRIX_') && !k.startsWith('ATEM_CROSSPOINT_'),
    ),
  );
  env.BLACKMATRIX_PORT = String(port);
  env.BLACKMATRIX_HOST = HOST;
  // Points at nothing on purpose: loadConfig() falls back to the defaults.
  env.BLACKMATRIX_CONFIG = join(runDir, 'no-such.config.json');

  const server = {
    child: spawn(process.execPath, [entry], {
      cwd: runDir,
      env,
      stdio: ['ignore', 'pipe', 'pipe'],
    }),
    exited: null,
  };
  server.child.on('exit', (code, signal) => {
    server.exited = { code, signal };
  });
  // Echoed live and prefixed: when this fails in CI, the server's own account
  // of the failure is already in the job log, in order, next to ours.
  echo(server.child.stdout);
  echo(server.child.stderr);
  return server;
}

function echo(stream) {
  let pending = '';
  stream.setEncoding('utf8');
  stream.on('data', (chunk) => {
    pending += chunk;
    const lines = pending.split('\n');
    pending = lines.pop() ?? '';
    for (const line of lines) console.log(`  server | ${line}`);
  });
  stream.on('end', () => {
    if (pending) console.log(`  server | ${pending}`);
  });
}

async function waitForBoot(server, port) {
  const deadline = Date.now() + BOOT_TIMEOUT_MS;
  while (Date.now() < deadline) {
    if (server.exited) {
      throw new Error(
        `the server exited during startup (${describeExit(server)}) — it never listened on ${port}.`,
      );
    }
    if (await answers(`http://${HOST}:${port}/`)) return;
    await sleep(POLL_MS);
  }
  throw new Error(`nothing answered on http://${HOST}:${port}/ within ${BOOT_TIMEOUT_MS / 1000}s.`);
}

async function answers(url) {
  try {
    const res = await fetch(url);
    await res.arrayBuffer();
    return true;
  } catch {
    return false;
  }
}

async function checkRoutes(server, port) {
  for (const check of CHECKS) {
    let res;
    try {
      res = await fetch(`http://${HOST}:${port}${check.path}`);
    } catch (err) {
      const gone = server.exited ? ` — the server has exited (${describeExit(server)})` : '';
      throw new Error(`GET ${check.path} (${check.what}) failed: ${err.message}${gone}`);
    }
    const body = await res.text();

    if (res.status !== 200) {
      throw new Error(
        `GET ${check.path} (${check.what}) returned ${res.status}, expected 200.` +
          (check.kind === 'html' && res.status === 404
            ? `\n  The SPA fallback did not serve index.html. Express 5 wants '/{*splat}'` +
              `\n  ('*' is Express 4 syntax and throws at registration), and sendFile` +
              `\n  needs { root } or a dot segment anywhere in the path 404s it.` +
              `\n  ${body.slice(0, 200)}`
            : ''),
      );
    }

    if (check.kind === 'html') {
      // The mount point from packages/web/index.html. A 200 alone would also
      // be satisfied by an error page, which is not what shipping looks like.
      if (!body.includes('id="root"')) {
        throw new Error(
          `GET ${check.path} returned 200 but not the UI shell (no #root mount point):` +
            `\n  ${body.slice(0, 200)}`,
        );
      }
    } else {
      let json;
      try {
        json = JSON.parse(body);
      } catch {
        throw new Error(`GET ${check.path} returned 200 but not JSON:\n  ${body.slice(0, 200)}`);
      }
      if (json.ok !== true) {
        throw new Error(`GET ${check.path} returned JSON without ok: true:\n  ${body.slice(0, 200)}`);
      }
    }

    say(`GET ${check.path} -> 200 (${check.what})`);
  }
}

async function shutdownCleanly(server) {
  server.child.kill('SIGTERM');
  const deadline = Date.now() + SHUTDOWN_TIMEOUT_MS;
  while (!server.exited && Date.now() < deadline) await sleep(POLL_MS);

  if (!server.exited) {
    server.child.kill('SIGKILL');
    throw new Error(
      `the server ignored SIGTERM for ${SHUTDOWN_TIMEOUT_MS / 1000}s and had to be killed: ` +
        `its shutdown path is stuck.`,
    );
  }
  if (server.exited.code !== 0) {
    throw new Error(`the server exited ${describeExit(server)} on SIGTERM; a clean stop exits 0.`);
  }
}

function describeExit(server) {
  const { code, signal } = server.exited;
  return signal ? `killed by ${signal}` : `exit code ${code}`;
}

function say(message) {
  console.log(`smoke: ${message}`);
}

function sleep(ms) {
  return new Promise((done) => setTimeout(done, ms));
}

main().catch((err) => {
  console.error(`\nsmoke: FAILED — ${err.message}\n`);
  process.exitCode = 1;
});
