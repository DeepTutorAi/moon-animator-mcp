// The `update` command: moves a Claude Code registration of this server to the
// latest release tag and refreshes installed copies of the skill. It runs only
// when the user asks for it, and changes nothing with `check: true`.

import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { installSkill, skillsDir } from './skill-install.mjs';
import { REPOSITORY, isNewer, packageSpec } from './update-check.mjs';

const SKILL_NAME = 'moon-animator';
const SCOPES = ['local', 'user', 'project'];

// Reads what `claude mcp get <name>` prints. Returns null when Claude Code has
// no such server, otherwise { scope, command, args, env }.
export function parseRegistration(text) {
  const field = (name) => new RegExp(`^\\s*${name}:[ \\t]*(.*)$`, 'm').exec(text)?.[1].trim();
  const command = field('Command');
  if (command === undefined) return null;

  const scope = /-s (\w+)\s*$/m.exec(text)?.[1] ?? field('Scope')?.split(' ')[0].toLowerCase();
  const env = [];
  const block = /^\s*Environment:[ \t]*\r?\n((?:[ \t]+\S.*\r?\n?)*)/m.exec(text)?.[1] ?? '';
  for (const line of block.split(/\r?\n/)) {
    const pair = /^\s+([A-Za-z_][A-Za-z0-9_]*)=(.*)$/.exec(line);
    if (pair) env.push([pair[1], pair[2]]);
  }
  return { scope: SCOPES.includes(scope) ? scope : null, command, args: field('Args') ?? '', env };
}

function quote(value) {
  return /^[A-Za-z0-9_@%+=:,./#-]+$/.test(value) ? value : `"${value.replace(/"/g, '\\"')}"`;
}

// Decides what to do with a registration: { action, ... } where action is
// 'missing', 'manual' (not a shape this command rewrites), 'tracking' (no tag,
// so npx already runs the newest commit), 'current', or 'retag' with commands.
export function planRegistration(name, registration, latest) {
  if (!registration) return { action: 'missing' };
  const spec = registration.args.split(/\s+/).find((arg) => arg.startsWith(`github:${REPOSITORY}`));
  if (registration.command !== 'npx' || !spec || !registration.scope) return { action: 'manual' };

  const tag = spec.split('#')[1];
  if (tag === undefined) return { action: 'tracking' };
  if (tag === `v${latest}`) return { action: 'current', scope: registration.scope };

  // The name goes before -e: that option takes several values and would
  // otherwise take the name as one of them.
  const env = registration.env.map(([key, value]) => ` -e ${quote(`${key}=${value}`)}`).join('');
  const add = (args) => `claude mcp add --scope ${registration.scope} ${quote(name)}${env} -- npx ${args.map(quote).join(' ')}`;
  const oldArgs = registration.args.split(/\s+/);
  return {
    action: 'retag',
    scope: registration.scope,
    from: tag,
    commands: [`claude mcp remove ${quote(name)} -s ${registration.scope}`, add(oldArgs.map((arg) => (arg === spec ? packageSpec(latest) : arg)))],
    // Puts the registration back as it was if adding the new one fails.
    restore: add(oldArgs),
  };
}

// Installed copies of the skill: [{ where, flag, dir, version, install }].
// `version` is null for a copy installed before versions were recorded;
// `install()` replaces the copy with the skill of the running package.
export function installedSkills() {
  const found = [];
  for (const [where, flag, options] of [['user', '', {}], ['project', ' --project', { project: true }]]) {
    const dir = join(skillsDir(options), SKILL_NAME);
    if (!existsSync(join(dir, 'SKILL.md'))) continue;
    const marker = join(dir, 'VERSION');
    found.push({
      where,
      flag,
      dir,
      version: existsSync(marker) ? readFileSync(marker, 'utf8').trim() : null,
      install: () => installSkill(options),
    });
  }
  return found;
}

// Runs the update. `exec(commandLine)` returns { status, stdout }; `log(line)`
// prints. Returns false when something has to be done by hand or failed.
export async function runUpdate({ current, latest, name = 'moon-animator', mcp = true, skill = true, check = false, exec, log, skills = installedSkills() }) {
  if (latest === null) {
    log('Could not read the latest version from GitHub. Check the connection and try again.');
    return false;
  }
  log(`This command is version ${current}; the latest release is ${latest}.`);
  const spec = packageSpec(latest);
  let complete = true;

  if (mcp) {
    const got = exec(`claude mcp get ${quote(name)}`);
    const plan = planRegistration(name, got.status === 0 ? parseRegistration(got.stdout) : null, latest);
    if (plan.action === 'current') {
      log(`MCP server: "${name}" (${plan.scope} scope) already runs ${latest}.`);
    } else if (plan.action === 'tracking') {
      log(`MCP server: "${name}" has no version tag, so it already runs the newest commit on every start.`);
    } else if (plan.action === 'retag' && check) {
      log(`MCP server: "${name}" (${plan.scope} scope) would move from ${plan.from} to v${latest}.`);
    } else if (plan.action === 'retag') {
      const [remove, add] = plan.commands;
      if (exec(remove).status !== 0) {
        log(`MCP server: \`${remove}\` failed; nothing was changed.`);
        return false;
      }
      if (exec(add).status !== 0) {
        const restored = exec(plan.restore).status === 0;
        log(
          `MCP server: \`${add}\` failed. ` +
            (restored ? `The registration was put back at ${plan.from}.` : `The registration is now missing; add it again with:\n  ${plan.restore}`),
        );
        return false;
      }
      log(`MCP server: "${name}" (${plan.scope} scope) moved from ${plan.from} to v${latest}. Restart your session to load it.`);
    } else {
      complete = false;
      log(
        `MCP server: no Claude Code server named "${name}" that this command can rewrite was found from this folder ` +
          `(run it in the project folder for a project or local registration, or pass --name). In any MCP client, ` +
          `set the package to ${spec}. With the Claude Code plugin, run \`claude plugin update moon-animator@moon-animator-mcp\`.`,
      );
    }
  }

  if (skill) {
    if (skills.length === 0) log('Skill: no installed copy found (install one with `install-skill`).');
    for (const copy of skills) {
      const label = `Skill (${copy.where}, ${copy.dir})`;
      if (copy.version === latest) {
        log(`${label}: already ${latest}.`);
      } else if (check) {
        log(`${label}: would move from ${copy.version ?? 'an unrecorded version'} to ${latest}.`);
      } else if (isNewer(latest, current)) {
        // The newer skill is in the newer package, not in the one running this command.
        const command = `npx -y ${spec} install-skill${copy.flag}`;
        if (exec(command).status !== 0) {
          log(`${label}: \`${command}\` failed.`);
          complete = false;
        } else {
          log(`${label}: updated to ${latest}.`);
        }
      } else {
        copy.install();
        log(`${label}: updated to ${current}.`);
      }
    }
  }
  return complete;
}
