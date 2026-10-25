const assert = require('node:assert/strict');
const { readFileSync } = require('node:fs');
const { join } = require('node:path');
const test = require('node:test');
const { loadModule } = require('./helpers/module.cjs');

const sky = loadModule(readFileSync(join(__dirname, '../js/drive/env-sky.js'), 'utf8'), { filename: 'env-sky.js' });

// The real TIME_PRESETS: only the preset table runs, so three.js is a vector and the rest empty stubs
class Vector3 {
  constructor(x, y, z) { Object.assign(this, { x, y, z }); }
  normalize() { const l = Math.hypot(this.x, this.y, this.z); this.x /= l; this.y /= l; this.z /= l; return this; }
}
const stub = new Proxy({}, { get: () => () => {} });
const { TIME_PRESETS } = loadModule(readFileSync(join(__dirname, '../js/lighting.js'), 'utf8'), {
  imports: {
    'three/webgpu': { Vector3 },
    'three/tsl': stub,
    'three/addons/objects/SkyMesh.js': stub,
    'three/addons/lights/SunLight.js': stub,
    'three/addons/lights/SunLightNode.js': stub,
    './tsl-materials.js': stub
  },
  filename: 'lighting.js'
});

const SEOUL = [37.5547, 126.9707];
const near = (a, b, tol, msg) => assert.ok(Math.abs(a - b) <= tol, `${msg}: ${a} vs ${b} ±${tol}`);

// Hour (KST) at which the sun crosses the horizon, by bisection between two hours on either side
function crossing(y, m, d, lo, hi) {
  const el = (h) => sky.solarPosition(...SEOUL, y, m, d, h).elevation + 0.83; // refraction + solar radius
  const rising = el(hi) > el(lo);
  for (let i = 0; i < 40; i++) {
    const mid = (lo + hi) / 2;
    if ((el(mid) > 0) === rising) hi = mid; else lo = mid;
  }
  return (lo + hi) / 2;
}

test('solar noon at the equinox stands at 90° - latitude, due south', () => {
  // Seoul (127° E) runs ~32 min behind KST's 135° meridian, plus ~7.5 min equation of time in March: ≈ 12:40 KST
  let best = { elevation: -90 };
  for (let h = 11; h <= 14; h += 1 / 120) {
    const s = sky.solarPosition(...SEOUL, 2026, 3, 20, h);
    if (s.elevation > best.elevation) best = { ...s, h };
  }
  near(best.elevation, 90 - SEOUL[0], 0.6, 'noon elevation');
  near(best.azimuth, 180, 1, 'noon azimuth');
  near(best.h, 12 + 40 / 60, 0.05, 'solar noon hour');
});

test('sunrise and sunset in Seoul fall at the published hours for the solstices', () => {
  // KASI: 21 Jun 2026 ≈ 05:11 / 19:57, 21 Dec 2026 ≈ 07:43 / 17:17
  near(crossing(2026, 6, 21, 3, 8), 5 + 11 / 60, 0.1, 'summer sunrise');
  near(crossing(2026, 6, 21, 17, 22), 19 + 57 / 60, 0.1, 'summer sunset');
  near(crossing(2026, 12, 21, 5, 10), 7 + 43 / 60, 0.1, 'winter sunrise');
  near(crossing(2026, 12, 21, 15, 20), 17 + 17 / 60, 0.1, 'winter sunset');
});

test('the world-frame sun vector points east in the morning and south at noon', () => {
  const m = sky.sunVector(90, 0);
  near(m.x, 1, 1e-9, 'east is +x');
  const n = sky.sunVector(180, 45);
  near(n.z, Math.SQRT1_2, 1e-9, 'south is +z');
  near(n.y, Math.SQRT1_2, 1e-9, 'up is +y');
  const s = sky.sunVector(...Object.values(sky.solarPosition(...SEOUL, 2026, 6, 21, 8)));
  near(Math.hypot(s.x, s.y, s.z), 1, 1e-9, 'unit length');
  assert.ok(s.x > 0.5 && s.y > 0, 'summer morning sun is in the east and up');
});

test('the KST calendar day of a Date does not depend on the browser time zone', () => {
  assert.deepEqual({ ...sky.kstDay(new Date('2026-06-21T00:00:00Z')) }, { year: 2026, month: 6, day: 21 });
  assert.deepEqual({ ...sky.kstDay(new Date('2026-06-20T16:00:00Z')) }, { year: 2026, month: 6, day: 21 });
  assert.deepEqual({ ...sky.kstDay('2026-12-21') }, { year: 2026, month: 12, day: 21 });
});

test('time-of-day blending reproduces the presets and has no jumps', () => {
  const at = (el, morning) => sky.blendTimeParams(el, TIME_PRESETS, morning);
  assert.equal(at(-30).skyExposure, TIME_PRESETS.midnight.skyExposure);
  assert.equal(at(6).sunIntensity, TIME_PRESETS.golden.sunIntensity);
  assert.equal(at(70).sunColor, TIME_PRESETS.midday.sunColor);
  for (const morning of [false, true]) {
    let prev = at(-40, morning);
    for (let el = -40; el <= 80; el += 0.05) {
      const p = at(el, morning);
      for (const key of Object.keys(p)) {
        const step = key.endsWith('Color') || /^(hemi(Sky|Ground)|sky(Top|Horizon))$/.test(key)
          ? Math.max(...[16, 8, 0].map((s) => Math.abs(((p[key] >> s) & 255) - ((prev[key] >> s) & 255))))
          : Math.abs(p[key] - prev[key]) / (Math.abs(prev[key]) + 1e-3);
        assert.ok(step < 3, `${key} jumps at ${el.toFixed(2)}° (${morning ? 'morning' : 'evening'})`);
      }
      prev = p;
    }
  }
  assert.ok(at(-20).nightFactor > at(-3).nightFactor && at(-3).nightFactor > at(20).nightFactor);
  assert.ok(at(-20).interiorGlow > at(40).interiorGlow, 'windows light up at night');
});

test('weather transitions ramp monotonically to their target and stop there', () => {
  let v = 0;
  let prev = v;
  let t = 0;
  while (v < 1) {
    v = sky.stepToward(v, 1, 1 / 6, 1 / 60);
    assert.ok(v >= prev && v <= 1);
    prev = v;
    t += 1 / 60;
  }
  near(t, 6, 0.05, 'six-second transition');
  assert.equal(sky.stepToward(0.5, 0.2, 10, 1), 0.2, 'no overshoot');
  // Graded lighting moves one way as cloud thickens
  const base = sky.blendTimeParams(40, TIME_PRESETS);
  let last = sky.applyWeather({ ...base }, 0, 0);
  for (let c = 0.1; c <= 1.0001; c += 0.1) {
    const p = sky.applyWeather({ ...base }, c, c);
    assert.ok(p.sunIntensity < last.sunIntensity && p.fogDensity > last.fogDensity && p.cloudCoverage > last.cloudCoverage);
    last = p;
  }
});

test('tunnel enclosure: identity when open, continuous, darker and lamp-tinted inside, dry road', () => {
  const base = sky.applyWeather(sky.blendTimeParams(40, TIME_PRESETS), 1, 1);
  base.roadWetness = 0.9;
  const at = (t, lamp) => sky.applyEnclosure({ ...base }, t, lamp);
  assert.deepEqual({ ...at(0) }, { ...base });
  let prev = at(0);
  for (let t = 0.01; t <= 1.0001; t += 0.01) {
    const p = at(t);
    for (const key of ['sunIntensity', 'envIntensity', 'hemiIntensity', 'roadWetness', 'canyonBounce']) {
      assert.ok(Math.abs(p[key] - prev[key]) <= 0.05 * Math.max(1, Math.abs(base[key])), `${key} jumps at ${t}`);
    }
    assert.ok(p.sunIntensity < prev.sunIntensity && p.envIntensity < prev.envIntensity && p.roadWetness < prev.roadWetness);
    prev = p;
  }
  assert.ok(prev.sunIntensity < 0.06 * base.sunIntensity && prev.envIntensity < 0.21 * base.envIntensity);
  assert.equal(prev.hemiSky, sky.TUNNEL_LAMPS.led);
  assert.equal(at(1, sky.TUNNEL_LAMPS.sodium).hemiSky, sky.TUNNEL_LAMPS.sodium);
  assert.equal(prev.skyExposure, base.skyExposure, 'the sky through the portals keeps its brightness');
  assert.equal(at(5).sunIntensity, at(1).sunIntensity, 'clamped');
});

// createEnvironment with three.js, the lighting system, rain and glass stubbed: what reaches the lights per frame
class Color {
  constructor(hex = 0) { this.set(hex); }
  set(hex) {
    if (typeof hex !== 'number') return this.copy(hex);
    this.r = ((hex >> 16) & 255) / 255;
    this.g = ((hex >> 8) & 255) / 255;
    this.b = (hex & 255) / 255;
    return this;
  }
  copy(c) { this.r = c.r; this.g = c.g; this.b = c.b; return this; }
  clone() { return new Color().copy(this); }
  multiplyScalar(s) { this.r *= s; this.g *= s; this.b *= s; return this; }
  lerp(c, t) { this.r += (c.r - this.r) * t; this.g += (c.g - this.g) * t; this.b += (c.b - this.b) * t; return this; }
}
class Vec3 {
  constructor(x = 0, y = 0, z = 0) { this.set(x, y, z); }
  set(x, y, z) { this.x = x; this.y = y; this.z = z; return this; }
  copy(v) { return this.set(v.x, v.y, v.z); }
  distanceTo(v) { return Math.hypot(this.x - v.x, this.y - v.y, this.z - v.z); }
}

function stubEnvironment() {
  const rainAmounts = [];
  const lighting = {
    uNightSkyColor: { value: new Color(0x101830) },
    bakes: 0,
    applied: null,
    applyParams(p) { this.applied = { ...p }; },
    bakeEnvironmentMap() { this.bakes++; }
  };
  const { createEnvironment, tunnelUniforms } = loadModule(readFileSync(join(__dirname, '../js/drive/environment.js'), 'utf8'), {
    imports: {
      'three/webgpu': { Color, Vector3: Vec3 },
      'three/tsl': { uniform: (value) => ({ value }) },
      '../lighting.js': { TIME_PRESETS },
      './env-sky.js': sky,
      './weather-rain.js': { createRain: () => ({ mesh: {}, update: (dt, amount) => rainAmounts.push(amount) }) },
      './weather-windshield.js': { createWindshieldMaterial: stub, createWiper: stub }
    },
    filename: 'environment.js'
  });
  const env = createEnvironment({ scene: { add() {} }, renderer: null, lighting, route: { origin: { lat: SEOUL[0], lon: SEOUL[1] } } });
  env.setDate('2026-06-21');
  env.setTime(13);
  env.setWeather('rain', true);
  env.update(1 / 60, null, null);
  return { env, lighting, rainAmounts, tunnelUniforms };
}

test('setEnclosure is cheap, reversible and stops the rain, driving the fixture tunnel at 1x and 60x', () => {
  const { createAutopilot } = loadModule(readFileSync(join(__dirname, '../js/drive/autopilot.js'), 'utf8'), {
    imports: { 'three/webgpu': { Vector3: Vec3 } },
    filename: 'autopilot.js'
  });
  const route = JSON.parse(readFileSync(join(__dirname, 'fixtures/drive-route.json'), 'utf8'));
  for (const timeScale of [1, 60]) {
    const { env, lighting, rainAmounts, tunnelUniforms } = stubEnvironment();
    const open = lighting.applied;
    const bakes = lighting.bakes;
    const pilot = createAutopilot(route);
    pilot.jumpTo(1700);
    let prevDepth = 0;
    let prevSun = open.sunIntensity;
    let deep = false;
    while (!pilot.state.finished) {
      const s = pilot.update(1 / 60, timeScale);
      env.setEnclosure(s.tunnelDepth, 'sodium');
      env.update(1 / 60, null, s);
      const sun = lighting.applied.sunIntensity;
      assert.ok(Math.abs(sun - prevSun) <= open.sunIntensity * Math.abs(s.tunnelDepth - prevDepth) + 1e-9, `sun jumps at ${s.distance} m`);
      assert.equal(tunnelUniforms.uEnclosure.value, s.tunnelDepth);
      if (s.tunnelDepth === 1) {
        deep = true;
        assert.equal(rainAmounts[rainAmounts.length - 1], 0, 'no rain under the roof');
        assert.ok(lighting.applied.envIntensity < 0.21 * open.envIntensity);
      }
      prevDepth = s.tunnelDepth;
      prevSun = sun;
    }
    assert.ok(deep, `went through the tunnel at ${timeScale}x`);
    assert.equal(lighting.bakes, bakes, 'no environment re-bake for the tunnel');
    assert.equal(rainAmounts[rainAmounts.length - 1], 1, 'rain again after the exit');
    for (const key of ['sunIntensity', 'hemiIntensity', 'envIntensity', 'hemiSky', 'fogColor', 'roadWetness']) {
      assert.equal(lighting.applied[key], open[key], `${key} restored after the tunnel`);
    }
    assert.ok(Math.abs(tunnelUniforms.uLampColor.value.r - 1) < 1e-9 && tunnelUniforms.uLampColor.value.b < 0.5, 'sodium lamps');
    assert.throws(() => env.setEnclosure(1, 'neon'));
  }
});
