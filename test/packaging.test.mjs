import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { buildPlugin } from '../server/plugin-install.mjs';

const BIN = fileURLToPath(new URL('../bin/moon-animator-mcp.mjs', import.meta.url));
const PACKAGE = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8'));

async function withHome(run) {
  const home = mkdtempSync(join(tmpdir(), 'moon-mcp-test-'));
  try {
    return await run(home, { ...process.env, MOON_MCP_HOME: home });
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
  assert.deepEqual(servers['moon-animator'].args, ['-y', 'github:DeepTutorAi/moon-animator-mcp']);
  assert.ok(PACKAGE.repository.url.includes('DeepTutorAi/moon-animator-mcp'));
});
