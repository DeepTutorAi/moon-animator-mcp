#!/usr/bin/env node
// Command line entry. With no arguments it runs the MCP server on stdio, which
// is what an MCP client starts. The subcommands manage the Studio plugin.

import { dataDir, bridgePort } from '../server/paths.mjs';
import { installPlugin, pluginInstalled, uninstallPlugin } from '../server/plugin-install.mjs';
import { PACKAGE, startServer } from '../server/mcp-server.mjs';
import { spawnSync } from 'node:child_process';
import { installSkill } from '../server/skill-install.mjs';
import { installedSkills, runUpdate } from '../server/update.mjs';
import { fetchLatestVersion, isNewer, updateInstructions } from '../server/update-check.mjs';

const HELP = `${PACKAGE.name} ${PACKAGE.version}
Unofficial MCP server for Moon Animator 2 (Roblox Studio).

Usage:
  moon-animator-mcp                    Run the MCP server on stdio (started by your MCP client).
  moon-animator-mcp install-plugin     Install the MoonBridge plugin into Roblox Studio now
                                       (the server also does this when it starts).
  moon-animator-mcp uninstall-plugin   Remove the MoonBridge plugin from Roblox Studio.
  moon-animator-mcp install-skill      Copy the optional agent skill to ~/.claude/skills
                                       (--project: ./.claude/skills, --dir <folder>: any skills folder).
  moon-animator-mcp update             Move the Claude Code registration to the latest release and
                                       refresh installed copies of the skill (--mcp or --skill for one
                                       of them, --check to only report, --name <server> if renamed).
  moon-animator-mcp doctor             Show what is installed on this machine.
  moon-animator-mcp --version | --help

Requires Windows, Roblox Studio, and Moon Animator 2 installed from the Roblox
Creator Store. Moon Animator 2 is a separate product and is not included.`;

const [command, ...options] = process.argv.slice(2);

try {
  if (command === undefined) {
    await startServer();
  } else if (command === 'install-plugin') {
    const target = installPlugin();
    console.log(`Installed ${target}`);
    console.log('Restart Roblox Studio, then allow the plugin to make HTTP requests to 127.0.0.1 when asked.');
  } else if (command === 'uninstall-plugin') {
    const { target, existed } = uninstallPlugin();
    console.log(existed ? `Removed ${target}` : `Nothing to remove (${target} does not exist)`);
  } else if (command === 'install-skill') {
    const dirIndex = options.indexOf('--dir');
    if (dirIndex >= 0 && !options[dirIndex + 1]) throw new Error('--dir needs a folder');
    const target = installSkill({ project: options.includes('--project'), dir: dirIndex >= 0 ? options[dirIndex + 1] : undefined });
    console.log(`Installed the moon-animator skill to ${target}`);
  } else if (command === 'update') {
    const nameIndex = options.indexOf('--name');
    if (nameIndex >= 0 && !options[nameIndex + 1]) throw new Error('--name needs the server name');
    const only = options.includes('--mcp') !== options.includes('--skill');
    const complete = await runUpdate({
      current: PACKAGE.version,
      latest: await fetchLatestVersion(),
      name: nameIndex >= 0 ? options[nameIndex + 1] : undefined,
      mcp: !only || options.includes('--mcp'),
      skill: !only || options.includes('--skill'),
      check: options.includes('--check'),
      exec: (line) => spawnSync(line, { shell: true, encoding: 'utf8', windowsHide: true }),
      log: (line) => console.log(line),
    });
    if (!complete) process.exitCode = 1;
  } else if (command === 'doctor') {
    console.log(`${PACKAGE.name} ${PACKAGE.version}`);
    console.log(`platform:           ${process.platform}${process.platform === 'win32' ? '' : ' (window capture and the plugin installer need Windows)'}`);
    console.log(`node:               ${process.version}`);
    console.log(`data directory:     ${dataDir()}`);
    console.log(`bridge port:        ${bridgePort()}`);
    console.log(`MoonBridge plugin:  ${pluginInstalled() ? 'installed' : 'not installed (run: moon-animator-mcp install-plugin)'}`);
    console.log('Moon Animator 2:    checked live by the moon_status tool while Roblox Studio is open');
    for (const copy of installedSkills()) {
      console.log(`skill (${copy.where}):${' '.repeat(Math.max(1, 12 - copy.where.length))}${copy.version ?? 'installed, version not recorded'}  ${copy.dir}`);
    }
    const latest = process.env.MOON_MCP_NO_UPDATE_CHECK === '1' ? null : await fetchLatestVersion();
    if (latest === null) {
      console.log('latest release:     not checked (offline, or MOON_MCP_NO_UPDATE_CHECK is set)');
    } else if (isNewer(latest, PACKAGE.version)) {
      console.log(`latest release:     ${latest} is available. ${updateInstructions(latest)}`);
    } else {
      console.log(`latest release:     ${latest} (up to date)`);
    }
  } else if (command === '--version' || command === '-v') {
    console.log(PACKAGE.version);
  } else if (command === '--help' || command === '-h' || command === 'help') {
    console.log(HELP);
  } else {
    console.error(`Unknown command: ${command}\n\n${HELP}`);
    process.exitCode = 2;
  }
} catch (error) {
  console.error(`${PACKAGE.name}: ${error.message}`);
  process.exitCode = 1;
}
