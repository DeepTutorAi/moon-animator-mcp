import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { createServer } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createInterface } from 'node:readline';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { createBridgeClient } from '../server/bridge-client.mjs';

const TOKEN = 'test-token';

function freePort() {
  return new Promise((resolve) => {
    const probe = createServer();
    probe.listen(0, '127.0.0.1', () => {
      const { port } = probe.address();
      probe.close(() => resolve(port));
    });
  });
}

// Minimal stand-in for the Studio plugin: answers every exec with a fixed value.
function startFakePlugin(port, value) {
  let stopped = false;
  const call = (method, path, body) =>
    fetch(`http://127.0.0.1:${port}${path}`, { method, body, headers: { 'X-Moon-Token': TOKEN } });
  const loop = (async () => {
    while (!stopped) {
      try {
        const command = await (await call('GET', '/poll')).json();
        if (command.id) {
          await call('POST', '/result', JSON.stringify({ id: command.id, result: { ok: true, values: [value] } }));
        }
      } catch {
        await new Promise((resolve) => setTimeout(resolve, 50));
      }
    }
  })();
  return { stop: () => ((stopped = true), loop) };
}

test('first client hosts the bridge, second relays, and the relay takes over when the host closes', async () => {
  const port = await freePort();
  const host = createBridgeClient({ port, token: TOKEN });
  const relay = createBridgeClient({ port, token: TOKEN });
  const plugin = startFakePlugin(port, 'pong');

  try {
    assert.equal(await host.start(), true);
    assert.equal(await relay.start(), false);

    assert.deepEqual((await host.exec('return 1')).values, ['pong']);
    assert.deepEqual((await relay.exec('return 1')).values, ['pong']);
    assert.equal((await relay.status()).pluginConnected, true);

    await host.close();
    assert.deepEqual((await relay.exec('return 1')).values, ['pong']);
    assert.equal(relay.isHost(), true);
  } finally {
    await plugin.stop();
    await host.close();
    await relay.close();
  }
});

test('MCP server answers initialize and tools/list over stdio', async () => {
  const port = await freePort();
  const home = mkdtempSync(join(tmpdir(), 'moon-mcp-test-'));
  const server = spawn(process.execPath, [fileURLToPath(new URL('../bin/moon-animator-mcp.mjs', import.meta.url))], {
    stdio: ['pipe', 'pipe', 'ignore'],
    env: { ...process.env, MOON_BRIDGE_PORT: String(port), MOON_MCP_HOME: home, MOON_STUDIO_PLUGINS_DIR: home, MOON_MCP_ALLOW_EXEC: '' },
  });
  const replies = createInterface({ input: server.stdout })[Symbol.asyncIterator]();
  const request = async (message) => {
    server.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', ...message })}\n`);
    return JSON.parse((await replies.next()).value);
  };

  try {
    const init = await request({ id: 1, method: 'initialize', params: { protocolVersion: '2025-03-26' } });
    assert.equal(init.result.protocolVersion, '2025-03-26');
    assert.equal(init.result.serverInfo.name, 'moon-animator-mcp');
    assert.match(init.result.instructions, /Creator Store/);
    const token = readFileSync(join(home, 'bridge-token'), 'utf8');
    assert.match(token, /^[0-9a-f]{48}$/);
    assert.ok(readFileSync(join(home, 'MoonBridge.rbxmx'), 'utf8').includes(token), 'starting the server installs the Studio plugin');

    const list = await request({ id: 2, method: 'tools/list' });
    const names = list.result.tools.map((tool) => tool.name);
    for (const expected of ['moon_status', 'moon_storyboard', 'moon_set_keyframes', 'moon_remove_items', 'moon_undo']) {
      assert.ok(names.includes(expected), `missing tool ${expected}`);
    }
    assert.ok(!names.includes('moon_exec_luau'), 'exec must stay off by default');
    assert.ok(list.result.tools.every((tool) => tool.inputSchema?.type === 'object' && tool.description.length > 20));

    const unknown = await request({ id: 3, method: 'nope' });
    assert.equal(unknown.error.code, -32601);

    const badTool = await request({ id: 4, method: 'tools/call', params: { name: 'missing' } });
    assert.equal(badTool.result.isError, true);
  } finally {
    server.stdin.end();
    await new Promise((resolve) => server.once('exit', resolve));
    rmSync(home, { recursive: true, force: true });
  }
});
