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
    const prev = { x: pilot.state.position.x, y: pilot.state.position.y, z: pilot.state.position.z, heading: pilot.state.heading, distance: pilot.state.distance };
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
    const body = s.pitch - Math.atan(s.grade);
    assert.ok(Math.abs(body) < 0.05 && Math.abs(s.roll) < 0.08, `body pitch ${body}, roll ${s.roll}`);
  });
  assert.ok(frames < 200, `${frames} frames at 60x`);
  assert.ok(Math.hypot(pilot.state.position.x - end.x, pilot.state.position.z - end.z) < 1e-6);
  assert.ok(Math.abs(pilot.state.position.y - slow.position.y) < 1e-6);
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

// Fixture v2 profile (raw centreline metres): flat at 20 m, +5 % to a crest at 560 m, -4 % then gentler, a bridge
// 1434–1684 m, -3 % into a sag at 1780 m, +2 % through the tunnel 1873–2273 m
test('elevation follows pathY continuously and pitch follows the grade', () => {
  for (const [dt, timeScale] of [[1 / 60, 1], [1 / 30, 60]]) {
    const pilot = createAutopilot(route);
    assert.ok(Math.abs(pilot.state.position.y - 20) < 0.01);
    let prevPitch = pilot.state.pitch;
    let prevGrade = pilot.state.grade;
    drive(pilot, dt, timeScale, (s, prev) => {
      const moved = Math.hypot(s.position.x - prev.x, s.position.z - prev.z);
      // An inside lane is shorter than the centreline, so its grade can exceed the profile's in tight corners: at 1x
      // check against the grade itself, at 60x (metres per frame) against the steepest the fixture's corner gets
      const steepest = timeScale > 1 ? 0.1 : Math.max(Math.abs(s.grade), Math.abs(prevGrade)) + 0.005;
      const rise = moved * steepest + 1e-6;
      assert.ok(Math.abs(s.position.y - prev.y) <= rise, `y step ${s.position.y - prev.y} over ${moved} m`);
      prevGrade = s.grade;
      assert.ok(Math.abs(s.pitch - prevPitch) <= 0.02 + moved * 0.002, `pitch step at ${s.distance} m`);
      prevPitch = s.pitch;
    });
  }
  const pilot = createAutopilot(route);
  const at = (d) => pilot.jumpTo(d);
  assert.ok(at(350).pitch > 0.045 && at(350).pitch < 0.055, `climb pitch ${at(350).pitch}`);
  assert.ok(Math.abs(at(350).position.y - 29.5) < 0.2, `y ${at(350).position.y}`);
  assert.ok(at(560).position.y > 38.5 && at(560).position.y < 40, `crest rounded, ${at(560).position.y}`);
  assert.ok(at(700).pitch < -0.035, `descent pitch ${at(700).pitch}`);
  assert.ok(at(1760).grade < 0 && at(1820).grade > 0, 'down into the sag, up out of it');
  assert.ok(at(2000).grade > 0.015 && at(2000).grade < 0.025, 'straight climb through the tunnel');
});

test('without pathY the car stays on y = 0', () => {
  const flat = { ...route, pathY: undefined };
  const pilot = createAutopilot(flat);
  drive(pilot, 0.5, 4, (s) => assert.ok(s.position.y === 0 && s.grade === 0 && s.pitch === s.pitch));
  assert.equal(pilot.state.finished, true);
});

test('bridge and tunnel flags; tunnelDepth ramps over ~40 m from each portal and is continuous', () => {
  const pilot = createAutopilot(route);
  const at = (d) => pilot.jumpTo(d);
  assert.ok(at(1550).bridge && !at(1550).tunnel);
  assert.ok(!at(1300).bridge && !at(1800).tunnel && at(1800).tunnelDepth === 0);
  assert.ok(at(2000).tunnel && at(2000).tunnelDepth === 1);
  assert.ok(Math.abs(at(1893).tunnelDepth - 0.5) < 0.05, `depth ${at(1893).tunnelDepth} 20 m in`);
  assert.ok(Math.abs(at(2253).tunnelDepth - 0.5) < 0.05, `depth ${at(2253).tunnelDepth} 20 m before the exit`);
  for (const [dt, timeScale] of [[1 / 60, 1], [1 / 60, 60]]) {
    const run = createAutopilot(route);
    let prevDepth = 0;
    let inside = 0;
    drive(run, dt, timeScale, (s, prev) => {
      assert.ok(Math.abs(s.tunnelDepth - prevDepth) <= (s.distance - prev.distance) / 38 + 1e-6, `depth jump at ${s.distance}`);
      prevDepth = s.tunnelDepth;
      if (s.tunnel) inside++;
    });
    assert.ok(inside > 0 && prevDepth === 0);
  }
});

// A synthetic motorway: points every 100 m, a long straight, a 1.5 km radius curve, a steep -6 % downgrade, a tunnel
// and an exit ramp (motorway_link) at the end
function motorway(km = 14, wiggle = false) {
  const path = [];
  const pathY = [];
  let x = 0, z = 0, h = 0, y = 100;
  const n = km * 10 + 1;
  for (let i = 0; i < n; i++) {
    path.push(x, z);
    pathY.push(Math.round(y * 10) / 10);
    const d = i * 100;
    h += wiggle ? 0.02 * Math.sin(i / 17) : d >= 3000 && d < 5000 ? 100 / 1500 : 0;
    y += wiggle ? 2 * Math.sin(i / 23) : d >= 6000 && d < 8000 ? -6 : 0;
    x += Math.sin(h) * 100;
    z -= Math.cos(h) * 100;
  }
  const base = { highway: 'motorway', name: '경부고속도로', ref: '1', lanes: 4, oneway: true, maxspeed: 110, tunnel: false, bridge: false, layer: 0 };
  const segments = wiggle ? [{ ...base, i0: 0, i1: n - 1 }] : [
    { ...base, i0: 0, i1: 90 },
    { ...base, i0: 90, i1: 110, tunnel: true, name: '터널', layer: -1 },
    { ...base, i0: 110, i1: 125 },
    { ...base, i0: 125, i1: n - 1, highway: 'motorway_link', lanes: 1, maxspeed: 80 }
  ];
  return { version: 2, id: `motorway-${km}`, path, pathY, segments, signals: [] };
}

test('motorway: cruises at 100-110 km/h, slows for a steep downgrade and on the exit ramp', () => {
  for (const [dt, timeScale] of [[1 / 60, 1], [1 / 30, 60]]) {
    const pilot = createAutopilot(motorway());
    let cruise = 0, downhill = Infinity, ramp = 0, tunnel = 0;
    drive(pilot, dt, timeScale, (s) => {
      const kmh = s.speed * 3.6;
      if (s.distance > 1000 && s.distance < 2800) cruise = Math.max(cruise, kmh);
      if (s.distance > 6500 && s.distance < 7800) downhill = Math.min(downhill, kmh);
      if (s.distance > 12800) ramp = Math.max(ramp, kmh);
      if (s.tunnel) tunnel = Math.max(tunnel, kmh);
      assert.ok(kmh <= 110 + 1e-6);
    });
    assert.ok(cruise >= 100 && cruise <= 110, `cruise ${cruise} km/h`);
    assert.ok(downhill < 100 && downhill > 80, `-6 % downgrade ${downhill} km/h`);
    assert.ok(tunnel >= 100, `tunnel ${tunnel} km/h`);
    assert.ok(ramp <= 60, `ramp ${ramp} km/h`);
    assert.equal(pilot.state.finished, true);
  }
});

// (The bake, ~0.2 s natively for 400 km, takes seconds under the test's vm context, so only frames are timed here)
test('a 400 km route: frames stay cheap at 60x', () => {
  const pilot = createAutopilot(motorway(400, true), { startDistance: 200000 });
  assert.ok(Math.abs(pilot.length - 400000) < 1);
  const t = performance.now();
  for (let i = 0; i < 600; i++) pilot.update(1 / 60, 60);
  const perFrame = (performance.now() - t) / 600;
  assert.ok(perFrame < 0.5, `${perFrame} ms per frame`);
  assert.ok(pilot.state.speed * 3.6 > 90 && Number.isFinite(pilot.state.position.y));
});
