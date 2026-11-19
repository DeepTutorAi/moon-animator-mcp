import assert from 'node:assert/strict';
import { test } from 'node:test';
import { parseRegistration, planRegistration, runUpdate } from '../server/update.mjs';
import { createUpdateCheck, fetchLatestVersion, isNewer } from '../server/update-check.mjs';

// What `claude mcp get <name>` prints for a registered server.
const registered = (args, { scope = 'local', env = '' } = {}) =>
  [
    'moon-animator:',
    `  Scope: ${scope === 'user' ? 'User config (available in all your projects)' : 'Local config (private to you in this project)'}`,
    '  Status: ✔ Connected',
    '  Type: stdio',
    '  Command: npx',
    `  Args: ${args}`,
    '  Environment:',
    env,
    '',
    `To remove this server, run: claude mcp remove moon-animator -s ${scope}`,
  ].join('\n');

test('isNewer compares x.y.z numerically and ignores anything it cannot read', () => {
  assert.equal(isNewer('0.1.4', '0.1.3'), true);
  assert.equal(isNewer('0.1.10', '0.1.9'), true);
  assert.equal(isNewer('1.0.0', '0.9.9'), true);
  assert.equal(isNewer('0.1.3', '0.1.3'), false);
  assert.equal(isNewer('0.1.2', '0.1.3'), false);
  assert.equal(isNewer('latest', '0.1.3'), false);
  assert.equal(isNewer(undefined, '0.1.3'), false);
});

test('a newer release is logged, shown in the version info, and announced once', async () => {
  const logged = [];
  const check = createUpdateCheck({ current: '0.1.3', fetchLatest: async () => '0.1.4', log: (line) => logged.push(line) });
  assert.deepEqual(check.info(), { running: '0.1.3' });
  assert.equal(check.takeNotice(), null, 'nothing to say before the lookup finished');

  await check.start();
  assert.equal(logged.length, 1);
  assert.match(logged[0], /Update available: moon-animator-mcp 0\.1\.4 \(running 0\.1\.3\)/);
  assert.match(logged[0], /Nothing is updated automatically/);
  assert.match(logged[0], /npx -y github:DeepTutorAi\/moon-animator-mcp#v0\.1\.4 update/);
  assert.match(logged[0], /CHANGELOG\.md/);

  assert.deepEqual(check.info(), {
    running: '0.1.3',
    latest: '0.1.4',
    update: 'npx -y github:DeepTutorAi/moon-animator-mcp#v0.1.4 update',
  });

  assert.match(check.takeNotice(), /Update available/);
  assert.equal(check.takeNotice(), null, 'said once per session');
});

test('the same or an older release, a failed lookup, and a disabled check stay quiet', async () => {
  for (const latest of ['0.1.3', '0.1.2', null]) {
    const logged = [];
    const check = createUpdateCheck({ current: '0.1.3', fetchLatest: async () => latest, log: (line) => logged.push(line) });
    await check.start();
    assert.equal(logged.length, 0);
    assert.equal(check.takeNotice(), null);
    assert.equal(check.info().update, undefined);
  }

  let asked = false;
  const disabled = createUpdateCheck({ current: '0.1.3', disabled: true, fetchLatest: async () => ((asked = true), '9.9.9') });
  await disabled.start();
  assert.equal(asked, false, 'a disabled check makes no request');
  assert.deepEqual(disabled.info(), { running: '0.1.3' });
});

test('the lookup returns null instead of throwing when the network or the answer is bad', async () => {
  const answer = (body, ok = true) => async () => ({ ok, json: async () => body });
  assert.equal(await fetchLatestVersion(answer({ version: '0.2.1' })), '0.2.1');
  assert.equal(await fetchLatestVersion(answer({ version: 'next' })), null);
  assert.equal(await fetchLatestVersion(answer({}, false)), null);
  assert.equal(await fetchLatestVersion(async () => { throw new TypeError('fetch failed'); }), null);
});

test('a registration is read with its scope, arguments and environment', () => {
  const parsed = parseRegistration(registered('-y github:DeepTutorAi/moon-animator-mcp#v0.1.3', { env: '    MOON_BRIDGE_PORT=47999\n    MOON_MCP_ALLOW_EXEC=1' }));
  assert.deepEqual(parsed, {
    scope: 'local',
    command: 'npx',
    args: '-y github:DeepTutorAi/moon-animator-mcp#v0.1.3',
    env: [['MOON_BRIDGE_PORT', '47999'], ['MOON_MCP_ALLOW_EXEC', '1']],
  });
  assert.equal(parseRegistration(registered('-y x', { scope: 'user' })).scope, 'user');
  assert.equal(parseRegistration('No MCP server named "moon-animator". Configured servers: a, b'), null);
});

test('planning moves a pinned registration, and leaves the rest alone', () => {
  const pinned = parseRegistration(registered('-y github:DeepTutorAi/moon-animator-mcp#v0.1.3', { scope: 'user', env: '    MOON_BRIDGE_PORT=47999' }));
  assert.deepEqual(planRegistration('moon-animator', pinned, '0.1.4'), {
    action: 'retag',
    scope: 'user',
    from: 'v0.1.3',
    // The name comes before -e, which would otherwise take it as a value.
    commands: [
      'claude mcp remove moon-animator -s user',
      'claude mcp add --scope user moon-animator -e MOON_BRIDGE_PORT=47999 -- npx -y github:DeepTutorAi/moon-animator-mcp#v0.1.4',
    ],
    restore: 'claude mcp add --scope user moon-animator -e MOON_BRIDGE_PORT=47999 -- npx -y github:DeepTutorAi/moon-animator-mcp#v0.1.3',
  });
  assert.equal(planRegistration('moon-animator', pinned, '0.1.3').action, 'current');

  const tracking = parseRegistration(registered('-y github:DeepTutorAi/moon-animator-mcp'));
  assert.equal(planRegistration('moon-animator', tracking, '0.1.4').action, 'tracking');

  const local = parseRegistration(registered('C:/code/moon-mcp/bin/moon-animator-mcp.mjs').replace('Command: npx', 'Command: node'));
  assert.equal(planRegistration('moon-animator', local, '0.1.4').action, 'manual');
  assert.equal(planRegistration('moon-animator', null, '0.1.4').action, 'missing');
});

function session({ registration, skills = [], failOn }) {
  const ran = [];
  const lines = [];
  const exec = (line) => {
    ran.push(line);
    if (failOn && line.startsWith(failOn)) return { status: 1, stdout: '' };
    if (line.startsWith('claude mcp get')) return { status: 0, stdout: registration ?? 'No MCP server named "moon-animator".' };
    return { status: 0, stdout: '' };
  };
  return { ran, lines, options: { exec, log: (line) => lines.push(line), skills } };
}

test('update moves the server and refreshes each installed skill from the new release', async () => {
  const skills = [
    { where: 'user', flag: '', dir: '~/.claude/skills/moon-animator', version: '0.1.3' },
    { where: 'project', flag: ' --project', dir: './.claude/skills/moon-animator', version: null },
  ];
  const s = session({ registration: registered('-y github:DeepTutorAi/moon-animator-mcp#v0.1.3'), skills });
  assert.equal(await runUpdate({ current: '0.1.3', latest: '0.1.4', ...s.options }), true);
  assert.deepEqual(s.ran, [
    'claude mcp get moon-animator',
    'claude mcp remove moon-animator -s local',
    'claude mcp add --scope local moon-animator -- npx -y github:DeepTutorAi/moon-animator-mcp#v0.1.4',
    'npx -y github:DeepTutorAi/moon-animator-mcp#v0.1.4 install-skill',
    'npx -y github:DeepTutorAi/moon-animator-mcp#v0.1.4 install-skill --project',
  ]);
  assert.match(s.lines.join('\n'), /moved from v0\.1\.3 to v0\.1\.4\. Restart your session/);
});

test('update --check changes nothing, and --mcp or --skill limit what is touched', async () => {
  const skills = [{ where: 'user', flag: '', dir: 'd', version: '0.1.3' }];
  const registration = registered('-y github:DeepTutorAi/moon-animator-mcp#v0.1.3');

  const check = session({ registration, skills });
  await runUpdate({ current: '0.1.3', latest: '0.1.4', check: true, ...check.options });
  assert.deepEqual(check.ran, ['claude mcp get moon-animator']);
  assert.match(check.lines.join('\n'), /would move from v0\.1\.3 to v0\.1\.4/);
  assert.match(check.lines.join('\n'), /Skill \(user, d\): would move from 0\.1\.3 to 0\.1\.4/);

  const onlySkill = session({ registration, skills });
  await runUpdate({ current: '0.1.3', latest: '0.1.4', mcp: false, ...onlySkill.options });
  assert.deepEqual(onlySkill.ran, ['npx -y github:DeepTutorAi/moon-animator-mcp#v0.1.4 install-skill']);

  const onlyServer = session({ registration, skills });
  await runUpdate({ current: '0.1.3', latest: '0.1.4', skill: false, ...onlyServer.options });
  assert.equal(onlyServer.ran.some((line) => line.includes('install-skill')), false);
});

test('update run from the latest release installs its own skill and reports what is already current', async () => {
  let installed = 0;
  const skills = [
    { where: 'user', flag: '', dir: 'd', version: '0.1.3', install: () => (installed += 1) },
    { where: 'project', flag: ' --project', dir: 'p', version: '0.1.4', install: () => (installed += 1) },
  ];
  const s = session({ registration: registered('-y github:DeepTutorAi/moon-animator-mcp#v0.1.4'), skills });
  assert.equal(await runUpdate({ current: '0.1.4', latest: '0.1.4', ...s.options }), true);
  assert.equal(installed, 1, 'only the outdated copy is replaced');
  assert.deepEqual(s.ran, ['claude mcp get moon-animator']);
  assert.match(s.lines.join('\n'), /already runs 0\.1\.4/);
  assert.match(s.lines.join('\n'), /Skill \(project, p\): already 0\.1\.4/);
});

test('update explains what to do when it cannot act', async () => {
  const offline = session({});
  assert.equal(await runUpdate({ current: '0.1.3', latest: null, ...offline.options }), false);
  assert.deepEqual(offline.ran, []);

  const missing = session({});
  assert.equal(await runUpdate({ current: '0.1.3', latest: '0.1.4', ...missing.options }), false);
  assert.match(missing.lines.join('\n'), /set the package to github:DeepTutorAi\/moon-animator-mcp#v0\.1\.4/);
  assert.match(missing.lines.join('\n'), /no installed copy found/);

  const tracking = session({ registration: registered('-y github:DeepTutorAi/moon-animator-mcp') });
  assert.equal(await runUpdate({ current: '0.1.3', latest: '0.1.4', ...tracking.options }), true);
  assert.match(tracking.lines.join('\n'), /no version tag/);

  // Adding the new registration fails: the old one is put back and nothing else is touched.
  const skills = [{ where: 'user', flag: '', dir: 'd', version: '0.1.3' }];
  const pinned = registered('-y github:DeepTutorAi/moon-animator-mcp#v0.1.3');
  const broken = session({ registration: pinned, skills, failOn: 'claude mcp add --scope local moon-animator -- npx -y github:DeepTutorAi/moon-animator-mcp#v0.1.4' });
  assert.equal(await runUpdate({ current: '0.1.3', latest: '0.1.4', ...broken.options }), false);
  assert.equal(broken.ran.at(-1), 'claude mcp add --scope local moon-animator -- npx -y github:DeepTutorAi/moon-animator-mcp#v0.1.3');
  assert.match(broken.lines.join('\n'), /put back at v0\.1\.3/);

  const stuck = session({ registration: pinned, failOn: 'claude mcp add' });
  assert.equal(await runUpdate({ current: '0.1.3', latest: '0.1.4', ...stuck.options }), false);
  assert.match(stuck.lines.join('\n'), /now missing; add it again with:\n {2}claude mcp add --scope local moon-animator -- npx -y github:DeepTutorAi\/moon-animator-mcp#v0\.1\.3/);

  const locked = session({ registration: pinned, failOn: 'claude mcp remove' });
  assert.equal(await runUpdate({ current: '0.1.3', latest: '0.1.4', ...locked.options }), false);
  assert.match(locked.lines.join('\n'), /nothing was changed/);
  assert.deepEqual(locked.ran, ['claude mcp get moon-animator', 'claude mcp remove moon-animator -s local']);
});
