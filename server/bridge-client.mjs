// Gives a process access to the MoonBridge plugin. The first process to bind
// the bridge port hosts the daemon in-process; later processes relay through
// it over HTTP and take over hosting if the host goes away.

import { createBridge, DEFAULT_EXEC_TIMEOUT_S } from './bridge-daemon.mjs';

const PLUGIN_WAIT_MS = 8_000;

export function createBridgeClient({ port, token }) {
  let hosted = null;
  let hostedAt = 0;

  async function tryHost() {
    const bridge = createBridge({ port, token });
    try {
      await bridge.listen();
      hosted = bridge;
      hostedAt = Date.now();
      return true;
    } catch (error) {
      if (error.code === 'EADDRINUSE') return false;
      throw error;
    }
  }

  async function remote(method, path, body, timeoutMs) {
    const response = await fetch(`http://127.0.0.1:${port}${path}`, {
      method,
      body,
      headers: { 'X-Moon-Token': token },
      signal: AbortSignal.timeout(timeoutMs),
    });
    if (response.status === 401) {
      throw new Error(`port ${port} is held by a process with a different bridge token`);
    }
    return response.json();
  }

  // Runs `viaHost` when this process hosts the daemon, otherwise `viaRemote`;
  // if the remote host is gone, becomes the host and retries once.
  async function route(viaHost, viaRemote) {
    if (!hosted) {
      try {
        return await viaRemote();
      } catch (error) {
        // undici reports refused and reset connections alike as TypeError("fetch failed").
        const hostGone = error instanceof TypeError && error.message === 'fetch failed';
        if (!hostGone) throw error;
        if (!(await tryHost())) return viaRemote();
      }
    }
    return viaHost();
  }

  // A bridge that just started hosting has not heard from the plugin yet, even
  // when Studio is ready (the plugin retries a lost bridge every few seconds),
  // so early calls wait for it instead of reporting "not connected".
  async function waitForPlugin() {
    const deadline = hostedAt + PLUGIN_WAIT_MS;
    while (!hosted.status().pluginConnected && Date.now() < deadline) {
      await new Promise((resolve) => setTimeout(resolve, 250));
    }
  }

  return {
    start: tryHost,
    isHost: () => hosted !== null,
    status: () =>
      route(
        async () => {
          await waitForPlugin();
          return hosted.status();
        },
        () => remote('GET', '/status', undefined, 5_000),
      ),
    exec: (code, timeout = DEFAULT_EXEC_TIMEOUT_S) =>
      route(
        async () => {
          await waitForPlugin();
          return hosted.exec(code, timeout);
        },
        () => remote('POST', `/exec?timeout=${timeout}`, code, (timeout + 10) * 1000),
      ),
    close: async () => {
      if (hosted) await hosted.close();
      hosted = null;
    },
  };
}
