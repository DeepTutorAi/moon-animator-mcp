// Camera path analysis: splits per-frame camera samples into shots at cuts and
// describes how the camera moves within each shot.
// A sample is [frame, px, py, pz, lookX, lookY, lookZ, fov], one per frame.

const NEIGHBORHOOD = 4;
const MIN_CUT_DISTANCE = 0.75; // studs in one frame
const MIN_CUT_ANGLE = 8; // degrees in one frame
const MIN_CUT_FOV = 8; // degrees in one frame
const OUTLIER_FACTOR = 6;
const STILL_DISTANCE = 0.05;
const STILL_ANGLE = 0.5;
const STILL_FOV = 0.5;

const round = (n, digits = 3) => Number(n.toFixed(digits));

function median(values) {
  if (values.length === 0) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  const mid = sorted.length >> 1;
  return sorted.length % 2 ? sorted[mid] : (sorted[mid - 1] + sorted[mid]) / 2;
}

function stepBetween(a, b) {
  const distance = Math.hypot(b[1] - a[1], b[2] - a[2], b[3] - a[3]);
  // atan2 of cross and dot stays accurate for the tiny per-frame angles acos cannot resolve.
  const dot = a[4] * b[4] + a[5] * b[5] + a[6] * b[6];
  const cross = Math.hypot(a[5] * b[6] - a[6] * b[5], a[6] * b[4] - a[4] * b[6], a[4] * b[5] - a[5] * b[4]);
  return { distance, angle: (Math.atan2(cross, dot) * 180) / Math.PI, fov: Math.abs(b[7] - a[7]) };
}

// A step is a cut when it jumps far more than the motion around it, so a fast
// but continuous move (whip pan) is not mistaken for one.
function isCut(steps, index) {
  const step = steps[index];
  const neighbors = [];
  for (let i = Math.max(0, index - NEIGHBORHOOD); i <= Math.min(steps.length - 1, index + NEIGHBORHOOD); i += 1) {
    if (i !== index) neighbors.push(steps[i]);
  }
  const exceeds = (key, minimum) =>
    step[key] >= minimum && step[key] > OUTLIER_FACTOR * median(neighbors.map((n) => n[key])) + minimum / 2;
  return exceeds('distance', MIN_CUT_DISTANCE) || exceeds('angle', MIN_CUT_ANGLE) || exceeds('fov', MIN_CUT_FOV);
}

function describeView(sample) {
  return {
    position: [sample[1], sample[2], sample[3]],
    look: [round(sample[4]), round(sample[5]), round(sample[6])],
    fov: sample[7],
  };
}

function describeShot(samples, steps, startIndex, endIndex, fps, number) {
  const first = samples[startIndex];
  const last = samples[endIndex];
  let travel = 0;
  let rotation = 0;
  for (let i = startIndex; i < endIndex; i += 1) {
    travel += steps[i].distance;
    rotation += steps[i].angle;
  }

  const movement = [];
  if (travel >= STILL_DISTANCE) {
    // Net displacement along the starting view direction tells a push-in from a sideways move.
    const net = [last[1] - first[1], last[2] - first[2], last[3] - first[3]];
    const forward = net[0] * first[4] + net[1] * first[5] + net[2] * first[6];
    const netLength = Math.hypot(...net);
    if (netLength > 0 && Math.abs(forward) / netLength > 0.7) {
      movement.push(forward > 0 ? 'push-in' : 'pull-out');
    } else {
      movement.push('travel');
    }
  }
  if (rotation >= STILL_ANGLE) movement.push('rotate');
  if (Math.abs(last[7] - first[7]) >= STILL_FOV) movement.push(last[7] < first[7] ? 'zoom-in' : 'zoom-out');
  if (movement.length === 0) movement.push('static');

  return {
    shot: number,
    startFrame: first[0],
    endFrame: last[0],
    durationSeconds: round((last[0] - first[0] + 1) / fps, 2),
    movement,
    travelStuds: round(travel, 2),
    rotationDegrees: round(rotation, 1),
    start: describeView(first),
    end: describeView(last),
  };
}

export function analyzeCameraPath(samples, fps) {
  if (samples.length === 0) return { cuts: [], shots: [] };

  const steps = [];
  for (let i = 1; i < samples.length; i += 1) steps.push(stepBetween(samples[i - 1], samples[i]));

  const cuts = [];
  const shots = [];
  let startIndex = 0;
  for (let i = 0; i < steps.length; i += 1) {
    if (isCut(steps, i)) {
      // The cut lands on the frame after step i.
      cuts.push(samples[i + 1][0]);
      shots.push(describeShot(samples, steps, startIndex, i, fps, shots.length + 1));
      startIndex = i + 1;
    }
  }
  shots.push(describeShot(samples, steps, startIndex, samples.length - 1, fps, shots.length + 1));
  return { cuts, shots };
}

// Frames worth looking at, at most `limit`: every shot gets at least one frame
// and longer shots get more, so the action in the middle of a long shot is
// not skipped. One frame shows the middle of a shot, two its start and end,
// more are spread evenly from start to end.
export function pickStoryboardFrames(shots, limit) {
  if (shots.length === 0 || limit <= 0) return [];

  if (shots.length >= limit) {
    const middles = shots.map((shot) => Math.round((shot.startFrame + shot.endFrame) / 2));
    return evenlySpaced(0, middles.length - 1, limit).map((index) => middles[index]);
  }

  const lengths = shots.map((shot) => shot.endFrame - shot.startFrame + 1);
  const total = lengths.reduce((sum, length) => sum + length, 0);
  const spare = limit - shots.length;
  const shares = lengths.map((length) => (spare * length) / total);
  const counts = shares.map((share) => 1 + Math.floor(share));
  // Hand out what rounding left over, largest remainder first.
  const byRemainder = shares.map((share, index) => ({ index, remainder: share - Math.floor(share) }));
  byRemainder.sort((a, b) => b.remainder - a.remainder);
  let left = limit - counts.reduce((sum, count) => sum + count, 0);
  for (const { index } of byRemainder) {
    if (left <= 0) break;
    counts[index] += 1;
    left -= 1;
  }

  const frames = [];
  shots.forEach((shot, index) => {
    const count = Math.min(counts[index], lengths[index]);
    if (count === 1) frames.push(Math.round((shot.startFrame + shot.endFrame) / 2));
    else frames.push(...evenlySpaced(shot.startFrame, shot.endFrame, count));
  });
  return [...new Set(frames)].sort((a, b) => a - b);
}

export function evenlySpaced(from, to, count) {
  if (count <= 1 || to <= from) return [from];
  const frames = [];
  for (let i = 0; i < count; i += 1) frames.push(Math.round(from + ((to - from) * i) / (count - 1)));
  return [...new Set(frames)];
}
