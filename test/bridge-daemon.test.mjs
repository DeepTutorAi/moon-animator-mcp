import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createBridge } from '../server/bridge-daemon.mjs';

const TOKEN = 'test-token';

async function startBridge(options = {}) {
  const bridge = createBridge({ port: 0, token: TOKEN, ...options });
  const port = await bridge.listen();
  const call = (method, path, body, token = TOKEN) =>
    fetch(`http://127.0.0.1:${port}${path}`, { method, body, headers: { 'X-Moon-Token': token } });
  return { bridge, call };
}

test('rejects requests without the shared token', async () => {
  const { bridge, call } = await startBridge();
  try {
    const response = await call('GET', '/status', undefined, 'wrong');
    assert.equal(response.status, 401);
  } finally {
    await bridge.close();
  }
});

test('exec fails fast when the plugin has never polled', async () => {
  const { bridge, call } = await startBridge();
  try {
    const response = await call('POST', '/exec', 'return 1');
    assert.equal(response.status, 503);
    assert.equal((await response.json()).ok, false);
  } finally {
    await bridge.close();
  }
});

test('relays an exec command to a polling plugin and returns its result', async () => {
  const { bridge, call } = await startBridge();
  try {
    const poll = call('GET', '/poll');
    await new Promise((resolve) => setTimeout(resolve, 50));
    const exec = call('POST', '/exec?timeout=7', 'return 1 + 1');

    const command = await (await poll).json();
    assert.equal(command.token, TOKEN);
    assert.equal(command.type, 'exec');
    assert.equal(command.code, 'return 1 + 1');
    assert.equal(command.timeout, 7);

    await call('POST', '/result', JSON.stringify({ id: command.id, result: { ok: true, values: [2] } }));
    assert.deepEqual(await (await exec).json(), { ok: true, values: [2] });
  } finally {
    await bridge.close();
  }
});

test('queues a command sent between polls', async () => {
  const { bridge, call } = await startBridge({ pollHoldMs: 30 });
  try {
    const idle = await (await call('GET', '/poll')).json();
    assert.equal(idle.idle, true);

    const exec = call('POST', '/exec', 'return "queued"');
    await new Promise((resolve) => setTimeout(resolve, 50));
    const command = await (await call('GET', '/poll')).json();
    assert.equal(command.code, 'return "queued"');

    await call('POST', '/result', JSON.stringify({ id: command.id, result: { ok: true, values: ['queued'] } }));
    assert.deepEqual((await (await exec).json()).values, ['queued']);
  } finally {
    await bridge.close();
  }
});
