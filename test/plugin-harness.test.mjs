// Runs the MoonBridge plugin source under the standalone Luau CLI with stubbed
// Roblox globals. Covers serialization, exec, and the Moon status report; it
// cannot cover real Studio behavior (HTTP permissions, _G sharing, datatypes).

import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { existsSync, mkdtempSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';

function findLuau() {
  if (process.env.MOON_LUAU) return process.env.MOON_LUAU;
  const storage = join(homedir(), '.rokit', 'tool-storage', 'luau-lang', 'luau');
  if (!existsSync(storage)) return null;
  for (const version of readdirSync(storage).sort().reverse()) {
    const candidate = join(storage, version, process.platform === 'win32' ? 'luau.exe' : 'luau');
    if (existsSync(candidate)) return candidate;
  }
  return null;
}

const STUBS = `
local captured = {}
local unloadCallback
local plugin = { Unloading = { Connect = function(_, callback) unloadCallback = callback end } }

local commands = {
	{ id = "basic", code = "local h = ... return 1 + 1, h.ser({ x = 1 }), nil, 'end'" },
	{ id = "runtime", code = "error('boom')" },
	{ id = "compile", code = "return +" },
	{ id = "cycle", code = "local t = {} t.self = t t.list = { 1, 2, 3 } return t" },
	{ id = "report", code = "return (...).report()" },
	{ id = "badtoken", code = "return 'must not run'", token = "wrong" },
}
local pollIndex = 0

local HttpStub = {}
function HttpStub:RequestAsync(request)
	assert(request.Headers["X-Moon-Token"] == "tok", "plugin must send the token")
	if request.Method == "GET" then
		pollIndex += 1
		local command = commands[pollIndex]
		if not command then
			unloadCallback()
			error("connection refused")
		end
		return { Success = true, StatusCode = 200, Body = {
			token = command.token or "tok", id = command.id, type = "exec", code = command.code,
		} }
	end
	captured[request.Body.id] = request.Body.result
	return { Success = true, StatusCode = 200, Body = { ok = true } }
end
function HttpStub:JSONEncode(value) return value end
function HttpStub:JSONDecode(value) return value end

local RunStub = { IsRunning = function() return false end }
local game = {
	Name = "TestPlace",
	GetService = function(_, name) return if name == "HttpService" then HttpStub else RunStub end,
}
local task = { spawn = function(f, ...) f(...) end, wait = function() end }

-- The Luau CLI sandboxes the real _G as read-only, so shadow it for the plugin chunk.
local _G = {}
_G.MoonGlobal = {
	ver = 36000,
	ready = true,
	Windows = { MoonAnimator = {
		Visible = true,
		DoCompositeAction = function() end,
		g_e = { LayerSystem = {
			CurrentFile = { Name = "Cutscene1" },
			FPS = 60, length = 300, SliderFrame = 12, RigOnlyMode = false,
			PlaybackHandler = { Loop = false },
			LayerHandler = { LayerContainer = { Objects = {
				{ ItemObject = {
					Path = { ItemType = "Camera", InstanceNames = { "game", "Workspace", "CurrentCamera" } },
					PropertyMap = { CFrame = { TrackItems = { size = 4 } }, FieldOfView = { TrackItems = { size = 2 } } },
				} },
				{ ItemObject = {
					Path = { ItemType = "Rig", InstanceNames = { "game", "Workspace", "Hero" } },
					PropertyMap = {},
					MarkerTrack = {},
					RigContainer = {},
					RigMap = { Torso = { TrackItems = { size = 3 } }, Head = { TrackItems = { size = 0 } } },
				} },
			} } },
		} },
	} },
}
`;

const ASSERTIONS = `
local basic = captured.basic
assert(basic.ok == true and basic.mode == "loadstring", "basic exec should succeed via loadstring")
assert(basic.values[1] == 2 and basic.values[2].x == 1, "basic exec values")
assert(basic.values[3] == "<nil>" and basic.values[4] == "end", "nil results keep their position")

assert(captured.runtime.ok == false and string.find(captured.runtime.error, "boom"), "runtime error is reported")
assert(captured.compile.ok == false and string.find(captured.compile.error, "compile error"), "compile error is reported")

local cycle = captured.cycle.values[1]
assert(cycle.self == "<cycle>" and cycle.list[3] == 3, "cycles are cut, arrays preserved")

local report = captured.report.values[1]
assert(report.hasMoonGlobal and report.moonVersion == 36000 and report.hasDoCompositeAction, "report sees Moon state")
assert(report.file.name == "Cutscene1" and report.file.frame == 12, "report file info")
assert(report.items[1].itemType == "Camera" and report.items[1].properties.CFrame == 4, "report camera item")
assert(report.items[1].path == "game.Workspace.CurrentCamera", "report item path")
assert(report.items[2].rig.joints == 2 and report.items[2].rig.keyedJoints == 1, "report rig joints")
assert(report.items[2].hasMarkerTrack == true, "report marker track")

assert(captured.badtoken == nil, "commands with a wrong token must not run")
assert(ser(0 / 0) == "nan" or ser(0 / 0) == "-nan" or type(ser(0 / 0)) == "string", "NaN becomes a string")
assert(ser({ a = { b = { c = { d = { e = { f = 1 } } } } } }).a.b.c.d.e == "<table>", "depth is limited")
print("HARNESS OK")
`;

test('plugin logic runs under the Luau CLI with stubbed Roblox globals', (t) => {
  const luau = findLuau();
  if (!luau) {
    t.skip('Luau CLI not found (set MOON_LUAU to enable this test)');
    return;
  }

  const pluginPath = fileURLToPath(new URL('../plugin/MoonBridge.luau', import.meta.url));
  const source = readFileSync(pluginPath, 'utf8').replace('@@PORT@@', '47823').replace('@@TOKEN@@', 'tok');
  const scriptPath = join(mkdtempSync(join(tmpdir(), 'moonbridge-')), 'harness.luau');
  writeFileSync(scriptPath, `${STUBS}\n${source}\n${ASSERTIONS}`);

  const output = execFileSync(luau, [scriptPath], { encoding: 'utf8' });
  assert.match(output, /HARNESS OK/);
});
