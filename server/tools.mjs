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
    'Pose the edit camera: position plus either look_at (world point) or rotation (XYZ degrees), optional fov. ' +
    'Overrides the camera animated by Moon Animator for this view.',
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
    'Frame an item of the open file automatically instead of giving a camera: the camera is placed on the named ' +
    'side of the item (relative to the way it faces) at the distance that fills the image, the image is cropped ' +
    'to the item, and Moon Animator screen effects are hidden.',
  properties: {
    item: { type: ['string', 'integer'], description: 'Item name, path or index.' },
    view: { type: 'string', enum: VIEWS, default: 'three_quarter' },
    margin: { type: 'number', minimum: 1, maximum: 3, default: 1.15 },
  },
};

function text(value) {
  return { type: 'text', text: typeof value === 'string' ? value : JSON.stringify(value, null, 2) };
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
  return { item: focus.item, view, margin };
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
const TESTED_MOON_VERSIONS = [36000];

export function createTools({ bridge, runLuau, captureWindow, composeSheet, annotateImage, allowExec = false }) {
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

  // One view inside a session: position the timeline/camera, then capture.
  // Restores a minimized Studio window once and retries.
  async function shoot(step, maxWidth, outFile, notes, cropAspect) {
    let view = await runLuau('view_step', { ...step, settleFrames: SETTLE_FRAMES });
    if (!view.settled) notes.add(STALE_NOTE);
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
    return framingFor(focus, { ...unionBounds(measured.frames), facing: measured.facing, viewport: measured.viewport });
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
    return notes;
  }

  const tools = [
    {
      name: 'moon_status',
      description:
        'Connection and state overview: whether the MoonBridge Studio plugin is connected, whether Moon Animator 2 ' +
        'is loaded, the open animation file (name, fps, length, current frame, items), and the current viewport ' +
        'size and edit camera. Call this first.',
      inputSchema: { type: 'object', properties: {}, additionalProperties: false },
      async call() {
        const status = await bridge.status();
        if (!status.pluginConnected) {
          return [
            text({
              bridge: status,
              hint:
                'Open Roblox Studio with the MoonBridge plugin installed and allow its HTTP requests. To install the ' +
                'plugin, run `moon-animator-mcp install-plugin` once (for example `npx -y github:DeepTutorAi/moon-animator-mcp ' +
                'install-plugin`) and restart Studio.',
            }),
          ];
        }
        const studio = await runLuau('status');
        const result = { bridge: status, studio };
        const notes = moonNotes(studio);
        if (notes.length > 0) result.notes = notes;
        return [text(result)];
      },
    },
    {
      name: 'moon_scene',
      description:
        'Structure of the open Moon Animator file: file settings, every item (Camera, Rig, parts, effects) with its ' +
        'property tracks, rig joints that have keyframes, keyframe frames with the easing used toward the next ' +
        'keyframe, and event markers. Set values=true to include keyframe values (rig joints as pose relative to rest).',
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
        'Returns an image of the Roblox Studio 3D viewport only (no Studio panels). With `frame`, first moves the ' +
        'Moon Animator timeline to that frame, so the image shows the cutscene through its animated camera. With ' +
        '`camera`, views from a custom pose instead (useful to inspect a rig pose from any angle). The Moon ' +
        'Animator window is hidden during capture, and the previous frame and camera are restored afterwards unless ' +
        'restore=false.',
      inputSchema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          frame: { type: 'integer', minimum: 0, description: 'Moon Animator frame to show. Requires an open file.' },
          camera: CAMERA_SCHEMA,
          focus: FOCUS_SCHEMA,
          restore: { type: 'boolean', default: true, description: 'Restore the previous timeline frame and camera afterwards.' },
          hide_ui: { type: 'boolean', default: true, description: 'Hide the Moon Animator window while capturing.' },
          max_width: { type: 'integer', minimum: 256, maximum: 2560, default: 1280 },
          recalibrate: {
            type: 'boolean',
            default: false,
            description: 'Force re-locating the viewport, e.g. after Studio panels were rearranged.',
          },
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
        const { view, shot } = await withView(session, () => shoot({ frame, camera }, maxWidth, outFile, notes, cropAspect));
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
        'Contact sheet of the open Moon Animator cutscene: several frames captured through the animated camera and ' +
        'laid out in a grid, each labeled with frame, time, shot number and subtitle text. Without `frames`, picks ' +
        'the start, middle and end of each detected camera shot (or evenly spaced frames when the file has no ' +
        'Camera item). Pass `camera` to view every frame from one fixed custom pose instead.',
      inputSchema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          frames: {
            type: 'array',
            items: { type: 'integer', minimum: 0 },
            minItems: 1,
            maxItems: MAX_STORYBOARD_FRAMES,
            description: 'Exact frames to show.',
          },
          count: { type: 'integer', minimum: 2, maximum: MAX_STORYBOARD_FRAMES, default: 9, description: 'Upper bound on automatically picked frames.' },
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
              const { view } = await shoot({ frame, camera }, cellWidth, file, notes, cropAspect);
              const time = Number((view.frame / view.fps).toFixed(2));
              const shot = shotOf(view.frame);
              const label = [`f${view.frame}`, `${time}s`, shot ? `shot ${shot}` : null, view.subtitle ? `"${view.subtitle}"` : null]
                .filter(Boolean)
                .join('  ');
              cells.at(-1).label = label;
              entries.push({ frame: view.frame, timeSeconds: time, shot, subtitle: view.subtitle, camera: view.camera });
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
        'Analyzes the camera of the open Moon Animator cutscene: detects cuts and lists each shot with its frame ' +
        'range, duration, kind of movement (static, push-in, pull-out, travel, rotate, zoom), travel distance, ' +
        'rotation, and start/end position, look direction and FOV. Also returns the camera keyframes and sampled ' +
        'positions along the path. Values come from scrubbing the real timeline, so they match what Moon Animator plays.',
      inputSchema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          from: { type: 'integer', minimum: 0, description: 'First frame (default 0).' },
          to: { type: 'integer', minimum: 0, description: 'Last frame (default: last keyframe).' },
        },
      },
      async call(args) {
        const from = integer(args.from, 'from', 0, 1_000_000, undefined);
        const to = integer(args.to, 'to', 0, 1_000_000, undefined);
        if (from !== undefined && to !== undefined && to < from) throw new Error('to must not be before from');

        const { path, analysis } = await cameraPath(from, to);
        // Thin the per-frame samples for output, but keep both frames of every shot boundary.
        const stride = Math.max(1, Math.ceil(path.samples.length / MAX_PATH_SAMPLES));
        const boundaries = new Set(analysis.shots.flatMap((shot) => [shot.startFrame, shot.endFrame]));
        const samples = path.samples
          .filter((sample, index) => index % stride === 0 || boundaries.has(sample[0]))
          .map((s) => ({
            frame: s[0],
            position: [s[1], s[2], s[3]],
            look: [s[4], s[5], s[6]].map((n) => Number(n.toFixed(3))),
            fov: s[7],
          }));

        return [
          text({
            fps: path.fps,
            range: { from: path.from, to: path.to, lastKeyframe: path.lastKeyframe },
            cuts: analysis.cuts,
            shots: analysis.shots,
            keyframes: path.tracks,
            samples,
          }),
        ];
      },
    },
    {
      name: 'moon_preview_pose',
      description:
        'Shows what a pose would look like WITHOUT creating keyframes. Applies joint rotations/positions (same ' +
        'convention as moon_set_keyframes) on top of the animation at `frame` (default: the current frame), returns ' +
        'images of the item from the requested sides plus the resulting world positions of its parts, then puts ' +
        'the animation back. Use it to find the right angles before committing them, and `relative_to` to read ' +
        'part positions in another part\'s local space (e.g. where the hand is relative to the head).',
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
          parts: { type: 'array', items: { type: 'string' }, description: 'Limit reported positions to these parts.' },
          relative_to: { type: 'string', description: 'Report positions in this part\'s local space.' },
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
              parts: args.parts,
              relativeTo: args.relative_to,
            });
            for (const view of views) {
              const file = tempFile('cell');
              cells.push({ file, label: view });
              const { camera, cropAspect } = framingFor({ view, margin: 1.15 }, posed);
              await shoot({ camera }, cellWidth, file, notes, cropAspect);
            }
          });
          const sheet = await composeSheet({ cells, columns: cells.length, outFile: sheetFile });
          const details = {
            image: { width: sheet.width, height: sheet.height },
            frame: posed.frame,
            views,
            positions: posed.parts,
            positionsRelativeTo: args.relative_to ?? 'world',
          };
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
        'Timing view: an image of an item with the paths its parts travel between two frames drawn over it, one ' +
        'colored trail per part with a dot on every sampled frame, so dots far apart mean fast motion and dots ' +
        'bunched together mean slow motion or a hold. Also returns numbers per part: path length, peak speed and ' +
        'the frame it happens on, the ranges where the part holds still, and speed per interval. Defaults to the ' +
        'head, hands and feet. Use it to judge spacing, arcs and easing, which single frames cannot show.',
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
            shoot({ frame: at, camera }, maxWidth, outFile, notes, cropAspect),
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
            report.push({ part: name, color: `rgb(${color.join(',')})`, ...motionStats(samples, trail.fps) });
          });
          await annotateImage({ file: outFile, shapes });

          const details = {
            image: { width: shot.width, height: shot.height },
            poseShownAtFrame: shown.frame,
            range: { from, to, step, fps: trail.fps },
            howToRead: 'One dot per sampled frame; numbers beside dots are frames. Wide gaps are fast, tight clusters are slow or held.',
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
        'Measures an item of the open file over time: the position of its parts on each sampled frame (world ' +
        'space, or the local space of `relative_to`), plus a ground-contact report for `contact_parts` (default: ' +
        'parts with "Foot" in the name) listing how far each slides while planted. Use it to check foot sliding, ' +
        'hand-to-face distance, jump height or travel with numbers instead of judging from images.',
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
          parts: { type: 'array', items: { type: 'string' }, description: 'Limit reported positions to these parts.' },
          relative_to: { type: 'string' },
          contact_parts: { type: 'array', items: { type: 'string' } },
        },
      },
      async call(args) {
        if (typeof args.item !== 'string' && !Number.isInteger(args.item)) throw new Error('item must be an item name, path or index');
        let frames = args.frames;
        if (frames !== undefined) {
          if (!Array.isArray(frames) || frames.length < 1 || frames.length > 400) throw new Error('frames must list 1 to 400 frames');
          frames.forEach((value, index) => integer(value, `frames[${index}]`, 0, 1_000_000));
        } else {
          const timeline = await runLuau('timeline');
          const from = integer(args.from, 'from', 0, 1_000_000, 0);
          const to = integer(args.to, 'to', 0, 1_000_000, timeline.lastKeyframe);
          if (to < from) throw new Error('to must not be before from');
          const step = integer(args.step, 'step', 1, 1_000_000, Math.max(1, Math.ceil((to - from) / 40)));
          frames = [];
          for (let frame = from; frame <= to; frame += step) frames.push(frame);
          if (frames.at(-1) !== to) frames.push(to);
          if (frames.length > 400) throw new Error('that range and step give more than 400 samples; use a larger step');
        }

        const wantsContacts = args.relative_to === undefined;
        const measured = await runLuau('sample', { item: args.item, frames, relativeTo: args.relative_to }, 120);
        const allParts = Object.keys(measured.frames[0]?.parts ?? {});
        const contactParts = args.contact_parts ?? allParts.filter((name) => /foot/i.test(name));
        const shown = args.parts ? new Set(args.parts) : null;
        if (shown) {
          const unknown = [...shown].filter((name) => !allParts.includes(name));
          if (unknown.length > 0) throw new Error(`unknown part(s): ${unknown.join(', ')} (parts: ${allParts.join(', ')})`);
        }

        const result = {
          item: measured.item,
          fps: measured.fps,
          positionsRelativeTo: args.relative_to ?? 'world',
          samples: measured.frames.map((frame) => ({
            frame: frame.frame,
            parts: shown ? Object.fromEntries(Object.entries(frame.parts).filter(([name]) => shown.has(name))) : frame.parts,
          })),
        };
        // Ground contact only makes sense in world space.
        if (wantsContacts) result.contacts = analyzeContacts(measured.frames, contactParts);
        return [text(result)];
      },
    },
    {
      name: 'moon_solve_reach',
      description:
        'Inverse kinematics by measurement: finds rotations for the listed joints that bring `end_part` (e.g. a ' +
        'hand, a foot, a held prop) to `target`, a point in world space or in the local space of `relative_to` ' +
        '(e.g. just in front of the Head for a microphone at the mouth). Starts from the animated pose at `frame`, ' +
        'changes nothing permanently, and returns rotations ready to pass to moon_set_keyframes or ' +
        'moon_preview_pose, with the remaining distance. Limit a hinge with axes (e.g. "x" for an elbow or knee).',
      inputSchema: {
        type: 'object',
        additionalProperties: false,
        required: ['item', 'end_part', 'target', 'joints'],
        properties: {
          item: { type: ['string', 'integer'] },
          frame: { type: 'integer', minimum: 0 },
          end_part: { type: 'string' },
          target: { type: 'array', items: { type: 'number' }, minItems: 3, maxItems: 3 },
          relative_to: { type: 'string', description: 'Part whose local space the target is given in. Omit for world space.' },
          tolerance: { type: 'number', minimum: 0, default: 0.05, description: 'Distance in studs that counts as reached.' },
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
                min: { type: 'array', items: { type: 'number' }, minItems: 3, maxItems: 3, description: 'Lowest XYZ angles in degrees.' },
                max: { type: 'array', items: { type: 'number' }, minItems: 3, maxItems: 3, description: 'Highest XYZ angles in degrees.' },
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
