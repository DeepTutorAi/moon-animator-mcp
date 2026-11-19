import assert from 'node:assert/strict';
import { test } from 'node:test';
import { analyzeCameraPath, evenlySpaced, pickStoryboardFrames } from '../server/shots.mjs';

// Builds one sample per frame from a function returning { p, look, fov }.
function path(frames, view) {
  return Array.from({ length: frames }, (_, f) => {
    const { p, look, fov = 70 } = view(f);
    const length = Math.hypot(...look);
    return [f, ...p, ...look.map((n) => n / length), fov];
  });
}

test('a continuous push-in is one shot', () => {
  const samples = path(60, (f) => ({ p: [0, 5, 20 - f * 0.1], look: [0, 0, -1] }));
  const { cuts, shots } = analyzeCameraPath(samples, 60);
  assert.deepEqual(cuts, []);
  assert.equal(shots.length, 1);
  assert.deepEqual(shots[0].movement, ['push-in']);
  assert.equal(shots[0].travelStuds, 5.9);
  assert.equal(shots[0].durationSeconds, 1);
});

test('a jump in position splits the path into two shots at the right frame', () => {
  const samples = path(40, (f) => (f < 25 ? { p: [0, 5, 0], look: [0, 0, -1] } : { p: [30, 8, 4], look: [-1, 0, 0] }));
  const { cuts, shots } = analyzeCameraPath(samples, 20);
  assert.deepEqual(cuts, [25]);
  assert.deepEqual(shots.map((shot) => [shot.shot, shot.startFrame, shot.endFrame]), [[1, 0, 24], [2, 25, 39]]);
  assert.deepEqual(shots[0].movement, ['static']);
  assert.equal(shots[0].travelStuds, 0, 'the jump itself is not counted as travel');
});

test('a fast but continuous pan is not mistaken for a cut', () => {
  const samples = path(30, (f) => {
    const angle = (f * 12 * Math.PI) / 180;
    return { p: [0, 5, 0], look: [Math.sin(angle), 0, -Math.cos(angle)] };
  });
  const { cuts, shots } = analyzeCameraPath(samples, 30);
  assert.deepEqual(cuts, []);
  assert.deepEqual(shots[0].movement, ['rotate']);
  assert.equal(shots[0].rotationDegrees, 348);
});

test('tiny per-frame rotation is measured without rounding noise', () => {
  const samples = path(100, (f) => {
    const angle = (f * 0.01 * Math.PI) / 180;
    return { p: [0, 5, 0], look: [Math.sin(angle), 0, -Math.cos(angle)] };
  });
  const [shot] = analyzeCameraPath(samples, 60).shots;
  assert.ok(Math.abs(shot.rotationDegrees - 0.99) < 0.11, `got ${shot.rotationDegrees}`);
});

test('zoom and sideways travel are classified', () => {
  const zoom = path(30, (f) => ({ p: [0, 5, 0], look: [0, 0, -1], fov: 70 - f }));
  assert.deepEqual(analyzeCameraPath(zoom, 30).shots[0].movement, ['zoom-in']);

  const truck = path(30, (f) => ({ p: [f * 0.2, 5, 0], look: [0, 0, -1] }));
  assert.deepEqual(analyzeCameraPath(truck, 30).shots[0].movement, ['travel']);

  const pullOut = path(30, (f) => ({ p: [0, 5, f * 0.2], look: [0, 0, -1] }));
  assert.deepEqual(analyzeCameraPath(pullOut, 30).shots[0].movement, ['pull-out']);
});

test('empty and single-sample paths do not crash', () => {
  assert.deepEqual(analyzeCameraPath([], 60), { cuts: [], shots: [] });
  const { shots } = analyzeCameraPath(path(1, () => ({ p: [0, 0, 0], look: [0, 0, -1] })), 60);
  assert.equal(shots.length, 1);
  assert.equal(shots[0].startFrame, shots[0].endFrame);
});

test('storyboard frame picking gives every shot a frame and longer shots more', () => {
  const dance = [
    { startFrame: 0, endFrame: 59 },
    { startFrame: 60, endFrame: 180 },
    { startFrame: 181, endFrame: 268 },
    { startFrame: 269, endFrame: 360 },
  ];
  assert.deepEqual(pickStoryboardFrames(dance, 12), [0, 59, 60, 100, 140, 180, 181, 225, 268, 269, 315, 360]);
  // With one frame per shot, each shot shows its middle.
  assert.deepEqual(pickStoryboardFrames(dance, 4), [30, 120, 225, 315]);
  // One spare frame goes to the longest shot.
  assert.deepEqual(pickStoryboardFrames(dance, 5), [30, 60, 180, 225, 315]);
});

test('storyboard frame picking handles more shots than frames, tiny shots, and no shots', () => {
  const many = Array.from({ length: 10 }, (_, i) => ({ startFrame: i * 10, endFrame: i * 10 + 9 }));
  const picked = pickStoryboardFrames(many, 4);
  assert.equal(picked.length, 4);
  assert.deepEqual(picked, [5, 35, 65, 95]);

  // A one-frame shot cannot yield more than one frame.
  const tiny = [{ startFrame: 0, endFrame: 0 }, { startFrame: 1, endFrame: 100 }];
  const frames = pickStoryboardFrames(tiny, 6);
  assert.ok(frames.includes(0) && frames.includes(1) && frames.includes(100));
  assert.ok(frames.length <= 6);
  assert.deepEqual(frames, [...new Set(frames)].sort((a, b) => a - b));

  assert.deepEqual(pickStoryboardFrames([], 9), []);
});

test('evenlySpaced covers both ends without duplicates', () => {
  assert.deepEqual(evenlySpaced(0, 100, 5), [0, 25, 50, 75, 100]);
  assert.deepEqual(evenlySpaced(0, 2, 6), [0, 1, 2]);
  assert.deepEqual(evenlySpaced(7, 7, 4), [7]);
});
