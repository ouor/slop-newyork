import { MeshData, STYLE, estimateBuilding, addFlatPolygon, addRingWalls, pointInPolygon, ringArea, ringBounds, mulberry32, hashId } from './world-geometry.js';

// js/drive/world-buildings.js
// Building masses of one tile from their OSM footprints (holes included), with heights and Korean styles from
// estimateBuilding (world-geometry.js), seeded by id so a building always comes out the same:
// - walls: one quad per footprint edge; windows, balconies, 필로티, 상가 signage bands, school bands, curtain walls and
//   the 아파트 brand emblems are all drawn by the facade shader (world-materials.js) from per-vertex style attributes
// - roofs: flat, Seoul's green waterproof paint or grey concrete
// - rooftop clutter: water tanks, AC units, 옥탑방, 아파트 lift cores, office plant rooms; church steeples with the red
//   neon cross (also on a few 상가, where upper-floor churches put theirs)
// - vertical projecting signs on 상가 walls, lit at night

const MAJOR = new Set(['motorway', 'trunk', 'primary', 'secondary']);

const PALETTE = {
  [STYLE.apartment]: [[0.88, 0.87, 0.83], [0.9, 0.87, 0.8], [0.84, 0.84, 0.84], [0.86, 0.82, 0.74], [0.92, 0.91, 0.88]],
  [STYLE.villa]: [[0.56, 0.31, 0.24], [0.5, 0.36, 0.27], [0.78, 0.7, 0.58], [0.66, 0.64, 0.6], [0.85, 0.84, 0.8], [0.62, 0.42, 0.32]],
  [STYLE.shop]: [[0.7, 0.69, 0.66], [0.78, 0.74, 0.66], [0.86, 0.86, 0.84], [0.42, 0.42, 0.44], [0.6, 0.55, 0.5], [0.74, 0.62, 0.52]],
  [STYLE.office]: [[0.3, 0.32, 0.35], [0.55, 0.57, 0.6], [0.22, 0.24, 0.26], [0.7, 0.71, 0.72]],
  [STYLE.school]: [[0.86, 0.79, 0.64], [0.82, 0.66, 0.56], [0.88, 0.86, 0.8]],
  [STYLE.plain]: [[0.68, 0.67, 0.64], [0.78, 0.74, 0.66], [0.6, 0.58, 0.55], [0.84, 0.82, 0.78]]
};
const ROOF_GREEN = [0.27, 0.5, 0.38];
const ROOF_GREY = [0.55, 0.55, 0.53];

function createBuildingMeshes() {
  return {
    facade: new MeshData({ uv: 2, tint: 3, bstyle: 4, bwall: 2 }),
    roof: new MeshData({ tint: 3 }),
    glow: new MeshData({ glow: 4 })
  };
}

/**
 * ctx: { grid (SegmentGrid of the tile's visible roads), roads (their records), residential ([{ pts, holes, box }]),
 * triangulate(outer, holes) → faces }. Yields every few buildings; returns { meshes, count }.
 */
function* buildBuildings(tile, ctx) {
  const meshes = createBuildingMeshes();
  const { facade, roof, glow } = meshes;
  let count = 0;
  for (const b of tile.buildings || []) {
    if (!b.pts || b.pts.length < 6) continue;
    const n = b.pts.length >> 1;
    let cx = 0, cz = 0;
    for (let i = 0; i < n; i++) { cx += b.pts[i * 2]; cz += b.pts[i * 2 + 1]; }
    cx /= n;
    cz /= n;
    const nearMajor = ctx.grid.nearest(cx, cz, 90, (k) => MAJOR.has(ctx.roads[k].hw));
    const residential = ctx.residential.some((a) => cx >= a.box.minX && cx <= a.box.maxX && cz >= a.box.minZ && cz <= a.box.maxZ && pointInPolygon(a.pts, a.holes, cx, cz));
    const est = estimateBuilding(b, { nearMajor, residential });
    const rng = mulberry32(hashId(b.id, 91));
    const pal = PALETTE[est.style];
    const tint = pal[Math.floor(rng() * pal.length)];
    // Phase 2: standing on the lowest ground under the footprint; the walls reach 1 m further down so the terrain
    // between the sampled corners never shows under them
    const ground = b.baseY ?? 0;
    const top = ground + est.height;
    const accent = rng();
    const sink = est.base > 0 ? 0 : 1;

    // Walls (outer ring & courtyards)
    facade.set('tint', ...tint);
    facade.set('bstyle', est.style, est.floorH, est.seed, est.height - est.base);
    const onWall = (len) => facade.set('bwall', len, accent);
    addRingWalls(facade, b.pts, false, ground + est.base - sink, top, onWall, -sink);
    for (const h of b.holes || []) if (h.length >= 6) addRingWalls(facade, h, true, ground + est.base - sink, top, onWall, -sink);

    // Roof
    roof.set('tint', ...(est.style !== STYLE.apartment && est.style !== STYLE.office && rng() < 0.55 ? ROOF_GREEN : ROOF_GREY));
    addFlatPolygon(roof, b.pts, (b.holes || []).filter((h) => h.length >= 6), top, ctx.triangulate);

    rooftop(b, est, top, tint, rng, roof, glow);
    if (est.style === STYLE.shop) projectingSigns(b, est, ground, rng, glow);
    count++;
    if (count % 8 === 0) yield;
  }
  return { meshes, count };
}

// A point inside the footprint near (centroid + offset along / across its main axis), or null
function spot(b, est, a, c) {
  const m = est.metrics;
  const x = m.cx + m.ux * a - m.uz * c, z = m.cz + m.uz * a + m.ux * c;
  return pointInPolygon(b.pts, b.holes, x, z) ? [x, z] : null;
}

function rooftop(b, est, top, tint, rng, roof, glow) {
  const m = est.metrics;
  const yaw = Math.atan2(-m.uz, m.ux);
  const L = m.long * 0.5, W = m.short * 0.5;
  const R = (lo, hi) => lo + (hi - lo) * rng();
  const church = est.style === STYLE.plain && (/church|chapel|cathedral/.test(b.type || '') || b.use === 'place_of_worship');
  if (m.area < 40 || b.type === 'roof') return;

  if (est.style === STYLE.apartment) {
    roof.set('tint', ...tint.map((v) => v * 0.92));
    for (const a of [-0.3, 0.3]) {
      const p = spot(b, est, a * m.long, 0);
      if (p) roof.box(p[0], top, p[1], 5, 3.4, Math.min(5, m.short * 0.6), yaw);
    }
  } else if (est.style === STYLE.office) {
    roof.set('tint', 0.42, 0.43, 0.45);
    const p = spot(b, est, 0, 0);
    if (p) roof.box(p[0], top, p[1], m.long * 0.45, 4, m.short * 0.45, yaw);
  } else if (!church) {
    // 빌라 & 상가: stainless or FRP water tank, AC condensers, sometimes a rooftop room (옥탑방)
    if (est.style === STYLE.villa && rng() < 0.4 && m.area > 90) {
      const p = spot(b, est, R(-0.25, 0.25) * L, R(-0.2, 0.2) * W);
      if (p) {
        roof.set('tint', 0.84, 0.83, 0.79);
        roof.box(p[0], top, p[1], Math.min(4, L), 2.4, Math.min(3.2, W), yaw);
        roof.set('tint', ...ROOF_GREEN);
        roof.box(p[0], top + 2.4, p[1], Math.min(4, L) + 0.3, 0.12, Math.min(3.2, W) + 0.3, yaw);
      }
    }
    if (rng() < 0.7) {
      const p = spot(b, est, R(-0.6, 0.6) * L, R(-0.5, 0.5) * W);
      if (p) {
        roof.set('tint', ...(rng() < 0.6 ? [0.78, 0.79, 0.8] : [0.28, 0.5, 0.62]));
        roof.cylinder(p[0], top, p[1], 0.7, 1.4, 8);
      }
    }
    roof.set('tint', 0.86, 0.86, 0.83);
    for (let k = Math.floor(R(0, 4)); k > 0; k--) {
      const p = spot(b, est, R(-0.7, 0.7) * L, R(-0.6, 0.6) * W);
      if (p) roof.box(p[0], top, p[1], 0.85, 0.65, 0.35, yaw + (rng() < 0.5 ? 0 : Math.PI / 2));
    }
  }

  // Red neon cross: churches on a steeple, and some upper-floor churches above 상가
  if (church || (est.style === STYLE.shop && rng() < 0.04)) {
    const p = spot(b, est, 0, 0) || [m.cx, m.cz];
    let y = top;
    if (church) {
      roof.set('tint', 0.82, 0.8, 0.76);
      roof.box(p[0], top, p[1], 2.4, 7, 2.4, yaw);
      y += 7;
    } else {
      roof.set('tint', 0.3, 0.3, 0.32);
      roof.box(p[0], top, p[1], 0.25, 3, 0.25, yaw);
      y += 3;
    }
    glow.set('glow', 1.0, 0.08, 0.06, 0);
    glow.box(p[0], y, p[1], 0.3, 4.2, 0.3, yaw);
    glow.box(p[0], y + 2.6, p[1], 2.4, 0.3, 0.3, yaw);
  }
}

// 1–2 vertical signs sticking out of the longer walls of a 상가, colour per sign
function projectingSigns(b, est, ground, rng, glow) {
  const n = b.pts.length >> 1;
  const sign = ringArea(b.pts) >= 0 ? 1 : -1;
  let made = 0;
  for (let i = 0; i < n && made < 2; i++) {
    const j = (i + 1) % n;
    const ax = b.pts[i * 2], az = b.pts[i * 2 + 1], bx = b.pts[j * 2], bz = b.pts[j * 2 + 1];
    const len = Math.hypot(bx - ax, bz - az);
    if (len < 6 || rng() < 0.45) continue;
    const dx = (bx - ax) / len, dz = (bz - az) / len;
    const nx = dz * sign, nz = -dx * sign;
    const t = 0.8 + rng() * Math.max(0, len - 1.6);
    const h = Math.min(est.height - est.base - 3.5, 2.5 + est.floors * 1.6);
    if (h < 2) continue;
    const x = ax + dx * t + nx * 0.45, z = az + dz * t + nz * 0.45;
    const hue = rng();
    const c = [0.5 + 0.5 * Math.cos(hue * 6.283), 0.5 + 0.5 * Math.cos(hue * 6.283 + 2.1), 0.5 + 0.5 * Math.cos(hue * 6.283 + 4.2)];
    glow.set('glow', ...c.map((v) => Math.min(1, v * v + 0.15)), 0);
    glow.box(x, ground + est.base + 3.2, z, 0.25, h, 0.75, Math.atan2(nx, nz));
    made++;
  }
}

// Residential landuse polygons of a tile with their boxes (for the 아파트 단지 slab rule)
function residentialAreas(tile) {
  return (tile.areas || []).filter((a) => a.key === 'landuse' && a.kind === 'residential' && a.pts.length >= 6)
    .map((a) => ({ pts: a.pts, holes: a.holes || [], box: ringBounds(a.pts) }));
}

export { buildBuildings, residentialAreas };
