// Copies the optional agent skill that ships with this package into a skills
// folder, for clients that use the MCP server without the Claude Code plugin.

import { cpSync } from 'node:fs';
import { homedir } from 'node:os';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const SKILL_NAME = 'moon-animator';
const SOURCE = fileURLToPath(new URL(`../plugins/moon-animator/skills/${SKILL_NAME}`, import.meta.url));

// Default: the user's Claude Code skills. `project` targets the current
// project instead; `dir` names any other skills folder.
export function skillsDir({ project = false, dir } = {}) {
  if (dir) return resolve(dir);
  return project ? resolve('.claude', 'skills') : join(homedir(), '.claude', 'skills');
}

export function installSkill(options) {
  const target = join(skillsDir(options), SKILL_NAME);
  cpSync(SOURCE, target, { recursive: true });
  return target;
}
