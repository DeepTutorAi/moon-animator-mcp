// moon-animator-mcp: MCP server (stdio, newline-delimited JSON-RPC) that lets
// an agent inspect and author Moon Animator 2 animations in Roblox Studio
// through the MoonBridge plugin. stdout carries protocol messages only;
// diagnostics go to stderr.

import { readFileSync } from 'node:fs';
import { createInterface } from 'node:readline';
import { fileURLToPath } from 'node:url';
import { createBridgeClient } from './bridge-client.mjs';
import { annotateImage, captureWindow, closeCaptureHost, composeSheet } from './capture.mjs';
import { createLuauRunner } from './luau.mjs';
import { bridgePort, ensureToken } from './paths.mjs';
import { bundledPluginVersion, ensurePlugin } from './plugin-install.mjs';
import { createTools } from './tools.mjs';
import { createUpdateCheck } from './update-check.mjs';

const PROTOCOL_VERSIONS = ['2025-06-18', '2025-03-26', '2024-11-05'];

export const PACKAGE = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8'));

const INSTRUCTIONS = [
  'Tools for Moon Animator 2, a Roblox Studio animation plugin. They work while Roblox Studio is open with two',
  'plugins loaded: Moon Animator 2 (the user installs it from the Roblox Creator Store; it is not included) and',
  'MoonBridge (this server installs it; Studio has to be restarted once afterwards). Call moon_status first: it',
  'says what is missing. Look with moon_storyboard, moon_screenshot and moon_motion_trail; find a pose with',
  'moon_solve_reach and moon_preview_pose before committing with moon_set_keyframes or moon_spin; check with',
  'moon_sample; finish with moon_save and moon_export.',
].join(' ');

export async function startServer() {
  // Keeps the Studio plugin in step with this package, so adding the server
  // to an MCP client is the only install step.
  const plugin = { version: bundledPluginVersion(), ...ensurePlugin() };
  if (plugin.state !== 'current') {
    console.error(`${PACKAGE.name}: MoonBridge Studio plugin ${plugin.state}${plugin.target ? ` at ${plugin.target}` : ''}${plugin.reason ? ` (${plugin.reason})` : ''}`);
  }

  // Looks up the latest release in the background and only reports it.
  const updates = createUpdateCheck({
    current: PACKAGE.version,
    disabled: process.env.MOON_MCP_NO_UPDATE_CHECK === '1',
    log: (message) => console.error(`${PACKAGE.name}: ${message}`),
  });
  updates.start();

  const bridge = createBridgeClient({ port: bridgePort(), token: ensureToken() });
  const tools = createTools({
    bridge,
    runLuau: createLuauRunner(bridge),
    captureWindow,
    composeSheet,
    annotateImage,
    plugin,
    version: () => updates.info(),
    allowExec: process.env.MOON_MCP_ALLOW_EXEC === '1',
  });

  function write(message) {
    process.stdout.write(`${JSON.stringify({ jsonrpc: '2.0', ...message })}\n`);
  }

  async function handle(request) {
    const { id, method, params } = request;
    const isNotification = id === undefined;

    if (method === 'initialize') {
      const requested = params?.protocolVersion;
      return {
        protocolVersion: PROTOCOL_VERSIONS.includes(requested) ? requested : PROTOCOL_VERSIONS[0],
        capabilities: { tools: {} },
        serverInfo: { name: PACKAGE.name, version: PACKAGE.version },
        instructions: INSTRUCTIONS,
      };
    }
    if (method === 'ping') return {};
    if (method === 'tools/list') return { tools: tools.list() };
    if (method === 'tools/call') {
      try {
        const content = await tools.call(params?.name, params?.arguments);
        // Said once per session, on whichever tool is used first.
        const notice = updates.takeNotice();
        if (notice) content.push({ type: 'text', text: notice });
        return { content };
      } catch (error) {
        return { content: [{ type: 'text', text: String(error.message ?? error) }], isError: true };
      }
    }
    if (isNotification) return undefined;

    const error = new Error(`method not found: ${method}`);
    error.rpcCode = -32601;
    throw error;
  }

  await bridge.start();
  console.error(`${PACKAGE.name} ${PACKAGE.version}: ready (${bridge.isHost() ? 'hosting bridge' : 'relaying through existing bridge'})`);

  const lines = createInterface({ input: process.stdin });
  lines.on('line', async (line) => {
    if (!line.trim()) return;

    let request;
    try {
      request = JSON.parse(line);
    } catch {
      write({ id: null, error: { code: -32700, message: 'parse error' } });
      return;
    }

    try {
      const result = await handle(request);
      if (request.id !== undefined && result !== undefined) write({ id: request.id, result });
    } catch (error) {
      if (request.id !== undefined) {
        write({ id: request.id, error: { code: error.rpcCode ?? -32603, message: String(error.message ?? error) } });
      }
    }
  });
  lines.on('close', async () => {
    await closeCaptureHost();
    await bridge.close();
    process.exit(0);
  });
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  await startServer();
}
