// MCP tool definitions. Dependencies are injected so the flows can be tested
// without Studio: `runLuau(name, args)`, `captureWindow(options)`,
// `composeSheet(options)` and `bridge` (status/exec).

import { mkdirSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createEditTools } from './edit-tools.mjs';
import { analyzeContacts, frameSubject, motionStats, unionBounds, VIEWS } from './framing.mjs';
import { analyzeCameraPath, evenlySpaced, pickStoryboardFrames } from './shots.mjs';

const MARKER_COLOR = [255, 0, 255];
const SETTLE_FRAMES = 3;
const STALE_NOTE = 'The viewport did not redraw in time; the image may not show the requested state.';
const ASPECT_TOLERANCE = 0.02;
const MAX_STORYBOARD_FRAMES = 24;
const MAX_PATH_SAMPLES = 60;

const CAMERA_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  required: ['position'],
  description:
    'Custom camera: position plus look_at (world point) or rotation (XYZ degrees), optional fov.',
  properties: {
    position: { type: 'array', items: { type: 'number' }, minItems: 3, maxItems: 3 },
    look_at: { type: 'array', items: { type: 'number' }, minItems: 3, maxItems: 3 },
    rotation: { type: 'array', items: { type: 'number' }, minItems: 3, maxItems: 3 },
    fov: { type: 'number', minimum: 1, maximum: 120 },
  },
};

const FOCUS_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  required: ['item'],
  description:
    'Frame an item automatically: the camera goes to the named side of the item (relative to the way it faces) ' +
    'at the distance that fills the image. Screen effects and anything standing between camera and item are hidden.',
  properties: {
    item: { type: ['string', 'integer'], description: 'Item name, path or index.' },
    with: { type: 'array', items: { type: ['string', 'integer'] }, maxItems: 4, description: 'Other items to keep in frame, e.g. an opponent.' },
    view: { type: 'string', enum: VIEWS, default: 'three_quarter' },
    margin: { type: 'number', minimum: 1, maximum: 3, default: 1.15 },
  },
};

// Results are read by a model, so they are sent as compact JSON: indentation
// roughly doubles the size of the number-heavy results these tools return.
function text(value) {
  return { type: 'text', text: typeof value === 'string' ? value : JSON.stringify(value) };
}

// The plugin reports every flag it probed; keep what an agent acts on.
function summarizeStudio(studio) {
  const summary = {
    place: studio.place,
    mode: studio.studioMode,
    moonAnimator: studio.hasMoonGlobal ? { version: studio.moonVersion, windowVisible: studio.windowVisible === true } : null,
    viewport: studio.viewport && { width: Math.round(studio.viewport.width), height: Math.round(studio.viewport.height) },
    file: studio.file ?? null,
  };
  if (studio.camera?.cframe) {
    summary.camera = { position: studio.camera.cframe.p, rotation: studio.camera.cframe.r, fov: studio.camera.fov };
  }
  if (studio.file && Array.isArray(studio.items)) {
    summary.items = studio.items.map((item) => {
      const entry = { index: item.index, type: item.itemType, path: item.path };
      if (item.stale) entry.stale = item.stale;
      if (item.properties && !Array.isArray(item.properties)) entry.keyframes = item.properties;
      if (item.rig) entry.rig = item.rig;
      if (item.hasMarkerTrack) entry.markers = true;
      return entry;
    });
  }
  return summary;
}

function vector3(value, name) {
  if (!Array.isArray(value) || value.length !== 3 || !value.every((n) => typeof n === 'number' && Number.isFinite(n))) {
    throw new Error(`${name} must be an array of three finite numbers`);
  }
  return value;
}

function integer(value, name, min, max, fallback) {
  if (value === undefined) return fallback;
  if (!Number.isInteger(value) || value < min || value > max) {
    throw new Error(`${name} must be an integer between ${min} and ${max}`);
  }
  return value;
}

function validateFocus(focus, camera) {
  if (focus === undefined) return undefined;
  if (camera !== undefined) throw new Error('give either camera or focus, not both');
  if (typeof focus !== 'object' || focus === null) throw new Error('focus must be an object');
  if (typeof focus.item !== 'string' && !Number.isInteger(focus.item)) {
    throw new Error('focus.item must be an item name, path or index');
  }
  const view = focus.view ?? 'three_quarter';
  if (!VIEWS.includes(view)) throw new Error(`focus.view must be one of: ${VIEWS.join(', ')}`);
  const margin = focus.margin ?? 1.15;
  if (typeof margin !== 'number' || margin < 1 || margin > 3) throw new Error('focus.margin must be between 1 and 3');
  return { item: focus.item, view, margin, with: itemList(focus.with, 'focus.with') };
}

// Extra items to keep in frame next to the main one.
function itemList(value, name) {
  if (value === undefined) return [];
  if (!Array.isArray(value) || value.length > 4 || !value.every((item) => typeof item === 'string' || Number.isInteger(item))) {
    throw new Error(`${name} must list at most 4 item names, paths or indexes`);
  }
  return value;
}

// A point for moon_measure: { item, part, offset? }.
function pointSpec(value, name) {
  if (typeof value !== 'object' || value === null) throw new Error(`${name} must be an object with item and part`);
  if (typeof value.item !== 'string' && !Number.isInteger(value.item)) throw new Error(`${name}.item must be an item name, path or index`);
  if (typeof value.part !== 'string' || value.part === '') throw new Error(`${name}.part must be a part or bone name`);
  if (value.offset !== undefined) vector3(value.offset, `${name}.offset`);
  return { item: value.item, part: value.part, offset: value.offset };
}

// Frames to visit: the explicit list, or from..to in steps (about 40 by default).
async function frameList(args, runLuau, max) {
  if (args.frames !== undefined) {
    if (!Array.isArray(args.frames) || args.frames.length < 1 || args.frames.length > max) throw new Error(`frames must list 1 to ${max} frames`);
    args.frames.forEach((value, index) => integer(value, `frames[${index}]`, 0, 1_000_000));
    return args.frames;
  }
  const timeline = await runLuau('timeline');
  const from = integer(args.from, 'from', 0, 1_000_000, 0);
  const to = integer(args.to, 'to', 0, 1_000_000, timeline.lastKeyframe);
  if (to < from) throw new Error('to must not be before from');
  const step = integer(args.step, 'step', 1, 1_000_000, Math.max(1, Math.ceil((to - from) / 40)));
  const frames = [];
  for (let frame = from; frame <= to; frame += step) frames.push(frame);
  if (frames.at(-1) !== to) frames.push(to);
  if (frames.length > max) throw new Error(`that range and step give more than ${max} samples; use a larger step`);
  return frames;
}

function validateCamera(camera) {
  if (camera === undefined) return undefined;
  if (typeof camera !== 'object' || camera === null) throw new Error('camera must be an object');
  const result = { position: vector3(camera.position, 'camera.position') };
  if (camera.look_at !== undefined && camera.rotation !== undefined) {
    throw new Error('camera accepts either look_at or rotation, not both');
  }
  if (camera.look_at !== undefined) {
    result.lookAt = vector3(camera.look_at, 'camera.look_at');
    if (result.lookAt.every((n, i) => n === result.position[i])) {
      throw new Error('camera.look_at must differ from camera.position');
    }
  }
  if (camera.rotation !== undefined) result.rotation = vector3(camera.rotation, 'camera.rotation');
  if (camera.fov !== undefined) {
    if (typeof camera.fov !== 'number' || camera.fov < 1 || camera.fov > 120) {
      throw new Error('camera.fov must be a number between 1 and 120');
    }
    result.fov = camera.fov;
  }
  return result;
}

const TRAIL_COLORS = [
  [255, 90, 90],
  [90, 170, 255],
  [100, 225, 130],
  [255, 205, 70],
  [205, 120, 255],
  [255, 150, 70],
];
const MAX_TRAIL_SAMPLES = 120;
const RELATIVE_ITEM = {
  type: ['string', 'integer'],
  description: 'Item that owns the relative_to part, when it is not this item (e.g. an opponent).',
};

const POINT_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  required: ['item', 'part'],
  properties: {
    item: { type: ['string', 'integer'] },
    part: { type: 'string', description: 'Part or bone name.' },
    offset: { type: 'array', items: { type: 'number' }, minItems: 3, maxItems: 3, description: 'Shift in the part\'s local space (studs).' },
  },
};

// Turns per-frame [frame, distance, gap, x, y, z] rows into columns plus the
// moments worth acting on: the closest approach and the time spent inside.
export function summarizeDistance(measured) {
  const rows = measured.samples;
  const hasSurface = rows.some((row) => row[2] !== false);
  const result = {
    from: measured.from,
    to: measured.to,
    fps: measured.fps,
    frames: rows.map((row) => row[0]),
    distance: rows.map((row) => row[1]),
  };
  const closest = rows.reduce((best, row) => (row[1] < best[1] ? row : best));
  result.closest = { frame: closest[0], distance: closest[1] };
  if (hasSurface) {
    result.toSize = measured.toSize;
    result.gap = rows.map((row) => row[2]);
    const nearest = rows.reduce((best, row) => (row[2] < best[2] ? row : best));
    result.nearestSurface = { frame: nearest[0], gap: nearest[2] };
    // Runs of consecutive samples where the point is inside the part.
    const inside = [];
    rows.forEach((row, index) => {
      if (row[2] >= 0) return;
      if (index > 0 && rows[index - 1][2] < 0) inside.at(-1).toFrame = row[0];
      else inside.push({ fromFrame: row[0], toFrame: row[0] });
    });
    if (inside.length > 0) result.inside = inside;
  }
  result.fromInToSpace = rows.map((row) => [row[3], row[4], row[5]]);
  return result;
}

function relativeLabel(args) {
  if (args.relative_to === undefined) return 'world';
  return args.relative_to_item === undefined ? args.relative_to : `${args.relative_to_item}.${args.relative_to}`;
}
const TESTED_MOON_VERSIONS = [36000];

// `plugin` describes the Studio plugin this server ships: { version, state, target, reason }.
// `version()` reports this server's version and, when known, the latest release.
export function createTools({ bridge, runLuau, captureWindow, composeSheet, annotateImage, plugin = {}, version, allowExec = false }) {
  let calibration = null;
  let shotCounter = 0;

  function tempFile(label) {
    const dir = join(tmpdir(), 'moon-mcp');
    mkdirSync(dir, { recursive: true });
    shotCounter += 1;
    return join(dir, `${label}-${process.pid}-${Date.now()}-${shotCounter}.jpg`);
  }

  function readImage(file) {
    try {
      return readFileSync(file).toString('base64');
    } finally {
      rmSync(file, { force: true });
    }
  }

  async function calibrate(viewport) {
    let found;
    await runLuau('calibrate_begin', { color: MARKER_COLOR });
    try {
      found = await captureWindow({ findColor: MARKER_COLOR });
    } finally {
      // Also waits for the marker to leave the screen, so it cannot appear in the next capture.
      await runLuau('calibrate_end');
    }

    const { bounds } = found;
    const expected = viewport.width / viewport.height;
    const actual = bounds.width / bounds.height;
    if (Math.abs(actual - expected) / expected > ASPECT_TOLERANCE) {
      throw new Error(
        `viewport calibration mismatch: marker region ${bounds.width}x${bounds.height} does not match the ` +
          `${viewport.width}x${viewport.height} viewport shape (is something covering the Studio viewport?)`,
      );
    }
    return {
      rect: bounds,
      windowKey: `${found.windowWidth}x${found.windowHeight}`,
      viewportKey: `${viewport.width}x${viewport.height}`,
    };
  }

  // Saves an image of the 3D viewport only. Recalibrates when the viewport or window size changed.
  // `cropAspect` keeps only a centered region of that width/height ratio.
  async function captureViewport(viewport, maxWidth, outFile, cropAspect) {
    const viewportKey = `${viewport.width}x${viewport.height}`;
    for (let attempt = 0; ; attempt += 1) {
      if (!calibration || calibration.viewportKey !== viewportKey) {
        calibration = await calibrate(viewport);
      }
      let crop = calibration.rect;
      if (cropAspect && cropAspect < crop.width / crop.height) {
        const width = Math.round(crop.height * cropAspect);
        crop = { ...crop, x: crop.x + Math.round((crop.width - width) / 2), width };
      }
      try {
        return await captureWindow({ outFile, crop, expectWindow: calibration.windowKey, maxWidth });
      } catch (error) {
        if (error.kind !== 'window_changed' || attempt > 0) throw error;
        calibration = null;
      }
    }
  }

  // Hides, for this view session only, whatever stands between the camera and the item.
  async function clearView(item, notes) {
    const cleared = await runLuau('view_reveal', { item, settleFrames: SETTLE_FRAMES });
    if (!cleared.settled) notes.add(STALE_NOTE);
    if (cleared.hidden.length > 0) {
      const names = cleared.hidden.slice(0, 5).join(', ') + (cleared.hidden.length > 5 ? ', ...' : '');
      notes.add(`Hidden for this image because they stood between the camera and the item: ${names}.`);
    }
    if (cleared.terrainInTheWay) notes.add('Terrain stands between the camera and the item and cannot be hidden; try another view.');
  }

  // One view inside a session: position the timeline/camera, then capture.
  // `reveal` names an item whose line of sight is cleared first. Restores a
  // minimized Studio window once and retries.
  async function shoot(step, maxWidth, outFile, notes, cropAspect, reveal) {
    let view = await runLuau('view_step', { ...step, settleFrames: SETTLE_FRAMES });
    if (!view.settled) notes.add(STALE_NOTE);
    if (reveal !== undefined) await clearView(reveal, notes);
    try {
      const shot = await captureViewport(view.viewport, maxWidth, outFile, cropAspect);
      return { view, shot };
    } catch (error) {
      if (error.kind !== 'minimized') throw error;
      await captureWindow({ restoreIfMinimized: true });
      notes.add('The Studio window was minimized and has been restored without focus.');
      calibration = null;
      view = await runLuau('view_step', { settleFrames: SETTLE_FRAMES });
      return { view, shot: await captureViewport(view.viewport, maxWidth, outFile, cropAspect) };
    }
  }

  // Runs `work` inside a view session and always ends the session.
  async function withView({ hideUi, hideEffects = false, restore }, work) {
    await runLuau('view_begin', { hideUi, hideEffects });
    try {
      return await work();
    } finally {
      await runLuau('view_end', { restoreCamera: restore, restoreFrame: restore });
    }
  }

  // Camera and crop that frame `bounds` (min, max, facing, viewport) from the focus view.
  function framingFor(focus, bounds) {
    const framing = frameSubject({
      min: bounds.min,
      max: bounds.max,
      facing: bounds.facing,
      view: focus.view,
      margin: focus.margin,
      viewportAspect: bounds.viewport.width / bounds.viewport.height,
    });
    return { camera: framing.camera, cropAspect: framing.cropAspect };
  }

  // Measures the focused item on the given frames and frames the union, so one
  // steady camera covers the whole motion.
  async function focusFraming(focus, frames) {
    const measured = await runLuau('sample', { item: focus.item, frames, parts: [] }, 120);
    const boxes = [...measured.frames];
    for (const other of focus.with ?? []) boxes.push(...(await runLuau('sample', { item: other, frames, parts: [] }, 120)).frames);
    return framingFor(focus, { ...unionBounds(boxes), facing: measured.facing, viewport: measured.viewport });
  }

  // Maps a point in viewport coordinates onto an image captured with
  // captureViewport (which may have cropped the sides and scaled it).
  function viewportToImage(point, viewport, cropAspect, shot) {
    const rect = calibration.rect;
    const croppedWidth = cropAspect && cropAspect < rect.width / rect.height ? Math.round(rect.height * cropAspect) : rect.width;
    const scale = shot.width / croppedWidth;
    const x = (point[0] / viewport.width) * rect.width - (rect.width - croppedWidth) / 2;
    const y = (point[1] / viewport.height) * rect.height;
    return [Number((x * scale).toFixed(1)), Number((y * scale).toFixed(1))];
  }

  async function cameraPath(from, to) {
    const path = await runLuau('camera_path', { from, to }, 120);
    return { path, analysis: analyzeCameraPath(path.samples, path.fps) };
  }

  // What is missing or unusual about the Moon Animator side, in words the
  // agent can pass on to the user.
  function moonNotes(studio) {
    if (!studio.hasMoonGlobal) {
      return [
        'Moon Animator 2 is not loaded in this Studio session. It is a separate plugin that each user installs from ' +
          'the Roblox Creator Store; this server does not include it. After installing, open it from the Plugins tab.',
      ];
    }
    const notes = [];
    if (!studio.hasMainWindow || !studio.hasLayerSystem) {
      notes.push('Moon Animator 2 has not finished opening. Click Moon Animator in the Plugins tab, then try again.');
    }
    if (studio.moonVersion !== undefined && !TESTED_MOON_VERSIONS.includes(Number(studio.moonVersion))) {
      notes.push(
        `This server was tested with Moon Animator 2 version ${TESTED_MOON_VERSIONS.join(', ')}; Studio reports ` +
          `${studio.moonVersion}. Tools may misbehave if its internals changed: check results with moon_scene and moon_screenshot.`,
      );
    }
    const stale = (studio.items ?? []).filter((item) => item.stale).map((item) => item.path);
    if (stale.length > 0) {
      notes.push(
        `Stale items (${stale.join(', ')}): the instance was removed or replaced after the file was opened, so keyframes ` +
          'no longer reach it. Call moon_save, then moon_open_file with this file name to link them again.',
      );
    }
    return notes;
  }

  function notConnectedHint() {
    if (plugin.state === 'installed' || plugin.state === 'updated') {
      return (
        `The MoonBridge Studio plugin was ${plugin.state} just now (${plugin.target}). Restart Roblox Studio so it loads, ` +
        'open a place, and allow MoonBridge to make HTTP requests to 127.0.0.1 when Studio asks.'
      );
    }
    if (plugin.state === 'current') {
      return (
        'Roblox Studio is not answering. Open a place in Studio in edit mode (restart Studio if it was already open ' +
        'when the MoonBridge plugin was installed) and allow MoonBridge to make HTTP requests to 127.0.0.1 if Studio asks.'
      );
    }
    return (
      `The MoonBridge Studio plugin is not installed${plugin.reason ? ` (${plugin.reason})` : ''}. Run ` +
      '`moon-animator-mcp install-plugin`, restart Roblox Studio, and allow its HTTP requests to 127.0.0.1.'
    );
  }

  const tools = [
    {
      name: 'moon_status',
      description:
        'Call first. Reports whether Roblox Studio and Moon Animator 2 are ready, the open file (fps, length, frame) ' +
        'with its items, and the viewport and camera, and says what to fix when something is missing.',
      inputSchema: { type: 'object', properties: {}, additionalProperties: false },
      async call() {
        const status = await bridge.status();
        const server = version?.();
        if (!status.pluginConnected) return [text({ connected: false, server, hint: notConnectedHint() })];

        const studio = await runLuau('status');
        const result = { connected: true, server, plugin: status.pluginVersion, ...summarizeStudio(studio) };
        const notes = moonNotes(studio);
        if (plugin.version && status.pluginVersion && status.pluginVersion !== plugin.version) {
          notes.push(`Studio is running MoonBridge ${status.pluginVersion}; version ${plugin.version} is installed. Restart Roblox Studio to load it.`);
        }
        if (notes.length > 0) result.notes = notes;
        return [text(result)];
      },
    },
    {
      name: 'moon_scene',
      description:
        'Tracks and keyframes of the open file. Per item: property tracks and keyed rig joints as {frames, ease} ' +
        '(or eases, one per frame, when they differ), the names of unkeyed joints, and markers. An ease applies from ' +
        'its keyframe toward the next. values=true adds a values list per track in the shape moon_set_keyframes takes.',
      inputSchema: {
        type: 'object',
        additionalProperties: false,
        properties: { values: { type: 'boolean', default: false } },
      },
      async call(args) {
        return [text(await runLuau('scene', { values: args.values === true }))];
      },
    },
    {
      name: 'moon_screenshot',
      description:
        'Image of the Studio 3D viewport only. `frame` moves the Moon Animator timeline there first, so the image ' +
        'shows the cutscene through its animated camera; `camera` views from a custom pose and `focus` frames one ' +
        'item instead. The Moon Animator window is hidden for the capture; timeline and camera are put back unless ' +
        'restore=false.',
      inputSchema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          frame: { type: 'integer', minimum: 0 },
          camera: CAMERA_SCHEMA,
          focus: FOCUS_SCHEMA,
          restore: { type: 'boolean', default: true },
          hide_ui: { type: 'boolean', default: true },
          max_width: { type: 'integer', minimum: 256, maximum: 2560, default: 1280 },
          recalibrate: { type: 'boolean', default: false, description: 'Locate the viewport again, e.g. after Studio panels moved.' },
        },
      },
      async call(args) {
        let camera = validateCamera(args.camera);
        const focus = validateFocus(args.focus, args.camera);
        const frame = integer(args.frame, 'frame', 0, 1_000_000, undefined);
        const maxWidth = integer(args.max_width, 'max_width', 256, 2560, 1280);
        if (args.recalibrate) calibration = null;

        let cropAspect;
        if (focus) ({ camera, cropAspect } = await focusFraming(focus, frame === undefined ? undefined : [frame]));

        const notes = new Set();
        const outFile = tempFile('shot');
        const session = { hideUi: args.hide_ui !== false, hideEffects: focus !== undefined, restore: args.restore !== false };
        const { view, shot } = await withView(session, () => shoot({ frame, camera }, maxWidth, outFile, notes, cropAspect, focus?.item));
        const details = { image: { width: shot.width, height: shot.height }, frame: view.frame, camera: view.camera };
        if (view.frame !== undefined && view.fps) details.timeSeconds = Number((view.frame / view.fps).toFixed(3));
        if (view.subtitle) details.subtitle = view.subtitle;
        if (notes.size > 0) details.notes = [...notes];
        return [{ type: 'image', data: readImage(outFile), mimeType: 'image/jpeg' }, text(details)];
      },
    },
    {
      name: 'moon_storyboard',
      description:
        'Contact sheet of the open file: frames in a grid, each labeled with frame, time, shot and subtitle. ' +
        'Without `frames` it picks frames from every detected camera shot (evenly spaced when there is no Camera ' +
        'item). `camera` or `focus` views every frame from one fixed pose instead of the cutscene camera.',
      inputSchema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          frames: {
            type: 'array',
            items: { type: 'integer', minimum: 0 },
            minItems: 1,
            maxItems: MAX_STORYBOARD_FRAMES,
          },
          count: { type: 'integer', minimum: 2, maximum: MAX_STORYBOARD_FRAMES, default: 9, description: 'Most frames to pick automatically.' },
          camera: CAMERA_SCHEMA,
          focus: FOCUS_SCHEMA,
          columns: { type: 'integer', minimum: 1, maximum: 6, default: 3 },
          cell_width: { type: 'integer', minimum: 160, maximum: 960, default: 480 },
        },
      },
      async call(args) {
        let camera = validateCamera(args.camera);
        const focus = validateFocus(args.focus, args.camera);
        const count = integer(args.count, 'count', 2, MAX_STORYBOARD_FRAMES, 9);
        const columns = integer(args.columns, 'columns', 1, 6, 3);
        const cellWidth = integer(args.cell_width, 'cell_width', 160, 960, 480);
        if (args.frames !== undefined) {
          if (!Array.isArray(args.frames) || args.frames.length < 1 || args.frames.length > MAX_STORYBOARD_FRAMES) {
            throw new Error(`frames must list 1 to ${MAX_STORYBOARD_FRAMES} frames`);
          }
          args.frames.forEach((frame, index) => integer(frame, `frames[${index}]`, 0, 1_000_000));
        }

        const timeline = await runLuau('timeline');
        let shots = [];
        if (timeline.hasCamera) shots = (await cameraPath(0, timeline.lastKeyframe)).analysis.shots;
        const frames =
          args.frames ??
          (shots.length > 0 ? pickStoryboardFrames(shots, count) : evenlySpaced(0, timeline.lastKeyframe, count));
        const shotOf = (frame) => shots.find((shot) => frame >= shot.startFrame && frame <= shot.endFrame)?.shot;

        let cropAspect;
        if (focus) ({ camera, cropAspect } = await focusFraming(focus, frames));

        const notes = new Set();
        const cells = [];
        const entries = [];
        const sheetFile = tempFile('sheet');
        try {
          await withView({ hideUi: true, hideEffects: focus !== undefined, restore: true }, async () => {
            for (const frame of frames) {
              const file = tempFile('cell');
              cells.push({ file });
              const { view } = await shoot({ frame, camera }, cellWidth, file, notes, cropAspect, focus?.item);
              const time = Number((view.frame / view.fps).toFixed(2));
              const shot = shotOf(view.frame);
              const label = [`f${view.frame}`, `${time}s`, shot ? `shot ${shot}` : null, view.subtitle ? `"${view.subtitle}"` : null]
                .filter(Boolean)
                .join('  ');
              cells.at(-1).label = label;
              entries.push({ frame: view.frame, timeSeconds: time, shot, subtitle: view.subtitle });
            }
          });
          const sheet = await composeSheet({ cells, columns: Math.min(columns, cells.length), outFile: sheetFile });
          const details = { image: { width: sheet.width, height: sheet.height }, fps: timeline.fps, frames: entries };
          if (notes.size > 0) details.notes = [...notes];
          return [{ type: 'image', data: readImage(sheetFile), mimeType: 'image/jpeg' }, text(details)];
        } finally {
          for (const cell of cells) rmSync(cell.file, { force: true });
          rmSync(sheetFile, { force: true });
        }
      },
    },
    {
      name: 'moon_camera_path',
      description:
        'Shot list of the cutscene camera, measured by scrubbing the timeline: cuts, and per shot its frames, ' +
        'duration, movement (static, push-in, pull-out, travel, rotate, zoom), distance, rotation, and start/end ' +
        'position, look direction and FOV, plus the camera keyframes. samples=true adds positions along the path.',
      inputSchema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          from: { type: 'integer', minimum: 0, description: 'First frame (default 0).' },
          to: { type: 'integer', minimum: 0, description: 'Last frame (default: last keyframe).' },
          samples: { type: 'boolean', default: false },
        },
      },
      async call(args) {
        const from = integer(args.from, 'from', 0, 1_000_000, undefined);
        const to = integer(args.to, 'to', 0, 1_000_000, undefined);
        if (from !== undefined && to !== undefined && to < from) throw new Error('to must not be before from');

        const { path, analysis } = await cameraPath(from, to);
        const result = {
          fps: path.fps,
          range: { from: path.from, to: path.to, lastKeyframe: path.lastKeyframe },
          cuts: analysis.cuts,
          shots: analysis.shots,
          keyframes: path.tracks,
        };
        if (args.samples === true) {
          // Thin the per-frame samples for output, but keep both frames of every shot boundary.
          const stride = Math.max(1, Math.ceil(path.samples.length / MAX_PATH_SAMPLES));
          const boundaries = new Set(analysis.shots.flatMap((shot) => [shot.startFrame, shot.endFrame]));
          result.sampleColumns = ['frame', 'x', 'y', 'z', 'lookX', 'lookY', 'lookZ', 'fov'];
          result.samples = path.samples
            .filter((sample, index) => index % stride === 0 || boundaries.has(sample[0]))
            .map((s) => [s[0], s[1], s[2], s[3], ...[s[4], s[5], s[6]].map((n) => Number(n.toFixed(3))), s[7]]);
        }
        return [text(result)];
      },
    },
    {
      name: 'moon_preview_pose',
      description:
        'Shows a pose WITHOUT creating keyframes: applies joint rotations/positions (as in moon_set_keyframes) on ' +
        'top of the animation at `frame` (default: current), returns images from the given sides and the positions ' +
        'of `parts` (world, or local to `relative_to`), then puts the animation back.',
      inputSchema: {
        type: 'object',
        additionalProperties: false,
        required: ['item', 'joints'],
        properties: {
          item: { type: ['string', 'integer'] },
          frame: { type: 'integer', minimum: 0 },
          joints: {
            type: 'array',
            minItems: 1,
            maxItems: 100,
            items: {
              type: 'object',
              additionalProperties: false,
              required: ['joint'],
              properties: {
                joint: { type: 'string' },
                rotation: { type: 'array', items: { type: 'number' }, minItems: 3, maxItems: 3 },
                position: { type: 'array', items: { type: 'number' }, minItems: 3, maxItems: 3 },
              },
            },
          },
          views: { type: 'array', items: { type: 'string', enum: VIEWS }, minItems: 1, maxItems: 4, default: ['front', 'right'] },
          parts: { type: 'array', items: { type: 'string' }, description: 'Parts or bones to report positions for (default: none).' },
          relative_to: { type: 'string', description: 'Report positions in the local space of this part.' },
          relative_to_item: RELATIVE_ITEM,
          with: { type: 'array', items: { type: ['string', 'integer'] }, maxItems: 4, description: 'Other items to keep in frame.' },
          cell_width: { type: 'integer', minimum: 160, maximum: 960, default: 420 },
        },
      },
      async call(args) {
        if (typeof args.item !== 'string' && !Number.isInteger(args.item)) throw new Error('item must be an item name, path or index');
        if (!Array.isArray(args.joints) || args.joints.length < 1 || args.joints.length > 100) {
          throw new Error('joints must list 1 to 100 joints');
        }
        const frame = integer(args.frame, 'frame', 0, 1_000_000, undefined);
        const cellWidth = integer(args.cell_width, 'cell_width', 160, 960, 420);
        const others = itemList(args.with, 'with');
        const views = args.views ?? ['front', 'right'];
        if (!Array.isArray(views) || views.length < 1 || views.length > 4 || !views.every((view) => VIEWS.includes(view))) {
          throw new Error(`views must list 1 to 4 of: ${VIEWS.join(', ')}`);
        }

        const notes = new Set();
        const cells = [];
        const sheetFile = tempFile('sheet');
        try {
          let posed;
          await withView({ hideUi: true, hideEffects: true, restore: true }, async () => {
            if (frame !== undefined) await runLuau('view_step', { frame, settleFrames: 0 });
            posed = await runLuau('view_pose', {
              item: args.item,
              joints: args.joints,
              parts: args.parts ?? [],
              relativeTo: args.relative_to,
              relativeToItem: args.relative_to_item,
            });
            // The other items as they stand on this frame, so the view holds them too.
            const boxes = [posed];
            for (const other of others) boxes.push(...(await runLuau('sample', { item: other, parts: [] })).frames);
            const bounds = { ...posed, ...unionBounds(boxes) };
            for (const view of views) {
              const file = tempFile('cell');
              cells.push({ file, label: view });
              const { camera, cropAspect } = framingFor({ view, margin: 1.15 }, bounds);
              await shoot({ camera }, cellWidth, file, notes, cropAspect, args.item);
            }
          });
          const sheet = await composeSheet({ cells, columns: cells.length, outFile: sheetFile });
          const details = { image: { width: sheet.width, height: sheet.height }, frame: posed.frame, views };
          if (args.parts !== undefined) {
            details.positions = posed.parts;
            details.positionsRelativeTo = relativeLabel(args);
          }
          if (notes.size > 0) details.notes = [...notes];
          return [{ type: 'image', data: readImage(sheetFile), mimeType: 'image/jpeg' }, text(details)];
        } finally {
          for (const cell of cells) rmSync(cell.file, { force: true });
          rmSync(sheetFile, { force: true });
        }
      },
    },
    {
      name: 'moon_motion_trail',
      description:
        'Timing view: image of an item with the path each part travels between two frames, one dot per sampled ' +
        'frame (wide gaps are fast, clusters are slow or held). Returns per part the path length, peak speed and ' +
        'its frame, and the ranges it holds still; detail=true adds speed per interval. Default parts: head, hands, feet.',
      inputSchema: {
        type: 'object',
        additionalProperties: false,
        required: ['item'],
        properties: {
          item: { type: ['string', 'integer'] },
          parts: { type: 'array', items: { type: 'string' }, minItems: 1, maxItems: 6 },
          from: { type: 'integer', minimum: 0, description: 'First frame (default 0).' },
          to: { type: 'integer', minimum: 0, description: 'Last frame (default: last keyframe).' },
          step: { type: 'integer', minimum: 1, description: 'Frames between dots (default: about 40 dots).' },
          at: { type: 'integer', minimum: 0, description: 'Frame whose pose is shown under the trails (default: `to`).' },
          view: { type: 'string', enum: VIEWS, default: 'front' },
          detail: { type: 'boolean', default: false },
          max_width: { type: 'integer', minimum: 256, maximum: 2560, default: 900 },
        },
      },
      async call(args) {
        if (typeof args.item !== 'string' && !Number.isInteger(args.item)) throw new Error('item must be an item name, path or index');
        const view = args.view ?? 'front';
        if (!VIEWS.includes(view)) throw new Error(`view must be one of: ${VIEWS.join(', ')}`);
        const maxWidth = integer(args.max_width, 'max_width', 256, 2560, 900);
        if (args.parts !== undefined && (!Array.isArray(args.parts) || args.parts.length < 1 || args.parts.length > 6)) {
          throw new Error('parts must list 1 to 6 part names');
        }

        const timeline = await runLuau('timeline');
        const from = integer(args.from, 'from', 0, 1_000_000, 0);
        const to = integer(args.to, 'to', 0, 1_000_000, timeline.lastKeyframe);
        if (to <= from) throw new Error('to must be after from');
        const step = integer(args.step, 'step', 1, 1_000_000, Math.max(1, Math.ceil((to - from) / 40)));
        const frames = [];
        for (let frame = from; frame <= to; frame += step) frames.push(frame);
        if (frames.at(-1) !== to) frames.push(to);
        if (frames.length > MAX_TRAIL_SAMPLES) throw new Error(`that range and step give more than ${MAX_TRAIL_SAMPLES} dots; use a larger step`);
        const at = integer(args.at, 'at', 0, 1_000_000, to);

        const { camera, cropAspect } = await focusFraming({ item: args.item, view, margin: 1.15 }, frames);
        const trail = await runLuau('trail', { item: args.item, parts: args.parts, frames, camera }, 120);

        const notes = new Set();
        const outFile = tempFile('trail');
        try {
          const { view: shown, shot } = await withView({ hideUi: true, hideEffects: true, restore: true }, () =>
            shoot({ frame: at, camera }, maxWidth, outFile, notes, cropAspect, args.item),
          );

          const shapes = [];
          const report = [];
          trail.parts.forEach((name, index) => {
            const color = TRAIL_COLORS[index % TRAIL_COLORS.length];
            const samples = trail.tracks[name];
            const points = samples.filter((sample) => sample[6]).map((sample) => viewportToImage([sample[4], sample[5]], shown.viewport, cropAspect, shot));
            shapes.push({ type: 'polyline', points, color, width: 2 });
            const labelEvery = Math.max(1, Math.ceil(samples.length / 6));
            samples.forEach((sample, sampleIndex) => {
              if (!sample[6]) return;
              const [x, y] = viewportToImage([sample[4], sample[5]], shown.viewport, cropAspect, shot);
              shapes.push({ type: 'dot', x, y, radius: 3, color });
              if (sampleIndex % labelEvery === 0 || sampleIndex === samples.length - 1) {
                shapes.push({ type: 'text', x: x + 5, y: y - 14, text: String(sample[0]), color });
              }
            });
            shapes.push({ type: 'text', x: 8, y: 6 + index * 16, text: name, color });
            const { speeds, ...stats } = motionStats(samples, trail.fps);
            report.push({ part: name, color: `rgb(${color.join(',')})`, ...stats, ...(args.detail === true ? { speeds } : {}) });
          });
          await annotateImage({ file: outFile, shapes });

          const details = {
            image: { width: shot.width, height: shot.height },
            poseShownAtFrame: shown.frame,
            range: { from, to, step, fps: trail.fps },
            units: 'pathStuds in studs, peakSpeed in studs per second; numbers beside dots are frames',
            parts: report,
          };
          if (notes.size > 0) details.notes = [...notes];
          return [{ type: 'image', data: readImage(outFile), mimeType: 'image/jpeg' }, text(details)];
        } finally {
          rmSync(outFile, { force: true });
        }
      },
    },
    {
      name: 'moon_sample',
      description:
        'Measures an item over frames: a ground-contact report (how far each of `contact_parts`, default the feet, ' +
        'slides while planted) and, for `parts`, their positions per frame in world space or local to ' +
        '`relative_to`. Use it for foot sliding, hand-to-face distance, jump height or travel.',
      inputSchema: {
        type: 'object',
        additionalProperties: false,
        required: ['item'],
        properties: {
          item: { type: ['string', 'integer'] },
          frames: { type: 'array', items: { type: 'integer', minimum: 0 }, minItems: 1, maxItems: 400 },
          from: { type: 'integer', minimum: 0 },
          to: { type: 'integer', minimum: 0 },
          step: { type: 'integer', minimum: 1, description: 'Frames between samples (default: about 40 samples).' },
          parts: { type: 'array', items: { type: 'string' }, maxItems: 12, description: 'Parts or bones to report positions for (default: none).' },
          relative_to: { type: 'string' },
          relative_to_item: RELATIVE_ITEM,
          contact_parts: { type: 'array', items: { type: 'string' }, maxItems: 12 },
        },
      },
      async call(args) {
        if (typeof args.item !== 'string' && !Number.isInteger(args.item)) throw new Error('item must be an item name, path or index');
        const frames = await frameList(args, runLuau, 400);

        for (const key of ['parts', 'contact_parts']) {
          const names = args[key];
          if (names !== undefined && (!Array.isArray(names) || names.length > 12 || !names.every((name) => typeof name === 'string'))) {
            throw new Error(`${key} must list at most 12 names`);
          }
        }
        // Ground contact only makes sense in world space.
        const wantsContacts = args.relative_to === undefined;
        const measured = await runLuau(
          'sample',
          {
            item: args.item,
            frames,
            parts: args.parts ?? [],
            contactParts: wantsContacts ? args.contact_parts : undefined,
            autoContacts: wantsContacts && args.contact_parts === undefined,
            relativeTo: args.relative_to,
            relativeToItem: args.relative_to_item,
          },
          120,
        );

        const result = { item: measured.item, fps: measured.fps, frames: measured.frames.map((frame) => frame.frame) };
        if (args.parts?.length > 0) {
          result.positionsRelativeTo = relativeLabel(args);
          result.positions = Object.fromEntries(args.parts.map((name) => [name, measured.frames.map((frame) => frame.parts[name])]));
        } else {
          result.availableParts = measured.partNames;
        }
        if (wantsContacts) result.contacts = analyzeContacts(measured.frames, measured.contactParts);
        return [text(result)];
      },
    },
    {
      name: 'moon_measure',
      description:
        'Distance between two points on any items over frames, e.g. a fist and an opponent\'s head, or how far ' +
        'apart two characters stand. A point is a part or bone of an item, optionally shifted by an offset in that ' +
        'part\'s local space. Per frame: distance between the points, gap from the `from` point to the surface of ' +
        'the `to` part (negative when inside it), and the `from` point in the `to` part\'s local space. Also the ' +
        'closest frame and the frames spent inside.',
      inputSchema: {
        type: 'object',
        additionalProperties: false,
        required: ['from', 'to'],
        properties: {
          from: POINT_SCHEMA,
          to: POINT_SCHEMA,
          frames: { type: 'array', items: { type: 'integer', minimum: 0 }, minItems: 1, maxItems: 400 },
          from_frame: { type: 'integer', minimum: 0 },
          to_frame: { type: 'integer', minimum: 0 },
          step: { type: 'integer', minimum: 1, description: 'Frames between samples (default: about 40 samples).' },
        },
      },
      async call(args) {
        const from = pointSpec(args.from, 'from');
        const to = pointSpec(args.to, 'to');
        const frames = await frameList({ frames: args.frames, from: args.from_frame, to: args.to_frame, step: args.step }, runLuau, 400);
        const measured = await runLuau('distance', { from, to, frames }, 120);
        return [text(summarizeDistance(measured))];
      },
    },
    {
      name: 'moon_solve_reach',
      description:
        'Inverse kinematics by measurement: finds rotations for `joints` that bring `end_part` (a hand, foot or ' +
        'held prop) to `target`, a point in world space or local to `relative_to`, which with `relative_to_item` ' +
        'can be a part of another item (an opponent\'s Head). Starts from the pose at `frame`, ' +
        'changes nothing, and returns rotations for moon_set_keyframes or moon_preview_pose with the remaining ' +
        'distance. Limit a hinge with axes, e.g. "x" for an elbow or knee.',
      inputSchema: {
        type: 'object',
        additionalProperties: false,
        required: ['item', 'end_part', 'target', 'joints'],
        properties: {
          item: { type: ['string', 'integer'] },
          frame: { type: 'integer', minimum: 0 },
          end_part: { type: 'string' },
          target: { type: 'array', items: { type: 'number' }, minItems: 3, maxItems: 3 },
          relative_to: { type: 'string' },
          relative_to_item: RELATIVE_ITEM,
          tolerance: { type: 'number', minimum: 0, default: 0.05, description: 'Studs that count as reached.' },
          joints: {
            type: 'array',
            minItems: 1,
            maxItems: 8,
            items: {
              type: 'object',
              additionalProperties: false,
              required: ['joint'],
              properties: {
                joint: { type: 'string' },
                axes: { type: 'string', pattern: '^[xyzXYZ]{1,3}$', default: 'xyz' },
                min: { type: 'array', items: { type: 'number' }, minItems: 3, maxItems: 3, description: 'Lowest XYZ degrees.' },
                max: { type: 'array', items: { type: 'number' }, minItems: 3, maxItems: 3 },
              },
            },
          },
        },
      },
      async call(args) {
        if (typeof args.item !== 'string' && !Number.isInteger(args.item)) throw new Error('item must be an item name, path or index');
        if (typeof args.end_part !== 'string' || args.end_part === '') throw new Error('end_part must be a part name');
        vector3(args.target, 'target');
        if (!Array.isArray(args.joints) || args.joints.length < 1 || args.joints.length > 8) {
          throw new Error('joints must list 1 to 8 joints');
        }
        for (const [index, joint] of args.joints.entries()) {
          if (typeof joint?.joint !== 'string') throw new Error(`joints[${index}].joint must be a joint name`);
          if (joint.axes !== undefined && !/^[xyz]{1,3}$/i.test(joint.axes)) throw new Error(`joints[${index}].axes must use only x, y, z`);
          if (joint.min !== undefined) vector3(joint.min, `joints[${index}].min`);
          if (joint.max !== undefined) vector3(joint.max, `joints[${index}].max`);
        }
        return [
          text(
            await runLuau('solve_reach', {
              item: args.item,
              frame: integer(args.frame, 'frame', 0, 1_000_000, undefined),
              endPart: args.end_part,
              target: args.target,
              relativeTo: args.relative_to,
              relativeToItem: args.relative_to_item,
              tolerance: args.tolerance,
              joints: args.joints,
            }),
          ),
        ];
      },
    },
    ...createEditTools({ runLuau }),
  ];

  if (allowExec) {
    tools.push({
      name: 'moon_exec_luau',
      description:
        'Runs Luau in the MoonBridge plugin context in Roblox Studio and returns the serialized return values. ' +
        'Development escape hatch; prefer the dedicated tools.',
      inputSchema: {
        type: 'object',
        additionalProperties: false,
        required: ['code'],
        properties: {
          code: { type: 'string' },
          timeout: { type: 'integer', minimum: 1, maximum: 300, default: 30 },
        },
      },
      async call(args) {
        if (typeof args.code !== 'string' || args.code.length === 0) throw new Error('code must be a non-empty string');
        const result = await bridge.exec(args.code, integer(args.timeout, 'timeout', 1, 300, 30));
        if (!result.ok) throw new Error(result.error);
        return [text(result.values)];
      },
    });
  }

  return {
    list: () => tools.map(({ name, description, inputSchema }) => ({ name, description, inputSchema })),
    async call(name, args) {
      const tool = tools.find((candidate) => candidate.name === name);
      if (!tool) throw new Error(`unknown tool: ${name}`);
      return tool.call(args ?? {});
    },
  };
}
