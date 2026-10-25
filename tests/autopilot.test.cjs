const assert = require('node:assert/strict');
const { readFileSync } = require('node:fs');
const { join } = require('node:path');
const test = require('node:test');
const { loadModule } = require('./helpers/module.cjs');

const source = readFileSync(join(__dirname, '../js/drive/autopilot.js'), 'utf8');
const route = JSON.parse(readFileSync(join(__dirname, 'fixtures/drive-route.json'), 'utf8'));

class Vector3 {
  constructor(x = 0, y = 0, z = 0) { this.set(x, y, z); }
  set(x, y, z) { this.x = x; this.y = y; this.z = z; return this; }
}
const { createAutopilot } = loadModule(source, { imports: { 'three/webgpu': { Vector3 } }, filename: 'autopilot.js' });

// Drives to the end, calling visit(state, dt) after every frame
function drive(pilot, dt, timeScale, visit = () => {}, maxFrames = 1e6) {
  for (let frame = 0; frame < maxFrames && !pilot.state.finished; frame++) {
    const prev = { x: pilot.state.position.x, z: pilot.state.position.z, heading: pilot.state.heading, distance: pilot.state.distance };
    visit(pilot.update(dt, timeScale), prev, dt * timeScale);
  }
  return pilot.state;
}

test('the car moves continuously: no position or heading jumps between frames', () => {
  const pilot = createAutopilot(route);
  let maxHeadingRate = 0;
  drive(pilot, 1 / 60, 1, (s, prev, h) => {
    const moved = Math.hypot(s.position.x - prev.x, s.position.z - prev.z);
    assert.ok(moved <= s.limit * 1.1 * h + 1e-6, `moved ${moved} m in ${h} s`);
    maxHeadingRate = Math.max(maxHeadingRate, Math.abs(s.heading - prev.heading) / h);
  });
  // Even the raw 90-degree corner becomes a gentle turn (yaw rate of a city corner, not a snap)
  assert.ok(maxHeadingRate < 0.8, `max yaw rate ${maxHeadingRate} rad/s`);
});

test('speed never exceeds the posted limit and the lateral acceleration stays comfortable', () => {
  const pilot = createAutopilot(route);
  let maxLateral = 0;
  drive(pilot, 1 / 30, 1, (s) => {
    assert.ok(s.speed <= (s.segment.maxspeed / 3.6) + 1e-6, `${s.speed} m/s on a ${s.segment.maxspeed} km/h road`);
    maxLateral = Math.max(maxLateral, s.speed * s.speed * Math.abs(s.curvature));
  });
  assert.ok(maxLateral < 2.6, `max lateral acceleration ${maxLateral} m/s²`);
});

test('the car stops and waits at the chosen signals, and reaches the end', () => {
  const pilot = createAutopilot(route);
  assert.ok(pilot.stops.length >= 1, 'at least one signal stop chosen');
  // The same route picks the same signals
  assert.deepEqual(createAutopilot(route).stops, pilot.stops);
  const waited = new Map();
  let time = 0;
  drive(pilot, 0.1, 1, (s) => {
    time += 0.1;
    if (s.waiting) {
      assert.equal(s.speed, 0);
      const key = Math.round(s.distance);
      waited.set(key, (waited.get(key) || 0) + 0.1);
    }
  });
  assert.equal(waited.size, pilot.stops.length);
  for (const stop of pilot.stops) {
    const wait = waited.get(Math.round(stop.at));
    assert.ok(wait >= 10 - 0.2 && wait <= 40 + 0.2, `waited ${wait} s at ${stop.at} m`);
  }
  assert.equal(pilot.state.finished, true);
  assert.equal(pilot.state.speed, 0);
  assert.ok(Math.abs(pilot.state.distance - pilot.length) < 1e-6);
  assert.ok(time < 1200, `finished in ${time} s`);
});

test('large time scales stay stable and reach the same end', () => {
  const slow = drive(createAutopilot(route), 1 / 60, 1);
  const end = { x: slow.position.x, z: slow.position.z };
  const pilot = createAutopilot(route);
  let frames = 0;
  drive(pilot, 0.25, 60, (s) => {
    frames++;
    assert.ok(Number.isFinite(s.position.x) && Number.isFinite(s.pitch) && Number.isFinite(s.roll));
    assert.ok(Math.abs(s.pitch) < 0.05 && Math.abs(s.roll) < 0.08, `pitch ${s.pitch}, roll ${s.roll}`);
  });
  assert.ok(frames < 200, `${frames} frames at 60x`);
  assert.ok(Math.hypot(pilot.state.position.x - end.x, pilot.state.position.z - end.z) < 1e-6);
});

test('the car keeps to the right of the centreline and jumpTo resumes mid-route', () => {
  const pilot = createAutopilot(route);
  pilot.jumpTo(300);
  const s = pilot.state;
  // First leg runs north along x = 0 on a two-way 6-lane road: the right lane is east (+x) of it
  assert.ok(s.position.x > 5 && s.position.x < 9, `lane offset ${s.position.x}`);
  assert.ok(Math.abs(s.heading) < 0.01);
  assert.ok(Math.abs(s.distance - 300) < 1e-9);
  const before = s.distance;
  pilot.update(1, 1);
  assert.ok(s.distance > before);
});
