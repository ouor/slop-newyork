import { Vector3 } from 'three/webgpu';

// js/drive/autopilot.js
// Drives the player car along a route.json path (see docs/drive.md). Pure logic, no scene access.
// - The raw OSM centreline (sharp kinks at every intersection) is resampled every metre of raw arc length, smoothed
//   by three box-filter passes (≈ a Gaussian, σ ≈ 7 m + the lane offset) and offset to the right into the driven lane.
// - A speed profile is baked once: the posted limit (a touch under it), capped by curvature for a comfortable lateral
//   acceleration, then swept backwards so the car brakes early enough for every curve and lower limit ahead.
// - At run time the car accelerates gently up to the profile, brakes to a stop line before a seeded subset of the
//   traffic signals (waits 10–40 s) and rolls to a stop at the end of the route.
// - `state.distance` is measured along the raw centreline (the same metric as route-data's `cumulative` /
//   `pointAt`), so callers can stream tiles and jump by distance without knowing about the smoothing.
// - Extra state beyond the contract: `curvature` (1/m, + = right turn; drives the steering wheel), `accel` (m/s²),
//   `limit` (current speed limit, m/s), `waiting` (stopped at a signal). `heading` is continuous (unwrapped), so it
//   can exceed ±π on routes that loop; pitch is + nose up, roll is + right side down.

const STEP = 1; // m of raw centreline between samples
const MIN_TURN_RADIUS = 7; // m: three box passes of half-width W round a right-angle corner to a radius of ≈ W
const LANE_SMOOTH_RADIUS = 25; // samples: lane offset changes blend over ~150 m
const LANE_WIDTH = 3.2;
const LIMIT_FACTOR = 0.95; // cruise a touch under the posted limit
const LATERAL_ACCEL = 2.2; // m/s²
const ACCEL = 1.5; // m/s²
const BRAKE = 2.5; // m/s²
const MAX_SUBSTEP = 0.05; // s of simulated time per integration step
const STOP_LINE_SETBACK = 10; // m before the signal node (usually the intersection centre)
const SIGNAL_CLUSTER = 60; // m: a signal this close after a stop is the same junction (dual carriageway), never stop twice
const SIGNAL_STOP_SHARE = 0.5;
const PITCH_PER_ACCEL = 0.006; // rad per m/s² (nose dips under braking, squats when pulling away)
const ROLL_PER_ACCEL = 0.012; // rad per m/s² of lateral acceleration (body leans out of the turn)

// Small deterministic integer hash -> [0, 1)
function hash01(n) {
  n = Math.imul(n ^ (n >>> 16), 0x45d9f3b);
  n = Math.imul(n ^ (n >>> 16), 0x45d9f3b);
  return ((n ^ (n >>> 16)) >>> 0) / 4294967296;
}

function stringSeed(text) {
  let h = 2166136261;
  for (let i = 0; i < text.length; i++) h = Math.imul(h ^ text.charCodeAt(i), 16777619);
  return h >>> 0;
}

// In-place running mean of half-width r (a number, or one per sample), applied `passes` times. A fractional width
// blends the means of the two neighbouring integer windows, so a smoothly varying width gives a smooth result.
function boxSmooth(values, r, passes = 3) {
  const n = values.length;
  const prefix = new Float64Array(n + 1);
  const mean = (i, w) => {
    // Shrink the window symmetrically at the ends so the start and end points stay put
    w = Math.min(i, n - 1 - i, w);
    return (prefix[i + w + 1] - prefix[i - w]) / (2 * w + 1);
  };
  for (let pass = 0; pass < passes; pass++) {
    for (let i = 0; i < n; i++) prefix[i + 1] = prefix[i] + values[i];
    for (let i = 0; i < n; i++) {
      const w = typeof r === 'number' ? r : r[i];
      const w0 = Math.floor(w);
      values[i] = w === w0 ? mean(i, w0) : mean(i, w0) + (mean(i, w0 + 1) - mean(i, w0)) * (w - w0);
    }
  }
  return values;
}

// Centre of the driven lane, metres to the right of the road centreline
function laneOffset(segment, lane) {
  const lanes = Math.max(1, segment.lanes || 2);
  if (segment.oneway) {
    const half = (lanes - 1) * 0.5 * LANE_WIDTH;
    return lane === 'left' ? -half : half;
  }
  const perSide = Math.max(1, Math.ceil(lanes / 2));
  return lane === 'left' ? LANE_WIDTH * 0.5 : (perSide - 0.5) * LANE_WIDTH;
}

/**
 * Bakes the drivable curve: per-sample position, heading, curvature, segment, step stretch & speed profile.
 */
function bakeRoute(route, lane) {
  const path = route.path;
  const count = path.length / 2;
  if (count < 2) throw new Error('autopilot: route.path needs at least two points');
  let cumulative = route.cumulative;
  if (!cumulative || cumulative.length !== count) {
    cumulative = new Float64Array(count);
    for (let i = 1; i < count; i++) {
      cumulative[i] = cumulative[i - 1] + Math.hypot(path[2 * i] - path[2 * i - 2], path[2 * i + 1] - path[2 * i - 1]);
    }
  }
  const length = cumulative[count - 1];
  const segments = route.segments?.length ? route.segments : [{ i0: 0, i1: count - 1, lanes: 2, oneway: false, maxspeed: 50 }];
  const segmentOfPoint = new Int32Array(count);
  segments.forEach((seg, k) => {
    for (let i = seg.i0; i <= Math.min(seg.i1, count - 1); i++) segmentOfPoint[i] = k;
  });

  // 1. Resample every STEP m of raw arc length
  const n = Math.max(2, Math.floor(length / STEP) + 1);
  const px = new Float64Array(n);
  const pz = new Float64Array(n);
  const offset = new Float64Array(n);
  const segIndex = new Int32Array(n);
  let j = 0;
  for (let i = 0; i < n; i++) {
    const s = Math.min(i * STEP, length);
    while (j < count - 2 && cumulative[j + 1] <= s) j++;
    const span = cumulative[j + 1] - cumulative[j];
    const t = span > 1e-9 ? (s - cumulative[j]) / span : 0;
    px[i] = path[2 * j] + (path[2 * j + 2] - path[2 * j]) * t;
    pz[i] = path[2 * j + 1] + (path[2 * j + 3] - path[2 * j + 1]) * t;
    segIndex[i] = segmentOfPoint[j];
    offset[i] = laneOffset(segments[segIndex[i]], lane);
  }

  // 2. Smooth the lane offset, then the centreline (rounder on wide roads: an offset d to the inside of a turn of
  //    radius R leaves R - d, so the window grows with d to keep every lane's turn at least MIN_TURN_RADIUS), then
  //    push the curve sideways into the lane
  boxSmooth(offset, LANE_SMOOTH_RADIUS);
  const radius = new Float64Array(n);
  for (let i = 0; i < n; i++) radius[i] = (MIN_TURN_RADIUS + Math.abs(offset[i])) / STEP;
  boxSmooth(px, radius);
  boxSmooth(pz, radius);
  const heading = new Float64Array(n);
  for (let i = 0; i < n; i++) {
    const a = Math.max(0, i - 1);
    const b = Math.min(n - 1, i + 1);
    heading[i] = Math.atan2(px[b] - px[a], -(pz[b] - pz[a]));
  }
  const x = new Float64Array(n);
  const z = new Float64Array(n);
  for (let i = 0; i < n; i++) {
    // Right of heading h is (cos h, sin h) in (x, z)
    x[i] = px[i] + Math.cos(heading[i]) * offset[i];
    z[i] = pz[i] + Math.sin(heading[i]) * offset[i];
  }
  // A light pass removes the small ripples the offset leaves where the lane width changes inside a curve
  boxSmooth(x, 2, 1);
  boxSmooth(z, 2, 1);

  // 3. Final heading (unwrapped), stretch (driven metres per raw metre) and curvature
  const stretch = new Float64Array(n);
  for (let i = 0; i < n; i++) {
    const a = Math.max(0, i - 1);
    const b = Math.min(n - 1, i + 1);
    let h = Math.atan2(x[b] - x[a], -(z[b] - z[a]));
    if (i > 0) h = heading[i - 1] + Math.atan2(Math.sin(h - heading[i - 1]), Math.cos(h - heading[i - 1]));
    heading[i] = h;
    if (i < n - 1) stretch[i] = Math.max(0.2, Math.hypot(x[i + 1] - x[i], z[i + 1] - z[i]) / STEP);
  }
  stretch[n - 1] = stretch[n - 2];
  const curvature = new Float64Array(n);
  for (let i = 0; i < n; i++) {
    const a = Math.max(0, i - 1);
    const b = Math.min(n - 1, i + 1);
    curvature[i] = b > a ? (heading[b] - heading[a]) / ((b - a) * STEP * stretch[i]) : 0;
  }
  boxSmooth(curvature, 2, 1);

  // 4. Speed profile: posted limit, curvature cap, then a backward braking sweep
  const limit = new Float64Array(n);
  const profile = new Float64Array(n);
  for (let i = 0; i < n; i++) {
    limit[i] = ((segments[segIndex[i]].maxspeed || 50) / 3.6) * LIMIT_FACTOR;
    profile[i] = Math.min(limit[i], Math.sqrt(LATERAL_ACCEL / Math.max(Math.abs(curvature[i]), 1e-6)));
  }
  for (let i = n - 2; i >= 0; i--) {
    profile[i] = Math.min(profile[i], Math.sqrt(profile[i + 1] * profile[i + 1] + 2 * BRAKE * STEP * stretch[i]));
  }

  return { n, length, cumulative, segments, x, z, heading, curvature, stretch, limit, profile, segIndex };
}

// Seeded subset of the signals to stop at: [{ at: stop-line distance, wait: s }], in route order
function pickSignalStops(route, cumulative, seed) {
  const stops = [];
  let lastSignal = -Infinity;
  const signals = (route.signals || []).filter((i) => i >= 0 && i < cumulative.length).sort((a, b) => a - b);
  for (const index of signals) {
    const d = cumulative[index];
    const clustered = d - lastSignal < SIGNAL_CLUSTER;
    lastSignal = d;
    if (clustered || d < STOP_LINE_SETBACK) continue;
    if (hash01(seed ^ Math.imul(index + 1, 0x9e3779b1)) >= SIGNAL_STOP_SHARE) continue;
    stops.push({ index, at: d - STOP_LINE_SETBACK, wait: 10 + 30 * hash01(seed + index * 7919 + 1) });
  }
  return stops;
}

function createAutopilot(route, { lane = 'right', startDistance = 0, seed = stringSeed(String(route.id ?? 'route')) } = {}) {
  const baked = bakeRoute(route, lane);
  const { n, length, x, z, heading, curvature, stretch, limit, profile, segIndex, segments } = baked;
  const stops = pickSignalStops(route, baked.cumulative, seed);

  const state = {
    distance: 0,
    position: new Vector3(),
    heading: 0,
    pitch: 0,
    roll: 0,
    speed: 0,
    segment: segments[0],
    finished: false,
    curvature: 0,
    accel: 0,
    limit: 0,
    waiting: false
  };

  let nextStop = 0; // index into stops of the next signal still ahead
  let waitLeft = 0; // s left at the current stop line
  // Pitch & roll follow their targets through a lightly underdamped spring, for a lively but calm camera
  let pitchVel = 0;
  let rollVel = 0;

  const sample = (array, s) => {
    const f = Math.min(Math.max(s / STEP, 0), n - 1);
    const i = Math.min(Math.floor(f), n - 2);
    const t = f - i;
    return array[i] + (array[i + 1] - array[i]) * t;
  };

  function writePose() {
    const s = state.distance;
    state.position.set(sample(x, s), 0, sample(z, s));
    state.heading = sample(heading, s);
    state.curvature = sample(curvature, s);
    const i = Math.min(Math.round(s / STEP), n - 1);
    state.segment = segments[segIndex[i]];
    state.limit = limit[i];
  }

  function step(h) {
    if (state.finished) return;
    const s = state.distance;
    if (waitLeft > 0) {
      waitLeft -= h;
      state.waiting = waitLeft > 0;
      if (!state.waiting) nextStop++;
      state.accel = 0;
      return;
    }
    // Distance to the next place the car must stand still: a chosen signal's stop line or the end of the route
    const stop = stops[nextStop];
    const target = stop ? Math.min(stop.at, length) : length;
    const toTarget = Math.max(0, target - s);
    const cap = Math.min(sample(profile, s), Math.sqrt(2 * BRAKE * toTarget));
    const v = Math.min(state.speed + ACCEL * h, cap);
    state.accel = (v - state.speed) / h;
    state.speed = v;
    // Driven metres -> raw centreline metres
    state.distance = Math.min(s + (v * h) / sample(stretch, s), target);
    if (target - state.distance < 0.02) {
      state.distance = target;
      state.speed = 0;
      if (stop && stop.at < length) {
        waitLeft = stop.wait;
        state.waiting = true;
      } else {
        state.finished = true;
      }
    }
  }

  function update(dt, timeScale = 1) {
    const total = Math.max(0, dt) * Math.max(0, timeScale);
    const steps = Math.ceil(total / MAX_SUBSTEP);
    const h = steps > 0 ? total / steps : 0;
    for (let k = 0; k < steps; k++) {
      step(h);
      writePose();
      // Body motion: nose dips with braking, leans out of turns (lateral accel v²κ is + towards the right)
      const pitchTarget = state.accel * PITCH_PER_ACCEL;
      const rollTarget = -state.speed * state.speed * state.curvature * ROLL_PER_ACCEL;
      const w = 7;
      pitchVel += ((pitchTarget - state.pitch) * w * w - 2 * 0.55 * w * pitchVel) * h;
      rollVel += ((rollTarget - state.roll) * w * w - 2 * 0.55 * w * rollVel) * h;
      state.pitch += pitchVel * h;
      state.roll += rollVel * h;
    }
    return state;
  }

  function jumpTo(distanceM) {
    state.distance = Math.min(Math.max(0, distanceM), length);
    state.finished = state.distance >= length;
    state.waiting = false;
    waitLeft = 0;
    nextStop = stops.findIndex((stop) => stop.at > state.distance);
    if (nextStop < 0) nextStop = stops.length;
    // Keep cruising if the profile allows it, so long-route jumps don't start from a standstill
    state.speed = Math.min(state.speed, sample(profile, state.distance));
    state.pitch = state.roll = pitchVel = rollVel = 0;
    writePose();
    return state;
  }

  jumpTo(startDistance);
  state.speed = 0;

  return { update, state, jumpTo, length, stops };
}

export { createAutopilot };
