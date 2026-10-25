import * as THREE from 'three/webgpu';
import {
  Fn,
  float,
  vec2,
  vec3,
  vec4,
  uniform,
  positionLocal,
  fract,
  floor,
  sin,
  cos,
  dot,
  atan,
  abs,
  min,
  max,
  pow,
  sqrt,
  mix,
  clamp,
  smoothstep,
  select,
  length,
  normalize
} from 'three/tsl';

// js/drive/weather-windshield.js
// Procedural windshield glass seen from the driver's seat: faint tint and dirt when dry; in rain, beading drops
// (two cell layers) and drops running down (or up the glass at speed, pushed by the airflow) with trails, all cleared by
// a pair of tandem wipers. Each drop only exists once enough time has passed since a blade last swept its spot, so the
// glass refills between sweeps. Drops are shaded as small lenses (sky-bright where they refract the sky above, dark
// rims, a specular glint) rather than by sampling the frame behind: the scene pass may discard its MSAA colour, which a
// mid-pass framebuffer copy would break.
//
// Glass coordinates come from the mesh's local bounding box (no UVs needed): x across the car, y up the slope, metres.

const PIVOTS = [0.17, 0.6]; // wiper pivots, fraction of the glass width, just below its bottom edge
const SWEEP = [0.06, 2.75]; // blade angle range (rad from +x), parked → top of stroke

const hash = Fn(([p]) => fract(sin(dot(p, vec2(127.1, 311.7))).mul(43758.5453)));

const noise = Fn(([p]) => {
  const i = floor(p);
  const f = fract(p);
  const u = f.mul(f).mul(float(3).sub(f.mul(2)));
  const a = hash(i);
  const b = hash(i.add(vec2(1, 0)));
  const c = hash(i.add(vec2(0, 1)));
  const d = hash(i.add(vec2(1, 1)));
  return mix(mix(a, b, u.x), mix(c, d, u.x), u.y);
});

function createWindshieldMaterial(mesh) {
  const geometry = mesh.geometry;
  if (!geometry.boundingBox) geometry.computeBoundingBox();
  const bb = geometry.boundingBox;
  const size = bb.getSize(new THREE.Vector3());
  const acrossX = size.x >= size.z;
  const width = Math.max(acrossX ? size.x : size.z, 0.01);
  const slant = Math.max(Math.hypot(size.y, acrossX ? size.z : size.x), 0.01);
  const arm = Math.min(0.47 * width, 0.92 * slant);

  const u = {
    time: uniform(0),
    rain: uniform(0), // drop density 0..1
    fill: uniform(8), // s for a wiped spot to bead up again
    cycle: uniform(new THREE.Vector4(-1e4, -1e4, 1, 1)), // current / previous wipe start, their sweep durations
    blade: uniform(SWEEP[0]),
    runFlow: uniform(0), // accumulated metres run down the glass (negative: pushed up)
    runSign: uniform(1),
    sky: uniform(new THREE.Color(0x9aa8bc)), // light the drops refract from above
    ambient: uniform(new THREE.Color(0x404850)), // light scattered by the dirt film
    glint: uniform(new THREE.Color(0xffffff))
  };

  const across = acrossX ? positionLocal.x.sub(bb.min.x) : positionLocal.z.sub(bb.min.z);
  const q = vec2(across, positionLocal.y.sub(bb.min.y).mul(slant / Math.max(size.y, 0.01)));

  // Seconds since a blade last crossed q (1e4 where neither reaches)
  const wiperAge = Fn(([p, pivot]) => {
    const d = p.sub(pivot);
    const r = length(d);
    const s = atan(d.y, d.x).sub(SWEEP[0]).div(SWEEP[1] - SWEEP[0]);
    const inside = r.lessThan(arm).and(r.greaterThan(0.05)).and(s.greaterThanEqual(0)).and(s.lessThanEqual(1));
    const t = u.time;
    const up = u.cycle.x.add(s.mul(u.cycle.z).mul(0.5));
    const down = u.cycle.x.add(u.cycle.z).sub(s.mul(u.cycle.z).mul(0.5));
    const prevDown = u.cycle.y.add(u.cycle.w).sub(s.mul(u.cycle.w).mul(0.5));
    const age = select(t.greaterThanEqual(down), t.sub(down), select(t.greaterThanEqual(up), t.sub(up), t.sub(prevDown)));
    return select(inside, age, float(1e4));
  });

  // Dark blade + arm at the current angle
  const bladeMask = Fn(([p, pivot]) => {
    const d = p.sub(pivot);
    const dir = vec2(cos(u.blade), sin(u.blade));
    const along = dot(d, dir);
    const perp = abs(dot(d, vec2(dir.y.negate(), dir.x)));
    const onArm = along.greaterThan(0.02).and(along.lessThan(arm));
    return select(onArm, smoothstep(0.009, 0.005, perp), float(0));
  });

  // Beading drops on a jittered cell grid: xy = lens normal offset, z = coverage
  const beads = Fn(([p, cell, density, age]) => {
    const g = p.div(cell);
    const id = floor(g);
    const f = fract(g).sub(0.5);
    const h1 = hash(id);
    const r = pow(h1, 3).mul(0.26).add(0.12);
    const c = vec2(hash(id.add(17.3)), hash(id.add(41.7))).sub(0.5).mul(float(1).sub(r.mul(2)));
    const dv = f.sub(c).div(r).mul(vec2(1, 0.9));
    const alive = hash(id.add(3.1)).lessThan(density).and(age.greaterThan(hash(id.add(9.2)).mul(u.fill)));
    return vec3(dv, select(alive, smoothstep(1.0, 0.82, dot(dv, dv)), float(0)));
  });

  // Drops running along the slope in columns, with a thinning trail behind
  const runners = Fn(([p, age]) => {
    const colW = 0.05;
    const cx = floor(p.x.div(colW));
    const h = hash(vec2(cx, 7.0));
    const h2 = hash(vec2(cx, 13.0));
    const L = slant + 0.4;
    const pos = fract(h2.add(u.runFlow.mul(h.mul(0.8).add(0.6)).div(L))).mul(L);
    const yd = float(slant + 0.2).sub(pos);
    const lx = p.x.sub(cx.add(0.5).mul(colW)).sub(sin(p.y.mul(38).add(h.mul(6.3))).mul(0.006));
    const dy = p.y.sub(yd);
    const dv = vec2(lx, dy).div(0.0042);
    const head = smoothstep(1.0, 0.8, dot(dv, dv));
    const behind = dy.mul(u.runSign);
    const w = float(0.0016).mul(float(1).sub(behind.div(0.14)));
    const trail = select(behind.greaterThan(0).and(behind.lessThan(0.14)), smoothstep(w, w.mul(0.4), abs(lx)).mul(0.7), float(0));
    const alive = h.lessThan(u.rain.mul(0.4)).and(age.greaterThan(h2.mul(u.fill).mul(1.5)));
    const m = select(alive, max(head, trail), float(0));
    return vec3(select(head.greaterThan(trail), dv, vec2(lx.div(max(w, 0.0005)), 0)), m);
  });

  const material = new THREE.MeshBasicNodeMaterial({ transparent: true, depthWrite: false, side: THREE.DoubleSide });
  material.fog = false;

  const shade = Fn(() => {
    const pA = vec2(width * PIVOTS[0], -0.04);
    const pB = vec2(width * PIVOTS[1], -0.04);
    const age = min(wiperAge(q, pA), wiperAge(q, pB));

    const small = beads(q, float(0.011), u.rain.mul(0.75), age);
    const large = beads(q.add(3.7), float(0.03), u.rain.mul(0.45), age);
    const run = runners(q, age);
    const m = max(max(small.z, large.z), run.z);
    const n = clamp(small.xy.mul(small.z).add(large.xy.mul(large.z)).add(run.xy.mul(run.z)), -1, 1);

    // Lens shading: the lower half of a drop shows the bright sky above, its rim stays dark, a glint near the top
    const rim = smoothstep(0.35, 1.0, length(n));
    const nz = sqrt(max(float(1).sub(dot(n, n)), 0));
    const lens = mix(u.ambient.mul(0.5), u.sky, smoothstep(-0.6, 0.8, n.y.negate()));
    const glint = pow(max(dot(normalize(vec3(n.mul(0.9), nz)), normalize(vec3(-0.25, 0.55, 0.8))), 0), 60);
    const dropCol = lens.mul(float(1).sub(rim.mul(0.65))).add(u.glint.mul(glint).mul(1.5));
    const dropA = m.mul(mix(0.28, 0.8, rim)).add(glint.mul(m).mul(0.5));

    // Dry glass: faint grey-green tint plus a smeared dirt film, heavier low down where the wipers don't reach
    const dirt = smoothstep(0.45, 0.95, noise(q.mul(vec2(9, 4))).mul(0.6).add(noise(q.mul(41)).mul(0.4)));
    const low = smoothstep(0.35, 0.0, q.y.div(slant));
    const glassA = dirt.mul(0.05).add(low.mul(0.04)).add(0.035);
    const glassCol = mix(vec3(0.02, 0.035, 0.03), u.ambient, min(dirt.add(low), 1));

    const blade = max(bladeMask(q, pA), bladeMask(q, pB));
    const a = mix(glassA, 1, min(dropA, 1));
    const col = mix(glassCol, dropCol, min(dropA, 1).div(max(a, 0.001)));
    return vec4(mix(col, vec3(0.012), blade), mix(a, 1, blade));
  })();
  material.colorNode = shade.rgb;
  material.opacityNode = shade.a;

  return { material, uniforms: u };
}

// CPU half of the wipers: starts sweeps and drives the blade angle the shader also derives wipe times from
function createWiper(uniforms) {
  let start = -1e4;
  let sweep = 1;
  let interval = 1;

  function update(time, rain) {
    if (rain > 0.05 && time - start >= Math.max(sweep, interval)) {
      const prev = uniforms.cycle.value;
      prev.y = start;
      prev.w = sweep;
      start = time;
      sweep = rain > 0.7 ? 0.9 : 1.25;
      interval = rain > 0.7 ? sweep : rain > 0.35 ? 2.5 : 5.0;
      prev.x = start;
      prev.z = sweep;
    }
    const c = time - start;
    const s = c < sweep ? (c < sweep / 2 ? c / (sweep / 2) : (sweep - c) / (sweep / 2)) : 0;
    uniforms.blade.value = SWEEP[0] + s * (SWEEP[1] - SWEEP[0]);
  }

  return { update };
}

export { createWindshieldMaterial, createWiper };
