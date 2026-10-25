import { MeshData, resamplePolyline, hashId } from './world-geometry.js';
import { ribbon, wall, block, off, inRun } from './world-roads.js';

// js/drive/world-structures.js
// Civil structures of one tile along the roads world-roads.js laid out (plain mesh data; world-builder.js makes the
// meshes), all on the road profile (`ys`) and down to the tile's ground (heightAt):
// - bridges & viaducts: deck slab with its edge and soffit, I-girders (expressways) or a box girder (city bridges),
//   concrete parapets (expressways) or a kerb with a steel railing (반포대교…), piers every 32 / 45 m down to the ground
//   or river bed (a pier cap on one or two round columns, or a wall pier), abutments at the deck ends
// - tunnels: a horseshoe lining (lower wall in light panels, arch above; uv = metres along / round the section) with
//   walkways, two rows of lamps under the arch (world-materials.js tunnelLamp: tunnelUniforms.uLampColor), green
//   emergency-exit signs every 250 m and red hydrant cabinets every 50 m; a concrete headwall round the opening at each
//   portal. Portals are returned so the terrain shader can cut the hillside out of the tunnel mouth
// - expressways: steel W-beam guardrails at the outer edges, a concrete median barrier where the other carriageway runs
//   alongside, retaining walls at the foot of deep cuts, noise barriers (방음벽: metal base, transparent panels, H-beam
//   posts) where homes are close

const EXPRESS = new Set(['motorway', 'trunk', 'motorway_link', 'trunk_link']);
const CONCRETE = [0.62, 0.61, 0.58];
const PIER = [0.56, 0.55, 0.52];
const STEEL = [0.72, 0.74, 0.76];

function createStructureMeshes() {
  return {
    concrete: new MeshData({ tint: 3 }),
    prop: new MeshData({ tint: 3 }),
    lining: new MeshData({ uv: 2 }),
    lamp: new MeshData(),
    glow: new MeshData({ glow: 4 }),
    glass: new MeshData({ tint: 3 })
  };
}

const yawAcross = (p) => Math.atan2(-p.rz, p.rx); // box yaw putting its width across the road at sample p

// Underside of a beam: both walls and the bottom face (block() has a top)
function beam(mesh, S, o0, o1, y0, y1) {
  ribbon(mesh, S, o0, o1, y0, null, -1);
  wall(mesh, S, o0, y0, y1, -1);
  wall(mesh, S, o1, y0, y1, 1);
}

/**
 * roads: buildRoads' result. ctx: { heightAt(x, z) (ground incl. water cuts), triangulate(outer, holes),
 * nearHomes(x, z) (homes within ~50 m) }. Yields per road; returns { meshes, portals }, portals:
 * [{ x, y, z, dx, dz (into the tunnel), grade (rise per m inwards), halfW, height }].
 */
function* buildStructures(tile, roads, ctx) {
  const meshes = createStructureMeshes();
  const portals = [];
  const [bx0, bz0, bx1, bz1] = tile.bounds || [tile.tx * 500, tile.tz * 500, tile.tx * 500 + 500, tile.tz * 500 + 500];
  const onBorder = (x, z) => Math.min(Math.abs(x - bx0), Math.abs(x - bx1), Math.abs(z - bz0), Math.abs(z - bz1)) < 0.3;
  for (const r of roads.bridges) {
    bridge(meshes, r, roads, ctx, onBorder);
    yield;
  }
  for (const r of roads.tunnels) {
    tunnel(meshes, r, roads, ctx, onBorder, portals);
    yield;
  }
  for (const r of roads.roads) {
    if (!EXPRESS.has(r.hw) || r.src.tunnel) continue;
    roadside(meshes, r, roads, ctx);
    yield;
  }
  return { meshes, portals };
}

function bridge(m, r, roads, ctx, onBorder) {
  const { src, half } = r;
  const express = EXPRESS.has(r.hw);
  const S = resamplePolyline(src.pts, 4, src.ys);
  const edge = half + (express ? 0.6 : 0.4);
  const depth = express ? 2.1 : 1.7;
  const slab = 0.45;

  // Deck slab edges & soffit, girders under it
  m.concrete.set('tint', ...CONCRETE);
  wall(m.concrete, S, -edge, -slab, 0.02, -1);
  wall(m.concrete, S, edge, -slab, 0.02, 1);
  ribbon(m.concrete, S, -edge, edge, -slab, null, -1);
  if (express) {
    const k = Math.max(3, Math.round(edge / 1.6));
    for (let g = 0; g < k; g++) {
      const o = -edge * 0.78 + (edge * 1.56 * g) / (k - 1);
      beam(m.concrete, S, o - 0.25, o + 0.25, -depth, -slab);
    }
  } else {
    beam(m.concrete, S, -edge * 0.6, edge * 0.6, -depth, -slab);
  }

  // Parapets, left out where the next carriageway of the deck runs alongside (the median barrier goes there)
  const R = resamplePolyline(src.pts, 2.5, src.ys);
  for (const side of [-1, 1]) {
    const ok = R.map((p) => { const a = off(p, side * (half + 1.5)); return !roads.coveredByOther(r, a[0], a[1]); });
    if (express) {
      m.concrete.set('tint', 0.58, 0.57, 0.55);
      block(m.concrete, R, side > 0 ? half + 0.1 : -edge, side > 0 ? edge : -half - 0.1, -0.1, 1.05, ok);
      m.prop.set('tint', ...STEEL);
      block(m.prop, R, side * (edge - 0.2) - 0.04, side * (edge - 0.2) + 0.04, 1.05, 1.25, ok);
    } else {
      const o = side * (half + 0.2);
      m.concrete.set('tint', 0.6, 0.6, 0.58);
      block(m.concrete, R, o - 0.2, o + 0.2, -0.2, 0.4, ok);
      m.prop.set('tint', 0.42, 0.47, 0.52);
      block(m.prop, R, o - 0.05, o + 0.05, 1.0, 1.1, ok);
      block(m.prop, R, o - 0.02, o + 0.02, 0.7, 0.74, ok);
      R.forEach((p, i) => { if (inRun(ok, i)) { const [x, z] = off(p, o); m.prop.box(x, p.y + 0.4, z, 0.07, 0.62, 0.07); } });
    }
  }

  // Piers down to the ground (river bed under water), not standing on another road below
  const P = resamplePolyline(src.pts, express ? 32 : 45, src.ys);
  const onRoadBelow = (x, z) => roads.grid.covering(x, z, 1.5, (k) => k === r.index || roads.roads[k].src.bridge);
  for (let i = 1; i < P.length - 1; i++) {
    const p = P[i];
    const g = ctx.heightAt(p.x, p.z);
    const top = p.y - depth;
    if (top - g < 1.2 || onRoadBelow(p.x, p.z)) continue;
    const yaw = yawAcross(p);
    m.concrete.set('tint', ...PIER);
    if (express) {
      m.concrete.box(p.x, top - 1.5, p.z, edge * 1.7, 1.5, 2.2, yaw);
      const cols = edge > 6.5 ? [-edge * 0.45, edge * 0.45] : [0];
      for (const o of cols) m.concrete.cylinder(p.x + p.rx * o, g - 1, p.z + p.rz * o, 0.9, top - 0.5 - g, 10);
    } else {
      m.concrete.box(p.x, g - 1, p.z, half * 1.3, top - g + 1, 2.6, yaw);
    }
  }

  // Abutments: a wall under each deck end, from the ground up to the soffit
  const n = src.pts.length >> 1;
  for (const [i, dir] of [[0, 1], [n - 1, -1]]) {
    const x = src.pts[i * 2], z = src.pts[i * 2 + 1];
    if (onBorder(x, z)) continue;
    const p = dir > 0 ? S[0] : S[S.length - 1];
    const cx = x + p.dx * dir * 1.5, cz = z + p.dz * dir * 1.5;
    const g = ctx.heightAt(cx, cz);
    const y = (src.ys ? src.ys[i] : 0) - slab;
    if (y - g < 0.5) continue;
    m.concrete.set('tint', ...PIER);
    m.concrete.box(cx, g - 1, cz, edge * 2 + 1, y - g + 1, 3, yawAcross(p));
  }
}

function tunnel(m, r, roads, ctx, onBorder, portals) {
  const { src, half } = r;
  const S = resamplePolyline(src.pts, 4, src.ys);
  if (S.length < 2) return;
  const W = half + 1.3;
  const Hc = Math.min(9, Math.max(6.5, 4.6 + W * 0.32));
  const SPRING = 1.6; // m: vertical lower wall, then the arch
  // Section from the left wall foot over the arch to the right wall foot: [offset, height]
  const prof = [[-W, -0.2], [-W, SPRING]];
  for (let k = 1; k < 10; k++) {
    const a = Math.PI * (1 - k / 10);
    prof.push([W * Math.cos(a), SPRING + (Hc - SPRING) * Math.sin(a)]);
  }
  prof.push([W, SPRING], [W, -0.2]);
  const archH = (o) => SPRING + (Hc - SPRING) * Math.sqrt(Math.max(0, 1 - (o / W) ** 2));

  // Lining, facing into the tube; v = metres round the section from the left foot
  const L = m.lining;
  let v = 0;
  for (let k = 0; k + 1 < prof.length; k++) {
    const [o0, h0] = prof[k], [o1, h1] = prof[k + 1];
    const len = Math.hypot(o1 - o0, h1 - h0);
    const no = (h1 - h0) / len, nh = -(o1 - o0) / len; // inward
    for (let i = 0; i + 1 < S.length; i++) {
      const a = S[i], b = S[i + 1];
      const nx = ((a.rx + b.rx) / 2) * no, nz = ((a.rz + b.rz) / 2) * no;
      L.quad([
        [a.x + a.rx * o0 * a.miter, a.y + h0, a.z + a.rz * o0 * a.miter],
        [b.x + b.rx * o0 * b.miter, b.y + h0, b.z + b.rz * o0 * b.miter],
        [b.x + b.rx * o1 * b.miter, b.y + h1, b.z + b.rz * o1 * b.miter],
        [a.x + a.rx * o1 * a.miter, a.y + h1, a.z + a.rz * o1 * a.miter]
      ], nx, nh, nz, [[a.s, v], [b.s, v], [b.s, v + len], [a.s, v + len]]);
    }
    v += len;
  }

  // Walkways, lamp rows, emergency fittings
  m.concrete.set('tint', 0.7, 0.69, 0.66);
  block(m.concrete, S, -W, -half - 0.05, -0.1, 0.25);
  block(m.concrete, S, half + 0.05, W, -0.1, 0.25);
  const lampO = W * 0.62, lampH = archH(lampO) - 0.12;
  for (const p of resamplePolyline(src.pts, 6, src.ys)) {
    const yaw = yawAcross(p);
    for (const side of [-1, 1]) m.lamp.box(p.x + p.rx * side * lampO, p.y + lampH, p.z + p.rz * side * lampO, 0.32, 0.1, 1.4, yaw);
  }
  const phase = hashId(src.id, 7) % 50;
  for (const p of resamplePolyline(src.pts, 50, src.ys)) {
    if (p.s < 10) continue;
    const yaw = yawAcross(p);
    const o = W - 0.12;
    m.prop.set('tint', 0.78, 0.12, 0.1);
    m.prop.box(p.x + p.rx * o, p.y + 0.6, p.z + p.rz * o, 0.25, 1.2, 0.9, yaw);
    m.glow.set('glow', 1.0, 0.15, 0.08, 1);
    m.glow.box(p.x + p.rx * (o - 0.13), p.y + 1.85, p.z + p.rz * (o - 0.13), 0.06, 0.18, 0.18, yaw);
    if ((Math.round(p.s) + phase) % 250 < 50) {
      m.glow.set('glow', 0.1, 0.85, 0.35, 1);
      m.glow.box(p.x + p.rx * (o - 0.05), p.y + 2.6, p.z + p.rz * (o - 0.05), 0.08, 0.45, 1.3, yaw);
    }
  }

  // Portals: tunnel ends joining an open road
  const n = src.pts.length >> 1;
  for (const [i, dir] of [[0, 1], [n - 1, -1]]) {
    const x = src.pts[i * 2], z = src.pts[i * 2 + 1];
    if (onBorder(x, z)) continue;
    const joins = roads.roads.some((o) => !o.src.tunnel && hasPointNear(o.src.pts, x, z, 2));
    if (!joins) continue;
    const p = dir > 0 ? S[0] : S[S.length - 1];
    const dx = p.dx * dir, dz = p.dz * dir; // into the tunnel
    const y = src.ys ? src.ys[i] : 0;
    const inner = S[Math.min(S.length - 1, Math.max(0, dir > 0 ? 5 : S.length - 6))];
    const grade = (inner.y - y) / Math.max(1, Math.hypot(inner.x - x, inner.z - z));
    portals.push({ x, y, z, dx, dz, grade, halfW: W + 0.4, height: Hc + 0.3 });
    headwall(m.concrete, x, y, z, dx, dz, prof, W, Hc, ctx.triangulate);
  }
}

const hasPointNear = (pts, x, z, d) => {
  for (let i = 0; i < pts.length; i += 2) if (Math.abs(pts[i] - x) < d && Math.abs(pts[i + 1] - z) < d) return true;
  return false;
};

// Concrete face round the tunnel opening at a portal (x, y, z), facing out (against d), 1.5 m deep into the hill
function headwall(mesh, x, y, z, dx, dz, prof, W, Hc, triangulate) {
  const ux = -dz, uz = dx; // across
  const U = W + 5, top = Hc + 3.2, bottom = -1.5;
  const outer = [-U, bottom, U, bottom, U, top, -U, top];
  const hole = [];
  for (let k = prof.length - 1; k >= 0; k--) hole.push(prof[k][0], Math.max(prof[k][1], bottom + 0.1));
  const P = (u, v, back = 0) => [x + ux * u + dx * back, y + v, z + uz * u + dz * back];
  mesh.set('tint', 0.7, 0.69, 0.65);
  const base = mesh.count;
  for (const ring of [outer, hole]) for (let k = 0; k < ring.length; k += 2) mesh.vert(...P(ring[k], ring[k + 1]), -dx, 0, -dz);
  for (const f of triangulate(outer, [hole])) mesh.tri(base + f[0], base + f[1], base + f[2], -dx, 0, -dz);
  // Top & sides, back into the hill
  mesh.quad([P(-U, top), P(U, top), P(U, top, 1.5), P(-U, top, 1.5)], 0, 1, 0);
  mesh.quad([P(U, bottom), P(U, bottom, 1.5), P(U, top, 1.5), P(U, top)], ux, 0, uz);
  mesh.quad([P(-U, bottom), P(-U, top), P(-U, top, 1.5), P(-U, bottom, 1.5)], -ux, 0, -uz);
}

// Guardrails, median barriers, retaining walls and noise barriers along an expressway carriageway
function roadside(m, r, roads, ctx) {
  const { src, half } = r;
  const W = resamplePolyline(src.pts, 4, src.ys);
  const height = 4 + (hashId(src.id, 11) % 3);
  for (const side of [1, -1]) {
    const free = W.map((p) => { const a = off(p, side * (half + 0.3)); return !roads.coveredByOther(r, a[0], a[1]); });
    // The other carriageway right alongside (within ~4 m): a concrete median barrier between them
    const median = W.map((p, i) => { const a = off(p, side * (half + 2.5)); return free[i] && side < 0 && src.oneway && !!roads.coveredByOther(r, a[0], a[1], 1.5); });
    const rail = free.map((f, i) => f && !median[i] && !src.bridge);
    const o = side * (half + 0.25);
    m.prop.set('tint', ...STEEL);
    block(m.prop, W, o - 0.04, o + 0.04, 0.45, 0.8, rail);
    W.forEach((p, i) => { if (inRun(rail, i)) { const [x, z] = off(p, side * (half + 0.33)); m.prop.box(x, p.y, z, 0.1, 0.75, 0.1); } });
    m.concrete.set('tint', 0.7, 0.69, 0.66);
    block(m.concrete, W, -half - 0.75, -half - 0.15, -0.05, 0.3, median);
    block(m.concrete, W, -half - 0.58, -half - 0.32, 0.3, 0.85, median);
    if (median.some(Boolean)) continue;

    // Retaining wall at the foot of a deep cut
    if (!src.bridge) {
      const cut = W.map((p, i) => { const a = off(p, side * (half + 10)); return free[i] && ctx.heightAt(a[0], a[1]) - p.y > 3.5; });
      m.concrete.set('tint', 0.6, 0.6, 0.57);
      block(m.concrete, W, side > 0 ? half + 3.5 : -half - 4.1, side > 0 ? half + 4.1 : -half - 3.5, -0.4, 2.6, cut);
    }

    // Noise barrier where homes are close (on the parapet over a bridge)
    const noisy = W.map((p, i) => { const a = off(p, side * (half + 30)); return free[i] && ctx.nearHomes(a[0], a[1]); });
    if (!noisy.some(Boolean)) continue;
    const no = side * (src.bridge ? half + 0.4 : half + 1.6);
    const y0 = src.bridge ? 1.05 : 0;
    m.prop.set('tint', 0.32, 0.45, 0.56);
    block(m.prop, W, no - 0.08, no + 0.08, y0 - 0.2, y0 + 1.3, noisy);
    m.glass.set('tint', 0.45, 0.6, 0.7);
    wall(m.glass, W, no, y0 + 1.3, y0 + height, 1, noisy);
    wall(m.glass, W, no, y0 + 1.3, y0 + height, -1, noisy);
    m.prop.set('tint', 0.4, 0.42, 0.45);
    block(m.prop, W, no - 0.1, no + 0.1, y0 + height, y0 + height + 0.15, noisy);
    W.forEach((p, i) => { if (inRun(noisy, i)) { const [x, z] = off(p, no); m.prop.box(x, p.y + y0 - 0.2, z, 0.22, height + 0.35, 0.22, yawAcross(p)); } });
  }
}

export { buildStructures, EXPRESS };
