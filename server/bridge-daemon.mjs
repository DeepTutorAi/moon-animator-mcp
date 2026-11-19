// Bridge daemon: relays commands between local tools and the MoonBridge
// Studio plugin. The plugin long-polls GET /poll; tools call POST /exec.
// Binds to 127.0.0.1 only and requires the shared token on every request.

import http from 'node:http';
import { randomUUID } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { bridgePort, ensureToken } from './paths.mjs';

const POLL_HOLD_MS = 20_000;
const PLUGIN_STALE_MS = 30_000;
const MAX_BODY_BYTES = 4 * 1024 * 1024;
export const DEFAULT_EXEC_TIMEOUT_S = 30;
export const NOT_CONNECTED_ERROR =
  'MoonBridge plugin is not connected (is Roblox Studio open with the MoonBridge plugin installed and HTTP allowed?)';

function readBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let size = 0;
    req.on('data', (chunk) => {
      size += chunk.length;
      if (size > MAX_BODY_BYTES) {
        reject(new Error('body too large'));
        req.destroy();
        return;
      }
      chunks.push(chunk);
    });
    req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
    req.on('error', reject);
  });
}

function send(res, status, payload) {
  const body = JSON.stringify(payload);
  res.writeHead(status, { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(body) });
  res.end(body);
}

export function createBridge({ port, token, pollHoldMs = POLL_HOLD_MS }) {
  const queue = [];
  const pending = new Map();
  let waiter = null;
  let lastPollAt = 0;
  let pluginVersion = null;

  function releaseWaiter(payload) {
    if (!waiter) return;
    clearTimeout(waiter.timer);
    const { res } = waiter;
    waiter = null;
    send(res, 200, payload);
  }

  function dispatch() {
    if (waiter && queue.length > 0) {
      releaseWaiter({ token, ...queue.shift() });
    }
  }

  function pluginConnected() {
    return waiter !== null || Date.now() - lastPollAt < PLUGIN_STALE_MS;
  }

  function status() {
    return {
      pluginConnected: pluginConnected(),
      pluginVersion,
      lastPollAgoMs: lastPollAt ? Date.now() - lastPollAt : null,
      queued: queue.length,
    };
  }

  // Resolves with the plugin's result object: { ok, values } or { ok: false, error }.
  function exec(code, timeout = DEFAULT_EXEC_TIMEOUT_S) {
    if (!pluginConnected()) {
      return Promise.resolve({ ok: false, error: NOT_CONNECTED_ERROR, notConnected: true });
    }
    const id = randomUUID();
    return new Promise((resolve) => {
      const timer = setTimeout(() => {
        pending.delete(id);
        const index = queue.findIndex((command) => command.id === id);
        if (index >= 0) queue.splice(index, 1);
        resolve({ ok: false, error: `no result from plugin within ${timeout + 5}s` });
      }, (timeout + 5) * 1000);
      pending.set(id, { resolve, timer });
      queue.push({ id, type: 'exec', code, timeout });
      dispatch();
    });
  }

  async function handle(req, res) {
    if (req.headers['x-moon-token'] !== token) {
      send(res, 401, { error: 'invalid token' });
      return;
    }

    const url = new URL(req.url, 'http://127.0.0.1');
    const route = `${req.method} ${url.pathname}`;

    if (route === 'GET /poll') {
      lastPollAt = Date.now();
      pluginVersion = req.headers['x-moon-bridge'] ?? null;
      releaseWaiter({ token, idle: true });
      waiter = {
        res,
        timer: setTimeout(() => releaseWaiter({ token, idle: true }), pollHoldMs),
      };
      req.on('close', () => {
        if (waiter && waiter.res === res && !res.writableEnded) {
          clearTimeout(waiter.timer);
          waiter = null;
        }
      });
      dispatch();
      return;
    }

    if (route === 'POST /result') {
      const { id, result } = JSON.parse(await readBody(req));
      const entry = pending.get(id);
      if (entry) {
        clearTimeout(entry.timer);
        pending.delete(id);
        entry.resolve(result);
      }
      send(res, 200, { token, ok: true });
      return;
    }

    if (route === 'POST /exec') {
      const code = await readBody(req);
      const timeout = Number(url.searchParams.get('timeout')) || DEFAULT_EXEC_TIMEOUT_S;
      const result = await exec(code, timeout);
      send(res, result.notConnected ? 503 : 200, result);
      return;
    }

    if (route === 'GET /status') {
      send(res, 200, status());
      return;
    }

    send(res, 404, { error: 'not found' });
  }

  const server = http.createServer((req, res) => {
    handle(req, res).catch((error) => {
      if (!res.headersSent) send(res, 400, { error: String(error.message ?? error) });
    });
  });

  return {
    server,
    exec,
    status,
    listen: () =>
      new Promise((resolve, reject) => {
        server.once('error', reject);
        server.listen(port, '127.0.0.1', () => {
          server.removeListener('error', reject);
          resolve(server.address().port);
        });
      }),
    close: () =>
      new Promise((resolve) => {
        if (waiter) clearTimeout(waiter.timer);
        for (const entry of pending.values()) clearTimeout(entry.timer);
        server.closeAllConnections();
        server.close(() => resolve());
      }),
  };
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const bridge = createBridge({ port: bridgePort(), token: ensureToken() });
  bridge.listen().then(
    (boundPort) => console.log(`moon bridge daemon listening on 127.0.0.1:${boundPort}`),
    (error) => {
      console.error(`failed to start bridge daemon: ${error.message}`);
      process.exit(1);
    },
  );
}
