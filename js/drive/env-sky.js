// js/drive/env-sky.js
// Pure time-of-day / weather maths for the drive environment (no three.js, unit-tested in tests/drive-env.test.cjs):
// NOAA solar position, sun-elevation keyed blending of the LightingSystem presets, and the overcast / rain grade.

const RAD = Math.PI / 180;
const KST = 9;

// Solar azimuth (deg clockwise from north) and elevation (deg, no refraction) at a local civil time.
// NOAA spreadsheet approximation (good to ~0.1° over 1900-2100), date given as its local calendar day.
function solarPosition(latDeg, lonDeg, year, month, day, hours, tzHours = KST) {
  const jd = Date.UTC(year, month - 1, day) / 864e5 + 2440587.5 + (hours - tzHours) / 24;
  const t = (jd - 2451545) / 36525;
  const L0 = (280.46646 + t * (36000.76983 + t * 0.0003032)) % 360;
  const M = 357.52911 + t * (35999.05029 - 0.0001537 * t);
  const e = 0.016708634 - t * (0.000042037 + 0.0000001267 * t);
  const C = Math.sin(M * RAD) * (1.914602 - t * (0.004817 + 0.000014 * t)) +
    Math.sin(2 * M * RAD) * (0.019993 - 0.000101 * t) + Math.sin(3 * M * RAD) * 0.000289;
  const omega = 125.04 - 1934.136 * t;
  const lambda = L0 + C - 0.00569 - 0.00478 * Math.sin(omega * RAD);
  const eps0 = 23 + (26 + (21.448 - t * (46.815 + t * (0.00059 - t * 0.001813))) / 60) / 60;
  const eps = eps0 + 0.00256 * Math.cos(omega * RAD);
  const decl = Math.asin(Math.sin(eps * RAD) * Math.sin(lambda * RAD));
  const y = Math.tan(eps * RAD / 2) ** 2;
  const eqTime = 4 / RAD * (y * Math.sin(2 * L0 * RAD) - 2 * e * Math.sin(M * RAD) +
    4 * e * y * Math.sin(M * RAD) * Math.cos(2 * L0 * RAD) - 0.5 * y * y * Math.sin(4 * L0 * RAD) -
    1.25 * e * e * Math.sin(2 * M * RAD));
  const trueSolarMin = hours * 60 + eqTime + 4 * lonDeg - 60 * tzHours;
  const ha = (trueSolarMin / 4 - 180) * RAD;
  const lat = latDeg * RAD;
  const sinEl = Math.sin(lat) * Math.sin(decl) + Math.cos(lat) * Math.cos(decl) * Math.cos(ha);
  const elevation = Math.asin(Math.max(-1, Math.min(1, sinEl))) / RAD;
  const az = Math.atan2(Math.sin(ha), Math.cos(ha) * Math.sin(lat) - Math.tan(decl) * Math.cos(lat)) / RAD + 180;
  return { azimuth: (az + 360) % 360, elevation };
}

// World frame of docs/drive.md: x = east, y = up, z = south
function sunVector(azimuthDeg, elevationDeg) {
  const az = azimuthDeg * RAD;
  const el = elevationDeg * RAD;
  return { x: Math.cos(el) * Math.sin(az), y: Math.sin(el), z: -Math.cos(el) * Math.cos(az) };
}

// Calendar day in KST of a Date (or 'YYYY-MM-DD' string): the same day wherever the browser is
function kstDay(date) {
  if (typeof date === 'string') {
    const [y, m, d] = date.split('-').map(Number);
    return { year: y, month: m, day: d };
  }
  const k = new Date(date.getTime() + KST * 3600e3);
  return { year: k.getUTCFullYear(), month: k.getUTCMonth() + 1, day: k.getUTCDate() };
}

// Dawn variant of the blue-hour preset: rosier horizon, clearer air and dimmer windows than the evening rush
const DAWN = {
  sunColor: 0xffa27a, sunIntensity: 2.9, hemiSky: 0x6a80b4, hemiGround: 0x6a5852, hemiIntensity: 0.9,
  skyTop: 0x1c3060, skyHorizon: 0xd99a92, fogColor: 0x5a5e78, fogDensity: 0.00034, interiorGlow: 0.7,
  roadWetness: 0.3, envIntensity: 0.38, canyonBounce: 0.3, turbidity: 7.0, rayleigh: 3.2, mieCoefficient: 0.009,
  mieDirectionalG: 0.88, cloudCoverage: 0.34, cloudDensity: 0.36, skyExposure: 0.12, nightFactor: 0.26
};

const COLOR_KEYS = ['sunColor', 'hemiSky', 'hemiGround', 'skyTop', 'skyHorizon', 'fogColor'];

const smooth = (t) => t * t * (3 - 2 * t);
const lerpHex = (a, b, t) => {
  let out = 0;
  for (const s of [16, 8, 0]) out |= Math.round(((a >> s) & 255) * (1 - t) + ((b >> s) & 255) * t) << s;
  return out;
};

// Blend of two preset-shaped objects; ids, names and vectors are dropped
function mixParams(a, b, t) {
  const out = {};
  for (const key of Object.keys(a)) {
    if (typeof a[key] !== 'number' || typeof b[key] !== 'number') continue;
    out[key] = COLOR_KEYS.includes(key) ? lerpHex(a[key], b[key], t) : a[key] + (b[key] - a[key]) * t;
  }
  return out;
}

// Sun elevation (deg) → lighting values, smoothstepped between the presets: night ↔ blue hour (dawn in the
// morning) ↔ golden ↔ midday. Continuous in elevation, so continuous in time.
function blendTimeParams(elevation, presets, morning = false) {
  const keys = [
    [-12, presets.midnight],
    [-3, morning ? DAWN : presets.twilight],
    [6, presets.golden],
    [32, presets.midday]
  ];
  if (elevation <= keys[0][0]) return mixParams(keys[0][1], keys[0][1], 0);
  for (let i = 1; i < keys.length; i++) {
    if (elevation <= keys[i][0]) {
      const t = (elevation - keys[i - 1][0]) / (keys[i][0] - keys[i - 1][0]);
      return mixParams(keys[i - 1][1], keys[i][1], smooth(t));
    }
  }
  return mixParams(keys[keys.length - 1][1], keys[keys.length - 1][1], 0);
}

const grey = (hex, amount, scale = 1) => {
  const r = (hex >> 16) & 255, g = (hex >> 8) & 255, b = hex & 255;
  const l = 0.2126 * r + 0.7152 * g + 0.0722 * b;
  const ch = (c) => Math.min(255, Math.round((c + (l - c) * amount) * scale));
  return (ch(r) << 16) | (ch(g) << 8) | ch(b);
};

// Overcast (cloud 0..1) and rain (0..1) on top of a time-of-day blend: thick flat cloud deck, sun dimmed and
// diffuse, grey fog that thickens in rain. Mutates and returns p.
function applyWeather(p, cloud, rain) {
  const c = Math.max(cloud, rain);
  p.sunIntensity *= 1 - 0.82 * c;
  p.sunColor = grey(p.sunColor, 0.6 * c);
  p.hemiIntensity *= 1 + 0.1 * c - 0.2 * rain;
  p.hemiSky = grey(p.hemiSky, 0.65 * c, 1 - 0.12 * c);
  p.hemiGround = grey(p.hemiGround, 0.5 * c, 1 - 0.2 * c);
  p.skyTop = grey(p.skyTop, 0.75 * c, 1 + 0.4 * c * (1 - p.nightFactor));
  p.skyHorizon = grey(p.skyHorizon, 0.7 * c, 1 - 0.1 * c);
  p.fogColor = grey(p.fogColor, 0.7 * c, 1 - 0.15 * rain);
  p.fogDensity *= 1 + 1.6 * c + 3.5 * rain;
  p.turbidity += 6 * c;
  p.rayleigh *= 1 - 0.4 * c;
  p.mieCoefficient += 0.02 * c;
  p.mieDirectionalG -= 0.2 * c;
  p.cloudCoverage += (0.97 - p.cloudCoverage) * c;
  p.cloudDensity += (0.9 - p.cloudDensity) * c;
  p.skyExposure *= 1 - 0.35 * c - 0.2 * rain;
  p.envIntensity *= 1 - 0.15 * c;
  p.canyonBounce *= 1 - 0.6 * c;
  p.interiorGlow += 0.35 * c * (1 - p.nightFactor);
  p.nightFactor = Math.min(1, p.nightFactor + 0.12 * rain);
  return p;
}

// Linear ramp of value toward target at rate (units / s): monotonic, never overshoots
function stepToward(value, target, rate, dt) {
  const d = target - value;
  const step = rate * dt;
  return Math.abs(d) <= step ? target : value + Math.sign(d) * step;
}

export { solarPosition, sunVector, kstDay, blendTimeParams, applyWeather, stepToward, DAWN };
