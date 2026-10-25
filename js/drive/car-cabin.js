import * as THREE from 'three/webgpu';
import { Fn, float, vec2, vec3, uv, uniform, length, atan, cos, sin, abs, fract, step, smoothstep, max, dot, mix } from 'three/tsl';
import { mergeGeometries } from 'three/addons/utils/BufferGeometryUtils.js';
import { cityUniforms, createContactShadowMaterial } from '../tsl-materials.js';
import {
  BODY_SPECS,
  carLayout,
  carBodyHalfWidthAt,
  buildCarGeometry,
  buildSteerableWheelGeo,
  createLoftedCarMaterial
} from '../actor-models.js';
import { createVehicleHeadlight, placeVehicleHeadlight } from '../vehicle-lights.js';

// js/drive/car-cabin.js
// The Korea Drive player car seen from inside: the lofted sedan exterior from actor-models.js (white, no taxi sign)
// plus a procedural left-hand-drive interior sized from the same body spec (carLayout), so it fits any BODY_SPECS
// entry: dashboard with a TSL-drawn instrument cluster and a centre screen, steering wheel, A/B/C pillars, roof liner,
// door cards with window ledges, rear-view & side mirror glass, front seats and a rear bench, and transparent glass.
// - The exterior materials are front-face only, so from a seat the body and its painted glasshouse are culled and
//   the interior (DoubleSide) plus the real glass meshes take over. The interior glass sits just inside the painted
//   glass, so from outside (chase view) the exterior still wins the depth test.
// - Car local frame (as in actor-models.js): +z forward, +x LEFT, y up. The driver sits at +x (left-hand drive).
// - The cabin owns its camera: `cabin.camera` (PerspectiveCamera, aspect 1: the caller sets aspect + calls
//   updateProjectionMatrix on resize). Each frame call `setPose(autopilotState)` then `update(dt, input)` before
//   rendering with `cabin.camera`.
// - `input = { lookDX, lookDY }`: pointer movement in CSS pixels since the last update (drag right = look right,
//   drag down = look down). The look offset is clamped per view and eases back to centre after ~1.2 s idle.
// - In interior views only the interior casts shadows (so sunlight falls through the windows onto the dash); in the
//   chase view the exterior body does and the interior is hidden.

const PAINT = 0xe9eaec; // 화이트 펄
const STEER_RATIO = 15;
const LOOK_PER_PX = 0.004; // rad per CSS pixel
const LOOK_IDLE = 1.2; // s before the look eases back
const CLUSTER_W = 0.34;
const CLUSTER_H = 0.13;
// Per lamp: wide near spread (top edge ~4° above the horizon, lights verges and signs) + narrow far reach. Intensities
// in cd for inverse-square decay: ≈ 4 at 60 m and ≈ 1 at 120 m on the road ahead (dark asphalt needs it).
const BEAMS = [
  { angle: 0.5, penumbra: 0.7, pitch: 0.43, distance: 45, intensity: 2400 },
  { angle: 0.13, penumbra: 0.6, pitch: 0.012, distance: 140, intensity: 14000 }
];

const _up = new THREE.Vector3(0, 1, 0);
const _zAxis = new THREE.Vector3(0, 0, 1);
const _v = new THREE.Vector3();
const _q = new THREE.Quaternion();
const _e = new THREE.Euler(0, 0, 0, 'YXZ');

// Merges a mix of indexed (Box, Plane, Torus) and non-indexed (Extrude) geometries
function merge(list) {
  return mergeGeometries(list.map((g) => (g.index ? g.toNonIndexed() : g)));
}

// Grid surface through fn(u, v) -> [x, y, z] for u, v in [0, 1]
function surface(nu, nv, fn) {
  const geo = new THREE.PlaneGeometry(1, 1, nu, nv);
  const pos = geo.attributes.position;
  for (let i = 0; i < pos.count; i++) {
    const [x, y, z] = fn(pos.getX(i) + 0.5, pos.getY(i) + 0.5);
    pos.setXYZ(i, x, y, z);
  }
  geo.computeVertexNormals();
  return geo;
}

// Box of width w x thickness t running from point a to point b (thickness along `up` where possible)
function beam(a, b, w, t, up = _up) {
  const dir = _v.subVectors(b, a);
  const len = dir.length();
  const m = new THREE.Matrix4().lookAt(new THREE.Vector3(), dir.clone().negate(), up);
  return new THREE.BoxGeometry(w, t, len).applyMatrix4(m).translate((a.x + b.x) / 2, (a.y + b.y) / 2, (a.z + b.z) / 2);
}

// Side-view profile [z, y][] extruded across x in [-halfWidth, halfWidth] (optionally bevelled)
function sideExtrude(profile, halfWidth, bevel = 0) {
  const shape = new THREE.Shape(profile.map(([z, y]) => new THREE.Vector2(z, y)));
  const geo = new THREE.ExtrudeGeometry(shape, {
    depth: 2 * (halfWidth - bevel),
    bevelEnabled: bevel > 0,
    bevelThickness: bevel,
    bevelSize: bevel,
    bevelSegments: 2,
    curveSegments: 4
  });
  // Shape x -> car z, extrusion -> car x
  return geo.rotateY(-Math.PI / 2).translate(halfWidth - bevel, 0, 0);
}

// The lofted body is a closed tube whose crown runs at belt height under the glasshouse: seen from a seat it would
// be a lid over the whole interior. Drop its upward-facing triangles between the cowl and the deck.
function openCabinTop(geometry, L) {
  const cab = L.spec.cabin;
  const pos = geometry.attributes.position;
  const partId = geometry.attributes.partId;
  const index = geometry.index.array;
  const kept = [];
  const a = new THREE.Vector3();
  const b = new THREE.Vector3();
  const c = new THREE.Vector3();
  for (let i = 0; i < index.length; i += 3) {
    const [i0, i1, i2] = [index[i], index[i + 1], index[i + 2]];
    if (partId.getX(i0) === 0) {
      a.fromBufferAttribute(pos, i0);
      b.fromBufferAttribute(pos, i1);
      c.fromBufferAttribute(pos, i2);
      const z = (a.z + b.z + c.z) / 3;
      const y = (a.y + b.y + c.y) / 3;
      if (z < cab.cowl - 0.02 && z > cab.deck + 0.02 && y > L.cabin(z).beltY - 0.15) {
        const ny = b.sub(a).cross(c.sub(a)).normalize().y;
        if (ny > 0.4) continue;
      }
    }
    kept.push(i0, i1, i2);
  }
  geometry.setIndex(kept);
  return geometry;
}

// Seat: cushion + reclined backrest + headrest, centred on x, cushion front at zFront
function buildSeat(x, zFront, width, cushionY, recline = 0.22) {
  const parts = [];
  parts.push(new THREE.BoxGeometry(width, 0.13, 0.5, 2, 1, 2).translate(x, cushionY, zFront - 0.25));
  parts.push(new THREE.BoxGeometry(width * 0.16, 0.07, 0.48).translate(x + width * 0.42, cushionY + 0.06, zFront - 0.26));
  parts.push(new THREE.BoxGeometry(width * 0.16, 0.07, 0.48).translate(x - width * 0.42, cushionY + 0.06, zFront - 0.26));
  const back = new THREE.BoxGeometry(width, 0.66, 0.13, 2, 2, 1).translate(0, 0.33, 0).rotateX(-recline);
  parts.push(back.translate(x, cushionY + 0.04, zFront - 0.52));
  return parts;
}

// Instrument cluster: speedometer & tachometer drawn in TSL from uv, needles from uniforms (0..1 of full scale)
function createClusterMaterial(speedU, rpmU) {
  const mat = new THREE.MeshStandardNodeMaterial({ color: 0x07080a, roughness: 0.3, metalness: 0 });
  const aspect = CLUSTER_W / CLUSTER_H;
  const dial = (p, cx, value) => {
    const q = p.sub(vec2(cx, 0));
    const r = length(q);
    const a = atan(q.y, q.x);
    // 270° sweep from bottom-left (225°) clockwise to bottom-right (-45°); the bottom wedge stays dark
    const inSweep = float(1).sub(step(-Math.PI * 0.75, a).mul(step(a, -Math.PI * 0.25)));
    const ring = smoothstep(0.016, 0.006, abs(r.sub(0.41)));
    const ticks = smoothstep(0.8, 0.92, abs(fract(a.mul(36 / (2 * Math.PI))).sub(0.5)).mul(2))
      .mul(step(0.33, r)).mul(step(r, 0.4));
    const theta = float(Math.PI * 1.25).sub(value.mul(Math.PI * 1.5));
    const dir = vec2(cos(theta), sin(theta));
    const along = dot(q, dir);
    const perp = abs(q.x.mul(dir.y).sub(q.y.mul(dir.x)));
    const needle = smoothstep(0.014, 0.005, perp).mul(step(-0.04, along)).mul(step(along, 0.37));
    const hub = smoothstep(0.05, 0.04, r);
    const scale = max(ring, ticks).mul(inSweep);
    return vec3(0.55, 0.78, 1.0).mul(scale).add(vec3(1.0, 0.3, 0.08).mul(max(needle, hub.mul(0.6))).mul(2.0));
  };
  mat.emissiveNode = Fn(() => {
    const p = uv().sub(0.5).mul(vec2(aspect, 1));
    // Centre trip display: a faint blue panel
    const panel = step(abs(p.x), 0.2).mul(step(abs(p.y), 0.32)).mul(0.06);
    return dial(p, -aspect * 0.27, speedU).add(dial(p, aspect * 0.27, rpmU)).add(vec3(0.2, 0.45, 0.8).mul(panel));
  })();
  return mat;
}

function createCarCabin(scene, { spec = 'sedan' } = {}) {
  spec = typeof spec === 'string' ? BODY_SPECS[spec] : spec;
  if (spec.sign) spec = Object.assign({}, spec, { name: `${spec.name}-nosign`, sign: false });
  const L = carLayout(spec);
  const cab = spec.cabin;

  const group = new THREE.Group();
  group.name = 'DriveCar';
  const chassis = new THREE.Group(); // pitch & roll; wheels stay on the group
  group.add(chassis);

  // --- Exterior ---------------------------------------------------------------------------------------------------
  const paintMat = createLoftedCarMaterial(spec, PAINT);
  const body = new THREE.Mesh(openCabinTop(buildCarGeometry(spec, false), L), paintMat);
  body.receiveShadow = true;
  chassis.add(body);
  const carState = paintMat.userData.carState;

  const wheels = [];
  const wheelGeo = { [-1]: buildSteerableWheelGeo(spec, -1), [1]: buildSteerableWheelGeo(spec, 1) };
  for (const side of [-1, 1]) {
    for (const z of [spec.wheelZ, -spec.wheelZ]) {
      const steerPivot = new THREE.Group();
      steerPivot.position.set(side * spec.wheelX, spec.wheelRadius, z);
      const tire = new THREE.Mesh(wheelGeo[side], paintMat);
      tire.castShadow = true;
      steerPivot.add(tire);
      group.add(steerPivot);
      wheels.push({ steerPivot, tire, isFront: z > 0 });
    }
  }

  const contact = new THREE.PlaneGeometry(2.22, (spec.zFront - spec.zRear) * 1.12).rotateX(-Math.PI / 2);
  const contactShadow = new THREE.Mesh(contact, createContactShadowMaterial());
  contactShadow.position.y = 0.02;
  contactShadow.renderOrder = 998;
  group.add(contactShadow);

  // Korean plates (white, black characters) over the material's painted plates
  const plateCanvas = document.createElement('canvas');
  plateCanvas.width = 256;
  plateCanvas.height = 56;
  const ctx = plateCanvas.getContext('2d');
  ctx.fillStyle = '#f4f5f2';
  ctx.fillRect(0, 0, 256, 56);
  ctx.strokeStyle = '#222';
  ctx.lineWidth = 4;
  ctx.strokeRect(3, 3, 250, 50);
  ctx.fillStyle = '#111';
  ctx.font = 'bold 40px sans-serif';
  ctx.textAlign = 'center';
  ctx.textBaseline = 'middle';
  ctx.fillText('12가 3456', 128, 30);
  const plateTex = new THREE.CanvasTexture(plateCanvas);
  plateTex.colorSpace = THREE.SRGBColorSpace;
  const plateMat = new THREE.MeshStandardNodeMaterial({ map: plateTex, roughness: 0.35 });
  for (const end of [0, 1]) {
    const plate = new THREE.Mesh(new THREE.PlaneGeometry(0.52, 0.11), plateMat);
    plate.position.set(0, spec.plates[end], end === 0 ? spec.zFront + 0.03 : spec.zRear - 0.03);
    if (end === 1) plate.rotation.y = Math.PI;
    chassis.add(plate);
  }

  // Manhattan's low beam (±8°, 36 m) assumes lit streets; on an unlit motorway a lamp needs both a wide, short
  // spread over the near road and verges and a narrow beam that reaches ~100 m. A round cone can't be both, so
  // each lamp is a pair of spots (same position, different cone, pitch and reach).
  const headLights = [];
  for (const side of [-1, 1]) {
    for (const beam of BEAMS) {
      const spot = createVehicleHeadlight();
      placeVehicleHeadlight(spot, spec, side);
      spot.angle = beam.angle;
      spot.penumbra = beam.penumbra;
      spot.distance = beam.distance;
      const t = spot.target.position;
      t.y = spot.position.y - (t.z - spot.position.z) * Math.tan(beam.pitch);
      spot.userData.intensity = beam.intensity;
      chassis.add(spot, spot.target);
      headLights.push(spot);
    }
  }

  // --- Interior ---------------------------------------------------------------------------------------------------
  const interior = new THREE.Group();
  chassis.add(interior);
  const side2 = THREE.DoubleSide;
  const darkMat = new THREE.MeshStandardNodeMaterial({ color: 0x1b1c1f, roughness: 0.78, side: side2 });
  const linerMat = new THREE.MeshStandardNodeMaterial({ color: 0xb4afa6, roughness: 0.95, side: side2 });
  const seatMat = new THREE.MeshStandardNodeMaterial({ color: 0x2a2725, roughness: 0.62, side: side2 });
  const carpetMat = new THREE.MeshStandardNodeMaterial({ color: 0x141416, roughness: 1, side: side2 });
  const trimMat = new THREE.MeshStandardNodeMaterial({ color: 0x5d5f63, roughness: 0.4, metalness: 0.6, side: side2 });
  // Mirror glass: no real reflection, a dim sky-coloured sheen so it reads as a mirror by day and dusk alike
  const mirrorMat = new THREE.MeshStandardNodeMaterial({ color: 0x3a4148, roughness: 0.15, metalness: 0.3 });
  mirrorMat.emissiveNode = mix(cityUniforms.uSkyHorizonColor, cityUniforms.uSkyTopColor, 0.5).mul(0.35);
  const screenMat = new THREE.MeshStandardNodeMaterial({ color: 0x050608, roughness: 0.2, emissive: 0x0d2238, emissiveIntensity: 1 });
  const glassMat = new THREE.MeshStandardNodeMaterial({
    color: 0x8fa6a8,
    roughness: 0.04,
    metalness: 0,
    transparent: true,
    opacity: 0.16,
    depthWrite: false,
    side: side2
  });
  const speedU = uniform(0);
  const rpmU = uniform(0);
  const clusterMat = createClusterMaterial(speedU, rpmU);

  const cowl = L.cabin(cab.cowl);
  const front = L.cabin(cab.roofFront);
  const rear = L.cabin(cab.roofRear);
  const deck = L.cabin(cab.deck);
  const floorY = Math.max(spec.wheelRadius * 0.85, L.body(0).yB + 0.04);
  const driverX = Math.min(0.37, front.railX * 0.57);
  const halfWidth = (z, y) => carBodyHalfWidthAt(spec, z, y);
  const P = (x, y, z) => new THREE.Vector3(x, y, z);

  // Dashboard: a side-view profile under the windshield base, rolling into a lip and down to the floor
  const dashTop = cowl.beltY - 0.015;
  const dashRear = cab.cowl - 0.58;
  const dashHalf = halfWidth(dashRear, dashTop - 0.1) - 0.06;
  const dash = sideExtrude([
    [cab.cowl + 0.04, dashTop - 0.03],
    [cab.cowl - 0.25, dashTop + 0.01],
    [dashRear + 0.08, dashTop + 0.03],
    [dashRear, dashTop - 0.0],
    [dashRear - 0.02, dashTop - 0.09],
    [dashRear + 0.06, dashTop - 0.2],
    [dashRear + 0.06, floorY + 0.25],
    [cab.cowl - 0.05, floorY],
    [cab.cowl + 0.04, floorY]
  ], dashHalf, 0.02);
  // Binnacle hood over the cluster, centre stack, console between the seats and the steering column
  const binnacle = sideExtrude([
    [dashRear + 0.26, dashTop - 0.01],
    [dashRear + 0.2, dashTop + 0.15],
    [dashRear - 0.03, dashTop + 0.155],
    [dashRear - 0.05, dashTop + 0.13],
    [dashRear + 0.06, dashTop + 0.135],
    [dashRear + 0.07, dashTop - 0.01]
  ], 0.21, 0.01)
    .translate(driverX, 0, 0);
  const stack = new THREE.BoxGeometry(0.3, 0.36, 0.2).translate(0, dashTop - 0.23, dashRear + 0.06);
  const console_ = sideExtrude([[dashRear + 0.05, floorY + 0.32], [dashRear - 0.25, floorY + 0.24], [-0.85, floorY + 0.3], [-0.85, floorY], [dashRear + 0.05, floorY]], 0.12, 0.015);
  const floor = new THREE.PlaneGeometry(1.8, cab.cowl - spec.zRear * 0.7).rotateX(-Math.PI / 2)
    .translate(0, floorY, (cab.cowl + spec.zRear * 0.7) / 2);
  interior.add(new THREE.Mesh(merge([dash, binnacle, stack, console_]), darkMat), new THREE.Mesh(floor, carpetMat));

  const cluster = new THREE.Mesh(new THREE.PlaneGeometry(CLUSTER_W, CLUSTER_H), clusterMat);
  cluster.position.set(driverX, dashTop + 0.065, dashRear + 0.035);
  cluster.rotation.set(-0.1, Math.PI, 0);
  const screen = new THREE.Mesh(new THREE.PlaneGeometry(0.26, 0.15), screenMat);
  screen.position.set(0, dashTop + 0.06, dashRear + 0.12);
  screen.rotation.set(-0.25, Math.PI, 0);
  const screenBezel = new THREE.Mesh(new THREE.BoxGeometry(0.28, 0.17, 0.02).translate(0, 0, 0.012), darkMat);
  screen.add(screenBezel);
  interior.add(cluster, screen);

  // Steering wheel: rim, hub and three spokes on a pivot tilted towards the driver; the pivot spins with steering
  const wheelPivot = new THREE.Group();
  wheelPivot.position.set(driverX, dashTop - 0.15, dashRear - 0.2);
  wheelPivot.rotation.x = 0.42;
  const steering = new THREE.Group();
  wheelPivot.add(steering);
  const rim = new THREE.TorusGeometry(0.185, 0.017, 8, 40);
  const hub = new THREE.CylinderGeometry(0.06, 0.07, 0.06, 16).rotateX(Math.PI / 2).translate(0, -0.01, 0.02);
  const spokes = [
    new THREE.BoxGeometry(0.15, 0.035, 0.018).translate(0.1, 0, 0.01),
    new THREE.BoxGeometry(0.15, 0.035, 0.018).translate(-0.1, 0, 0.01),
    new THREE.BoxGeometry(0.035, 0.13, 0.018).translate(0, -0.1, 0.01)
  ];
  steering.add(new THREE.Mesh(merge([rim, hub, ...spokes]), darkMat));
  const column = new THREE.CylinderGeometry(0.035, 0.045, 0.3, 10).rotateX(Math.PI / 2).translate(0, -0.01, 0.17);
  wheelPivot.add(new THREE.Mesh(column, darkMat));
  interior.add(wheelPivot);

  // Pillars, roof headers and the roof liner (they shade the cabin, so they cast shadows)
  const shell = [];
  for (const side of [-1, 1]) {
    const s = side;
    shell.push(beam(P(s * (cowl.beltX - 0.02), cowl.beltY, cab.cowl), P(s * (front.railX - 0.03), front.railY + 0.02, cab.roofFront), 0.08, 0.05));
    const zb = cab.pillars[0];
    const b = L.cabin(zb);
    shell.push(beam(P(s * (b.beltX - 0.03), b.beltY - 0.02, zb), P(s * (b.railX - 0.03), b.railY + 0.02, zb), 0.06, 0.1, _zAxis));
    if (cab.pillars[1] !== undefined) {
      const zc = cab.pillars[1];
      const c = L.cabin(zc);
      shell.push(beam(P(s * (c.beltX - 0.03), c.beltY - 0.02, zc), P(s * (c.railX - 0.03), c.railY + 0.02, zc), 0.06, 0.1, _zAxis));
    }
    // C pillar: the broad panel behind the rear door glass, down to the deck
    const zc0 = Math.max(spec.doors[2], cab.roofRear) - 0.03;
    shell.push(surface(4, 2, (u, v) => {
      const z = THREE.MathUtils.lerp(zc0, cab.deck, u);
      const c = L.cabin(z);
      return [s * (THREE.MathUtils.lerp(c.beltX, c.railX, v) - 0.035), THREE.MathUtils.lerp(c.beltY - 0.02, c.railY + 0.03, v), z];
    }));
  }
  shell.push(beam(P(front.railX, front.railY + 0.03, cab.roofFront - 0.02), P(-front.railX, front.railY + 0.03, cab.roofFront - 0.02), 0.08, 0.05));
  shell.push(beam(P(rear.railX, rear.railY + 0.03, cab.roofRear + 0.02), P(-rear.railX, rear.railY + 0.03, cab.roofRear + 0.02), 0.08, 0.05));
  const liner = surface(10, 6, (u, v) => {
    const z = THREE.MathUtils.lerp(cab.roofFront + 0.02, cab.roofRear - 0.02, v);
    const c = L.cabin(z);
    const x = (u * 2 - 1) * c.railX;
    return [x, L.cabinTop(c, x) - 0.03, z];
  });
  // Sun visors folded up against the liner
  for (const side of [-1, 1]) shell.push(new THREE.BoxGeometry(0.36, 0.02, 0.16).translate(side * driverX, front.railY + 0.0, cab.roofFront - 0.12));
  const shellMesh = new THREE.Mesh(merge(shell), linerMat);
  const linerMesh = new THREE.Mesh(liner, linerMat);
  interior.add(shellMesh, linerMesh);

  // Door cards (inner skin below the glass) with a window ledge and front-door armrests
  const doorZ0 = cab.cowl + 0.02;
  const doorZ1 = cab.deck + 0.08;
  const doors = [];
  const ledges = [];
  for (const side of [-1, 1]) {
    doors.push(surface(14, 4, (u, v) => {
      const z = THREE.MathUtils.lerp(doorZ0, doorZ1, u);
      const top = L.cabin(z).beltY - 0.012;
      const y = THREE.MathUtils.lerp(floorY - 0.02, top, v);
      return [side * (halfWidth(z, y) - 0.07), y, z];
    }));
    ledges.push(surface(14, 1, (u, v) => {
      const z = THREE.MathUtils.lerp(doorZ0, doorZ1, u);
      const c = L.cabin(z);
      const inner = halfWidth(z, c.beltY - 0.1) - 0.13;
      return [side * THREE.MathUtils.lerp(inner, c.beltX + 0.005, v), c.beltY - 0.012 + v * 0.008, z];
    }));
    ledges.push(new THREE.BoxGeometry(0.08, 0.05, 0.42).translate(side * (halfWidth(-0.3, 0.68) - 0.11), floorY + 0.36, -0.35));
  }
  interior.add(new THREE.Mesh(merge(doors), darkMat), new THREE.Mesh(merge(ledges), seatMat));

  // Seats: two fronts and a rear bench; a parcel shelf closes the boot
  const frontSeatZ = dashRear - 0.62;
  const benchZ = Math.max(cab.pillars[0] - 0.75, cab.deck + 0.95);
  const seats = [
    ...buildSeat(driverX, frontSeatZ, 0.5, floorY + 0.22),
    ...buildSeat(-driverX, frontSeatZ, 0.5, floorY + 0.22),
    ...buildSeat(0, benchZ, 2 * (halfWidth(benchZ, 0.6) - 0.12), floorY + 0.2, 0.3)
  ];
  for (const x of [driverX, -driverX]) {
    seats.push(new THREE.BoxGeometry(0.24, 0.17, 0.1).rotateX(-0.22).translate(x, floorY + 1.0, frontSeatZ - 0.66));
  }
  const shelf = new THREE.BoxGeometry(2 * (deck.beltX - 0.05), 0.03, 0.4).translate(0, deck.beltY - 0.04, cab.deck + 0.22);
  interior.add(new THREE.Mesh(merge(seats), seatMat), new THREE.Mesh(shelf, darkMat));

  // Mirrors: rear-view under the roof header, mirror glass on the cabin side of the exterior housings
  const zm = cab.cowl - 0.17;
  const cm = L.cabin(zm);
  const mirrorY = L.cabinTop(L.cabin(cab.roofFront + 0.1), 0) - 0.1;
  const mirrorBack = new THREE.BoxGeometry(0.26, 0.075, 0.035).translate(0, mirrorY, cab.roofFront + 0.1);
  const stem = new THREE.BoxGeometry(0.02, 0.08, 0.02).translate(0, mirrorY + 0.06, cab.roofFront + 0.11);
  interior.add(new THREE.Mesh(merge([mirrorBack, stem]), darkMat));
  const mirrorGlass = [new THREE.PlaneGeometry(0.24, 0.06).rotateY(Math.PI).translate(0, mirrorY, cab.roofFront + 0.082)];
  for (const side of [-1, 1]) {
    mirrorGlass.push(new THREE.PlaneGeometry(0.09, 0.05).rotateY(Math.PI - side * 0.12).translate(side * (cm.beltX + 0.15), cm.beltY + 0.085, zm - 0.064));
  }
  interior.add(new THREE.Mesh(merge(mirrorGlass), mirrorMat));
  // Chrome window surround trim along the door glass base
  interior.add(new THREE.Mesh(merge([-1, 1].map((s) =>
    beam(P(s * (cowl.beltX - 0.02), cowl.beltY + 0.003, cab.cowl - 0.02), P(s * (deck.beltX - 0.02), deck.beltY + 0.003, cab.deck + 0.1), 0.012, 0.012)
  )), trimMat));

  // Glass: windshield (its own mesh & material; environment.js swaps in rainy glass), side windows and backlight
  const inset = 0.014;
  const topGlass = (z0, z1) => surface(12, 6, (u, v) => {
    const z = THREE.MathUtils.lerp(z0, z1, v);
    const c = L.cabin(z);
    const x = (u * 2 - 1) * c.railX * 0.995;
    return [x, L.cabinTop(c, x) - inset, z];
  });
  const windshield = new THREE.Mesh(topGlass(cab.cowl, cab.roofFront), glassMat.clone());
  windshield.name = 'Windshield';
  windshield.renderOrder = 2;
  const sideGlass = [topGlass(cab.roofRear, cab.deck)];
  for (const side of [-1, 1]) {
    sideGlass.push(surface(20, 3, (u, v) => {
      const z = THREE.MathUtils.lerp(cab.cowl, cab.deck, u);
      const c = L.cabin(z);
      const x = THREE.MathUtils.lerp(c.beltX, c.railX, v) + c.bulge * 4 * v * (1 - v) - inset;
      return [side * x, THREE.MathUtils.lerp(c.beltY, c.railY, v), z];
    }));
  }
  const windows = new THREE.Mesh(merge(sideGlass), glassMat);
  windows.renderOrder = 2;
  chassis.add(windshield, windows);

  for (const mesh of [shellMesh, linerMesh]) mesh.castShadow = true;
  interior.traverse((o) => { if (o.isMesh) o.receiveShadow = true; });

  // --- Views & camera ---------------------------------------------------------------------------------------------
  const camera = new THREE.PerspectiveCamera(72, 1, 0.05, 6000);
  const eyeY = Math.min(1.15, front.railY - 0.18);
  const views = {
    driver: { label: '운전석', eye: P(driverX, eyeY, frontSeatZ - 0.14), yaw: 0, pitch: -0.05, fov: 64, yawLimit: [-1.9, 2.0], pitchLimit: [-0.6, 0.45] },
    'passenger-side': { label: '조수석 창밖', eye: P(-driverX * 0.9, eyeY - 0.02, frontSeatZ + 0.2), yaw: -1.25, pitch: -0.04, fov: 68, yawLimit: [-2.4, 0.5], pitchLimit: [-0.5, 0.4] },
    'rear-seat': { label: '뒷좌석', eye: P(-driverX * 0.8, Math.min(1.1, L.cabin(benchZ - 0.15).railY - 0.15), benchZ - 0.2), yaw: 0.06, pitch: -0.1, fov: 70, yawLimit: [-1.6, 1.6], pitchLimit: [-0.5, 0.4] },
    chase: { label: '외부 추적', eye: P(0, 2.3, spec.zRear - 5.2), yaw: 0, pitch: -0.12, fov: 60, yawLimit: [-Math.PI, Math.PI], pitchLimit: [-0.5, 0.35], chase: true }
  };
  let view = views.driver;
  let viewId = 'driver';
  let lookYaw = 0;
  let lookPitch = 0;
  let idle = 0;
  const chasePos = new THREE.Vector3();
  let chaseReady = false;

  function setView(id) {
    if (!views[id]) throw new Error(`car-cabin: unknown view ${id}`);
    viewId = id;
    view = views[id];
    lookYaw = lookPitch = 0;
    chaseReady = false;
    camera.fov = view.fov;
    camera.updateProjectionMatrix();
    body.castShadow = !!view.chase;
    interior.visible = !view.chase;
  }
  setView('driver');

  // --- Pose -------------------------------------------------------------------------------------------------------
  let steer = 0; // road-wheel angle, rad (+ = right)
  let steerTarget = 0;
  let wheelSpin = 0;
  let lastDistance = null;
  let speed = 0;
  let inTunnel = false;

  function setPose(state) {
    group.position.copy(state.position);
    group.rotation.y = Math.PI - state.heading;
    chassis.rotation.set(-(state.pitch || 0), 0, state.roll || 0);
    steerTarget = Math.atan(2 * spec.wheelZ * (state.curvature || 0));
    speed = state.speed;
    inTunnel = !!state.tunnel;
    if (lastDistance !== null) {
      const step = (state.distance - lastDistance) / spec.wheelRadius;
      wheelSpin = (wheelSpin + Math.sign(step) * Math.min(Math.abs(step), 0.48)) % (Math.PI * 2);
    }
    lastDistance = state.distance;
    carState.value.x = (state.accel ?? 0) < -0.4 || state.speed < 0.1 ? 1 : 0;
    const kmh = state.speed * 3.6;
    speedU.value = Math.min(kmh / 240, 1);
    // A five-speed automatic, roughly: revs climb through each gear band and drop at the shift
    const band = kmh < 20 ? kmh / 20 : kmh < 40 ? (kmh - 20) / 20 : kmh < 65 ? (kmh - 40) / 25 : kmh < 90 ? (kmh - 65) / 25 : Math.min(1, (kmh - 90) / 60);
    rpmU.value = state.speed < 0.1 ? 0.1 : 0.15 + band * 0.22 + Math.max(0, state.accel ?? 0) * 0.04;
  }

  function update(dt, input = {}) {
    // Steering eases towards the path curvature (a driver doesn't snap the wheel)
    steer += (steerTarget - steer) * (1 - Math.exp(-dt * 6));
    steering.rotation.z = steer * STEER_RATIO;
    for (const w of wheels) {
      w.tire.rotation.x = wheelSpin + (w.isFront ? 0 : 0.55);
      if (w.isFront) w.steerPivot.rotation.y = -steer;
    }

    // Headlights fade in at dusk exactly like the Manhattan player car, and are switched on in tunnels (as the law asks)
    const glow = cityUniforms.uInteriorGlow.value;
    const beamScale = Math.max(inTunnel ? 1 : 0, Math.min(1.28, Math.max(0, (glow - 0.6) * 1.45)));
    for (const spot of headLights) spot.intensity = spot.userData.intensity * beamScale;

    // Look around: drag offsets, clamped per view, easing back to centre when idle
    const dx = input.lookDX || 0;
    const dy = input.lookDY || 0;
    if (dx || dy) {
      idle = 0;
      lookYaw = THREE.MathUtils.clamp(lookYaw - dx * LOOK_PER_PX, view.yawLimit[0] - view.yaw, view.yawLimit[1] - view.yaw);
      lookPitch = THREE.MathUtils.clamp(lookPitch - dy * LOOK_PER_PX, view.pitchLimit[0] - view.pitch, view.pitchLimit[1] - view.pitch);
    } else if ((idle += dt) > LOOK_IDLE) {
      const k = Math.exp(-dt * 2.5);
      lookYaw *= k;
      lookPitch *= k;
    }

    group.updateMatrixWorld(true);
    if (view.chase) {
      // Trail behind the car (orbiting with the look yaw), smoothed so turns swing the camera out
      const yaw = group.rotation.y + lookYaw;
      const back = -view.eye.z;
      const target = _v.set(group.position.x - Math.sin(yaw) * back, group.position.y + view.eye.y, group.position.z - Math.cos(yaw) * back);
      if (!chaseReady || chasePos.distanceTo(target) > 40) chasePos.copy(target);
      else chasePos.lerp(target, 1 - Math.exp(-dt * 4));
      chaseReady = true;
      camera.position.copy(chasePos);
      camera.lookAt(group.position.x, group.position.y + 1.1, group.position.z);
      camera.rotateX(lookPitch);
    } else {
      // Head bolted to the chassis (it pitches & rolls with the body), looking forward along +z plus the offsets
      camera.position.copy(view.eye).applyMatrix4(chassis.matrixWorld);
      chassis.getWorldQuaternion(_q);
      _e.set(view.pitch + lookPitch, Math.PI + view.yaw + lookYaw, 0);
      camera.quaternion.copy(_q).multiply(new THREE.Quaternion().setFromEuler(_e));
    }
    camera.updateMatrixWorld();
  }

  scene.add(group);

  return {
    group,
    chassis,
    windshield,
    windows,
    camera,
    views,
    headLights,
    setPose,
    setView,
    get view() { return viewId; },
    update
  };
}

export { createCarCabin };
