// Camera framing and contact analysis from measured bounds and part positions.

export const VIEWS = ['front', 'back', 'left', 'right', 'three_quarter', 'top'];

const FOCUS_FOV = 40;
const MIN_CROP_ASPECT = 0.75;
const PLANTED_TOLERANCE = 0.1; // studs above a part's lowest point that still count as on the ground
const MIN_REPORTED_SLIDE = 0.05;

const add = (a, b) => [a[0] + b[0], a[1] + b[1], a[2] + b[2]];
const scale = (a, s) => [a[0] * s, a[1] * s, a[2] * s];
const cross = (a, b) => [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]];
const round = (n, digits = 3) => Number(n.toFixed(digits));

function normalize(v) {
  const length = Math.hypot(...v);
  return length === 0 ? [0, 0, -1] : scale(v, 1 / length);
}

// Smallest box containing every measured frame.
export function unionBounds(frames) {
  const min = [Infinity, Infinity, Infinity];
  const max = [-Infinity, -Infinity, -Infinity];
  for (const frame of frames) {
    for (let i = 0; i < 3; i += 1) {
      min[i] = Math.min(min[i], frame.min[i]);
      max[i] = Math.max(max[i], frame.max[i]);
    }
  }
  return { min, max };
}

// Places a camera so the box fills the image from the named side of the
// subject. Returns the camera pose and the image aspect to crop to, so a tall
// subject is not lost in a wide viewport.
export function frameSubject({ min, max, facing, view = 'three_quarter', viewportAspect, margin = 1.15 }) {
  const center = scale(add(min, max), 0.5);
  const size = [max[0] - min[0], max[1] - min[1], max[2] - min[2]];
  const look = normalize([facing.look[0], 0, facing.look[2]]);
  const right = normalize([facing.right[0], 0, facing.right[2]]);
  const up = [0, 1, 0];

  // Direction from the subject toward the camera.
  const directions = {
    front: look,
    back: scale(look, -1),
    right,
    left: scale(right, -1),
    three_quarter: add(add(look, scale(right, 0.8)), scale(up, 0.35)),
    // Slightly off vertical so the camera keeps a defined up direction.
    top: add(up, scale(look, -0.08)),
  };
  if (!directions[view]) throw new Error(`view must be one of: ${VIEWS.join(', ')}`);
  const toCamera = normalize(directions[view]);

  const forward = scale(toCamera, -1);
  const cameraRight = normalize(cross(forward, up));
  const cameraUp = cross(cameraRight, forward);
  const extent = (axis) => (Math.abs(axis[0]) * size[0] + Math.abs(axis[1]) * size[1] + Math.abs(axis[2]) * size[2]) / 2;
  const halfWidth = Math.max(extent(cameraRight), 0.01);
  const halfHeight = Math.max(extent(cameraUp), 0.01);
  const halfDepth = extent(forward);

  const cropAspect = Math.min(Math.max(halfWidth / halfHeight, MIN_CROP_ASPECT), viewportAspect);
  const tan = Math.tan((FOCUS_FOV * Math.PI) / 360);
  const distance = (margin * Math.max(halfHeight, halfWidth / cropAspect)) / tan + halfDepth;

  return {
    camera: {
      position: add(center, scale(toCamera, distance)).map((n) => round(n)),
      lookAt: center.map((n) => round(n)),
      fov: FOCUS_FOV,
    },
    cropAspect: round(cropAspect, 4),
  };
}

// Finds parts that slide along the ground while they should be planted.
// `frames` are measured samples in frame order; `partNames` are the contact parts.
export function analyzeContacts(frames, partNames) {
  const report = [];
  for (const name of partNames) {
    const track = frames.filter((frame) => frame.parts[name]).map((frame) => ({ frame: frame.frame, p: frame.parts[name] }));
    if (track.length < 2) continue;

    const ground = Math.min(...track.map((sample) => sample.p[1]));
    let total = 0;
    const slides = [];
    for (let i = 1; i < track.length; i += 1) {
      const a = track[i - 1];
      const b = track[i];
      if (a.p[1] > ground + PLANTED_TOLERANCE || b.p[1] > ground + PLANTED_TOLERANCE) continue;
      const distance = Math.hypot(b.p[0] - a.p[0], b.p[2] - a.p[2]);
      if (distance < MIN_REPORTED_SLIDE) continue;
      total += distance;
      slides.push({ fromFrame: a.frame, toFrame: b.frame, studs: round(distance, 2) });
    }
    slides.sort((x, y) => y.studs - x.studs);
    report.push({
      part: name,
      lowestY: round(ground, 2),
      highestY: round(Math.max(...track.map((sample) => sample.p[1])), 2),
      slideStuds: round(total, 2),
      worstSlides: slides.slice(0, 5),
    });
  }
  return report;
}

const HOLD_SPEED = 0.25; // studs per second below which a part counts as still
const MIN_HOLD_SECONDS = 0.1;

// Describes how a part moves over time. `samples` are [frame, x, y, z, ...] in
// frame order. Speeds are in studs per second.
export function motionStats(samples, fps) {
  if (samples.length < 2) return { pathStuds: 0, peakSpeed: 0, peakFrame: samples[0]?.[0] ?? 0, holds: [], speeds: [] };

  const speeds = [];
  let path = 0;
  let peak = { speed: 0, frame: samples[0][0] };
  for (let i = 1; i < samples.length; i += 1) {
    const a = samples[i - 1];
    const b = samples[i];
    const distance = Math.hypot(b[1] - a[1], b[2] - a[2], b[3] - a[3]);
    const speed = (distance * fps) / (b[0] - a[0]);
    path += distance;
    speeds.push({ fromFrame: a[0], toFrame: b[0], speed: round(speed, 2) });
    if (speed > peak.speed) peak = { speed, frame: b[0] };
  }

  // Runs of near-zero speed: where the part is holding still.
  const holds = [];
  let start = null;
  const close = (endFrame) => {
    if (start !== null && (endFrame - start) / fps >= MIN_HOLD_SECONDS) holds.push({ fromFrame: start, toFrame: endFrame });
    start = null;
  };
  for (const step of speeds) {
    if (step.speed < HOLD_SPEED) {
      if (start === null) start = step.fromFrame;
    } else {
      close(step.fromFrame);
    }
  }
  close(speeds.at(-1).toFrame);

  return { pathStuds: round(path, 2), peakSpeed: round(peak.speed, 2), peakFrame: peak.frame, holds, speeds };
}
