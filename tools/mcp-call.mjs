// Calls one tool on the MCP server over real MCP stdio and prints the result.
// Usage: node tools/mcp-call.mjs <tool | --list> [json-args | @args-file] [--save <image-file>]

import { spawn } from 'node:child_process';
import { readFileSync, writeFileSync } from 'node:fs';
import { createInterface } from 'node:readline';
import { fileURLToPath } from 'node:url';

const [toolName, ...rest] = process.argv.slice(2);
if (!toolName) {
  console.error('usage: node tools/mcp-call.mjs <tool> [json-args] [--save <image-file>]');
  process.exit(2);
}
const saveIndex = rest.indexOf('--save');
const savePath = saveIndex >= 0 ? rest[saveIndex + 1] : null;
const argsValue = rest.find((value, index) => saveIndex < 0 || (index !== saveIndex && index !== saveIndex + 1));
// "@path" reads the arguments from a JSON file, for payloads too long for a command line.
const argsJson = argsValue?.startsWith('@') ? readFileSync(argsValue.slice(1), 'utf8') : argsValue;

// MOON_MCP_SERVER_CMD runs a different server command (for example
// "npx -y github:DeepTutorAi/moon-animator-mcp") instead of this checkout.
const serverCommand = process.env.MOON_MCP_SERVER_CMD;
const server = serverCommand
  ? spawn(serverCommand, { shell: true, stdio: ['pipe', 'pipe', 'inherit'] })
  : spawn(process.execPath, [fileURLToPath(new URL('../bin/moon-animator-mcp.mjs', import.meta.url))], {
      stdio: ['pipe', 'pipe', 'inherit'],
    });
const send = (message) => server.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', ...message })}\n`);

const replies = createInterface({ input: server.stdout });
replies.on('line', (line) => {
  const message = JSON.parse(line);
  if (message.id === 1) {
    send({ method: 'notifications/initialized' });
    if (toolName === '--list') {
      send({ id: 2, method: 'tools/list' });
    } else {
      send({ id: 2, method: 'tools/call', params: { name: toolName, arguments: argsJson ? JSON.parse(argsJson) : {} } });
    }
    return;
  }
  if (message.id !== 2) return;

  if (message.error) {
    console.error(`rpc error: ${message.error.message}`);
    process.exitCode = 1;
  } else if (message.result.tools) {
    for (const tool of message.result.tools) console.log(`${tool.name}: ${tool.description}`);
  } else {
    for (const item of message.result.content) {
      if (item.type === 'image') {
        if (savePath) writeFileSync(savePath, Buffer.from(item.data, 'base64'));
        console.log(`[image ${item.mimeType}, ${item.data.length} base64 chars${savePath ? `, saved to ${savePath}` : ''}]`);
      } else {
        console.log(item.text);
      }
    }
    if (message.result.isError) process.exitCode = 1;
  }
  server.stdin.end();
});

send({
  id: 1,
  method: 'initialize',
  params: { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'mcp-call', version: '0' } },
});
