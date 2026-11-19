import assert from 'node:assert/strict';
import { test } from 'node:test';
import { analyzeContacts, frameSubject, motionStats, unionBounds } from '../server/framing.mjs';

// A 2 wide, 5 tall, 1 deep character standing at the origin, facing -Z.
const CHARACTER = { min: [-1, 0, -0.5], max: [1, 5, 0.5], facing: { look: [0, 0, -1], right: [1, 0, 0] } };
const TAN_20 = Math.tan((20 * Math.PI) / 180);

const close = (actual, expected, tolerance = 0.01) =>
  assert.ok(Math.abs(actual - expected) <= tolerance, `expected ${expected}, got ${actual}`);

test('front view sits in front of the subject at the distance that fits its height', () => {
  const { camera, cropAspect } = frameSubject({ ...CHARACTER, view: 'front', viewportAspect: 2.6, margin: 1 });
  assert.deepEqual(camera.lookAt, [0, 2.5, 0]);
  close(camera.position[0], 0);
  close(camera.position[1], 2.5);
  // Half height 2.5 at a 40 degree vertical field of view, plus half the depth.
  close(camera.position[2], -(2.5 / TAN_20 + 0.5));
  assert.equal(camera.fov, 40);
  assert.equal(cropAspect, 0.75, 'a narrow subject is cropped no thinner than 3:4');
});

test('side views use the facing of the subject, not world axes', () => {
  const turned = { ...CHARACTER, facing: { look: [1, 0, 0], right: [0, 0, 1] } };
  const right = frameSubject({ ...turned, view: 'right', viewportAspect: 2 }).camera;
  assert.ok(right.position[2] > 5 && Math.abs(right.position[0]) < 0.01, 'camera is on the +Z side');
  const front = frameSubject({ ...turned, view: 'front', viewportAspect: 2 }).camera;
  assert.ok(front.position[0] > 5, 'camera is in front along +X');
  const back = frameSubject({ ...turned, view: 'back', viewportAspect: 2 }).camera;
  assert.ok(back.position[0] < -5);
});

test('a wide subject is limited by width and keeps the viewport shape', () => {
  const wide = { min: [-10, 0, -1], max: [10, 2, 1], facing: CHARACTER.facing };
  const { camera, cropAspect } = frameSubject({ ...wide, view: 'front', viewportAspect: 2, margin: 1 });
  assert.equal(cropAspect, 2);
  // Half width 10 must fit in half the image width: 10 / (tan * aspect), plus half the depth.
  close(camera.position[2], -(10 / (TAN_20 * 2) + 1));
});

test('margin moves the camera back and top view stays above the subject', () => {
  const near = frameSubject({ ...CHARACTER, view: 'front', viewportAspect: 2, margin: 1 }).camera;
  const far = frameSubject({ ...CHARACTER, view: 'front', viewportAspect: 2, margin: 1.5 }).camera;
  assert.ok(far.position[2] < near.position[2]);

  const top = frameSubject({ ...CHARACTER, view: 'top', viewportAspect: 2 }).camera;
  assert.ok(top.position[1] > 5);
  assert.ok(top.position.every(Number.isFinite));

  assert.throws(() => frameSubject({ ...CHARACTER, view: 'below', viewportAspect: 2 }), /view must be one of/);
});

test('unionBounds covers every measured frame', () => {
  const union = unionBounds([
    { min: [0, 0, 0], max: [1, 5, 1] },
    { min: [-2, 1, 0], max: [0.5, 8, 3] },
  ]);
  assert.deepEqual(union, { min: [-2, 0, 0], max: [1, 8, 3] });
});

test('contact analysis reports sliding only while a part is on the ground', () => {
  const frames = [
    { frame: 0, parts: { LeftFoot: [0, 0.1, 0], RightFoot: [1, 0.1, 0] } },
    { frame: 5, parts: { LeftFoot: [0.3, 0.1, 0], RightFoot: [1, 0.1, 0] } }, // left slides 0.3
    { frame: 10, parts: { LeftFoot: [0.3, 1.5, 0], RightFoot: [1, 0.1, 0] } }, // left lifts
    { frame: 15, parts: { LeftFoot: [2.0, 1.5, 0], RightFoot: [1, 0.1, 0] } }, // moves in the air
    { frame: 20, parts: { LeftFoot: [2.0, 0.1, 0], RightFoot: [1, 0.1, 0.02] } }, // lands; right jitters
  ];
  const [left, right] = analyzeContacts(frames, ['LeftFoot', 'RightFoot', 'Missing']);
  assert.equal(left.part, 'LeftFoot');
  assert.equal(left.slideStuds, 0.3);
  assert.deepEqual(left.worstSlides, [{ fromFrame: 0, toFrame: 5, studs: 0.3 }]);
  assert.equal(left.highestY, 1.5);
  assert.equal(right.slideStuds, 0, 'movement below the reporting threshold is ignored');
});

test('motion stats report path length, peak speed, and the ranges where a part holds still', () => {
  // Still for two frames, moves 4 studs up over the next two, then still again.
  const samples = [[0, 0, 0, 0], [2, 0, 0, 0], [4, 0, 4, 0], [6, 0, 4, 0], [8, 0, 4, 0]];
  const stats = motionStats(samples, 10);
  assert.equal(stats.pathStuds, 4);
  assert.equal(stats.peakSpeed, 20);
  assert.equal(stats.peakFrame, 4);
  assert.deepEqual(stats.holds, [{ fromFrame: 0, toFrame: 2 }, { fromFrame: 4, toFrame: 8 }]);
  assert.equal(stats.speeds.length, 4);
});

test('motion stats ignore holds shorter than a tenth of a second and handle a single sample', () => {
  const brief = motionStats([[0, 0, 0, 0], [1, 0, 0, 0], [2, 0, 3, 0]], 60);
  assert.deepEqual(brief.holds, []);
  assert.deepEqual(motionStats([[7, 1, 2, 3]], 60), { pathStuds: 0, peakSpeed: 0, peakFrame: 7, holds: [], speeds: [] });
});
