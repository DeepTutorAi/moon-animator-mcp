// Builds the MoonBridge Studio plugin (plugin/MoonBridge.luau with this
// machine's bridge port and token) and places it in Roblox Studio's local
// plugins folder.

import { existsSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { bridgePort, ensureToken } from './paths.mjs';

const PLUGIN_FILE = 'MoonBridge.rbxmx';

export function studioPluginsDir() {
  if (process.platform !== 'win32' || !process.env.LOCALAPPDATA) {
    throw new Error('the Studio plugin installer currently supports Windows only');
  }
  const dir = join(process.env.LOCALAPPDATA, 'Roblox', 'Plugins');
  if (!existsSync(dir)) {
    throw new Error(`Roblox Studio plugins folder not found: ${dir} (open Roblox Studio once, then try again)`);
  }
  return dir;
}

export function buildPlugin({ port, token }) {
  const template = readFileSync(new URL('../plugin/MoonBridge.luau', import.meta.url), 'utf8');
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
