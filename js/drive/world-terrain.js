import { MeshData, addFlatPolygon, ringArea, ringBounds } from './world-geometry.js';

// js/drive/world-terrain.js
// Ground of one tile from its road-conformed height grid (tiles/<key>.terrain.bin, docs/drive.md phase 2), as plain
// arrays (world-builder.js turns them into meshes; pure, unit-tested in tests/drive-world-terrain.test.cjs):
// - a tileN × tileN heightfield with a skirt hanging 20 m down from its edges, so neighbours at a different level of
//   detail (or with different water cuts) never show a crack; two index lists, full and every other vertex
// - per-vertex surface hints for the terrain shader (world-materials.js): `tint` (sRGB, by landuse / leisure / natural
//   area or the default ground) and `land` = (urban, farmland, forest, cut slope) weights. Unmapped ground is paved where
//   buildings stand close together and wooded where it is steep; the 1:2 cut slopes the pipeline carved beside the main
//   roads become shotcrete, the fill slopes grass
// - water: every water area at its own level (a low percentile of the ground under it), the ground inside sunk below
//   it so the banks slope down to the shore; sea (ground at ≤ 0.15 m, Busan) under a plane at y = 0
// Version 1 tiles (no terrain) get a flat grid at y = 0.

const SKIRT = 20; // m the skirt hangs below the edge
const N_FLAT = 65;
const BASE_TINT = [0.5, 0.49, 0.46]; // paved, built-up
const RURAL_TINT = [0.43, 0.45, 0.3]; // unmapped open ground: dry grass & scrub
const FOREST_TINT = [0.2, 0.29, 0.14];
const FILL_TINT = [0.38, 0.47, 0.25]; // seeded grass on embankments
const SEA_Y = 0;

// kind → [tint, land (urban, farmland, forest, cut), priority (higher paints over lower)]
const U = [1, 0, 0, 0], F = [0, 1, 0, 0], W = [0, 0, 1, 0], O = [0, 0, 0, 0];
const AREA_STYLE = {
  residential: [[0.56, 0.55, 0.52], U, 1], commercial: [[0.54, 0.53, 0.51], U, 1], retail: [[0.54, 0.53, 0.51], U, 1],
  religious: [[0.55, 0.54, 0.5], U, 1], industrial: [[0.5, 0.5, 0.49], U, 1], garages: [[0.5, 0.5, 0.49], U, 1],
  depot: [[0.5, 0.5, 0.49], U, 1], civic_admin: [[0.55, 0.54, 0.5], U, 1], education: [[0.55, 0.54, 0.5], U, 1],
  military: [[0.38, 0.45, 0.3], O, 1], railway: [[0.43, 0.4, 0.37], U, 2], landfill: [[0.5, 0.45, 0.36], O, 2],
  construction: [[0.55, 0.47, 0.38], O, 2], brownfield: [[0.55, 0.47, 0.38], O, 2], greenfield: [[0.45, 0.47, 0.3], O, 2],
  farmland: [[0.47, 0.5, 0.29], F, 2], meadow: [[0.42, 0.5, 0.27], O, 2], orchard: [[0.36, 0.45, 0.24], [0, 0.4, 0.3, 0], 2],
  greenhouse_horticulture: [[0.62, 0.62, 0.58], O, 2], plant_nursery: [[0.38, 0.47, 0.26], O, 2], farmyard: [[0.5, 0.47, 0.4], O, 2],
  allotments: [[0.4, 0.42, 0.26], F, 3], cemetery: [[0.4, 0.48, 0.27], O, 3],
  park: [[0.3, 0.45, 0.22], O, 3], garden: [[0.3, 0.47, 0.22], O, 3], grass: [[0.33, 0.49, 0.23], O, 3], flowerbed: [[0.36, 0.45, 0.24], O, 3],
  greenery: [[0.33, 0.49, 0.23], O, 3], village_green: [[0.33, 0.49, 0.23], O, 3], grassland: [[0.38, 0.47, 0.25], O, 3], common: [[0.35, 0.48, 0.24], O, 3],
  recreation_ground: [[0.35, 0.48, 0.24], O, 3], golf_course: [[0.32, 0.52, 0.24], O, 3], heath: [[0.4, 0.44, 0.27], O, 3],
  wetland: [[0.3, 0.38, 0.24], O, 3], sand: [[0.7, 0.64, 0.5], O, 3],
  wood: [FOREST_TINT, W, 4], forest: [FOREST_TINT, W, 4], scrub: [[0.27, 0.36, 0.19], [0, 0, 0.6, 0], 4],
  pitch: [[0.24, 0.5, 0.3], O, 5], track: [[0.62, 0.3, 0.24], O, 5], playground: [[0.6, 0.5, 0.38], O, 5], stadium: [[0.24, 0.5, 0.3], O, 5],
  sports_centre: [[0.45, 0.47, 0.42], U, 5], swimming_pool: [[0.3, 0.55, 0.7], O, 5], fitness_station: [[0.6, 0.5, 0.38], O, 5]
};

const isWater = (a) => a.kind === 'water' || a.key === 'water' || a.kind === 'riverbank' || a.kind === 'reservoir' || a.kind === 'basin';
// Roads whose cut / fill slopes are dressed (the pipeline carves them for every class; minor ones stay natural)
const SLOPED = new Set(['motorway', 'trunk', 'primary', 'secondary', 'motorway_link', 'trunk_link', 'primary_link']);

const smooth = (a, b, x) => {
  const t = Math.min(1, Math.max(0, (x - a) / (b - a)));
  return t * t * (3 - 2 * t);
};

// Grid vertices (i, j) inside a polygon (outer + holes, even-odd), by scanline over the rows. Rows and columns on the
// tile edge are nudged inwards, where clipped polygons have their cut edges.
function rasterize(rings, minX, minZ, step, n, cb) {
  const xs = [];
  const eps = 0.01;
  for (let j = 0; j < n; j++) {
    const z = Math.min(minZ + (n - 1) * step - eps, Math.max(minZ + eps, minZ + j * step));
    xs.length = 0;
    for (const ring of rings) {
      const m = ring.length >> 1;
      for (let a = 0, b = m - 1; a < m; b = a++) {
        const za = ring[a * 2 + 1], zb = ring[b * 2 + 1];
        if ((za > z) === (zb > z)) continue;
        const xa = ring[a * 2], xb = ring[b * 2];
        xs.push(xa + ((z - za) * (xb - xa)) / (zb - za));
      }
    }
    if (xs.length < 2) continue;
    xs.sort((p, q) => p - q);
    for (let k = 0; k + 1 < xs.length; k += 2) {
      const i0 = Math.max(0, Math.ceil((xs[k] - minX) / step - eps * 2));
      const i1 = Math.min(n - 1, Math.floor((xs[k + 1] - minX) / step + eps * 2));
      for (let i = i0; i <= i1; i++) cb(i, j);
    }
  }
}

/**
 * ctx: { roads (world-roads.js visible roads: { src, S, half, hw }), triangulate(outer, holes) }. A generator (yields
 * a few times). Returns { n, position, normal, tint, land, index: [full, coarse], heights (Int16 dm like tile.terrain:
 * the final ground incl. the water cuts, for createTileSampler), water (MeshData), sea (bool) }.
 */
function* buildTerrain(tile, ctx) {
  const [x0, z0, x1] = tile.bounds || [tile.tx * 500, tile.tz * 500, tile.tx * 500 + 500];
  const src = tile.terrain;
  const n = src ? Math.round(Math.sqrt(src.length)) : N_FLAT;
  const step = (x1 - x0) / (n - 1);
  const H = new Float32Array(n * n);
  if (src) for (let k = 0; k < n * n; k++) H[k] = src[k] * 0.1;
  const at = (i, j) => H[Math.min(n - 1, Math.max(0, j)) * n + Math.min(n - 1, Math.max(0, i))];
  const sampleH = (x, z) => {
    const fx = Math.min(n - 1, Math.max(0, (x - x0) / step)), fz = Math.min(n - 1, Math.max(0, (z - z0) / step));
    const i = Math.min(n - 2, Math.floor(fx)), j = Math.min(n - 2, Math.floor(fz));
    const tx = fx - i, tz = fz - j;
    return (at(i, j) * (1 - tx) + at(i + 1, j) * tx) * (1 - tz) + (at(i, j + 1) * (1 - tx) + at(i + 1, j + 1) * tx) * tz;
  };

  // 1. Water areas: one level each from the ground under them, overlapping ones sharing the lowest
  const water = new MeshData();
  const waters = [];
  for (const a of tile.areas || []) {
    if (!isWater(a) || a.pts.length < 6) continue;
    const rings = [a.pts, ...(a.holes || []).filter((h) => h.length >= 6)];
    const cells = [];
    rasterize(rings, x0, z0, step, n, (i, j) => cells.push(j * n + i));
    let level;
    if (cells.length >= 3) {
      const hs = cells.map((k) => H[k]).sort((p, q) => p - q);
      level = hs[Math.floor(hs.length * 0.25)];
    } else {
      level = Infinity;
      for (let k = 0; k < a.pts.length; k += 2) level = Math.min(level, sampleH(a.pts[k], a.pts[k + 1]));
    }
    waters.push({ a, rings, cells, level, box: ringBounds(a.pts) });
  }
  for (const w of waters) {
    for (const v of waters) {
      if (v === w || Math.abs(v.level - w.level) > 2) continue;
      if (v.box.minX > w.box.maxX || v.box.maxX < w.box.minX || v.box.minZ > w.box.maxZ || v.box.maxZ < w.box.minZ) continue;
      w.level = v.level = Math.min(v.level, w.level);
    }
  }
  const inWater = new Uint8Array(n * n);
  for (const w of waters) for (const k of w.cells) inWater[k] = 1;
  for (const w of waters) {
    w.level += 0.15;
    for (const k of w.cells) {
      const i = k % n, j = (k - i) / n;
      // Deeper away from the shore: 1.2 m at the edge, 3 m where all four neighbours are wet too
      const interior = inWater[i > 0 ? k - 1 : k] && inWater[i < n - 1 ? k + 1 : k] && inWater[j > 0 ? k - n : k] && inWater[j < n - 1 ? k + n : k];
      H[k] = Math.min(H[k], w.level - (interior ? 3 : 1.2));
    }
    addFlatPolygon(water, w.a.pts, w.rings.slice(1), w.level, ctx.triangulate);
  }
  // Sea: the far grid and the tiles keep it at 0
  let sea = false;
  for (let k = 0; k < n * n; k++) {
    if (H[k] <= 0.15 && src) {
      H[k] = SEA_Y - 2;
      sea = true;
    }
  }
  yield;

  // 2. Surface hints: urban density from the building footprints (50 m cells), slope, areas, road slopes
  const C = 10, cs = (x1 - x0) / C;
  const cover = new Float32Array(C * C);
  for (const b of tile.buildings || []) {
    if (!b.pts || b.pts.length < 6) continue;
    const box = ringBounds(b.pts);
    const ci = Math.floor(((box.minX + box.maxX) / 2 - x0) / cs), cj = Math.floor(((box.minZ + box.maxZ) / 2 - z0) / cs);
    if (ci >= 0 && ci < C && cj >= 0 && cj < C) cover[cj * C + ci] += Math.abs(ringArea(b.pts)) / (cs * cs);
  }
  const coverAt = (x, z) => {
    const fx = Math.min(C - 1, Math.max(0, (x - x0) / cs - 0.5)), fz = Math.min(C - 1, Math.max(0, (z - z0) / cs - 0.5));
    const i = Math.min(C - 2, Math.floor(fx)), j = Math.min(C - 2, Math.floor(fz));
    const tx = fx - i, tz = fz - j;
    const c = (a, b) => cover[b * C + a];
    return (c(i, j) * (1 - tx) + c(i + 1, j) * tx) * (1 - tz) + (c(i, j + 1) * (1 - tx) + c(i + 1, j + 1) * tx) * tz;
  };

  const V = n * n + 4 * (n - 1);
  const position = new Float32Array(V * 3);
  const normal = new Float32Array(V * 3);
  const tint = new Float32Array(V * 3);
  const land = new Float32Array(V * 4);
  for (let j = 0; j < n; j++) {
    for (let i = 0; i < n; i++) {
      const k = j * n + i;
      const gx = (at(i + 1, j) - at(i - 1, j)) / ((Math.min(n - 1, i + 1) - Math.max(0, i - 1)) * step);
      const gz = (at(i, j + 1) - at(i, j - 1)) / ((Math.min(n - 1, j + 1) - Math.max(0, j - 1)) * step);
      const l = Math.hypot(gx, 1, gz);
      const x = x0 + i * step, z = z0 + j * step;
      position.set([x, H[k], z], k * 3);
      normal.set([-gx / l, 1 / l, -gz / l], k * 3);
      const urban = smooth(0.04, 0.16, coverAt(x, z));
      // (world-rural.js plants forest on unmapped countryside slopes steeper than ~0.08)
      const forest = smooth(0.06, 0.1, Math.hypot(gx, gz)) * (1 - urban);
      for (let c = 0; c < 3; c++) {
        const rural = RURAL_TINT[c] + (FOREST_TINT[c] - RURAL_TINT[c]) * forest;
        tint[k * 3 + c] = rural + (BASE_TINT[c] - rural) * urban;
      }
      land.set([urban, 0, forest, 0], k * 4);
    }
  }
  yield;

  const areas = (tile.areas || []).filter((a) => !isWater(a) && a.pts.length >= 6 && AREA_STYLE[a.kind])
    .sort((p, q) => AREA_STYLE[p.kind][2] - AREA_STYLE[q.kind][2]);
  for (const a of areas) {
    const [t, w] = AREA_STYLE[a.kind];
    rasterize([a.pts, ...(a.holes || []).filter((h) => h.length >= 6)], x0, z0, step, n, (i, j) => {
      const k = j * n + i;
      tint.set(t, k * 3);
      land.set(w, k * 4);
    });
  }
  yield;

  // Cut & fill slopes beside the main roads: march out from the shoulder while the ground follows the pipeline's 1:2
  // slope (above the road: cut, below: fill)
  for (const r of ctx.roads || []) {
    if (!SLOPED.has(r.hw) || r.src.tunnel || r.src.bridge || !r.src.ys) continue;
    for (let s = 0; s < r.S.length; s += 2) {
      const p = r.S[s];
      for (const side of [1, -1]) {
        for (let o = r.half + 4; o < r.half + 84; o += step * 0.7) {
          const x = p.x + p.rx * side * o, z = p.z + p.rz * side * o;
          const i = Math.round((x - x0) / step), j = Math.round((z - z0) / step);
          if (i < 0 || j < 0 || i >= n || j >= n) break;
          const k = j * n + i;
          const rise = (o - r.half - 4) * 0.5;
          const h = H[k] - p.y;
          if (h > 1.0 && Math.abs(h + 0.3 - rise) < 1.5) {
            land[k * 4 + 3] = 1;
            land[k * 4 + 2] = 0;
          } else if (h < -1.3 && Math.abs(-h - 0.3 - rise) < 1.5) {
            tint.set(FILL_TINT, k * 3);
            land.set(O, k * 4);
          } else if (o > r.half + 6) break;
        }
      }
    }
  }
  yield;

  // 3. Skirt: a copy of every edge vertex 20 m lower, same normal & hints, in order round the edge
  const edge = [];
  for (let i = 0; i < n - 1; i++) edge.push(i); // north (z0), west → east
  for (let j = 0; j < n - 1; j++) edge.push(j * n + n - 1); // east, north → south
  for (let i = n - 1; i > 0; i--) edge.push((n - 1) * n + i); // south, east → west
  for (let j = n - 1; j > 0; j--) edge.push(j * n); // west, south → north
  const skirtOf = new Int32Array(n * n).fill(-1);
  edge.forEach((k, e) => {
    const v = n * n + e;
    skirtOf[k] = v;
    position.set([position[k * 3], position[k * 3 + 1] - SKIRT, position[k * 3 + 2]], v * 3);
    normal.set(normal.subarray(k * 3, k * 3 + 3), v * 3);
    tint.set(tint.subarray(k * 3, k * 3 + 3), v * 3);
    land.set(land.subarray(k * 4, k * 4 + 4), v * 4);
  });

  // Triangles facing up (+y), and skirt quads facing out of the tile, at a vertex stride of 1 and 2
  const lod = (st) => {
    const idx = [];
    for (let j = 0; j + st < n; j += st) {
      for (let i = 0; i + st < n; i += st) {
        const a = j * n + i, b = a + st, c = a + st * n, d = c + st;
        idx.push(a, c, b, b, c, d);
      }
    }
    // Round the edge (north edge west → east, east edge north → south …): (p, q, p') faces out of the tile
    const ring = edge.filter((k) => (k % n) % st === 0 && Math.floor(k / n) % st === 0);
    for (let e = 0; e < ring.length; e++) {
      const p = ring[e], q = ring[(e + 1) % ring.length];
      idx.push(p, q, skirtOf[p], q, skirtOf[q], skirtOf[p]);
    }
    return new Uint32Array(idx);
  };
  const index = [lod(1), lod(2)];
  return { n, position, normal, tint, land, index, heights: Int16Array.from(H, (h) => Math.round(h * 10)), water, sea, bounds: [x0, z0, x1, z0 + (x1 - x0)] };
}

export { buildTerrain, rasterize, isWater, AREA_STYLE, SEA_Y };
