// Runs the Luau snippets in ./luau inside Studio through the bridge.
// - A snippet sees its arguments as the `ARGS` table and the plugin helpers as `...`.
// - A first line of `--@<name>` prepends <name>.luau (`--@prelude` gives Moon
//   Animator handles, `--@settle` the redraw wait).
// - Structured results are returned as a JSON string and parsed here, because
//   the plugin's own value serializer limits nesting depth.
// - `error("MOON: <message>", 0)` in a snippet becomes a clean user-facing error.

import { readFileSync } from 'node:fs';

const INCLUDE = /^--@(\w+)\r?\n/;
const USER_ERROR = /MOON: ([^\r\n]*)/;
const cache = new Map();

function readSnippet(name) {
  return readFileSync(new URL(`./luau/${name}.luau`, import.meta.url), 'utf8');
}

function loadSnippet(name) {
  if (!cache.has(name)) {
    let body = readSnippet(name);
    // Leading `--@name` lines are includes, prepended in the order they are listed.
    const includes = [];
    let rest = body;
    for (let match = INCLUDE.exec(rest); match; match = INCLUDE.exec(rest)) {
      includes.push(readSnippet(match[1]));
      rest = rest.slice(match[0].length);
    }
    body = [...includes, rest].join('\n');
    cache.set(name, body);
  }
  return cache.get(name);
}

// Embeds args as a JSON long-string literal on the first line, so line numbers
// in error messages stay aligned with the snippet source.
export function withArgs(body, args) {
  const json = JSON.stringify(args ?? {});
  let level = 1;
  while (json.includes(`]${'='.repeat(level)}]`)) level += 1;
  const eq = '='.repeat(level);
  return `local ARGS = game:GetService("HttpService"):JSONDecode([${eq}[${json}]${eq}]) ${body}`;
}

export function parseResult(name, result) {
  if (!result.ok) {
    const userError = USER_ERROR.exec(result.error ?? '');
    throw new Error(userError ? userError[1] : `${name}: ${result.error}`);
  }
  const value = result.values[0];
  if (typeof value === 'string' && (value.startsWith('{') || value.startsWith('['))) {
    return JSON.parse(value);
  }
  return value;
}

export function createLuauRunner(bridge) {
  return async function runLuau(name, args, timeout) {
    return parseResult(name, await bridge.exec(withArgs(loadSnippet(name), args), timeout));
  };
}
