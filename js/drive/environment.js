import * as THREE from 'three/webgpu';
import { uniform } from 'three/tsl';
import { TIME_PRESETS } from '../lighting.js';
import { solarPosition, sunVector, kstDay, blendTimeParams, applyWeather, applyEnclosure, stepToward, TUNNEL_LAMPS } from './env-sky.js';
import { createRain } from './weather-rain.js';
import { createWindshieldMaterial, createWiper } from './weather-windshield.js';

// js/drive/environment.js
// Time of day and weather for the drive app (docs/drive.md): the real sun over the route origin in KST, the
// LightingSystem presets blended continuously by sun elevation, overcast / rain grading, rain streaks around the camera,
// wet roads and a rainy windshield with wipers. The PMREM environment map is only re-baked when the sky changed enough.
// Tunnels: setEnclosure(t) (0 open … 1 inside, e.g. the autopilot's tunnelDepth) scales the lights and the environment
// intensity directly (no re-bake), tints the ambience with the tunnel lamps and stops the rain under the roof.

// Shared with the world builder's tunnel lamps: how enclosed the camera is and the current tunnel's lamp colour
const tunnelUniforms = {
  uEnclosure: uniform(0),
  uLampColor: uniform(new THREE.Color(TUNNEL_LAMPS.led))
};

const WEATHER = { clear: [0, 0], overcast: [1, 0], rain: [1, 1] }; // [cloud, rain]
const TRANSITION_RATE = 1 / 6; // weather changes take 6 s
const WET_RATE = 1 / 25; // roads soak in ~25 s of rain …
const DRY_RATE = 1 / 240; // … and take 4 minutes to dry
const DRY_ROAD = 0.05;
const MOON_SWITCH = -4; // sun elevation (deg) where the shadow-casting light hands over from the sun to the moon
const BAKE_THRESHOLD = 0.06;
const BAKE_MIN_INTERVAL = 1.5; // s between bakes while the sky keeps changing (a bake costs about a frame of GPU time)
const BAKE_SETTLE = 4; // s after which any remaining change is baked

// Preetham's sun energy (SkyMesh sunIntensity / EE) at an elevation in degrees
const skySunEnergy = (el) => Math.max(1e-4, 1 - Math.exp(-(1.6110731556870734 - (90 - el) * Math.PI / 180) / 1.5));

const smoothstep = (a, b, x) => {
  const t = Math.min(1, Math.max(0, (x - a) / (b - a)));
  return t * t * (3 - 2 * t);
};

function createEnvironment({ scene, renderer, lighting, route }) {
  const origin = (route && route.origin) || { lat: 37.5547, lon: 126.9707 };
  const state = {
    hours: 12,
    date: kstDay(new Date()),
    weather: 'clear',
    cloud: 0, // 0..1 current overcast amount
    rain: 0, // 0..1 current rain amount
    wetness: 0, // 0..1 road wetness (lags the rain)
    sun: { azimuth: 0, elevation: 0, direction: new THREE.Vector3(0, 1, 0) },
    nightFactor: 0,
    look: 'midday', // nearest post-processing LOOK id, for colorGrade.applyPreset
    enclosure: 0, // 0 open … 1 inside a tunnel
    lamp: TUNNEL_LAMPS.led, // current tunnel's lamp colour (hex)
    params: null // the blended lighting values last applied
  };
  let target = WEATHER.clear;
  let clock = 0;

  const lightDir = new THREE.Vector3();
  const skyDir = new THREE.Vector3();
  const camPos = new THREE.Vector3();
  const rainColor = new THREE.Color();
  const tmpColor = new THREE.Color();
  const WARM = new THREE.Color(0xffc890);
  const NIGHT_SKY = lighting.uNightSkyColor.value.clone();

  const rain = createRain();
  scene.add(rain.mesh);
  let windshield = null;
  let wiper = null;
  let runFlow = 0;

  const baked = { dir: new THREE.Vector3(), exposure: 1, night: -1, cloud: -1, turbidity: 0, age: Infinity };

  function computeParams() {
    const d = state.date;
    const s = solarPosition(origin.lat, origin.lon, d.year, d.month, d.day, state.hours);
    const v = sunVector(s.azimuth, s.elevation);
    state.sun.azimuth = s.azimuth;
    state.sun.elevation = s.elevation;
    state.sun.direction.set(v.x, v.y, v.z);

    const p = applyWeather(blendTimeParams(s.elevation, TIME_PRESETS, s.azimuth < 180), state.cloud, state.rain);
    // Shadow light: the sun held a few degrees up, or after dusk the moon opposite it, fading to nothing at the hand-over
    const moon = s.elevation < MOON_SWITCH;
    const l = sunVector(moon ? s.azimuth + 180 : s.azimuth, moon ? Math.max(-s.elevation, 20) : Math.max(s.elevation, 3));
    p.sunDir = lightDir.set(l.x, l.y, l.z);
    p.sunIntensity *= smoothstep(0, 4, Math.abs(s.elevation - MOON_SWITCH));
    // Preetham's sky goes black once the sun is ~2° under the horizon: keep its glow there and let the blended exposure
    // and night factor take the sky down instead
    const k = sunVector(s.azimuth, Math.max(s.elevation, 1));
    p.skySunDir = skyDir.set(k.x, k.y, k.z);
    // The presets were tuned with the sky's sun 20-35° up; keep a low real sun's sky as bright (just redder)
    p.skyExposure *= Math.min(8, Math.max(1, skySunEnergy(30) / skySunEnergy(Math.max(s.elevation, 1))));
    p.roadWetness = Math.max(DRY_ROAD, state.wetness);

    state.nightFactor = p.nightFactor;
    // Preetham has no cloud deck: grey the sky through its night-colour mix (the fog colour is the overcast grade)
    const night = p.nightFactor;
    p.nightFactor = 1 - (1 - night) * (1 - 0.92 * state.cloud);
    lighting.uNightSkyColor.value.copy(NIGHT_SKY).lerp(tmpColor.set(p.fogColor), p.nightFactor > 0 ? (p.nightFactor - night) / p.nightFactor : 0);
    applyEnclosure(p, state.enclosure, state.lamp);
    state.look = s.elevation < -8 ? 'midnight' : s.elevation < 2 ? 'twilight' : s.elevation < 15 ? 'golden' : 'midday';
    state.params = p;
    return p;
  }

  // Re-bake the environment map only when the sky moved noticeably, at most every BAKE_MIN_INTERVAL
  function maybeBake(p, dt) {
    baked.age += dt;
    const change = p.skySunDir.distanceTo(baked.dir) * 4 +
      Math.abs(Math.log(p.skyExposure / baked.exposure)) +
      Math.abs(p.nightFactor - baked.night) +
      Math.abs(p.cloudCoverage - baked.cloud) +
      Math.abs(p.turbidity - baked.turbidity) / 8;
    if (change <= 1e-4) return;
    if ((change > BAKE_THRESHOLD && baked.age > BAKE_MIN_INTERVAL) || baked.age > BAKE_SETTLE) {
      lighting.bakeEnvironmentMap();
      baked.dir.copy(p.skySunDir);
      baked.exposure = p.skyExposure;
      baked.night = p.nightFactor;
      baked.cloud = p.cloudCoverage;
      baked.turbidity = p.turbidity;
      baked.age = 0;
    }
  }

  function setTime(hours) {
    state.hours = ((hours % 24) + 24) % 24;
  }

  // Date or 'YYYY-MM-DD'; only its calendar day (in KST) matters
  function setDate(date) {
    state.date = kstDay(date);
  }

  function setWeather(kind, immediate = false) {
    if (!WEATHER[kind]) throw new Error(`Unknown weather: ${kind}`);
    state.weather = kind;
    target = WEATHER[kind];
    if (immediate) {
      [state.cloud, state.rain] = target;
      state.wetness = target[1];
    }
  }

  // t: 0 open … 1 inside a tunnel; lamp: 'led' | 'sodium' | hex colour (kept until changed)
  function setEnclosure(t, lamp) {
    state.enclosure = Math.min(1, Math.max(0, t || 0));
    tunnelUniforms.uEnclosure.value = state.enclosure;
    if (lamp !== undefined) {
      const hex = typeof lamp === 'string' ? TUNNEL_LAMPS[lamp] : lamp;
      if (hex === undefined) throw new Error(`Unknown tunnel lamp: ${lamp}`);
      state.lamp = hex;
      tunnelUniforms.uLampColor.value.set(hex);
    }
  }

  function attachWindshield(mesh) {
    const glass = createWindshieldMaterial(mesh);
    mesh.material = glass.material;
    mesh.castShadow = false;
    mesh.renderOrder = 10; // after the rain and other transparents: it is the nearest surface
    windshield = glass.uniforms;
    wiper = createWiper(windshield);
    return glass.material;
  }

  function updateWindshield(dt, p, speed, rainHere) {
    const u = windshield;
    u.time.value = clock;
    u.rain.value = rainHere;
    u.fill.value = 14 - 11 * rainHere;
    // Drops trickle down at a few cm/s; above ~40 km/h the airflow pushes them up the glass
    const runRate = 0.06 - 0.0005 * speed * speed;
    runFlow += runRate * dt;
    u.runFlow.value = runFlow;
    u.runSign.value = runRate >= 0 ? 1 : -1;
    wiper.update(clock, rainHere);
    tmpColor.set(p.hemiSky).multiplyScalar(p.hemiIntensity * 0.45);
    // At night the warm street-light share dims too: on unlit roads drops must not glow over the view ahead
    u.sky.value.copy(tmpColor).lerp(WARM, 0.15 * state.nightFactor).multiplyScalar(1 - 0.8 * state.nightFactor);
    u.ambient.value.copy(tmpColor).multiplyScalar(0.5);
    u.glint.value.set(p.sunColor).multiplyScalar(Math.min(1, p.sunIntensity / 5) + 0.15).lerp(WARM, 0.6 * state.nightFactor)
      .multiplyScalar(1 - 0.7 * state.nightFactor);
  }

  function update(dt, camera, carState) {
    clock += dt;
    state.cloud = stepToward(state.cloud, target[0], TRANSITION_RATE, dt);
    state.rain = stepToward(state.rain, target[1], TRANSITION_RATE, dt);
    state.wetness = stepToward(state.wetness, state.rain, state.rain > state.wetness ? WET_RATE : DRY_RATE, dt);

    const p = computeParams();
    lighting.applyParams(p, false);
    maybeBake(p, dt);

    // Streaks lit by the sky (and, at night, a faint share of sodium street lighting), greyed into the fog. At night
    // rain is mostly seen where the car's own headlights catch it (weather-rain.js), so the ambient share stays dim.
    rainColor.set(p.hemiSky).multiplyScalar(p.hemiIntensity * 0.9)
      .lerp(tmpColor.set(p.fogColor), 0.3)
      .lerp(WARM, 0.25 * state.nightFactor)
      .multiplyScalar(1 - 0.75 * state.nightFactor);
    // Same dusk ramp as the car's headlights (car-cabin.js)
    const beams = Math.min(1, Math.max(0, (p.interiorGlow - 0.6) * 1.45));
    if (camera) camera.getWorldPosition(camPos);
    // No rain under a tunnel roof: streaks and fresh drops on the glass fade with the enclosure and return at the exit
    const rainHere = state.rain * (1 - state.enclosure);
    rain.update(dt, rainHere, rainColor, camPos, carState, beams);

    if (windshield) updateWindshield(dt, p, (carState && carState.speed) || 0, rainHere);
  }

  // Lighting ready before the first update (e.g. for a precompile pass); the first update bakes the environment map
  lighting.applyParams(computeParams(), false);

  return { setTime, setDate, setWeather, setEnclosure, attachWindshield, update, state };
}

export { createEnvironment, tunnelUniforms };
