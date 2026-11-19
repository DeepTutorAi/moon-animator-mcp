// Builds the MoonBridge Studio plugin (plugin/MoonBridge.luau with this
// machine's bridge port and token) and places it in Roblox Studio's local
// plugins folder.

import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { bridgePort, ensureToken } from './paths.mjs';

const PLUGIN_FILE = 'MoonBridge.rbxmx';
const TEMPLATE = new URL('../plugin/MoonBridge.luau', import.meta.url);

// Studio loads local plugins from this folder. It only creates the folder the
// first time the user opens it from the Plugins tab, so it is created here
// when Roblox itself is installed. MOON_STUDIO_PLUGINS_DIR names another one.
export function studioPluginsDir() {
  if (process.env.MOON_STUDIO_PLUGINS_DIR) return process.env.MOON_STUDIO_PLUGINS_DIR;
  if (process.platform !== 'win32' || !process.env.LOCALAPPDATA) {
    throw new Error('the Studio plugin installer currently supports Windows only');
  }
  const dir = join(process.env.LOCALAPPDATA, 'Roblox', 'Plugins');
  if (!existsSync(dirname(dir))) {
    throw new Error(`Roblox is not installed for this user (${dirname(dir)} not found)`);
  }
  mkdirSync(dir, { recursive: true });
  return dir;
}

// Version the plugin source in this package reports to the bridge.
export function bundledPluginVersion() {
  return /BRIDGE_VERSION = "([^"]+)"/.exec(readFileSync(TEMPLATE, 'utf8'))?.[1];
}

export function buildPlugin({ port, token }) {
  const template = readFileSync(TEMPLATE, 'utf8');
  for (const placeholder of ['@@PORT@@', '@@TOKEN@@']) {
    if (!template.includes(placeholder)) throw new Error(`plugin source is missing the ${placeholder} placeholder`);
  }
  const source = template.replace('@@PORT@@', String(port)).replace('@@TOKEN@@', token);
  if (source.includes(']]>')) throw new Error('plugin source contains "]]>", which cannot be embedded in CDATA');

  return `<roblox xmlns:xmime="http://www.w3.org/2005/05/xmlmime" xmlns:xsi="http://www.w3.org/2001/XMLSchema-instance" xsi:noNamespaceSchemaLocation="http://www.roblox.com/roblox.xsd" version="4">
	<Item class="Script" referent="RBX0">
		<Properties>
			<string name="Name">MoonBridge</string>
			<ProtectedString name="Source"><![CDATA[${source}]]></ProtectedString>
		</Properties>
	</Item>
</roblox>
`;
}

export function installPlugin() {
  const target = join(studioPluginsDir(), PLUGIN_FILE);
  writeFileSync(target, buildPlugin({ port: bridgePort(), token: ensureToken() }));
  return target;
}

// Installs the plugin when it is missing or differs from this package's build
// of it. Never throws: the server must still start, and say what is wrong, on
// a machine where this cannot work. Returns { state, target } or { state, reason }
// where state is current, installed, updated, skipped or unavailable.
export function ensurePlugin() {
  if (process.env.MOON_MCP_NO_PLUGIN_INSTALL === '1') {
    return { state: 'skipped', reason: 'MOON_MCP_NO_PLUGIN_INSTALL is set' };
  }
  try {
    const target = join(studioPluginsDir(), PLUGIN_FILE);
    const built = buildPlugin({ port: bridgePort(), token: ensureToken() });
    if (!existsSync(target)) {
      writeFileSync(target, built);
      return { state: 'installed', target };
    }
    if (readFileSync(target, 'utf8') === built) return { state: 'current', target };
    writeFileSync(target, built);
    return { state: 'updated', target };
  } catch (error) {
    return { state: 'unavailable', reason: error.message };
  }
}

export function uninstallPlugin() {
  const target = join(studioPluginsDir(), PLUGIN_FILE);
  const existed = existsSync(target);
  rmSync(target, { force: true });
  return { target, existed };
}

export function pluginInstalled() {
  try {
    return existsSync(join(studioPluginsDir(), PLUGIN_FILE));
  } catch {
    return false;
  }
}
