import assert from 'node:assert/strict';
import { existsSync, writeFileSync } from 'node:fs';
import { test } from 'node:test';
import { parseResult, withArgs } from '../server/luau.mjs';
import { createTools, summarizeDistance } from '../server/tools.mjs';

const VIEWPORT = { width: 1000, height: 500 };
const FACING = { look: [0, 0, -1], right: [1, 0, 0] };

// Two shots: a static camera on frames 0-9, then a cut to another static camera on 10-19.
function twoShotPath() {
  const samples = [];
  for (let f = 0; f < 20; f += 1) samples.push(f < 10 ? [f, 0, 5, 0, 0, 0, -1, 70] : [f, 20, 5, 0, -1, 0, 0, 70]);
  return { fps: 10, from: 0, to: 19, lastKeyframe: 19, samples, tracks: { CFrame: { enabled: true, keyframes: [] } } };
}

// Fake Studio + capture side. `captureErrors` queues errors for upcoming non-calibration captures.
function createHarness({
  captureErrors = [],
  markerBounds = { x: 10, y: 20, width: 1250, height: 625 },
  hasCamera = true,
  settled = true,
  studioStatus = { hasMoonGlobal: true, hasMainWindow: true, hasLayerSystem: true, moonVersion: 36000 },
  blockers = [],
} = {}) {
  const luauCalls = [];
  const captureCalls = [];
  const sheetCalls = [];
  const annotateCalls = [];
  let currentFrame = 3;

  const runLuau = async (name, args) => {
    luauCalls.push({ name, args });
    if (name === 'view_step') {
      if (args.frame !== undefined) currentFrame = args.frame;
      return {
        viewport: VIEWPORT,
        frame: currentFrame,
        fps: 10,
        settled,
        subtitle: currentFrame === 10 ? 'Hello' : undefined,
        camera: { position: [0, 0, 0], rotation: [0, 0, 0], fov: 70 },
      };
    }
    if (name === 'timeline') return { fps: 10, length: 300, lastKeyframe: 19, frame: currentFrame, hasCamera };
    if (name === 'camera_path') return twoShotPath();
    if (name === 'scene') return { file: { name: 'Cutscene1' }, items: [], valuesRequested: args.values };
    if (name === 'sample') {
      const frames = (args.frames ?? [currentFrame]).map((frame) => ({
        frame,
        min: [-1, 0, -0.5],
        max: [1, 5, 0.5],
        // The left foot drifts 0.2 studs per sample; the right foot stays put.
        parts: args.parts?.length === 0 && !args.autoContacts ? {} : { LeftFoot: [frame * 0.04, 0.1, 0], RightFoot: [1, 0.1, 0], Head: [0, 4.5, 0] },
      }));
      return {
        item: 'game.Workspace.Idol',
        fps: 10,
        lastKeyframe: 19,
        facing: FACING,
        viewport: VIEWPORT,
        partNames: ['Head', 'LeftFoot', 'RightFoot'],
        contactParts: args.contactParts ?? (args.autoContacts ? ['LeftFoot', 'RightFoot'] : []),
        frames,
      };
    }
    if (name === 'view_reveal') return { hidden: blockers, terrainInTheWay: false, settled: true };
    if (name === 'distance') {
      // A fist closing on a head 1.2 studs wide, passing through its front face on frame 20.
      const fixed = (n) => Number(n.toFixed(3));
      const samples = args.frames.map((frame) => [frame, fixed(2 - frame * 0.1), fixed(1.4 - frame * 0.1), 0, 0, fixed(frame * 0.1 - 2)]);
      return { fps: 10, from: 'Workspace.Idol.RightHand', to: 'Workspace.Enemy.Head', toSize: [1.2, 1.2, 1.2], samples };
    }
    if (name === 'view_pose') {
      return { min: [-1, 0, -0.5], max: [1, 5, 0.5], facing: FACING, viewport: VIEWPORT, frame: currentFrame, parts: { Mic: [0, -0.2, -0.8] } };
    }
    if (name === 'solve_reach') return { reached: true, distanceToTarget: 0.01, joints: [] };
    if (name === 'status') return studioStatus;
    if (name === 'trail') {
      // The head rises one stud per frame for five frames, then holds still.
      const samples = args.frames.map((frame) => [frame, 0, Math.min(frame, 5), 0, 500, 250 - Math.min(frame, 5) * 10, true]);
      return { fps: 10, viewport: VIEWPORT, parts: ['Head'], tracks: { Head: samples } };
    }
    return true;
  };

  const captureWindow = async (options = {}) => {
    captureCalls.push(options);
    if (options.findColor) return { ok: true, bounds: markerBounds, windowWidth: 1900, windowHeight: 1000 };
    if (options.restoreIfMinimized) return { ok: true, restored: true };
    const queued = captureErrors.shift();
    if (queued) {
      const error = new Error(`capture failed: ${queued}`);
      error.kind = queued;
      throw error;
    }
    writeFileSync(options.outFile, 'jpeg-bytes');
    return { ok: true, width: 1250, height: 625 };
  };

  const composeSheet = async (options) => {
    sheetCalls.push(options);
    assert.ok(options.cells.every((cell) => existsSync(cell.file)), 'cells must exist when the sheet is composed');
    writeFileSync(options.outFile, 'sheet-bytes');
    return { ok: true, width: 1500, height: 700 };
  };

  const bridge = { status: async () => ({ pluginConnected: true }), exec: async () => ({ ok: true, values: [42] }) };
  const annotateImage = async (options) => {
    annotateCalls.push(options);
    assert.ok(existsSync(options.file), 'the image must exist when it is annotated');
    return { ok: true };
  };

  const deps = { bridge, runLuau, captureWindow, composeSheet, annotateImage };
  return { luauCalls, captureCalls, sheetCalls, annotateCalls, deps, tools: createTools(deps) };
}

const names = (calls) => calls.map((call) => call.name);
const lastOf = (calls, name) => calls.filter((call) => call.name === name).at(-1);

test('screenshot runs inside a view session, calibrates once, and crops to the marker region', async () => {
  const h = createHarness();

  const [image, details] = await h.tools.call('moon_screenshot', {});
  assert.equal(Buffer.from(image.data, 'base64').toString(), 'jpeg-bytes');
  assert.deepEqual(JSON.parse(details.text).image, { width: 1250, height: 625 });
  assert.deepEqual(names(h.luauCalls), ['view_begin', 'view_step', 'calibrate_begin', 'calibrate_end', 'view_end']);
  assert.equal(h.luauCalls[0].args.hideUi, true);

  const shot = h.captureCalls.at(-1);
  assert.deepEqual(shot.crop, { x: 10, y: 20, width: 1250, height: 625 });
  assert.equal(shot.expectWindow, '1900x1000');
  assert.equal(shot.maxWidth, 1280);
  assert.ok(!existsSync(shot.outFile), 'temporary image must be removed');

  await h.tools.call('moon_screenshot', {});
  assert.equal(h.captureCalls.filter((call) => call.findColor).length, 1, 'second shot must not recalibrate');
});

test('screenshot moves the timeline and camera, reports the frame, and ends the session on failure', async () => {
  const h = createHarness({ captureErrors: ['print_failed'] });
  const camera = { position: [0, 10, 0], look_at: [0, 0, 5], fov: 40 };

  await assert.rejects(h.tools.call('moon_screenshot', { frame: 10, camera }), /print_failed/);
  const step = lastOf(h.luauCalls, 'view_step');
  assert.equal(step.args.frame, 10);
  assert.deepEqual(step.args.camera, { position: [0, 10, 0], lookAt: [0, 0, 5], fov: 40 });
  assert.deepEqual(h.luauCalls.at(-1), { name: 'view_end', args: { restoreCamera: true, restoreFrame: true } });

  const ok = createHarness();
  const [, details] = await ok.tools.call('moon_screenshot', { frame: 10, restore: false, hide_ui: false });
  const parsed = JSON.parse(details.text);
  assert.equal(parsed.frame, 10);
  assert.equal(parsed.timeSeconds, 1);
  assert.equal(parsed.subtitle, 'Hello');
  assert.equal(ok.luauCalls[0].args.hideUi, false);
  assert.deepEqual(ok.luauCalls.at(-1).args, { restoreCamera: false, restoreFrame: false });
});

test('screenshot recalibrates once when the window size changed', async () => {
  const h = createHarness({ captureErrors: ['window_changed'] });
  await h.tools.call('moon_screenshot', {});
  assert.equal(h.captureCalls.filter((call) => call.findColor).length, 2);

  const twice = createHarness({ captureErrors: ['window_changed', 'window_changed'] });
  await assert.rejects(twice.tools.call('moon_screenshot', {}), /window_changed/);
});

test('screenshot restores a minimized Studio window, retries, and says so', async () => {
  const h = createHarness({ captureErrors: ['minimized'] });
  const [, details] = await h.tools.call('moon_screenshot', {});
  assert.equal(h.captureCalls.filter((call) => call.restoreIfMinimized).length, 1);
  assert.match(JSON.parse(details.text).notes[0], /minimized/);
});

test('screenshot warns when the viewport did not redraw in time', async () => {
  const h = createHarness({ settled: false });
  const [, details] = await h.tools.call('moon_screenshot', {});
  assert.match(JSON.parse(details.text).notes[0], /did not redraw/);
});

test('screenshot rejects a marker region that does not match the viewport shape', async () => {
  const h = createHarness({ markerBounds: { x: 0, y: 0, width: 400, height: 400 } });
  await assert.rejects(h.tools.call('moon_screenshot', {}), /calibration mismatch/);
  assert.deepEqual(names(h.luauCalls).slice(-2), ['calibrate_end', 'view_end'], 'marker and session must be cleaned up');
});

test('tools validate their arguments before touching Studio', async () => {
  const h = createHarness();
  const invalid = [
    ['moon_screenshot', { camera: { position: [0, 1] } }],
    ['moon_screenshot', { camera: { position: [0, 1, Number.NaN] } }],
    ['moon_screenshot', { camera: { position: [0, 0, 0], look_at: [0, 0, 0] } }],
    ['moon_screenshot', { camera: { position: [0, 0, 0], look_at: [1, 0, 0], rotation: [0, 0, 0] } }],
    ['moon_screenshot', { camera: { position: [0, 0, 0], fov: 500 } }],
    ['moon_screenshot', { max_width: 10 }],
    ['moon_screenshot', { frame: -1 }],
    ['moon_screenshot', { frame: 1.5 }],
    ['moon_storyboard', { frames: [] }],
    ['moon_storyboard', { frames: [1, 'x'] }],
    ['moon_storyboard', { columns: 0 }],
    ['moon_camera_path', { from: 10, to: 5 }],
  ];
  for (const [tool, args] of invalid) {
    await assert.rejects(h.tools.call(tool, args), undefined, `${tool} ${JSON.stringify(args)}`);
  }
  assert.equal(h.luauCalls.length, 0);
});

test('storyboard picks frames from detected shots, labels cells, and cleans up', async () => {
  const h = createHarness();
  const [image, details] = await h.tools.call('moon_storyboard', {});
  assert.equal(Buffer.from(image.data, 'base64').toString(), 'sheet-bytes');

  const parsed = JSON.parse(details.text);
  assert.deepEqual(parsed.frames.map((entry) => entry.frame), [0, 2, 5, 7, 9, 10, 13, 16, 19]);
  assert.deepEqual(parsed.frames.map((entry) => entry.shot), [1, 1, 1, 1, 1, 2, 2, 2, 2]);

  const sheet = h.sheetCalls[0];
  assert.equal(sheet.columns, 3);
  assert.equal(sheet.cells[5].label, 'f10  1s  shot 2  "Hello"');
  assert.ok(sheet.cells.every((cell) => !existsSync(cell.file)), 'cell images must be removed');
  assert.ok(!existsSync(sheet.outFile), 'sheet image must be removed');
  assert.equal(h.captureCalls.at(-1).maxWidth, 480);

  assert.equal(names(h.luauCalls).filter((name) => name === 'view_begin').length, 1, 'one session for all frames');
  assert.deepEqual(h.luauCalls.at(-1), { name: 'view_end', args: { restoreCamera: true, restoreFrame: true } });
});

test('storyboard honors explicit frames and falls back to even spacing without a camera', async () => {
  const explicit = createHarness();
  const [, details] = await explicit.tools.call('moon_storyboard', { frames: [2, 12], columns: 4, cell_width: 320 });
  assert.deepEqual(JSON.parse(details.text).frames.map((entry) => entry.frame), [2, 12]);
  assert.equal(explicit.sheetCalls[0].columns, 2, 'columns shrink to the number of cells');

  const noCamera = createHarness({ hasCamera: false });
  const [, spaced] = await noCamera.tools.call('moon_storyboard', { count: 3 });
  assert.deepEqual(JSON.parse(spaced.text).frames.map((entry) => entry.frame), [0, 10, 19]);
  assert.ok(!names(noCamera.luauCalls).includes('camera_path'));
});

test('storyboard ends the view session and removes images when a capture fails midway', async () => {
  const h = createHarness({ captureErrors: [undefined, 'print_failed'] });
  await assert.rejects(h.tools.call('moon_storyboard', { frames: [1, 2, 3] }), /print_failed/);
  assert.equal(h.luauCalls.at(-1).name, 'view_end');
  assert.equal(h.sheetCalls.length, 0);
  assert.ok(h.captureCalls.filter((call) => call.outFile).every((call) => !existsSync(call.outFile)));
});

test('camera path reports cuts, shots, and thinned samples that keep shot boundaries', async () => {
  const h = createHarness();
  const [content] = await h.tools.call('moon_camera_path', {});
  const parsed = JSON.parse(content.text);
  assert.deepEqual(parsed.cuts, [10]);
  assert.deepEqual(parsed.shots.map((shot) => [shot.startFrame, shot.endFrame, shot.movement]), [
    [0, 9, ['static']],
    [10, 19, ['static']],
  ]);
  assert.equal(parsed.samples, undefined, 'path samples are opt-in');

  const [detailed] = await h.tools.call('moon_camera_path', { samples: true });
  const withSamples = JSON.parse(detailed.text);
  assert.equal(withSamples.sampleColumns[0], 'frame');
  const frames = withSamples.samples.map((sample) => sample[0]);
  for (const boundary of [0, 9, 10, 19]) assert.ok(frames.includes(boundary));
});

test('scene passes the values flag through', async () => {
  const h = createHarness();
  const [content] = await h.tools.call('moon_scene', { values: true });
  assert.equal(JSON.parse(content.text).valuesRequested, true);
});

test('status reports a disconnected plugin without calling Studio', async () => {
  const h = createHarness();
  const tools = createTools({ ...h.deps, bridge: { status: async () => ({ pluginConnected: false }) } });
  const [content] = await tools.call('moon_status', {});
  const report = JSON.parse(content.text);
  assert.equal(report.connected, false);
  assert.match(report.hint, /not installed/);
  assert.equal(h.luauCalls.length, 0);

  const hintFor = async (plugin) => {
    const offline = createTools({ ...h.deps, plugin, bridge: { status: async () => ({ pluginConnected: false }) } });
    return JSON.parse((await offline.call('moon_status', {}))[0].text).hint;
  };
  assert.match(await hintFor({ state: 'installed', target: 'X:/Plugins/MoonBridge.rbxmx' }), /installed just now.*Restart Roblox Studio/);
  assert.match(await hintFor({ state: 'current' }), /not answering/);
});

test('status passes on a healthy session without notes', async () => {
  const h = createHarness();
  const [content] = await h.tools.call('moon_status', {});
  const report = JSON.parse(content.text);
  assert.equal(report.connected, true);
  assert.deepEqual(report.moonAnimator, { version: 36000, windowVisible: false });
  assert.equal(report.notes, undefined);
  assert.ok(!content.text.includes('\n'), 'results are compact JSON');
});

test('status summarizes items, flags stale ones, and notices an outdated Studio plugin', async () => {
  const studioStatus = {
    hasMoonGlobal: true,
    hasMainWindow: true,
    hasLayerSystem: true,
    moonVersion: 36000,
    windowVisible: true,
    hasDoCompositeAction: true,
    camera: { cframe: { t: 'CFrame', p: [1, 2, 3], r: [0, 90, 0] }, fov: 70 },
    file: { name: 'Cutscene1', fps: 60, length: 300, frame: 0 },
    items: [
      { index: 1, itemType: 'Camera', path: 'game.Workspace.CurrentCamera', hasMarkerTrack: false, properties: { CFrame: 8 } },
      { index: 2, itemType: 'Rig', path: 'game.Workspace.Idol', hasMarkerTrack: false, properties: [], rig: { joints: 17, keyedJoints: 15 }, stale: 'replaced' },
    ],
  };
  const h = createHarness({ studioStatus });
  const tools = createTools({ ...h.deps, plugin: { version: '0.2.0', state: 'current' }, bridge: { status: async () => ({ pluginConnected: true, pluginVersion: '0.1.0' }) } });
  const report = JSON.parse((await tools.call('moon_status', {}))[0].text);

  assert.deepEqual(report.camera, { position: [1, 2, 3], rotation: [0, 90, 0], fov: 70 });
  assert.deepEqual(report.items, [
    { index: 1, type: 'Camera', path: 'game.Workspace.CurrentCamera', keyframes: { CFrame: 8 } },
    { index: 2, type: 'Rig', path: 'game.Workspace.Idol', stale: 'replaced', rig: { joints: 17, keyedJoints: 15 } },
  ]);
  assert.equal(report.hasDoCompositeAction, undefined);
  assert.equal(report.notes.length, 2);
  assert.match(report.notes[0], /Stale items \(game\.Workspace\.Idol\).*moon_open_file/);
  assert.match(report.notes[1], /running MoonBridge 0\.1\.0; version 0\.2\.0 is installed/);
});

test('status says when Moon Animator 2 is missing, not open, or an untested version', async () => {
  const notesFor = async (studioStatus) => {
    const [content] = await createHarness({ studioStatus }).tools.call('moon_status', {});
    return JSON.parse(content.text).notes;
  };

  const missing = await notesFor({ hasMoonGlobal: false });
  assert.equal(missing.length, 1);
  assert.match(missing[0], /Creator Store/);

  const closed = await notesFor({ hasMoonGlobal: true, hasMainWindow: false, moonVersion: 36000 });
  assert.match(closed[0], /Plugins tab/);

  const newer = await notesFor({ hasMoonGlobal: true, hasMainWindow: true, hasLayerSystem: true, moonVersion: 37000 });
  assert.match(newer[0], /tested with Moon Animator 2 version 36000.*37000/);
});

test('exec tool exists only when explicitly allowed', async () => {
  const h = createHarness();
  assert.ok(!h.tools.list().some((tool) => tool.name === 'moon_exec_luau'));
  await assert.rejects(h.tools.call('moon_exec_luau', { code: 'return 1' }), /unknown tool/);

  const allowed = createTools({ ...h.deps, allowExec: true });
  const [content] = await allowed.call('moon_exec_luau', { code: 'return 42' });
  assert.deepEqual(JSON.parse(content.text), [42]);
});

test('withArgs picks a long-string level that the JSON payload cannot close', () => {
  assert.equal(
    withArgs('return ARGS', { a: 1 }),
    'local ARGS = game:GetService("HttpService"):JSONDecode([=[{"a":1}]=]) return ARGS',
  );
  assert.match(withArgs('return ARGS', { text: 'x]=]y' }), /JSONDecode\(\[==\[.*\]==\]\)/);
});

test('parseResult decodes JSON results and turns MOON errors into clean messages', () => {
  assert.deepEqual(parseResult('x', { ok: true, values: ['{"a":[1,2]}'] }), { a: [1, 2] });
  assert.equal(parseResult('x', { ok: true, values: [true] }), true);
  assert.equal(parseResult('x', { ok: true, values: ['plain text'] }), 'plain text');
  assert.throws(
    () => parseResult('scene', { ok: false, error: 'MoonBridgeExec:12: MOON: no Moon Animator file is open\nstack traceback' }),
    { message: 'no Moon Animator file is open' },
  );
  assert.throws(() => parseResult('scene', { ok: false, error: 'attempt to index nil' }), {
    message: 'scene: attempt to index nil',
  });
});

test('focus frames the item, crops to it, and hides Moon Animator effects', async () => {
  const h = createHarness();
  const [, details] = await h.tools.call('moon_screenshot', { frame: 10, focus: { item: 'Idol', view: 'front' } });

  const sample = lastOf(h.luauCalls, 'sample');
  assert.deepEqual(sample.args, { item: 'Idol', frames: [10], parts: [] });
  assert.equal(lastOf(h.luauCalls, 'view_begin').args.hideEffects, true);

  const step = lastOf(h.luauCalls, 'view_step');
  assert.deepEqual(step.args.camera.lookAt, [0, 2.5, 0]);
  assert.ok(step.args.camera.position[2] < -5, 'camera is in front of a subject facing -Z');
  assert.equal(step.args.camera.fov, 40);

  // The 1250x625 viewport region is cropped to the 3:4 minimum around its center.
  const shot = h.captureCalls.at(-1);
  assert.deepEqual(shot.crop, { x: 10 + Math.round((1250 - 469) / 2), y: 20, width: 469, height: 625 });
  assert.equal(JSON.parse(details.text).frame, 10);

  // The line of sight is cleared after the camera is placed and before the capture.
  const order = names(h.luauCalls);
  assert.ok(order.indexOf('view_reveal') > order.indexOf('view_step'));
  assert.deepEqual(lastOf(h.luauCalls, 'view_reveal').args, { item: 'Idol', settleFrames: 3 });
  assert.equal(JSON.parse(details.text).notes, undefined);

  const blocked = createHarness({ blockers: ['Workspace.Wall', 'Workspace.Tree.Trunk'] });
  const [, blockedDetails] = await blocked.tools.call('moon_screenshot', { focus: { item: 'Idol' } });
  assert.match(JSON.parse(blockedDetails.text).notes[0], /Hidden for this image.*Workspace\.Wall, Workspace\.Tree\.Trunk/);

  const plain = createHarness();
  await plain.tools.call('moon_screenshot', { frame: 10 });
  assert.ok(!names(plain.luauCalls).includes('view_reveal'), 'the cutscene camera view hides nothing');

  await assert.rejects(
    h.tools.call('moon_screenshot', { focus: { item: 'Idol' }, camera: { position: [0, 0, 0] } }),
    /either camera or focus/,
  );
  await assert.rejects(h.tools.call('moon_screenshot', { focus: { item: 'Idol', view: 'below' } }), /focus.view/);
});

test('storyboard focus measures all frames once and keeps one camera', async () => {
  const h = createHarness();
  await h.tools.call('moon_storyboard', { frames: [2, 12, 18], focus: { item: 'Idol', view: 'right' } });
  assert.deepEqual(lastOf(h.luauCalls, 'sample').args.frames, [2, 12, 18]);
  const cameras = h.luauCalls.filter((call) => call.name === 'view_step').map((call) => JSON.stringify(call.args.camera));
  assert.equal(new Set(cameras).size, 1);
});

test('pose preview poses inside a view session, shoots each view, and restores', async () => {
  const h = createHarness();
  const joints = [{ joint: 'RightUpperArm', rotation: [40, 60, 0] }];
  const [image, details] = await h.tools.call('moon_preview_pose', { item: 'Idol', frame: 10, joints, parts: ['Mic'], relative_to: 'Head' });
  assert.equal(Buffer.from(image.data, 'base64').toString(), 'sheet-bytes');

  const order = names(h.luauCalls).filter((name) => name.startsWith('view_'));
  assert.deepEqual(order, ['view_begin', 'view_step', 'view_pose', 'view_step', 'view_reveal', 'view_step', 'view_reveal', 'view_end']);
  assert.deepEqual(h.luauCalls.find((call) => call.name === 'view_step').args, { frame: 10, settleFrames: 0 });
  assert.deepEqual(lastOf(h.luauCalls, 'view_pose').args, { item: 'Idol', joints, parts: ['Mic'], relativeTo: 'Head', relativeToItem: undefined });
  assert.deepEqual(h.luauCalls.at(-1), { name: 'view_end', args: { restoreCamera: true, restoreFrame: true } });

  const parsed = JSON.parse(details.text);
  assert.deepEqual(parsed.views, ['front', 'right']);
  assert.deepEqual(parsed.positions, { Mic: [0, -0.2, -0.8] });
  assert.equal(parsed.positionsRelativeTo, 'Head');
  assert.deepEqual(h.sheetCalls[0].cells.map((cell) => cell.label), ['front', 'right']);

  const [, bare] = await h.tools.call('moon_preview_pose', { item: 'Idol', joints });
  assert.equal(JSON.parse(bare.text).positions, undefined, 'positions are reported only for requested parts');
  assert.deepEqual(lastOf(h.luauCalls, 'view_pose').args.parts, []);

  await assert.rejects(h.tools.call('moon_preview_pose', { item: 'Idol', joints: [] }), /joints/);
  await assert.rejects(h.tools.call('moon_preview_pose', { item: 'Idol', joints, views: ['under'] }), /views/);
});

test('sample builds its frame list and reports foot sliding in world space only', async () => {
  const h = createHarness();
  const [content] = await h.tools.call('moon_sample', { item: 'Idol', from: 0, to: 19, step: 5, parts: ['LeftFoot'] });
  assert.deepEqual(lastOf(h.luauCalls, 'sample').args.frames, [0, 5, 10, 15, 19]);

  assert.deepEqual(lastOf(h.luauCalls, 'sample').args.parts, ['LeftFoot']);
  assert.equal(lastOf(h.luauCalls, 'sample').args.autoContacts, true);

  const parsed = JSON.parse(content.text);
  assert.deepEqual(parsed.frames, [0, 5, 10, 15, 19]);
  assert.deepEqual(Object.keys(parsed.positions), ['LeftFoot']);
  assert.deepEqual(parsed.positions.LeftFoot[2], [0.4, 0.1, 0]);
  const left = parsed.contacts.find((entry) => entry.part === 'LeftFoot');
  const right = parsed.contacts.find((entry) => entry.part === 'RightFoot');
  assert.equal(left.slideStuds, 0.76);
  assert.equal(right.slideStuds, 0);

  // Without `parts` there are no positions, only the names to ask for.
  const [bare] = await h.tools.call('moon_sample', { item: 'Idol', frames: [3, 8] });
  const summary = JSON.parse(bare.text);
  assert.equal(summary.positions, undefined);
  assert.deepEqual(summary.availableParts, ['Head', 'LeftFoot', 'RightFoot']);
  assert.equal(summary.contacts.length, 2);

  const [relative] = await h.tools.call('moon_sample', { item: 'Idol', frames: [3], parts: ['Head'], relative_to: 'Head' });
  assert.equal(JSON.parse(relative.text).contacts, undefined);
  assert.equal(lastOf(h.luauCalls, 'sample').args.autoContacts, false);

  await assert.rejects(h.tools.call('moon_sample', { item: 'Idol', frames: [3], parts: Array(13).fill('Head') }), /at most 12/);
  await assert.rejects(h.tools.call('moon_sample', { item: 'Idol', from: 9, to: 2 }), /before from/);
});

test('reach solver validates its arguments and forwards them', async () => {
  const h = createHarness();
  const args = {
    item: 'Idol',
    frame: 90,
    end_part: 'Mic_2',
    relative_to: 'Head',
    target: [0, -0.2, -0.8],
    joints: [{ joint: 'RightUpperArm' }, { joint: 'RightLowerArm', axes: 'x', min: [0, 0, 0], max: [150, 0, 0] }],
  };
  const [content] = await h.tools.call('moon_solve_reach', args);
  assert.equal(JSON.parse(content.text).reached, true);
  assert.deepEqual(lastOf(h.luauCalls, 'solve_reach').args, {
    item: 'Idol',
    frame: 90,
    endPart: 'Mic_2',
    target: [0, -0.2, -0.8],
    relativeTo: 'Head',
    relativeToItem: undefined,
    tolerance: undefined,
    joints: args.joints,
  });

  // A target on another item, such as an opponent's head.
  await h.tools.call('moon_solve_reach', { ...args, relative_to_item: 'Enemy' });
  assert.equal(lastOf(h.luauCalls, 'solve_reach').args.relativeToItem, 'Enemy');

  for (const bad of [{ target: [0, 1] }, { joints: [] }, { joints: [{ joint: 'A', axes: 'xq' }] }, { end_part: '' }]) {
    await assert.rejects(h.tools.call('moon_solve_reach', { ...args, ...bad }));
  }
});

test('motion trail samples the range, draws one trail per part, and reports speed and holds', async () => {
  const h = createHarness();
  const [image, details] = await h.tools.call('moon_motion_trail', { item: 'Idol', from: 0, to: 10, step: 1 });
  assert.equal(image.type, 'image');

  const trail = lastOf(h.luauCalls, 'trail');
  assert.deepEqual(trail.args.frames, [0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10]);
  assert.equal(trail.args.camera.fov, 40);

  const report = JSON.parse(details.text);
  assert.equal(report.poseShownAtFrame, 10);
  assert.deepEqual(report.range, { from: 0, to: 10, step: 1, fps: 10 });
  const [head] = report.parts;
  assert.equal(head.part, 'Head');
  assert.equal(head.speeds, undefined, 'per-interval speeds are opt-in');
  assert.equal(head.pathStuds, 5);
  assert.equal(head.peakSpeed, 10);
  assert.deepEqual(head.holds, [{ fromFrame: 5, toFrame: 10 }]);

  const [annotation] = h.annotateCalls;
  const count = (type) => annotation.shapes.filter((shape) => shape.type === type).length;
  assert.equal(count('polyline'), 1);
  assert.equal(count('dot'), 11);
  assert.equal(names(h.luauCalls).at(-1), 'view_end');
  assert.ok(!existsSync(annotation.file), 'the temporary image must be removed');
});

test('motion trail defaults the range to the last keyframe and rejects bad ranges', async () => {
  const h = createHarness();
  await h.tools.call('moon_motion_trail', { item: 1 });
  const frames = lastOf(h.luauCalls, 'trail').args.frames;
  assert.equal(frames[0], 0);
  assert.equal(frames.at(-1), 19);

  const [, detailed] = await h.tools.call('moon_motion_trail', { item: 1, from: 0, to: 4, step: 2, detail: true });
  assert.equal(JSON.parse(detailed.text).parts[0].speeds.length, 2);

  await assert.rejects(h.tools.call('moon_motion_trail', { item: 1, from: 10, to: 10 }), /to must be after from/);
  await assert.rejects(h.tools.call('moon_motion_trail', { item: 1, from: 0, to: 1000, step: 1 }), /larger step/);
  await assert.rejects(h.tools.call('moon_motion_trail', { item: 1, parts: [] }), /1 to 6 part names/);
  await assert.rejects(h.tools.call('moon_motion_trail', {}), /item must be/);
});

test('measure samples a pair of points and reports the closest approach and time inside', async () => {
  const h = createHarness();
  const from = { item: 'Idol', part: 'RightHand' };
  const to = { item: 'Enemy', part: 'Head', offset: [0, 0, -0.6] };
  const [content] = await h.tools.call('moon_measure', { from, to, from_frame: 0, to_frame: 19, step: 5 });
  assert.deepEqual(lastOf(h.luauCalls, 'distance').args, { from: { ...from, offset: undefined }, to, frames: [0, 5, 10, 15, 19] });

  const report = JSON.parse(content.text);
  assert.deepEqual(report.frames, [0, 5, 10, 15, 19]);
  assert.deepEqual(report.distance, [2, 1.5, 1, 0.5, 0.1]);
  assert.deepEqual(report.gap, [1.4, 0.9, 0.4, -0.1, -0.5]);
  assert.deepEqual(report.closest, { frame: 19, distance: 0.1 });
  assert.deepEqual(report.nearestSurface, { frame: 19, gap: -0.5 });
  assert.deepEqual(report.inside, [{ fromFrame: 15, toFrame: 19 }]);
  assert.deepEqual(report.fromInToSpace[0], [0, 0, -2]);

  await assert.rejects(h.tools.call('moon_measure', { from, to: { item: 'Enemy' } }), /to\.part/);
  await assert.rejects(h.tools.call('moon_measure', { from: { part: 'RightHand' }, to }), /from\.item/);
  await assert.rejects(h.tools.call('moon_measure', { from, to, frames: [] }), /frames/);
});

test('distance summary handles bones, which have no surface, and separate visits inside', () => {
  const bones = summarizeDistance({ fps: 60, from: 'a', to: 'b', samples: [[0, 3, false, 0, 0, 3], [1, 2, false, 0, 0, 2]] });
  assert.equal(bones.gap, undefined);
  assert.equal(bones.inside, undefined);
  assert.deepEqual(bones.closest, { frame: 1, distance: 2 });

  const twice = summarizeDistance({
    fps: 60,
    from: 'a',
    to: 'b',
    toSize: [1, 1, 1],
    samples: [[0, 1, 0.5, 0, 0, 1], [1, 0.4, -0.1, 0, 0, 0.4], [2, 1, 0.5, 0, 0, 1], [3, 0.3, -0.2, 0, 0, 0.3], [4, 0.2, -0.3, 0, 0, 0.2]],
  });
  assert.deepEqual(twice.inside, [{ fromFrame: 1, toFrame: 1 }, { fromFrame: 3, toFrame: 4 }]);
});

test('views can keep other items in frame and positions can be read against another item', async () => {
  const h = createHarness();
  await h.tools.call('moon_screenshot', { frame: 10, focus: { item: 'Idol', with: ['Enemy'], view: 'right' } });
  const sampled = h.luauCalls.filter((call) => call.name === 'sample').map((call) => call.args.item);
  assert.deepEqual(sampled, ['Idol', 'Enemy']);
  assert.equal(lastOf(h.luauCalls, 'view_reveal').args.item, 'Idol');
  await assert.rejects(h.tools.call('moon_screenshot', { focus: { item: 'Idol', with: 'Enemy' } }), /focus\.with/);

  const joints = [{ joint: 'RightUpperArm', rotation: [80, 0, 0] }];
  const [, details] = await h.tools.call('moon_preview_pose', {
    item: 'Idol',
    joints,
    parts: ['Mic'],
    relative_to: 'Head',
    relative_to_item: 'Enemy',
    with: ['Enemy'],
    views: ['right'],
  });
  assert.equal(lastOf(h.luauCalls, 'view_pose').args.relativeToItem, 'Enemy');
  assert.deepEqual(lastOf(h.luauCalls, 'sample').args, { item: 'Enemy', parts: [] });
  assert.equal(JSON.parse(details.text).positionsRelativeTo, 'Enemy.Head');

  const [sample] = await h.tools.call('moon_sample', { item: 'Idol', frames: [3], parts: ['Head'], relative_to: 'Head', relative_to_item: 'Enemy' });
  assert.equal(lastOf(h.luauCalls, 'sample').args.relativeToItem, 'Enemy');
  assert.equal(JSON.parse(sample.text).positionsRelativeTo, 'Enemy.Head');
});
