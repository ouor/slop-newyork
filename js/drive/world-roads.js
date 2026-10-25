import { MeshData, SegmentGrid, resamplePolyline, walkPolyline } from './world-geometry.js';

// js/drive/world-roads.js
// Road network of one tile, as plain mesh data (world-builder.js turns it into meshes):
// - asphalt ribbons with miter joins and round end caps, all at one height: crossing roads share the world-space
//   asphalt shader, so where they overlap the z-fight is between identical pixels and never shows
// - Korean markings: double yellow centre lines on two-way roads, dashed white lane lines, a yellow median line on
//   divided roads, blue bus lanes, zebra crosswalks and stop lines at intersections; paint is dropped wherever it would
//   lie on another road's carriageway, so intersections stay clean
// - raised sidewalks + granite curbs along streets, cut away where another carriageway crosses them; concrete medians
//   with the white & yellow anti-jaywalking fence on divided roads, steel guardrails along the expressways
// - bridges (반포대교…) as decks at road level with parapets and piers down into the river; roads hidden under a
//   higher deck (잠수교 under 반포대교) and tunnels off the route are left out
// It also returns where the street furniture goes: sidewalk lines for trees & lamps, signal approaches, small streets
// for utility poles.

const ROAD_Y = 0.01;
const PAINT_Y = 0.006; // above the asphalt
const CURB_H = 0.15;
const WHITE = [0.9, 0.89, 0.84];
const YELLOW = [0.91, 0.68, 0.13];
const BLUE = [0.16, 0.42, 0.85];

const STREET = new Set(['motorway', 'trunk', 'primary', 'secondary', 'tertiary', 'unclassified', 'residential', 'living_street',
  'motorway_link', 'trunk_link', 'primary_link', 'secondary_link', 'tertiary_link']);
const MAJOR = new Set(['motorway', 'trunk', 'primary', 'secondary', 'tertiary']);
const MARKED = new Set(['motorway', 'trunk', 'primary', 'secondary', 'tertiary', 'unclassified']);
// Sidewalk width by class (residential streets only when they are wide)
const SIDEWALK = { primary: 4.5, secondary: 3.5, tertiary: 2.8, unclassified: 2.0, primary_link: 2.5, secondary_link: 2.5, tertiary_link: 2.0 };

// Mesh data containers of a tile's roads, by material
function createRoadMeshes() {
  return {
    road: new MeshData(),
    sidewalk: new MeshData(),
    curb: new MeshData(),
    concrete: new MeshData({ tint: 3 }),
    prop: new MeshData({ tint: 3 }),
    paint: new MeshData({ color: 3, side: 2, paint: 3 })
  };
}

// Sample i is part of a run of at least two (posts stand only where their rails are)
const inRun = (ok, i) => ok[i] && (ok[i - 1] || ok[i + 1]);

// Offset point of a resampled polyline sample (miter-scaled)
const off = (p, o) => [p.x + p.rx * o * p.miter, p.z + p.rz * o * p.miter];

// Flat ribbon between offsets o0 < o1 at height y over the runs of samples where ok(i) holds
function ribbon(mesh, S, o0, o1, y, ok = null) {
  for (let i = 0; i + 1 < S.length; i++) {
    if (ok && !(ok[i] && ok[i + 1])) continue;
    const a0 = off(S[i], o0), a1 = off(S[i], o1), b0 = off(S[i + 1], o0), b1 = off(S[i + 1], o1);
    mesh.quad([[a0[0], y, a0[1]], [a1[0], y, a1[1]], [b1[0], y, b1[1]], [b0[0], y, b0[1]]], 0, 1, 0);
  }
}

// Vertical wall along offset o from y0 to y1, facing to the right of the road (face = 1) or to its left (-1)
function wall(mesh, S, o, y0, y1, face, ok = null) {
  for (let i = 0; i + 1 < S.length; i++) {
    if (ok && !(ok[i] && ok[i + 1])) continue;
    const a = off(S[i], o), b = off(S[i + 1], o);
    const nx = (S[i].rx + S[i + 1].rx) * 0.5 * face, nz = (S[i].rz + S[i + 1].rz) * 0.5 * face;
    mesh.quad([[a[0], y0, a[1]], [b[0], y0, b[1]], [b[0], y1, b[1]], [a[0], y1, a[1]]], nx, 0, nz);
  }
}

// Solid strip (parapet, median kerb, guardrail beam) between offsets o0 < o1 from y0 to y1: top & both sides
function block(mesh, S, o0, o1, y0, y1, ok = null) {
  ribbon(mesh, S, o0, o1, y1, ok);
  wall(mesh, S, o0, y0, y1, -1, ok);
  wall(mesh, S, o1, y0, y1, 1, ok);
}

// Round-ish cap (octagon) of radius r at (x, z), to fill the wedges where road pieces meet at an angle
function cap(mesh, x, z, r, y) {
  const c = mesh.vert(x, y, z, 0, 1, 0);
  const ring = [];
  for (let k = 0; k < 8; k++) ring.push(mesh.vert(x + Math.cos((k / 8) * Math.PI * 2) * r, y, z + Math.sin((k / 8) * Math.PI * 2) * r, 0, 1, 0));
  for (let k = 0; k < 8; k++) mesh.tri(c, ring[k], ring[(k + 1) % 8], 0, 1, 0);
}

/**
 * Builds a tile's roads. `routeGrid` is a SegmentGrid of the route centreline (route roads are never hidden).
 * Yields between roads so world-builder.js can slice the work. Returns (via the generator's value):
 * { meshes, grid, roads, walkSites, lampSites, signalSites, smallStreets, bridges }
 */
function* buildRoads(tile, routeGrid) {
  const meshes = createRoadMeshes();
  const [bx0, bz0, bx1, bz1] = tile.bounds || [tile.tx * 500, tile.tz * 500, tile.tx * 500 + 500, tile.tz * 500 + 500];
  const onBorder = (x, z) => Math.min(Math.abs(x - bx0), Math.abs(x - bx1), Math.abs(z - bz0), Math.abs(z - bz1)) < 0.3;

  // 1. Classify, find the route's own roads, drop the ones that should not be drawn
  const roads = [];
  for (const src of tile.roads || []) {
    if (!src.pts || src.pts.length < 4) continue;
    if (src.highway === 'pedestrian' && (src.bridge || src.layer > 0)) continue; // 서울로 7017 skywalk etc.
    const S = resamplePolyline(src.pts, 4);
    if (S.length < 2) continue;
    let onRoute = 0;
    for (const p of S) if (routeGrid.covering(p.x, p.z, 0)) onRoute++;
    const route = onRoute >= S.length * 0.6;
    if (src.tunnel && !route) continue;
    const half = Math.max(1.5, (src.width || 3.3 * (src.lanes || 1)) * 0.5);
    roads.push({ src, S, half, route, hw: src.highway, minor: !STREET.has(src.highway) || src.highway === 'busway', layer: src.layer || 0 });
  }
  // Roads lying under a higher deck for most of their length (잠수교 under 반포대교)
  const decks = new SegmentGrid(20);
  roads.forEach((r, k) => { if (r.src.bridge) decks.add(r.src.pts, r.half, k); });
  for (const r of roads) {
    if (r.route) continue;
    let under = 0;
    for (const p of r.S) if (decks.covering(p.x, p.z, 0, (k) => roads[k].layer <= r.layer)) under++;
    r.hidden = under >= r.S.length * 0.5;
  }
  const visible = roads.filter((r) => !r.hidden);
  const grid = new SegmentGrid(20);
  visible.forEach((r, k) => { r.index = k; grid.add(r.src.pts, r.half, k); });
  yield;

  // 2. Intersections: vertices shared by two or more streets
  const nodes = new Map();
  visible.forEach((r) => {
    const pts = r.src.pts;
    for (let i = 0; i < pts.length; i += 2) {
      const key = `${Math.round(pts[i] * 2)},${Math.round(pts[i + 1] * 2)}`;
      if (!nodes.has(key)) nodes.set(key, []);
      nodes.get(key).push({ r, i: i >> 1 });
    }
  });

  const walkSites = [];
  const lampSites = [];
  const signalSites = [];
  const smallStreets = [];
  const bridges = [];
  const coveredByOther = (r, x, z, margin = 0) => grid.covering(x, z, margin, (k) => k === r.index || visible[k].minor);

  for (const r of visible) {
    const { src, S, half } = r;
    const m = meshes;

    // Asphalt
    ribbon(m.road, S, -half, half, ROAD_Y);
    const n = src.pts.length >> 1;
    for (const i of [0, n - 1]) {
      const x = src.pts[i * 2], z = src.pts[i * 2 + 1];
      if (!onBorder(x, z)) cap(m.road, x, z, half, ROAD_Y);
    }

    // Bridges: deck edges, soffit, parapets and piers
    if (src.bridge) {
      m.concrete.set('tint', 0.62, 0.61, 0.58);
      wall(m.concrete, S, -half, -1.6, ROAD_Y, -1);
      wall(m.concrete, S, half, -1.6, ROAD_Y, 1);
      ribbon(m.concrete, S, -half, half, -1.6);
      // Low concrete kerb with a steel railing on posts, left out where the next carriageway of the deck runs alongside
      const R = resamplePolyline(src.pts, 2.5);
      for (const side of [-1, 1]) {
        const ok = R.map((p) => { const a = off(p, side * (half + 1.5)); return !coveredByOther(r, a[0], a[1]); });
        const o = side * (half + 0.2);
        m.concrete.set('tint', 0.6, 0.6, 0.58);
        block(m.concrete, R, o - 0.2, o + 0.2, -0.2, 0.4, ok);
        m.prop.set('tint', 0.42, 0.47, 0.52);
        block(m.prop, R, o - 0.05, o + 0.05, 1.0, 1.1, ok);
        block(m.prop, R, o - 0.02, o + 0.02, 0.7, 0.74, ok);
        R.forEach((p, i) => { if (inRun(ok, i)) { const [x, z] = off(p, o); m.prop.box(x, 0.4, z, 0.07, 0.62, 0.07); } });
      }
      const P = resamplePolyline(src.pts, 45);
      for (let i = 1; i < P.length - 1; i++) {
        m.concrete.set('tint', 0.55, 0.54, 0.51);
        m.concrete.box(P[i].x, -16, P[i].z, half * 1.3, 14.4, 2.6, Math.atan2(-P[i].rz, P[i].rx));
      }
      bridges.push(r);
      for (const p of resamplePolyline(src.pts, 30)) lampSites.push({ x: p.x + p.rx * (half + 0.2), z: p.z + p.rz * (half + 0.2), ax: -p.rx, az: -p.rz, y: 0.95, bridge: true });
    }

    // Markings
    if (MARKED.has(r.hw) || r.hw === 'busway' || (r.hw === 'residential' && half >= 5)) paintRoad(m.paint, r, S, coveredByOther);

    // Sidewalks & curbs, medians & fences, guardrails
    const sw = SIDEWALK[r.hw] ?? (r.hw === 'residential' && half >= 5 ? 2.2 : 0);
    const divided = src.oneway && (r.hw === 'primary' || r.hw === 'secondary' || r.hw === 'trunk') && src.lanes >= 2;
    if (!src.bridge && !src.tunnel && sw > 0) {
      const W = resamplePolyline(src.pts, 3);
      for (const side of divided ? [1] : [1, -1]) {
        const ok = W.map((p) => {
          const a = off(p, side * (half + 0.4)), b = off(p, side * (half + sw - 0.3));
          return !coveredByOther(r, a[0], a[1]) && !coveredByOther(r, b[0], b[1]);
        });
        const o0 = side > 0 ? half : -half - sw, o1 = side > 0 ? half + sw : -half;
        ribbon(m.sidewalk, W, o0, o1, CURB_H, ok);
        wall(m.curb, W, side * half, 0, CURB_H, -side, ok);
        ribbon(m.curb, W, side > 0 ? half : -half - 0.18, side > 0 ? half + 0.18 : -half, CURB_H + 0.002, ok);
        W.forEach((p, i) => {
          if (!ok[i]) return;
          walkSites.push({ x: p.x + p.rx * side * (half + sw - 1.0), z: p.z + p.rz * side * (half + sw - 1.0), s: p.s, road: r, side, sw, dx: p.dx, dz: p.dz, rx: p.rx * side, rz: p.rz * side });
          lampSites.push({ x: p.x + p.rx * side * (half + 0.5), z: p.z + p.rz * side * (half + 0.5), ax: -p.rx * side, az: -p.rz * side, s: p.s, road: r, side });
        });
      }
    }
    if (divided && !src.bridge) {
      // Median kerb with the white / yellow fence on the left of a divided road
      const W = resamplePolyline(src.pts, 2);
      const ok = W.map((p) => { const a = off(p, -half - 0.3); return !coveredByOther(r, a[0], a[1], -0.2); });
      m.concrete.set('tint', 0.66, 0.65, 0.6);
      block(m.concrete, W, -half - 0.5, -half, 0, 0.22, ok);
      m.prop.set('tint', 0.92, 0.92, 0.9);
      W.forEach((p, i) => {
        if (!inRun(ok, i)) return;
        const [x, z] = off(p, -half - 0.25);
        m.prop.set('tint', ...(i % 2 ? [0.95, 0.78, 0.12] : [0.92, 0.92, 0.9]));
        m.prop.box(x, 0.22, z, 0.08, 0.85, 0.08);
      });
      m.prop.set('tint', 0.92, 0.92, 0.9);
      block(m.prop, W, -half - 0.29, -half - 0.21, 0.95, 1.05, ok);
      block(m.prop, W, -half - 0.29, -half - 0.21, 0.5, 0.56, ok);
    }
    if ((r.hw === 'trunk' || r.hw === 'motorway' || r.hw === 'trunk_link') && !src.tunnel) {
      // Steel W-beam guardrails on posts along both edges of the expressways
      const W = resamplePolyline(src.pts, 4);
      for (const side of [1, -1]) {
        const ok = W.map((p) => { const a = off(p, side * (half + 0.3)); return !coveredByOther(r, a[0], a[1]); });
        m.prop.set('tint', 0.72, 0.74, 0.76);
        block(m.prop, W, side * (half + 0.25) - 0.04, side * (half + 0.25) + 0.04, 0.45, 0.8, ok);
        W.forEach((p, i) => { if (inRun(ok, i)) { const [x, z] = off(p, side * (half + 0.33)); m.prop.box(x, 0, z, 0.1, 0.75, 0.1); } });
      }
    }

    // Small streets get utility poles & wires (very Seoul)
    if (!src.bridge && !src.tunnel && (r.hw === 'residential' || r.hw === 'service' || r.hw === 'living_street' || r.hw === 'unclassified' || (r.hw === 'tertiary' && half < 5))) {
      smallStreets.push(r);
    }
    yield;
  }

  // 3. Crosswalks, stop lines & signal approaches at intersections of streets
  for (const list of nodes.values()) {
    const ids = new Set(list.filter((e) => !e.r.minor).map((e) => e.r.src.id));
    if (ids.size < 2) continue;
    const majors = list.filter((e) => MAJOR.has(e.r.hw)).length;
    for (const e of list) {
      const { r, i } = e;
      if (!(MARKED.has(r.hw) || (r.hw === 'residential' && r.half >= 3)) || r.src.bridge) continue;
      const others = list.filter((o) => o.r !== r && !o.r.minor);
      if (!others.length) continue;
      const R = Math.max(...others.map((o) => o.r.half)) + 1.5;
      const n = r.src.pts.length >> 1;
      for (const dir of [1, -1]) {
        if ((dir > 0 && i >= n - 1) || (dir < 0 && i <= 0)) continue;
        const c = walkPolyline(r.src.pts, i, dir, R + 2);
        if (!c || coveredByOther(r, c.x, c.z, -1)) continue;
        // (rx, rz): right of the arm's direction (away from the node)
        const rx = -c.dz, rz = c.dx;
        const h = r.half - 0.3;
        stripAcross(meshes.paint, c.x, c.z, rx, rz, -h, h, 3.4, WHITE, 1.2, 0.5);
        // Traffic coming in along this arm drives towards the node (one-way roads only along their direction)
        const inbound = !r.src.oneway || dir < 0;
        if (!inbound) continue;
        const sl = walkPolyline(r.src.pts, i, dir, R + 4.6);
        if (!sl) continue;
        // Its right-hand side is the arm's left: offsets [-half, 0] (two-way) or the whole road (one-way)
        stripAcross(meshes.paint, sl.x, sl.z, rx, rz, -h, r.src.oneway ? h : -0.3, 0.45, WHITE);
        if (MAJOR.has(r.hw) && majors >= 2 && r.half >= 3) {
          signalSites.push({ x: sl.x - rx * (r.half + 0.8), z: sl.z - rz * (r.half + 0.8), tx: -sl.dx, tz: -sl.dz, span: r.src.oneway ? r.half * 2 : r.half });
        }
      }
    }
  }
  // Mapped traffic signals away from intersections (pedestrian crossings): signals for both directions
  for (const pt of tile.points || []) {
    if (pt.kind !== 'traffic_signals') continue;
    if (signalSites.some((s) => Math.hypot(s.x - pt.x, s.z - pt.z) < 35)) continue;
    const seg = grid.covering(pt.x, pt.z, 0.5, (k) => !MAJOR.has(visible[k].hw));
    if (!seg) continue;
    const r = visible[seg.ref];
    const len = Math.hypot(seg.bx - seg.ax, seg.bz - seg.az) || 1;
    const dx = (seg.bx - seg.ax) / len, dz = (seg.bz - seg.az) / len;
    for (const s of r.src.oneway ? [1] : [1, -1]) {
      const tx = dx * s, tz = dz * s;
      signalSites.push({ x: pt.x - tz * (r.half + 0.8), z: pt.z + tx * (r.half + 0.8), tx, tz, span: r.src.oneway ? r.half * 2 : r.half });
    }
    stripAcross(meshes.paint, pt.x + dx * 3, pt.z + dz * 3, -dz, dx, -r.half + 0.3, r.half - 0.3, 3.4, WHITE, 1.2, 0.5);
  }

  return { meshes, grid, roads: visible, walkSites, lampSites, signalSites, smallStreets, bridges };
}

// Paint strip from offset o0 to o1 across a road at (x, z), w m deep along the road (right = (rx, rz)); dash pattern
// (period, duty) runs across the road (zebra bars)
function stripAcross(paint, x, z, rx, rz, o0, o1, w, col, period = 1, duty = 1) {
  const ax = x + rx * o0, az = z + rz * o0, bx = x + rx * o1, bz = z + rz * o1;
  paintStrip(paint, ax, az, bx, bz, w, col, period, duty, 0);
}

// Flat paint quad from a to b, w wide, with its dash pattern running from a (js/road-paint.js strip())
function paintStrip(paint, ax, az, bx, bz, w, col, period, duty, phase) {
  const len = Math.hypot(bx - ax, bz - az);
  if (len < 0.05) return;
  const sx = ((az - bz) / len) * w * 0.5;
  const sz = ((bx - ax) / len) * w * 0.5;
  paint.set('color', ...col);
  const i = [];
  for (const [x, z, s, u] of [[ax, az, -1, phase], [ax, az, 1, phase], [bx, bz, 1, phase + len], [bx, bz, -1, phase + len]]) {
    paint.set('side', sx * s, sz * s);
    paint.set('paint', u, period, duty);
    i.push(paint.vert(x + sx * s, ROAD_Y + PAINT_Y, z + sz * s, 0, 1, 0));
  }
  paint.tri(i[0], i[1], i[2], 0, 1, 0);
  paint.tri(i[0], i[2], i[3], 0, 1, 0);
}

// Lines along one road, dropped where they would lie on another carriageway
function paintRoad(paint, r, S, coveredByOther) {
  const { src, half } = r;
  const lanes = Math.max(1, src.lanes || 1);
  const laneW = (half * 2) / lanes;
  const along = (o, w, col, period = 1, duty = 1) => {
    for (let i = 0; i + 1 < S.length; i++) {
      const a = off(S[i], o), b = off(S[i + 1], o);
      if (coveredByOther(r, a[0], a[1], 0.4) || coveredByOther(r, b[0], b[1], 0.4)) continue;
      paintStrip(paint, a[0], a[1], b[0], b[1], w, col, period, duty, S[i].s);
    }
  };
  if (r.hw === 'busway') {
    along(-half + 0.2, 0.18, BLUE);
    along(half - 0.2, 0.18, BLUE);
    return;
  }
  if (src.oneway) {
    for (let k = 1; k < lanes; k++) along(-half + k * laneW, 0.15, WHITE, 12, 0.4);
    if (lanes >= 2 && MAJOR.has(r.hw)) along(-half + 0.3, 0.15, YELLOW);
  } else if (lanes >= 2) {
    along(-0.12, 0.13, YELLOW);
    along(0.12, 0.13, YELLOW);
    const perSide = Math.floor(lanes / 2);
    for (let k = 1; k < perSide; k++) {
      along(k * laneW, 0.15, WHITE, 12, 0.4);
      along(-k * laneW, 0.15, WHITE, 12, 0.4);
    }
  }
}

export { buildRoads, ROAD_Y, CURB_H };
