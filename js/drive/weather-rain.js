import * as THREE from 'three/webgpu';
import {
  Fn,
  float,
  vec3,
  uniform,
  attribute,
  varying,
  fract,
  floor,
  length,
  normalize,
  cross,
  dot,
  abs,
  max,
  smoothstep,
  select
} from 'three/tsl';

// js/drive/weather-rain.js
// Falling rain streaks around the camera: one static mesh of camera-facing quads, all motion on the GPU. Each drop
// lives at a fixed point of a world-space lattice that wraps in a box centred on the camera (so drops stay put while
// the camera moves through them) and falls by a CPU-wrapped offset; each quad is stretched along the drop's velocity
// relative to the car (motion blur), so at speed the streaks slant toward the windshield.

const DROPS = 9000;
const BOX = new THREE.Vector3(28, 16, 28);
const SHUTTER = 0.022; // s of motion blur per streak
const FALL_SPEED = 8.5; // m/s

function createRain() {
  const uCam = uniform(new THREE.Vector3());
  const uOffset = uniform(new THREE.Vector3()); // fall offset, wrapped into the box on the CPU (no float drift)
  const uRelVel = uniform(new THREE.Vector3(0, -FALL_SPEED, 0)); // drop velocity in the car's frame
  const uAmount = uniform(0);
  const uColor = uniform(new THREE.Color(0x8890a0));
  const uCarPos = uniform(new THREE.Vector3(0, -1e5, 0));
  const uCarAxes = uniform(new THREE.Vector4(0, -1, 1, 0)); // forward.xz, right.xz
  const uBeam = uniform(new THREE.Color(0x000000)); // headlight colour × on-ness (0 by day)

  const seeds = new Float32Array(DROPS * 4 * 3);
  const corners = new Float32Array(DROPS * 4 * 2);
  const index = new Uint32Array(DROPS * 6);
  for (let i = 0; i < DROPS; i++) {
    const s = [Math.random(), Math.random(), Math.random()];
    for (let k = 0; k < 4; k++) {
      seeds.set(s, (i * 4 + k) * 3);
      corners.set([k & 1 ? 1 : -1, k >> 1], (i * 4 + k) * 2);
    }
    index.set([i * 4, i * 4 + 1, i * 4 + 2, i * 4 + 2, i * 4 + 1, i * 4 + 3], i * 6);
  }
  const geometry = new THREE.BufferGeometry();
  geometry.setAttribute('position', new THREE.BufferAttribute(new Float32Array(DROPS * 4 * 3), 3));
  geometry.setAttribute('aSeed', new THREE.BufferAttribute(seeds, 3));
  geometry.setAttribute('aCorner', new THREE.BufferAttribute(corners, 2));
  geometry.setIndex(new THREE.BufferAttribute(index, 1));

  const seed = attribute('aSeed', 'vec3');
  const corner = attribute('aCorner', 'vec2');
  const box = vec3(BOX.x, BOX.y, BOX.z);
  const local = fract(seed.mul(box).add(uOffset).sub(uCam).div(box)).sub(0.5).mul(box);
  const head = uCam.add(local);

  // Fade at the box faces so wrapping drops never pop, and thin out with the rain amount
  const edge = max(max(abs(local.x).div(BOX.x), abs(local.z).div(BOX.z)), abs(local.y).div(BOX.y));
  const vFade = varying(float(1).sub(smoothstep(0.36, 0.5, edge)).mul(float(1).sub(corner.y.mul(0.8))), 'vRainFade');

  // Drops inside the headlight cones glint: in front of the car, within the wide beam's spread, below its top edge,
  // falling off with distance like the lamps (car-cabin.js BEAMS)
  const rel = head.sub(uCarPos);
  const along = dot(rel.xz, uCarAxes.xy);
  const across = dot(rel.xz, uCarAxes.zw);
  const spread = float(0.9).add(along.mul(0.5));
  const inBeam = smoothstep(1.5, 3.0, along)
    .mul(float(1).sub(smoothstep(spread.mul(0.6), spread, abs(across))))
    .mul(float(1).sub(smoothstep(along.mul(0.08).add(0.8), along.mul(0.08).add(1.6), rel.y)));
  const vBeam = varying(inBeam.div(along.div(14).pow(2).add(1)), 'vRainBeam');

  const material = new THREE.MeshBasicNodeMaterial({ transparent: true, depthWrite: false, side: THREE.DoubleSide });
  material.fog = false;
  material.positionNode = Fn(() => {
    const speed = length(uRelVel);
    const dir = uRelVel.div(speed);
    const toCam = uCam.sub(head);
    const dist = length(toCam);
    const side = normalize(cross(dir, toCam.div(max(dist, 0.01))));
    const streak = speed.mul(SHUTTER).mul(fract(seed.x.mul(13.7)).mul(0.6).add(0.7));
    const width = dist.mul(0.0012).add(0.004);
    const pos = head.sub(dir.mul(streak.mul(corner.y))).add(side.mul(width.mul(corner.x)));

    // Hidden drops collapse to a point: beyond the rain amount, too close to the lens, or inside the car body
    const inCar = abs(along).lessThan(2.6).and(abs(across).lessThan(1.05)).and(rel.y.lessThan(1.75));
    const hidden = fract(seed.z.mul(71.3)).greaterThan(uAmount).or(dist.lessThan(0.5)).or(inCar);
    return select(hidden, head, pos);
  })();
  material.colorNode = uColor.add(uBeam.mul(vBeam));
  material.opacityNode = vFade.mul(float(1).sub(abs(corner.x))).mul(0.5);

  const mesh = new THREE.Mesh(geometry, material);
  mesh.name = 'DriveRain';
  mesh.frustumCulled = false;
  mesh.matrixAutoUpdate = false;
  mesh.renderOrder = -1; // before other transparents (the windshield above all)
  mesh.visible = false;

  const fall = new THREE.Vector3();

  // amount 0..1, colour (THREE.Color), camera position, car state ({ position, heading, speed }) or null,
  // beams 0..1 (headlights on)
  function update(dt, amount, color, camPos, car, beams = 0) {
    mesh.visible = amount > 0.001;
    if (!mesh.visible) return;
    uAmount.value = amount;
    uColor.value.copy(color);
    uBeam.value.setRGB(1.0, 0.97, 0.9).multiplyScalar(1.6 * beams);
    uCam.value.copy(camPos);
    const wind = 1.2 * amount; // a little drift in heavy rain
    fall.set(wind * 0.6, -FALL_SPEED, wind * 0.4);
    const o = uOffset.value;
    o.x = (o.x + fall.x * dt) % BOX.x;
    o.y = (o.y + fall.y * dt) % BOX.y;
    o.z = (o.z + fall.z * dt) % BOX.z;
    if (car && car.position) {
      const h = car.heading || 0;
      const fx = Math.sin(h), fz = -Math.cos(h);
      const v = car.speed || 0;
      uCarPos.value.copy(car.position);
      uCarAxes.value.set(fx, fz, -fz, fx);
      uRelVel.value.set(fall.x - fx * v, fall.y, fall.z - fz * v);
    } else {
      uCarPos.value.set(0, -1e5, 0);
      uRelVel.value.copy(fall);
    }
  }

  return { mesh, update };
}

export { createRain };
