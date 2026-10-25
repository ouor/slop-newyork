import * as THREE from 'three/webgpu';
import {
  Fn,
  float,
  vec2,
  vec3,
  vec4,
  pow,
  color,
  attribute,
  positionWorld,
  cameraPosition,
  normalWorldGeometry,
  texture,
  uniform,
  pmremTexture,
  length,
  normalize,
  max,
  min,
  exp,
  abs,
  floor,
  mix,
  smoothstep,
  select,
  If,
  Discard,
  mx_noise_float
} from 'three/tsl';
import { createFarSampler } from './terrain-sample.js';
import { cityUniforms } from '../tsl-materials.js';

// js/drive/world-far.js
// Far terrain: one camera-centred grid out to ~26 km over the route's far.bin (route.far, 200 m DSM, docs/drive.md
// phase 2), so the mountain ranges stand on the horizon around the corridor of detailed tiles.
// - Vertex offsets are multiples of 200 m (200 m spacing to 3.2 km, 400 m to 8 km, 800 m beyond) and the grid is
//   re-centred in 800 m steps, so every vertex sits on a far.bin sample and nothing swims as the car moves; heights
//   (2 m low, so the detailed tiles win where they meet) are re-sampled on the CPU when it re-centres.
// - Wherever a detailed tile is built the far ground is discarded (a one-texel-per-tile mask over the far grid's area,
//   set by world-builder.js), so it never pokes through the corridor.
// - Shading by slope / height (wooded hills, fields in the flat valleys, rock on cliffs, the sea at 0 m), with an
//   aerial perspective like js/lighting.js's but thinning beyond 3 km, so the ranges 10–25 km away still read through
//   the haze rather than vanishing into it.

const STEPS = [[200, 16], [400, 12], [800, 23]]; // [spacing, count] per side, from the centre out
const RECENTRE = 800;
const DROP = 2;
const TILE = 500;

function offsets() {
  const out = [0];
  let d = 0;
  for (const [step, count] of STEPS) for (let k = 0; k < count; k++) out.push((d += step));
  return [...out.slice(1).reverse().map((v) => -v), ...out];
}

function createFarTerrain(scene, route) {
  const far = route.far;
  const sampler = createFarSampler(far, far.heights);
  const O = offsets();
  const n = O.length;

  const position = new Float32Array(n * n * 3);
  const normal = new Float32Array(n * n * 3);
  const index = [];
  for (let j = 0; j + 1 < n; j++) {
    for (let i = 0; i + 1 < n; i++) {
      const a = j * n + i, b = a + 1, c = a + n, d = c + 1;
      index.push(a, c, b, b, c, d);
    }
  }
  const geometry = new THREE.BufferGeometry();
  geometry.setAttribute('position', new THREE.BufferAttribute(position, 3));
  geometry.setAttribute('normal', new THREE.BufferAttribute(normal, 3));
  geometry.setIndex(index);

  // Built-tile mask over the far grid's extent (tile units)
  const tx0 = Math.floor(far.minX / TILE), tz0 = Math.floor(far.minZ / TILE);
  const mw = Math.ceil((far.minX + far.step * far.nx) / TILE) - tx0 + 1;
  const mh = Math.ceil((far.minZ + far.step * far.nz) / TILE) - tz0 + 1;
  const maskData = new Uint8Array(mw * mh);
  const mask = new THREE.DataTexture(maskData, mw, mh, THREE.RedFormat, THREE.UnsignedByteType);
  mask.magFilter = mask.minFilter = THREE.NearestFilter;
  mask.generateMipmaps = false;
  mask.needsUpdate = true;

  const fogDensity = uniform(scene.fog ? scene.fog.density : 0.0002);
  const material = createFarMaterial(scene, mask, vec2(tx0, tz0), vec2(mw, mh), fogDensity);
  const mesh = new THREE.Mesh(geometry, material);
  mesh.name = 'FarTerrain';
  mesh.frustumCulled = false;
  mesh.receiveShadow = false;
  mesh.castShadow = false;
  mesh.renderOrder = -2;
  scene.add(mesh);

  let cx = null, cz = null;
  function refill(ox, oz) {
    for (let j = 0; j < n; j++) {
      const z = oz + O[j];
      for (let i = 0; i < n; i++) {
        const x = ox + O[i];
        const k = (j * n + i) * 3;
        // Coarse rings: the highest of the samples they skip, so ridgelines don't sink as the spacing grows
        const s = Math.max(200, Math.abs(O[i]) > 8000 || Math.abs(O[j]) > 8000 ? 800 : Math.abs(O[i]) > 3200 || Math.abs(O[j]) > 3200 ? 400 : 200);
        let h = sampler.heightAt(x, z);
        if (s > 200) for (const [dx, dz] of [[-200, 0], [200, 0], [0, -200], [0, 200]]) h = Math.max(h, sampler.heightAt(x + dx * (s / 400), z + dz * (s / 400)));
        position[k] = x;
        position[k + 1] = h - DROP;
        position[k + 2] = z;
        const nn = sampler.normalAt(x, z);
        normal[k] = nn.x;
        normal[k + 1] = nn.y;
        normal[k + 2] = nn.z;
      }
    }
    geometry.attributes.position.needsUpdate = true;
    geometry.attributes.normal.needsUpdate = true;
  }

  function update(camPos) {
    if (scene.fog) fogDensity.value = scene.fog.density;
    const ox = Math.round(camPos.x / RECENTRE) * RECENTRE, oz = Math.round(camPos.z / RECENTRE) * RECENTRE;
    if (ox === cx && oz === cz) return;
    cx = ox;
    cz = oz;
    refill(ox, oz);
  }

  // A detailed tile was built (on = true) or removed
  function setTile(tx, tz, on) {
    const i = tx - tx0, j = tz - tz0;
    if (i < 0 || j < 0 || i >= mw || j >= mh) return;
    maskData[j * mw + i] = on ? 255 : 0;
    mask.needsUpdate = true;
  }

  function dispose() {
    mesh.removeFromParent();
    geometry.dispose();
    material.dispose();
    mask.dispose();
  }

  return { mesh, update, setTile, dispose };
}

function createFarMaterial(scene, mask, maskOrigin, maskSize, fogDensity) {
  const mat = new THREE.MeshStandardNodeMaterial({ roughness: 0.95, metalness: 0.0 });
  const srgb = (c) => pow(c, vec3(2.2));
  mat.colorNode = Fn(() => {
    const xz = positionWorld.xz;
    const cell = floor(xz.div(TILE)).sub(maskOrigin);
    If(texture(mask, cell.add(0.5).div(maskSize)).r.greaterThan(0.5), () => {
      Discard();
    });
    const y = positionWorld.y.add(DROP);
    const slope = float(1.0).sub(normalWorldGeometry.y);
    const nA = mx_noise_float(vec3(xz.mul(0.0011), 3.0)).mul(0.5).add(0.5);
    const nB = mx_noise_float(vec3(xz.mul(0.006), 9.0)).mul(0.5).add(0.5);
    // Valleys farmed, hills wooded (darker with height), rock on the steepest faces, the sea
    const fields = mix(srgb(vec3(0.47, 0.5, 0.3)), srgb(vec3(0.38, 0.47, 0.26)), nB);
    const woods = mix(srgb(vec3(0.17, 0.26, 0.12)), srgb(vec3(0.24, 0.32, 0.16)), nA).mul(nB.mul(0.3).add(0.85));
    const wooded = smoothstep(0.02, 0.07, slope.add(nA.mul(0.03))).max(smoothstep(120.0, 260.0, y));
    let c = mix(fields, woods, wooded);
    c = mix(c, srgb(vec3(0.38, 0.37, 0.34)), smoothstep(0.45, 0.6, slope));
    const sea = smoothstep(0.6, 0.2, y);
    c = mix(c, color(0x1a2e33), sea);
    return c.mul(mix(float(1.0), float(0.75), smoothstep(0.2, 0.8, cityUniforms.uRoadWetness)));
  })();
  mat.roughnessNode = mix(float(0.95), float(0.25), smoothstep(0.6, 0.2, positionWorld.y.add(DROP)));

  // Own aerial perspective (js/lighting.js's formula), the distance compressed beyond 3 km
  const env = scene.environment;
  mat.fog = false;
  const baseSetupOutput = mat.setupOutput.bind(mat);
  mat.setupOutput = (builder, outputNode) => {
    const toFrag = positionWorld.sub(cameraPosition);
    const dist = length(toFrag);
    const dir = toFrag.div(max(dist, 0.001));
    const skyColor = env ? pmremTexture(env, normalize(vec3(dir.x, max(dir.y, 0.015), dir.z)), float(0.3)).rgb : vec3(0.6, 0.65, 0.7);
    const H = float(900.0);
    const ya = max(positionWorld.y, 0.0);
    const yb = max(cameraPosition.y, 0.0);
    const dy = yb.sub(ya);
    const ea = exp(ya.div(H).negate());
    const eb = exp(yb.div(H).negate());
    const meanDensity = select(abs(dy).greaterThan(1.0), ea.sub(eb).mul(H).div(dy), ea);
    const d = min(dist, 3000.0).add(max(dist.sub(3000.0), 0.0).mul(0.25));
    const tau = fogDensity.mul(d).mul(meanDensity);
    const f = float(1.0).sub(exp(tau.mul(tau).negate()));
    return baseSetupOutput(builder, vec4(mix(outputNode.rgb, skyColor, f), outputNode.a));
  };
  return mat;
}

export { createFarTerrain };
