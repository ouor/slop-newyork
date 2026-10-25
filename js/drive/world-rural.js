import * as THREE from 'three/webgpu';
import { Fn, float, vec2, vec3, pow, attribute, positionWorld, fract, sin, dot, floor, texture, uv, smoothstep, mix } from 'three/tsl';
import { cityUniforms } from '../tsl-materials.js';
import { MeshData, mulberry32, hashId } from './world-geometry.js';
import { routeIndex, ruralMask, villageLots, farmParcels, forestSites, powerLines, highwayPlan, tileSeed } from './world-rural-layout.js';
import { getAtlas, writeFurniture, beam } from './world-rural-signs.js';

// js/drive/world-rural.js
// The countryside of one Korea Drive tile (docs/drive.md, phase 2), standing on the terrain: buildRural(tile, ctx) lays
// the tile out (world-rural-layout.js) and turns the layout into a handful of merged / instanced meshes:
// - forests: low-poly 소나무 (pine) & 참나무 (oak) instanced per 125 m cell of the tile, a branchy crown near the
//   camera and an 8-triangle spindle beyond TREE_NEAR; woods, scrub and every unmapped slope of the countryside
// - farmland: 논 paddies (rice sheet + earthen bunds), 밭 ridges (soil, black mulch or crop rows), orchards,
//   비닐하우스 tunnels (instanced arches), 축사 barns with blue / red / green roofs
// - villages: 시골 houses with metal or tiled gable roofs, yard walls and a yard tree, hamlets at the foot of the
//   hills, 조립식 factories with blue roofs on industrial land
// - 송전탑 lattice towers with catenary conductors, consistent across tiles (lines live in world space), and a
//   relay mast on the odd summit
// - expressway furniture (world-rural-signs.js): green direction signs, gantries, route shields, 거리표, km markers,
//   비상전화, delineators
// Materials and templates are shared by every tile and created on first use; the work is a generator run in ≈ 8 ms
// slices.

const SLICE_MS = 8;
const QUAD = 125; // m, tree LOD cell
const TREE_NEAR = 90; // m from a cell's box: crowns within, spindles beyond
const TREE_FAR = 1500; // m: spindles hidden beyond (the terrain's own shading carries the hills further out)
const DETAIL_FAR = 650; // m: furniture, field ridges & bunds hidden beyond
const RURAL_FAR = 2200; // m: the whole tile hidden beyond
const TOWER_TOP = 48; // m above the far-terrain sample: towers share their top height across tiles

const yieldToBrowser = () => (globalThis.scheduler?.yield ? globalThis.scheduler.yield() : new Promise((resolve) => setTimeout(resolve, 0)));

// ---------------------------------------------------------------------------------------------------------------------
// Materials (shared, lazily)
// ---------------------------------------------------------------------------------------------------------------------
const hash21 = Fn(([p]) => fract(sin(dot(p, vec2(127.1, 311.7))).mul(43758.5453)));
const srgb = (c) => pow(c, vec3(2.2));
const nightFactor = () => smoothstep(0.55, 1.2, cityUniforms.uInteriorGlow);

function tintMaterial({ roughness = 0.85, metalness = 0, noise = 0.12, grain = 1.7 } = {}) {
  const mat = new THREE.MeshStandardNodeMaterial({ roughness, metalness });
  mat.colorNode = srgb(attribute('tint', 'vec3')).mul(hash21(floor(positionWorld.xz.mul(grain))).mul(noise).add(1.0 - noise * 0.5));
  return mat;
}

let materials = null;
function getMaterials() {
  if (materials) return materials;
  const atlas = getAtlas();
  const sign = new THREE.MeshStandardNodeMaterial({ roughness: 0.45, metalness: 0 });
  const face = texture(atlas.texture, uv()).rgb;
  sign.colorNode = face;
  // Retroreflective sheeting: the lettering lights up in the headlights at night
  sign.emissiveNode = face.mul(nightFactor().mul(0.5));
  const tree = tintMaterial({ roughness: 0.9, noise: 0.3, grain: 0.9 });
  tree.colorNode = tree.colorNode.mul(mix(float(0.8), float(1.05), hash21(floor(positionWorld.xz.mul(0.35)).add(7.0))));
  materials = {
    tint: tintMaterial(),
    farm: tintMaterial({ roughness: 0.92, noise: 0.18, grain: 0.6 }),
    metal: tintMaterial({ roughness: 0.5, metalness: 0.35, noise: 0.04 }),
    tree,
    greenhouse: new THREE.MeshStandardNodeMaterial({ color: 0xe6edef, roughness: 0.28, metalness: 0, transparent: true, opacity: 0.88 }),
    sign,
    wire: new THREE.LineBasicNodeMaterial({ color: 0x2a2c30 })
  };
  return materials;
}

// ---------------------------------------------------------------------------------------------------------------------
// Templates (shared, lazily)
// ---------------------------------------------------------------------------------------------------------------------
function toGeometry(md) {
  const a = md.arrays();
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.BufferAttribute(a.position, 3));
  g.setAttribute('normal', new THREE.BufferAttribute(a.normal, 3));
  for (const e of md.extra) g.setAttribute(e.name, new THREE.BufferAttribute(a[e.name], e.size));
  g.setIndex(new THREE.BufferAttribute(a.index, 1));
  g.computeBoundingSphere();
  return g;
}

const lerp3 = (a, b, t) => [a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t, a[2] + (b[2] - a[2]) * t];

// Low-poly ellipsoid (seg around, 3 bands) with smooth normals, tinted from `bottom` to `top`
function blob(md, cx, cy, cz, rx, ry, rz, seg, top, bottom) {
  const v = (x, y, z, t) => {
    md.set('tint', ...lerp3(bottom, top, t));
    const nx = (x - cx) / rx, ny = (y - cy) / ry, nz = (z - cz) / rz;
    const l = Math.hypot(nx, ny, nz) || 1;
    return md.vert(x, y, z, nx / l, ny / l, nz / l);
  };
  const tri = (a, b, c) => {
    const P = md.pos.a;
    const fx = (P[a * 3] + P[b * 3] + P[c * 3]) / 3 - cx, fy = (P[a * 3 + 1] + P[b * 3 + 1] + P[c * 3 + 1]) / 3 - cy, fz = (P[a * 3 + 2] + P[b * 3 + 2] + P[c * 3 + 2]) / 3 - cz;
    md.tri(a, b, c, fx, fy, fz);
  };
  const rows = [[v(cx, cy + ry, cz, 1)]];
  for (let i = 1; i < 3; i++) {
    const phi = (i / 3) * Math.PI, y = Math.cos(phi), r = Math.sin(phi);
    const row = [];
    for (let k = 0; k < seg; k++) {
      const a = ((k + (i % 2) * 0.5) / seg) * Math.PI * 2;
      row.push(v(cx + Math.cos(a) * r * rx, cy + y * ry, cz + Math.sin(a) * r * rz, (y + 1) / 2));
    }
    rows.push(row);
  }
  rows.push([v(cx, cy - ry, cz, 0)]);
  for (let i = 0; i + 1 < rows.length; i++) {
    const A = rows[i], B = rows[i + 1];
    for (let k = 0; k < seg; k++) {
      if (A.length === 1) tri(A[0], B[k], B[(k + 1) % seg]);
      else if (B.length === 1) tri(A[k], A[(k + 1) % seg], B[0]);
      else {
        tri(A[k], B[k], A[(k + 1) % seg]);
        tri(A[(k + 1) % seg], B[k], B[(k + 1) % seg]);
      }
    }
  }
}

// Two-cone spindle (far trees): `seg` sides, from y0 to y1 with its widest ring at ym
function spindle(md, y0, ym, y1, r, seg, top, bottom) {
  const ring = [];
  md.set('tint', ...bottom);
  const b = md.vert(0, y0, 0, 0, -1, 0);
  md.set('tint', ...lerp3(bottom, top, 0.6));
  for (let k = 0; k < seg; k++) {
    const a = (k / seg) * Math.PI * 2;
    ring.push(md.vert(Math.cos(a) * r, ym, Math.sin(a) * r, Math.cos(a), 0.3, Math.sin(a)));
  }
  md.set('tint', ...top);
  const t = md.vert(0, y1, 0, 0, 1, 0);
  for (let k = 0; k < seg; k++) {
    const a = ((k + 0.5) / seg) * Math.PI * 2;
    md.tri(ring[k], ring[(k + 1) % seg], t, Math.cos(a), 0.6, Math.sin(a));
    md.tri(ring[(k + 1) % seg], ring[k], b, Math.cos(a), -0.6, Math.sin(a));
  }
}

const PINE = { top: [0.2, 0.33, 0.16], bottom: [0.1, 0.17, 0.09] };
const OAK = { top: [0.36, 0.48, 0.2], bottom: [0.17, 0.25, 0.1] };
const BARK = [0.33, 0.25, 0.19];

let templates = null;
function getTemplates() {
  if (templates) return templates;
  // 소나무: a reddish trunk under layered crown clumps (≈ 10 m); in a stand the clumps of neighbours touch
  const pine = new MeshData({ tint: 3 });
  pine.set('tint', 0.42, 0.27, 0.2);
  pine.cylinder(0, -0.5, 0, 0.2, 7.0, 5);
  blob(pine, 0.2, 6.2, 0, 3.0, 1.6, 2.8, 6, PINE.top, PINE.bottom);
  blob(pine, -1.0, 4.6, 0.7, 2.4, 1.4, 2.3, 6, PINE.top, PINE.bottom);
  blob(pine, 0.8, 8.0, -0.5, 2.2, 1.2, 2.0, 6, PINE.top, PINE.bottom);
  blob(pine, -0.3, 9.3, 0.2, 1.3, 0.8, 1.3, 5, PINE.top, PINE.bottom);
  // 참나무: a short trunk under a broad rounded crown (≈ 9 m)
  const oak = new MeshData({ tint: 3 });
  oak.set('tint', ...BARK);
  oak.cylinder(0, -0.5, 0, 0.24, 4.0, 5);
  blob(oak, 0, 5.8, 0, 3.6, 3.0, 3.5, 7, OAK.top, OAK.bottom);
  blob(oak, 1.6, 4.4, 1.1, 2.6, 2.2, 2.4, 6, OAK.top, OAK.bottom);
  blob(oak, -1.5, 7.2, -0.9, 2.5, 2.1, 2.5, 6, OAK.top, OAK.bottom);
  const pineFar = new MeshData({ tint: 3 });
  spindle(pineFar, 2.6, 6.0, 10.4, 3.2, 4, PINE.top, PINE.bottom);
  const oakFar = new MeshData({ tint: 3 });
  spindle(oakFar, 1.8, 5.6, 9.6, 3.8, 4, OAK.top, OAK.bottom);

  // 비닐하우스: a unit arch (1 wide, 1 high, 1 long along +z) with closed ends, scaled per tunnel
  const arch = new MeshData();
  const S = 10;
  const pts = [];
  for (let k = 0; k <= S; k++) {
    const a = (k / S) * Math.PI;
    pts.push([Math.cos(a) * 0.5, Math.sin(a), Math.cos(a), Math.sin(a) * 2]);
  }
  for (let k = 0; k < S; k++) {
    const [x0, y0, n0x, n0y] = pts[k], [x1, y1, n1x, n1y] = pts[k + 1];
    const a = arch.vert(x0, y0, -0.5, n0x, n0y, 0), b = arch.vert(x1, y1, -0.5, n1x, n1y, 0);
    const c = arch.vert(x1, y1, 0.5, n1x, n1y, 0), d = arch.vert(x0, y0, 0.5, n0x, n0y, 0);
    arch.tri(a, b, c, n0x + n1x, n0y + n1y, 0);
    arch.tri(a, c, d, n0x + n1x, n0y + n1y, 0);
  }
  for (const z of [-0.5, 0.5]) {
    const c = arch.vert(0, 0, z, 0, 0, Math.sign(z));
    const ring = pts.map(([x, y]) => arch.vert(x, y, z, 0, 0, Math.sign(z)));
    for (let k = 0; k < S; k++) arch.tri(c, ring[k], ring[k + 1], 0, 0, Math.sign(z));
  }

  // 송전탑: a tapering square lattice, its top (the earth-wire peaks) at y = 0, legs reaching 80 m down (into the ground
  // wherever the tile's terrain is higher than the far sample), three cross-arms a side along ±x, the line along z
  const tower = new MeshData({ tint: 3 });
  tower.set('tint', 0.62, 0.64, 0.65);
  const hw = (y) => (y >= -20 ? 0.6 + (-y - 2) * 0.03 : 1.14 + (-20 - y) * 0.1);
  const levels = [-2, -7, -12, -17, -20, -27, -35, -44, -54, -66, -80];
  const corners = [[1, 1], [-1, 1], [-1, -1], [1, -1]];
  for (let i = 0; i + 1 < levels.length; i++) {
    const ya = levels[i], yb = levels[i + 1], ha = hw(ya), hb = hw(yb);
    for (let c = 0; c < 4; c++) {
      const [sx, sz] = corners[c], [tx, tz] = corners[(c + 1) % 4];
      beam(tower, sx * ha, ya, sz * ha, sx * hb, yb, sz * hb, 0.13 + (-yb / 80) * 0.08);
      beam(tower, sx * hb, yb, sz * hb, tx * hb, yb, tz * hb, 0.06);
      beam(tower, sx * ha, ya, sz * ha, tx * hb, yb, tz * hb, 0.05);
      beam(tower, tx * ha, ya, tz * ha, sx * hb, yb, sz * hb, 0.05);
    }
  }
  const attach = [];
  for (const [y, L] of [[-6, 6.5], [-11, 7.8], [-16, 6.5]]) {
    const h = hw(y);
    for (const s of [-1, 1]) {
      tower.set('tint', 0.62, 0.64, 0.65);
      beam(tower, s * h, y, h, s * L, y, 0, 0.07);
      beam(tower, s * h, y, -h, s * L, y, 0, 0.07);
      beam(tower, s * h, y + 2.2, 0, s * L, y, 0, 0.05);
      tower.set('tint', 0.48, 0.42, 0.36);
      beam(tower, s * L, y, 0, s * L, y - 2.2, 0, 0.14); // insulator string
      attach.push([s * L, y - 2.2, 0]);
    }
  }
  tower.set('tint', 0.62, 0.64, 0.65);
  for (const s of [-1, 1]) {
    beam(tower, s * hw(-2), -2, hw(-2), s * 2.6, 0, 0, 0.05);
    beam(tower, s * hw(-2), -2, -hw(-2), s * 2.6, 0, 0, 0.05);
    attach.push([s * 2.6, 0, 0]);
  }

  templates = {
    trees: [[toGeometry(pine), toGeometry(pineFar)], [toGeometry(oak), toGeometry(oakFar)]],
    arch: toGeometry(arch),
    tower: toGeometry(tower),
    attach
  };
  return templates;
}

// ---------------------------------------------------------------------------------------------------------------------
// Writers: buildings & fields (into per-tile MeshData)
// ---------------------------------------------------------------------------------------------------------------------
const ROOF_METAL = [[0.2, 0.42, 0.72], [0.66, 0.22, 0.18], [0.24, 0.5, 0.33], [0.82, 0.45, 0.2], [0.55, 0.58, 0.6]];
const ROOF_TILE = [[0.24, 0.26, 0.3], [0.33, 0.33, 0.34], [0.46, 0.25, 0.2]];
const WALLS = [[0.92, 0.9, 0.84], [0.86, 0.84, 0.78], [0.8, 0.8, 0.78], [0.62, 0.38, 0.3], [0.9, 0.86, 0.72]];

// Local (lx, lz) of a footprint centred at (x, z) turned by yaw → world [x, z] (MeshData.box's convention)
const local = (x, z, yaw) => {
  const c = Math.cos(yaw), s = Math.sin(yaw);
  return (lx, lz) => [x + lx * c + lz * s, z - lx * s + lz * c];
};

// Gable roof over a w × d footprint (ridge along local x) from eave height e, rising `pitch` m per m, overhang o
function gable(md, x, z, yaw, w, d, e, pitch, o, tint) {
  const P = local(x, z, yaw);
  const c = Math.cos(yaw), s = Math.sin(yaw);
  const hw = w / 2 + o, hd = d / 2 + o, ridge = e + pitch * hd;
  md.set('tint', ...tint);
  for (const side of [1, -1]) {
    // slope normal (0, 1, side * pitch) in the local frame
    const nl = Math.hypot(1, pitch);
    const nx = (side * pitch * s) / nl, nz = (side * pitch * c) / nl, ny = 1 / nl;
    const q = [[-hw, side * hd], [hw, side * hd], [hw, 0], [-hw, 0]].map(([lx, lz], i) => {
      const [wx, wz] = P(lx, lz);
      return [wx, i < 2 ? e : ridge, wz];
    });
    md.quad(q, nx, ny, nz);
    // underside of the eaves
    md.quad(q.map(([a, b, cc]) => [a, b - 0.12, cc]), -nx, -ny, -nz);
  }
  md.set('tint', ...WALLS[1]);
  for (const side of [1, -1]) {
    const [ax, az] = P(side * (w / 2), -d / 2), [bx, bz] = P(side * (w / 2), d / 2), [cx, cz] = P(side * (w / 2), 0);
    const a = md.vert(ax, e, az, side * c, 0, -side * s), b = md.vert(bx, e, bz, side * c, 0, -side * s), t = md.vert(cx, e + pitch * (d / 2), cz, side * c, 0, -side * s);
    md.tri(a, b, t, side * c, 0, -side * s);
  }
}

// Footprint's ground range: { lo, hi } over its corners & centre
function groundRange(sampler, x, z, yaw, w, d) {
  const P = local(x, z, yaw);
  let lo = Infinity, hi = -Infinity;
  for (const [a, b] of [[0, 0], [-w / 2, -d / 2], [w / 2, -d / 2], [w / 2, d / 2], [-w / 2, d / 2]]) {
    const [px, pz] = P(a, b);
    const h = sampler.heightAt(px, pz);
    lo = Math.min(lo, h);
    hi = Math.max(hi, h);
  }
  return { lo, hi };
}

function writeHouse(md, lot, sampler, yardTrees) {
  const r = mulberry32(lot.seed);
  const { x, z, yaw, w, d, storeys } = lot;
  const { lo, hi } = groundRange(sampler, x, z, yaw, w + 6, d + 6);
  const y0 = lo - 0.4, base = hi + 0.15, eave = base + storeys * 2.8;
  const P = local(x, z, yaw);
  md.set('tint', ...WALLS[Math.floor(r() * WALLS.length)]);
  md.box(x, y0, z, w, eave - y0, d, yaw);
  // windows & door on the south-facing front (local +z), a window on each gable end
  md.set('tint', 0.16, 0.19, 0.22);
  for (let f = 0; f < storeys; f++) {
    for (const u of [-w / 4, w / 4]) {
      if (f === 0 && u > 0) continue;
      const [wx, wz] = P(u, d / 2);
      md.box(wx, base + f * 2.8 + 0.9, wz, Math.min(2.4, w * 0.3), 1.2, 0.12, yaw);
    }
  }
  const [dx, dz] = P(w / 4, d / 2);
  md.set('tint', 0.45, 0.33, 0.24);
  md.box(dx, base, dz, 1.0, 2.1, 0.14, yaw);
  // Roof: coloured metal (low pitch), tiles (steeper), or a flat slab with a parapet on some 2-storey houses
  if (storeys === 2 && r() < 0.35) {
    md.set('tint', 0.62, 0.62, 0.6);
    md.box(x, eave, z, w + 0.3, 0.5, d + 0.3, yaw);
  } else {
    const metal = r() < 0.65;
    const tint = metal ? ROOF_METAL[Math.floor(r() * ROOF_METAL.length)] : ROOF_TILE[Math.floor(r() * ROOF_TILE.length)];
    gable(md, x, z, yaw, w, d, eave, metal ? 0.3 : 0.48, 0.55, tint);
  }
  // 담: a block wall round the yard with a gate gap at the front
  if (r() < 0.6) {
    const W = w + 6, D = d + 6;
    md.set('tint', ...(r() < 0.5 ? [0.72, 0.71, 0.68] : [0.85, 0.84, 0.8]));
    const pieces = [[-W / 2, -D / 2, W / 2, -D / 2], [W / 2, -D / 2, W / 2, D / 2], [-W / 2, D / 2, -W / 2, -D / 2], [-W / 2, D / 2, -1.6, D / 2], [1.6, D / 2, W / 2, D / 2]];
    for (const [a0, b0, a1, b1] of pieces) {
      const [p0x, p0z] = P(a0, b0), [p1x, p1z] = P(a1, b1);
      const len = Math.hypot(p1x - p0x, p1z - p0z);
      const mx = (p0x + p1x) / 2, mz = (p0z + p1z) / 2;
      const g0 = Math.min(sampler.heightAt(p0x, p0z), sampler.heightAt(p1x, p1z)), g1 = Math.max(sampler.heightAt(p0x, p0z), sampler.heightAt(p1x, p1z));
      md.box(mx, g0 - 0.3, mz, 0.2, g1 - g0 + 1.6, len, Math.atan2(p1x - p0x, p1z - p0z));
    }
  }
  // A persimmon / zelkova in the yard
  if (r() < 0.55) {
    const [tx, tz] = P((r() < 0.5 ? -1 : 1) * (w / 2 + 1.8), -d / 2 - 1.2);
    yardTrees.push({ x: tx, z: tz, sp: 1, s: 0.45 + r() * 0.2, hue: 1 });
  }
}

function writeFactory(md, lot, sampler) {
  const r = mulberry32(lot.seed);
  const { x, z, yaw, w, d } = lot;
  const { lo, hi } = groundRange(sampler, x, z, yaw, w, d);
  const y0 = lo - 0.5, base = hi + 0.2, eave = base + 6 + r() * 4;
  md.set('tint', ...(r() < 0.5 ? [0.86, 0.86, 0.82] : [0.74, 0.77, 0.8]));
  md.box(x, y0, z, w, eave - y0, d, yaw);
  // blue fascia stripe and roller doors on the front
  const P = local(x, z, yaw);
  md.set('tint', 0.2, 0.4, 0.68);
  md.box(x, eave - 0.8, z, w + 0.06, 0.6, d + 0.06, yaw);
  md.set('tint', 0.5, 0.52, 0.54);
  for (const u of [-w / 4, w / 4]) {
    const [px, pz] = P(u, d / 2);
    md.box(px, base, pz, 4.2, 4.4, 0.15, yaw);
  }
  gable(md, x, z, yaw, w, d, eave, 0.12, 0.35, r() < 0.8 ? ROOF_METAL[0] : ROOF_METAL[4]);
}

// 축사 / farm shed on a parcel: long, low, a coloured low-pitch metal roof
function writeBarn(md, p, sampler) {
  const r = mulberry32(p.seed);
  const w = Math.min(Math.max(p.lu * 0.7, 14), 48), d = Math.min(p.lv * 0.6, 9 + r() * 6);
  const yaw = Math.atan2(p.uz, p.ux) * -1;
  const { lo, hi } = groundRange(sampler, p.cx, p.cz, yaw, w, d);
  const eave = hi + 2.6 + r() * 0.8;
  md.set('tint', ...(r() < 0.6 ? [0.84, 0.84, 0.8] : [0.7, 0.68, 0.62]));
  md.box(p.cx, lo - 0.4, p.cz, w, eave - lo + 0.4, d, yaw);
  md.set('tint', 0.22, 0.22, 0.22);
  md.box(p.cx, eave - 1.0, p.cz, w + 0.04, 0.6, d + 0.04, yaw); // ventilation band
  gable(md, p.cx, p.cz, yaw, w, d, eave, 0.22, 0.6, ROOF_METAL[Math.floor(r() * 4)]);
  // a small shed at the end
  if (r() < 0.6) {
    const [sx, sz] = local(p.cx, p.cz, yaw)(w / 2 + 4, 0);
    const g = groundRange(sampler, sx, sz, yaw, 5, 4);
    md.set('tint', 0.6, 0.6, 0.58);
    md.box(sx, g.lo - 0.3, sz, 5, g.hi - g.lo + 2.7, 4, yaw);
    gable(md, sx, sz, yaw, 5, 4, g.hi + 2.4, 0.25, 0.3, ROOF_METAL[Math.floor(r() * 5)]);
  }
}

// A terrain-following strip on a parcel: corners of local (u, v) offsets → height above ground
function* parcelGrid(p, nu, nv) {
  for (let j = 0; j <= nv; j++) for (let i = 0; i <= nu; i++) yield [(i / nu - 0.5) * p.lu, (j / nv - 0.5) * p.lv];
}

// Summer rice in its greens, a few still flooded or freshly planted
const RICE = [[0.4, 0.58, 0.2], [0.46, 0.62, 0.23], [0.33, 0.52, 0.17], [0.5, 0.64, 0.26], [0.38, 0.55, 0.22], [0.3, 0.36, 0.32]];
const BUND = [0.42, 0.47, 0.28];

// Paddy: a rice / water sheet just above the ground and earthen bunds round its edge
function writePaddy(md, p, sampler) {
  const r = mulberry32(p.seed);
  const tint = RICE[Math.floor(r() * RICE.length)];
  const nu = Math.max(1, Math.ceil(p.lu / 8)), nv = Math.max(1, Math.ceil(p.lv / 8));
  const at = (u, v) => [p.cx + p.ux * u - p.uz * v, p.cz + p.uz * u + p.ux * v];
  md.set('tint', ...tint);
  const base = md.count;
  for (const [u, v] of parcelGrid(p, nu, nv)) {
    const [x, z] = at(u, v);
    md.vert(x, sampler.heightAt(x, z) + 0.14, z, 0, 1, 0);
  }
  for (let j = 0; j < nv; j++) {
    for (let i = 0; i < nu; i++) {
      const a = base + j * (nu + 1) + i;
      md.tri(a, a + 1, a + nu + 2, 0, 1, 0);
      md.tri(a, a + nu + 2, a + nu + 1, 0, 1, 0);
    }
  }
  writeBunds(md, p, sampler, at);
}

// Bunds (논두렁): a 0.35 m ridge round the parcel, sampled every ≤ 8 m so it follows the ground
function writeBunds(md, p, sampler, at) {
  md.set('tint', ...BUND);
  const hu = p.lu / 2 + 0.6, hv = p.lv / 2 + 0.6;
  for (const [u0, v0, u1, v1] of [[-hu, -hv, hu, -hv], [hu, -hv, hu, hv], [hu, hv, -hu, hv], [-hu, hv, -hu, -hv]]) {
    const len = Math.hypot(u1 - u0, v1 - v0), n = Math.max(1, Math.ceil(len / 8));
    const du = (u1 - u0) / len, dv = (v1 - v0) / len;
    // across = (-dv, du) in (u, v)
    let prev = null;
    for (let k = 0; k <= n; k++) {
      const u = u0 + (u1 - u0) * (k / n), v = v0 + (v1 - v0) * (k / n);
      const [lx, lz] = at(u + dv * 0.45, v - du * 0.45), [cx, cz] = at(u, v), [rx, rz] = at(u - dv * 0.45, v + du * 0.45);
      const cur = [[lx, sampler.heightAt(lx, lz) - 0.05, lz], [cx, sampler.heightAt(cx, cz) + 0.38, cz], [rx, sampler.heightAt(rx, rz) - 0.05, rz]];
      if (prev) {
        const ox = cur[0][0] - cur[2][0], oz = cur[0][2] - cur[2][2];
        md.quad([prev[0], cur[0], cur[1], prev[1]], ox, 0.9, oz);
        md.quad([prev[1], cur[1], cur[2], prev[2]], -ox, 0.9, -oz);
      }
      prev = cur;
    }
  }
}

// 밭: ridges (이랑) 1.1 m apart along the parcel, in soil, black mulch film or crop green
function writeField(md, p, sampler) {
  const r = mulberry32(p.seed);
  const q = r();
  const tint = q < 0.35 ? [0.07, 0.07, 0.08] : q < 0.65 ? [0.5, 0.38, 0.27] : [0.34, 0.5, 0.2];
  const at = (u, v) => [p.cx + p.ux * u - p.uz * v, p.cz + p.uz * u + p.ux * v];
  const rows = Math.floor(p.lv / 1.1);
  const n = Math.max(1, Math.ceil(p.lu / 10));
  md.set('tint', ...tint);
  for (let j = 0; j < rows; j++) {
    const v = -p.lv / 2 + (j + 0.5) * 1.1;
    let prev = null;
    for (let k = 0; k <= n; k++) {
      const u = (k / n - 0.5) * p.lu;
      const [ax, az] = at(u, v - 0.4), [cx, cz] = at(u, v), [bx, bz] = at(u, v + 0.4);
      const cur = [[ax, sampler.heightAt(ax, az) - 0.02, az], [cx, sampler.heightAt(cx, cz) + 0.26, cz], [bx, sampler.heightAt(bx, bz) - 0.02, bz]];
      if (prev) {
        md.quad([prev[0], cur[0], cur[1], prev[1]], p.uz, 1, -p.ux);
        md.quad([prev[1], cur[1], cur[2], prev[2]], -p.uz, 1, p.ux);
      }
      prev = cur;
    }
  }
  writeBunds(md, p, sampler, at);
}

// ---------------------------------------------------------------------------------------------------------------------
// Build
// ---------------------------------------------------------------------------------------------------------------------
const dummy = new THREE.Object3D();
const colour = new THREE.Color();

function instanced(geometry, material, list, name, set) {
  const mesh = new THREE.InstancedMesh(geometry, material, list.length);
  list.forEach((t, i) => {
    set(t, dummy, colour);
    dummy.updateMatrix();
    mesh.setMatrixAt(i, dummy.matrix);
    if (mesh.instanceColor || t.colour) mesh.setColorAt(i, colour);
  });
  mesh.name = name;
  mesh.castShadow = mesh.receiveShadow = true;
  mesh.computeBoundingSphere();
  mesh.computeBoundingBox?.();
  return mesh;
}

function* build(tile, ctx) {
  const key = tile.key ?? `${tile.tx}_${tile.tz}`;
  const M = getMaterials();
  const T = getTemplates();
  const sampler = ctx.sampler;
  const index = ctx.route?.path ? routeIndex(ctx.route) : null;
  const seed = ctx.seed ?? 0;
  const [minX, minZ, maxX, maxZ] = tile.bounds;
  const root = new THREE.Group();
  root.name = `Rural_${key}`;
  const owned = [];
  const add = (md, material, name, parent = root, { cast = true } = {}) => {
    if (!md || md.empty) return null;
    const g = toGeometry(md);
    owned.push(g);
    const mesh = new THREE.Mesh(g, material);
    mesh.name = name;
    mesh.castShadow = cast;
    mesh.receiveShadow = true;
    parent.add(mesh);
    return mesh;
  };
  const stats = { trees: 0, houses: 0, parcels: 0, towers: 0, furniture: 0 };

  const mask = yield* ruralMask(tile, sampler, index);
  yield;
  const lots = villageLots(tile, mask, seed);
  yield;
  const parcels = farmParcels(tile, mask, seed);
  yield;
  const trees = forestSites(tile, mask, seed);
  yield;

  // Buildings
  const structures = new MeshData({ tint: 3 });
  const extraTrees = [];
  for (let i = 0; i < lots.length; i++) {
    if (lots[i].kind === 'factory') writeFactory(structures, lots[i], sampler);
    else writeHouse(structures, lots[i], sampler, extraTrees);
    if (i % 10 === 9) yield;
  }
  stats.houses = lots.length;

  // Fields
  const farm = new MeshData({ tint: 3 });
  const greenhouses = [];
  for (let i = 0; i < parcels.length; i++) {
    const p = parcels[i];
    if (p.type === 'paddy') writePaddy(farm, p, sampler);
    else if (p.type === 'field') writeField(farm, p, sampler);
    else if (p.type === 'barn') writeBarn(structures, p, sampler);
    else if (p.type === 'fallow') writeBunds(farm, p, sampler, (u, v) => [p.cx + p.ux * u - p.uz * v, p.cz + p.uz * u + p.ux * v]);
    else if (p.type === 'orchard') {
      const r = mulberry32(p.seed);
      const hue = r() < 0.5 ? 2 : 3;
      for (let u = -p.lu / 2 + 2.5; u < p.lu / 2 - 1; u += 5) {
        for (let v = -p.lv / 2 + 2; v < p.lv / 2 - 1; v += 4.5) extraTrees.push({ x: p.cx + p.ux * u - p.uz * v, z: p.cz + p.uz * u + p.ux * v, sp: 1, s: 0.34 + r() * 0.06, hue });
      }
    } else if (p.type === 'greenhouse') {
      const r = mulberry32(p.seed);
      const w = 6.2 + r() * 1.4, pitch = w + 1.4;
      const n = Math.max(1, Math.floor(p.lv / pitch));
      const L = p.lu - 3;
      const h = 2.9 + r() * 0.6;
      for (let k = 0; k < n; k++) {
        const v = (k - (n - 1) / 2) * pitch;
        const x = p.cx - p.uz * v, z = p.cz + p.ux * v;
        const lo = Math.min(sampler.heightAt(x + p.ux * L / 2, z + p.uz * L / 2), sampler.heightAt(x - p.ux * L / 2, z - p.uz * L / 2), sampler.heightAt(x, z));
        greenhouses.push({ x, y: lo - 0.15, z, w, h, L, yaw: Math.atan2(p.ux, p.uz) });
      }
    }
    if (i % 6 === 5) yield;
  }
  stats.parcels = parcels.length;

  // Transmission lines: towers & spans owned by this tile (or by none in the corridor, see powerLines)
  const S = index?.tileSize || 500;
  const tileOf = (x, z) => `${Math.floor(x / S)}_${Math.floor(z / S)}`;
  const inTile = (t) => tileOf(t.x, t.z) === key;
  const orphan = (t) => !index || !index.corridor.has(tileOf(t.x, t.z));
  const topAt = (t) => (ctx.far ? ctx.far.heightAt(t.x, t.z) : sampler.heightAt(t.x, t.z)) + TOWER_TOP;
  const avoid = index ? (x, z) => !!index.nearest(x, z, 40) : null;
  const towers = [];
  const wire = [];
  for (const line of powerLines(minX, minZ, maxX, maxZ, seed, avoid)) {
    const yaw = Math.atan2(line.dx, line.dz);
    const c = Math.cos(yaw), s = Math.sin(yaw);
    const ts = line.towers;
    const attachAt = (t) => {
      const top = topAt(t);
      return T.attach.map(([lx, ly, lz]) => [t.x + lx * c + lz * s, top + ly, t.z - lx * s + lz * c]);
    };
    for (let i = 0; i < ts.length; i++) {
      const t = ts[i];
      const draw = inTile(t) || (orphan(t) && ((i > 0 && inTile(ts[i - 1])) || (i + 1 < ts.length && inTile(ts[i + 1]))));
      if (draw) towers.push({ x: t.x, y: topAt(t), z: t.z, yaw });
      if (i + 1 < ts.length && (inTile(t) || (orphan(t) && inTile(ts[i + 1])))) {
        const a = attachAt(t), b = attachAt(ts[i + 1]);
        const span = Math.hypot(ts[i + 1].x - t.x, ts[i + 1].z - t.z);
        const sag = span * 0.028;
        for (let w = 0; w < a.length; w++) {
          for (let k = 0; k < 12; k++) {
            const u0 = k / 12, u1 = (k + 1) / 12;
            wire.push(
              a[w][0] + (b[w][0] - a[w][0]) * u0, a[w][1] + (b[w][1] - a[w][1]) * u0 - 4 * sag * u0 * (1 - u0), a[w][2] + (b[w][2] - a[w][2]) * u0,
              a[w][0] + (b[w][0] - a[w][0]) * u1, a[w][1] + (b[w][1] - a[w][1]) * u1 - 4 * sag * u1 * (1 - u1), a[w][2] + (b[w][2] - a[w][2]) * u1
            );
          }
        }
      }
    }
  }
  stats.towers = towers.length;

  // A relay mast on the tile's summit, now and then
  const hts = tile.terrain;
  if (hts && hts.length) {
    const n = Math.round(Math.sqrt(hts.length));
    let best = -1, lo = Infinity;
    for (let i = 0; i < hts.length; i++) {
      if (best < 0 || hts[i] > hts[best]) best = i;
      lo = Math.min(lo, hts[i]);
    }
    const ix = best % n, iz = Math.floor(best / n);
    if (ix > 3 && iz > 3 && ix < n - 4 && iz < n - 4 && hts[best] - lo > 600 && hashId(tileSeed(tile, seed), 21) % 3 === 0) {
      const step = (maxX - minX) / (n - 1);
      const x = minX + ix * step, z = minZ + iz * step;
      const k = mask.at(x, z);
      if (k >= 0 && mask.road[k] > 10) {
        const g = sampler.heightAt(x, z);
        structures.set('tint', 0.78, 0.78, 0.76);
        structures.box(x + 6, g - 0.5, z + 2, 5, 3.4, 4, 0);
        structures.set('tint', 0.68, 0.7, 0.72);
        const legs = [[1.1, 0], [-0.55, 0.95], [-0.55, -0.95]];
        for (let j = 0; j < 3; j++) {
          const [ax, az] = legs[j], [bx, bz] = legs[(j + 1) % 3];
          beam(structures, x + ax, g - 1, z + az, x + ax * 0.5, g + 34, z + az * 0.5, 0.1);
          for (let y = 0; y < 33; y += 4) beam(structures, x + ax * (1 - y / 70), g + y, z + az * (1 - y / 70), x + bx * (1 - (y + 4) / 70), g + y + 4, z + bz * (1 - (y + 4) / 70), 0.04);
        }
        structures.set('tint', 0.9, 0.9, 0.88);
        structures.cylinder(x + 0.7, g + 26, z, 0.5, 1.4, 8);
        structures.cylinder(x - 0.5, g + 30, z + 0.4, 0.4, 1.0, 8);
        structures.set('tint', 0.8, 0.15, 0.12);
        structures.cylinder(x, g + 34, z, 0.2, 1.2, 6);
      }
    }
  }
  yield;

  // Expressway furniture
  const detail = new THREE.Group();
  detail.name = 'RuralDetail';
  root.add(detail);
  if (index) {
    const plan = highwayPlan(tile, index);
    stats.furniture = plan.length;
    if (plan.length) {
      const metal = new MeshData({ tint: 3 });
      const face = new MeshData({ uv: 2 });
      writeFurniture(plan, metal, face, sampler.heightAt);
      add(metal, M.metal, 'HighwayFurniture', detail);
      add(face, M.sign, 'HighwaySigns', detail, { cast: false });
    }
  }
  yield;

  // Meshes
  add(structures, M.tint, 'RuralBuildings');
  add(farm, M.farm, 'Fields', detail, { cast: false });
  if (greenhouses.length) {
    root.add(instanced(T.arch, M.greenhouse, greenhouses, 'Greenhouses', (t, o) => {
      o.position.set(t.x, t.y, t.z);
      o.rotation.set(0, t.yaw, 0);
      o.scale.set(t.w, t.h, t.L);
    }));
  }
  if (towers.length) {
    root.add(instanced(T.tower, M.metal, towers, 'PowerTowers', (t, o) => {
      o.position.set(t.x, t.y, t.z);
      o.rotation.set(0, t.yaw, 0);
      o.scale.setScalar(1);
    }));
  }
  if (wire.length) {
    const g = new THREE.BufferGeometry();
    g.setAttribute('position', new THREE.Float32BufferAttribute(wire, 3));
    g.computeBoundingSphere();
    owned.push(g);
    const lines = new THREE.LineSegments(g, M.wire);
    lines.name = 'PowerLines';
    root.add(lines);
  }
  yield;

  // Trees: per cell & species, a near and a far instanced mesh (update() shows one)
  const all = trees.concat(extraTrees);
  stats.trees = all.length;
  const cells = new Map();
  for (const t of all) {
    const ck = `${Math.floor(t.x / QUAD)},${Math.floor(t.z / QUAD)}`;
    if (!cells.has(ck)) cells.set(ck, { box: new THREE.Box3(), lists: [[], []], near: [], far: [] });
    const c = cells.get(ck);
    c.lists[t.sp].push(t);
  }
  const treeCells = [];
  let done = 0;
  for (const c of cells.values()) {
    for (let sp = 0; sp < 2; sp++) {
      const list = c.lists[sp];
      if (!list.length) continue;
      const sites = list.map((t) => {
        const r = mulberry32(hashId(Math.round(t.x * 10), Math.round(t.z * 10)));
        const y = sampler.heightAt(t.x, t.z) - 0.2;
        c.box.expandByPoint(new THREE.Vector3(t.x, y, t.z));
        c.box.expandByPoint(new THREE.Vector3(t.x, y + 12 * t.s, t.z));
        // hue: 0 forest, 1 yard tree, 2 / 3 orchard (pear / apple greens)
        const k = 0.82 + r() * 0.36;
        const tint = t.hue === 2 ? [1.2, 1.25, 1.0] : t.hue === 3 ? [1.1, 1.15, 0.85] : t.hue === 1 ? [1.15, 1.05, 0.8] : [k * (0.92 + r() * 0.16), k, k * (0.9 + r() * 0.2)];
        return { x: t.x, y, z: t.z, yaw: r() * Math.PI * 2, s: t.s, sy: t.s * (0.85 + r() * 0.3), colour: tint };
      });
      const set = (t, o, col) => {
        o.position.set(t.x, t.y, t.z);
        o.rotation.set(0, t.yaw, 0);
        o.scale.set(t.s, t.sy, t.s);
        col.setRGB(...t.colour);
      };
      for (let lod = 0; lod < 2; lod++) {
        const mesh = instanced(T.trees[sp][lod], M.tree, sites, `${sp ? 'Oaks' : 'Pines'}_${lod ? 'far' : 'near'}`, set);
        mesh.castShadow = lod === 0;
        mesh.visible = false;
        (lod ? c.far : c.near).push(mesh);
        root.add(mesh);
      }
      done += list.length;
      if (done > 1000) { done = 0; yield; }
    }
    c.box.expandByScalar(4);
    treeCells.push(c);
  }

  const tileBox = new THREE.Box3(new THREE.Vector3(minX, -1e4, minZ), new THREE.Vector3(maxX, 1e4, maxZ));
  root.traverse((o) => {
    o.updateMatrix();
    o.matrixAutoUpdate = false;
  });
  root.updateMatrixWorld(true);

  const cam = new THREE.Vector3();
  function update(camera) {
    cam.setFromMatrixPosition(camera.matrixWorld);
    const d = tileBox.distanceToPoint(cam);
    // Tiles streamed far ahead at high playback speed stay hidden until they are within sight
    root.visible = d < RURAL_FAR;
    if (!root.visible) return;
    detail.visible = d < DETAIL_FAR;
    for (const c of treeCells) {
      const dc = c.box.distanceToPoint(cam);
      for (const m of c.near) m.visible = dc < TREE_NEAR;
      for (const m of c.far) m.visible = dc >= TREE_NEAR && dc < TREE_FAR;
    }
  }
  function dispose() {
    root.removeFromParent();
    for (const g of owned) g.dispose();
    owned.length = 0;
    // Templates are shared: only the instance buffers go
    root.traverse((o) => { if (o.isInstancedMesh) o.dispose(); });
  }
  return { root, update, dispose, stats };
}

/**
 * The tile's countryside: ctx = { route, tile, sampler (tile terrain), far (far terrain, optional), materials (unused),
 * seed }. Returns a Promise of { root, update(camera), dispose(), stats } (null when there is nothing to build); the
 * work runs in ≈ 8 ms slices. Before the first update(camera) every tree is hidden.
 */
async function buildRural(tile, ctx = {}) {
  if (!tile?.bounds || !ctx.sampler) return null;
  const gen = build(tile, { ...ctx, tile });
  let t0 = performance.now();
  let busy = 0, longest = 0;
  for (;;) {
    const { done, value } = gen.next();
    const t = performance.now();
    if (done) {
      busy += t - t0;
      // stats.cpuMs: main-thread time spent on the tile, stats.sliceMs: the longest slice
      value.stats.cpuMs = busy;
      value.stats.sliceMs = Math.max(longest, t - t0);
      return value;
    }
    if (t - t0 > SLICE_MS) {
      busy += t - t0;
      longest = Math.max(longest, t - t0);
      await yieldToBrowser();
      t0 = performance.now();
    }
  }
}

export { buildRural };
