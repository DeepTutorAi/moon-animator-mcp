import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { buildPlugin, bundledPluginVersion, ensurePlugin } from '../server/plugin-install.mjs';

const BIN = fileURLToPath(new URL('../bin/moon-animator-mcp.mjs', import.meta.url));
const PACKAGE = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8'));

async function withHome(run) {
  const home = mkdtempSync(join(tmpdir(), 'moon-mcp-test-'));
  try {
    return await run(home, { ...process.env, MOON_MCP_HOME: home, MOON_STUDIO_PLUGINS_DIR: home });
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
}

test('built plugin carries the port and token and leaves no placeholders', () => {
  const plugin = buildPlugin({ port: 51234, token: 'secret-token' });
  assert.match(plugin, /<string name="Name">MoonBridge<\/string>/);
  assert.match(plugin, /tonumber\("51234"\)/);
  assert.match(plugin, /"secret-token"/);
  assert.ok(!plugin.includes('@@'), 'placeholders must be replaced');
});

test('the token is created once per data directory and reused', async () => {
  await withHome(async (home) => {
    const previous = process.env.MOON_MCP_HOME;
    process.env.MOON_MCP_HOME = home;
    try {
      const { ensureToken } = await import('../server/paths.mjs');
      const first = ensureToken();
      assert.match(first, /^[0-9a-f]{48}$/);
      assert.equal(ensureToken(), first);
      assert.equal(readFileSync(join(home, 'bridge-token'), 'utf8'), first);
    } finally {
      if (previous === undefined) delete process.env.MOON_MCP_HOME;
      else process.env.MOON_MCP_HOME = previous;
    }
  });
});

test('command line reports its version, explains itself, and rejects unknown commands', async () => {
  await withHome((home, env) => {
    assert.equal(execFileSync(process.execPath, [BIN, '--version'], { env, encoding: 'utf8' }).trim(), PACKAGE.version);

    const help = execFileSync(process.execPath, [BIN, '--help'], { env, encoding: 'utf8' });
    assert.match(help, /install-plugin/);
    assert.match(help, /Creator Store/);

    const doctor = execFileSync(process.execPath, [BIN, 'doctor'], { env, encoding: 'utf8' });
    assert.ok(doctor.includes(home), 'doctor shows the data directory in use');

    assert.throws(() => execFileSync(process.execPath, [BIN, 'nope'], { env, stdio: 'pipe' }), (error) => error.status === 2);
  });
});

test('package ships everything the server loads at runtime', () => {
  const shipped = (path) => PACKAGE.files.some((entry) => path === entry || path.startsWith(`${entry}/`));
  for (const path of [
    'bin/moon-animator-mcp.mjs',
    'server/mcp-server.mjs',
    'server/luau/prelude.luau',
    'plugin/MoonBridge.luau',
    'plugins/moon-animator/skills/moon-animator/SKILL.md',
    'tools/capture-host.ps1',
  ]) {
    assert.ok(shipped(path), `${path} must be listed in package.json files`);
  }
  assert.equal(PACKAGE.bin['moon-animator-mcp'], 'bin/moon-animator-mcp.mjs');
});

test('install-skill copies the skill with its references into the chosen folder', async () => {
  await withHome((home, env) => {
    const output = execFileSync(process.execPath, [BIN, 'install-skill', '--dir', home], { env, encoding: 'utf8' });
    const skill = join(home, 'moon-animator');
    assert.ok(output.includes(skill));
    assert.match(readFileSync(join(skill, 'SKILL.md'), 'utf8'), /^---\r?\nname: moon-animator\r?\ndescription: /);
    assert.ok(existsSync(join(skill, 'references', 'recipes.md')));
  });
});

test('plugin manifest, marketplace entry and package agree on names and version', () => {
  const read = (path) => JSON.parse(readFileSync(new URL(`../${path}`, import.meta.url), 'utf8'));
  const manifest = read('plugins/moon-animator/.claude-plugin/plugin.json');
  const marketplace = read('.claude-plugin/marketplace.json');
  const servers = read('plugins/moon-animator/.mcp.json').mcpServers;

  assert.equal(manifest.version, PACKAGE.version);
  assert.deepEqual(marketplace.plugins.map((plugin) => [plugin.name, plugin.source]), [[manifest.name, './plugins/moon-animator']]);
  // The release is pinned everywhere a user copies the package name from.
  const pinned = `github:DeepTutorAi/moon-animator-mcp#v${PACKAGE.version}`;
  assert.deepEqual(servers['moon-animator'].args, ['-y', pinned]);
  for (const path of ['README.md', 'plugins/moon-animator/README.md']) {
    const text = readFileSync(new URL(`../${path}`, import.meta.url), 'utf8');
    const specs = text.match(/github:DeepTutorAi\/moon-animator-mcp[^\s`"]*/g) ?? [];
    assert.ok(specs.length > 0, `${path} names the package`);
    for (const spec of specs) assert.ok(spec === pinned || spec.endsWith('#<new'), `${path} has an unpinned or outdated spec: ${spec}`);
  }
  assert.ok(PACKAGE.repository.url.includes('DeepTutorAi/moon-animator-mcp'));
});

test('the Studio plugin is installed once, left alone when current, and rewritten when it differs', async () => {
  await withHome((home) => {
    const saved = { ...process.env };
    Object.assign(process.env, { MOON_MCP_HOME: home, MOON_STUDIO_PLUGINS_DIR: home });
    delete process.env.MOON_MCP_NO_PLUGIN_INSTALL;
    try {
      const first = ensurePlugin();
      assert.equal(first.state, 'installed');
      assert.equal(ensurePlugin().state, 'current');

      writeFileSync(first.target, 'an older build');
      assert.equal(ensurePlugin().state, 'updated');
      assert.ok(readFileSync(first.target, 'utf8').includes(readFileSync(join(home, 'bridge-token'), 'utf8')));

      process.env.MOON_MCP_NO_PLUGIN_INSTALL = '1';
      assert.equal(ensurePlugin().state, 'skipped');
    } finally {
      for (const key of ['MOON_MCP_HOME', 'MOON_STUDIO_PLUGINS_DIR', 'MOON_MCP_NO_PLUGIN_INSTALL']) {
        if (saved[key] === undefined) delete process.env[key];
        else process.env[key] = saved[key];
      }
    }
  });
  assert.match(bundledPluginVersion(), /^\d+\.\d+\.\d+$/);
});
