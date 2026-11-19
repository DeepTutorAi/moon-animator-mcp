// Per-user state. The server may run from a read-only or temporary package
// directory (for example under npx), so the bridge token lives in the user's
// home directory, shared by the server and the plugin installer.

import { randomBytes } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';

export const DEFAULT_PORT = 47823;

export function dataDir() {
  return process.env.MOON_MCP_HOME || join(homedir(), '.moon-animator-mcp');
}

export function bridgePort() {
  return Number(process.env.MOON_BRIDGE_PORT ?? DEFAULT_PORT);
}

// The shared secret between the bridge and the Studio plugin. Created on
// first use; the plugin installer embeds the same value in the plugin.
export function ensureToken() {
  const dir = dataDir();
  const file = join(dir, 'bridge-token');
  if (!existsSync(file)) {
    mkdirSync(dir, { recursive: true });
    writeFileSync(file, randomBytes(24).toString('hex'), { mode: 0o600 });
  }
  return readFileSync(file, 'utf8').trim();
}
