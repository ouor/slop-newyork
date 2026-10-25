import { mulberry32, hashId, distToSegment, ringArea, SegmentGrid } from './world-geometry.js';

// js/drive/world-rural-layout.js
// Pure layout rules for the rural scenery of a Korea Drive tile (world-rural.js turns them into meshes; unit-tested in
// tests/drive-world-rural.test.cjs). Everything is seeded by world position / tile key, so a tile always comes out
// the same and neighbouring tiles agree:
// - routeIndex(route): the route centreline in a segment grid → chainage (m from the start) of any point near it, the
//   corridor tile set, and the chainage of the cities along the way (for the green direction signs)
// - createRuralMask(tile, sampler, index): a 4 m raster of the tile — land class (forest / farmland / village / …
//   from the OSM areas), terrain slope, clearance from the carriageways and distance from OSM building footprints
// - villageLots / farmParcels / forestSites: houses, factories, paddies, fields, greenhouses, orchards and barns,
//   and the trees of woods and of unmapped steep slopes (Korean hills are forested; OSM rarely says so)
// - powerLines(…): 송전탑 lines defined in world space from the seed (6 km cells), so every tile places the same towers
// - highwayPlan(tile, index): direction signs, gantries, route shields, distance posts, km markers, emergency phones
//   and delineators along the motorway / trunk carriageways, keyed to route chainage

const CELL = 4; // m, raster resolution of the mask

// Land classes of the mask
const C = { NONE: 0, FOREST: 1, SCRUB: 2, FARM: 3, ORCHARD: 4, VILLAGE: 5, INDUSTRY: 6, WATER: 7, URBAN: 8, GREENHOUSE: 9, YARD: 10 };

const KIND_CLASS = {
  wood: C.FOREST, forest: C.FOREST,
  scrub: C.SCRUB, heath: C.SCRUB, grassland: C.SCRUB,
  farmland: C.FARM, meadow: C.FARM, greenfield: C.FARM, allotments: C.FARM, farm: C.FARM,
  orchard: C.ORCHARD, vineyard: C.ORCHARD, plant_nursery: C.ORCHARD,
  greenhouse_horticulture: C.GREENHOUSE,
  residential: C.VILLAGE, farmyard: C.VILLAGE,
  industrial: C.INDUSTRY, depot: C.INDUSTRY,
  water: C.WATER, wetland: C.WATER, basin: C.WATER, reservoir: C.WATER, riverbank: C.WATER
};
// Paint order: natural cover first, land use over it, water last
const PRIORITY = { [C.SCRUB]: 1, [C.FOREST]: 2, [C.FARM]: 3, [C.ORCHARD]: 4, [C.GREENHOUSE]: 4, [C.VILLAGE]: 5, [C.INDUSTRY]: 5, [C.URBAN]: 6, [C.WATER]: 7 };
const classOf = (a) => (a.key === 'water' ? C.WATER : KIND_CLASS[a.kind] ?? C.URBAN);

const MAJOR = new Set(['motorway', 'trunk']);
// Extra clearance kept from a carriageway edge by class (cut / fill slopes & verges of the big roads)
const roadExtra = (hw) => (MAJOR.has(hw) ? 8 : hw && hw.endsWith('_link') ? 4 : hw === 'primary' ? 2 : 0);

// Cities along Korean expressways (lat, lon) for the direction signs; only those within 12 km of the route are used
const CITIES = [
  ['서울', 37.5665, 126.978], ['성남', 37.42, 127.1265], ['용인', 37.2411, 127.1776], ['수원', 37.2636, 127.0286],
  ['오산', 37.1499, 127.0775], ['평택', 36.9921, 127.1129], ['안성', 37.008, 127.2797], ['천안', 36.8151, 127.1139],
  ['청주', 36.6424, 127.489], ['세종', 36.48, 127.289], ['대전', 36.3504, 127.3845], ['옥천', 36.3064, 127.5714],
  ['영동', 36.175, 127.7764], ['김천', 36.1398, 128.1136], ['구미', 36.1195, 128.3446], ['칠곡', 35.9956, 128.4017],
  ['대구', 35.8714, 128.6014], ['경산', 35.8251, 128.7411], ['청도', 35.6473, 128.7339], ['밀양', 35.5038, 128.7467],
  ['양산', 35.335, 129.0373], ['김해', 35.2285, 128.8894], ['부산', 35.1796, 129.0756], ['창원', 35.2281, 128.6811],
  ['창녕', 35.5446, 128.4925], ['고령', 35.7262, 128.2629], ['성주', 35.919, 128.2829], ['상주', 36.4109, 128.159],
  ['문경', 36.5866, 128.1868], ['괴산', 36.8154, 127.7867], ['충주', 36.991, 127.9259], ['음성', 36.9403, 127.6906],
  ['여주', 37.2984, 127.637], ['이천', 37.272, 127.435], ['원주', 37.3422, 127.9202], ['진천', 36.8554, 127.4356],
  ['광주', 37.4295, 127.2550], ['하남', 37.5393, 127.2149]
];

// ---------------------------------------------------------------------------------------------------------------------
// Route index (cached per route object)
// ---------------------------------------------------------------------------------------------------------------------
const indexCache = new WeakMap();

function routeIndex(route) {
  if (indexCache.has(route)) return indexCache.get(route);
  const path = route.path || [];
  const n = path.length >> 1;
  const cum = route.cumulative || new Float64Array(n);
  if (!route.cumulative) for (let i = 1; i < n; i++) cum[i] = cum[i - 1] + Math.hypot(path[2 * i] - path[2 * i - 2], path[2 * i + 1] - path[2 * i - 1]);
  const segs = route.segments || [];
  const segAt = (i) => {
    let lo = 0, hi = segs.length - 1;
    while (lo < hi) {
      const mid = (lo + hi + 1) >> 1;
      if (segs[mid].i0 <= i) lo = mid;
      else hi = mid - 1;
    }
    return segs[lo] || null;
  };
  const grid = new SegmentGrid(100);
  for (let i = 0; i + 1 < n; i++) grid.add([path[2 * i], path[2 * i + 1], path[2 * i + 2], path[2 * i + 3]], 0, i);

  // Nearest centreline point within `radius`: { chainage, dist, dx, dz (route direction), segment }
  function nearest(x, z, radius = 60) {
    const c = grid.cell;
    let best = null, bestD = radius;
    for (let ix = Math.floor((x - radius) / c); ix <= Math.floor((x + radius) / c); ix++) {
      for (let iz = Math.floor((z - radius) / c); iz <= Math.floor((z + radius) / c); iz++) {
        for (const s of grid.map.get(grid.key(ix, iz)) || []) {
          const d = distToSegment(x, z, s.ax, s.az, s.bx, s.bz);
          if (d >= bestD) continue;
          const len = Math.hypot(s.bx - s.ax, s.bz - s.az) || 1;
          const t = Math.max(0, Math.min(1, ((x - s.ax) * (s.bx - s.ax) + (z - s.az) * (s.bz - s.az)) / (len * len)));
          bestD = d;
          best = { chainage: cum[s.ref] + t * len, dist: d, dx: (s.bx - s.ax) / len, dz: (s.bz - s.az) / len, i: s.ref };
        }
      }
    }
    if (best) best.segment = segAt(best.i);
    return best;
  }

  // Cities projected on the route (brute force over the path, once per route)
  const lat0 = route.origin?.lat ?? 0, lon0 = route.origin?.lon ?? 0;
  const kx = 111320 * Math.cos((lat0 * Math.PI) / 180);
  const cities = [];
  for (const [name, lat, lon] of CITIES) {
    const x = (lon - lon0) * kx, z = -(lat - lat0) * 110540;
    let bd = Infinity, bi = 0;
    for (let i = 0; i < n; i++) {
      const d = (path[2 * i] - x) ** 2 + (path[2 * i + 1] - z) ** 2;
      if (d < bd) { bd = d; bi = i; }
    }
    if (bd < 12000 * 12000) cities.push({ name, chainage: cum[bi] });
  }
  cities.sort((a, b) => a.chainage - b.chainage);

  const index = { grid, nearest, cities, length: n ? cum[n - 1] : 0, corridor: new Set(route.tiles || []), tileSize: route.tileSize || 500, segAt };
  indexCache.set(route, index);
  return index;
}

// The next two cities ahead of chainage c in direction dir (+1 towards the route's end) and the final one
function destinations(cities, c, dir) {
  const ahead = cities.filter((k) => (k.chainage - c) * dir > 1500).sort((a, b) => (a.chainage - b.chainage) * dir);
  if (!ahead.length) return [];
  const list = ahead.slice(0, 2);
  if (!list.includes(ahead[ahead.length - 1])) list.push(ahead[ahead.length - 1]);
  return list.map((k) => ({ name: k.name, km: Math.max(1, Math.round(Math.abs(k.chainage - c) / 1000)) }));
}

// ---------------------------------------------------------------------------------------------------------------------
// Mask
// ---------------------------------------------------------------------------------------------------------------------

// Even-odd scanline fill of rings (flat [x, z, …]) over an n × n raster of `cell` m from (minX, minZ), cell centres;
// fill(iz, ix0, ix1) for every covered run (inclusive)
function rasterRings(rings, minX, minZ, cell, n, fill) {
  const rows = new Map();
  for (const ring of rings) {
    const m = ring.length >> 1;
    for (let i = 0, j = m - 1; i < m; j = i++) {
      const xi = ring[i * 2], zi = ring[i * 2 + 1], xj = ring[j * 2], zj = ring[j * 2 + 1];
      if (zi === zj) continue;
      const lo = Math.max(0, Math.ceil((Math.min(zi, zj) - minZ) / cell - 0.5));
      const hi = Math.min(n - 1, Math.ceil((Math.max(zi, zj) - minZ) / cell - 0.5) - 1);
      for (let iz = lo; iz <= hi; iz++) {
        const zc = minZ + (iz + 0.5) * cell;
        let list = rows.get(iz);
        if (!list) rows.set(iz, (list = []));
        list.push(xi + ((zc - zi) * (xj - xi)) / (zj - zi));
      }
    }
  }
  for (const [iz, xs] of rows) {
    xs.sort((a, b) => a - b);
    for (let k = 0; k + 1 < xs.length; k += 2) {
      const ix0 = Math.max(0, Math.ceil((xs[k] - minX) / cell - 0.5));
      const ix1 = Math.min(n - 1, Math.ceil((xs[k + 1] - minX) / cell - 0.5) - 1);
      if (ix1 >= ix0) fill(iz, ix0, ix1);
    }
  }
}

/**
 * The tile's 4 m raster: cls (land class), slope (rise over run), road (m from the nearest carriageway edge, minus the
 * class's extra verge; 99 beyond ~12 m), bld (m from an OSM building footprint). `rural` is false for built-up tiles.
 * ruralMask is the same as a generator yielding between its phases (for slicing); createRuralMask runs it through.
 */
const createRuralMask = (tile, sampler, index = null) => {
  const gen = ruralMask(tile, sampler, index);
  for (;;) {
    const r = gen.next();
    if (r.done) return r.value;
  }
};

function* ruralMask(tile, sampler, index = null) {
  const [minX, minZ, maxX] = tile.bounds;
  const size = maxX - minX;
  const n = Math.round(size / CELL);
  const N = n * n;
  const cls = new Uint8Array(N);
  const slope = new Float32Array(N);
  const road = new Float32Array(N).fill(99);
  const bld = new Float32Array(N).fill(1e4);
  const at = (x, z) => {
    const ix = Math.floor((x - minX) / CELL), iz = Math.floor((z - minZ) / CELL);
    return ix < 0 || iz < 0 || ix >= n || iz >= n ? -1 : iz * n + ix;
  };

  // Areas by paint priority
  const areas = (tile.areas || []).filter((a) => a.pts && a.pts.length >= 6).map((a) => ({ a, c: classOf(a) }));
  areas.sort((p, q) => PRIORITY[p.c] - PRIORITY[q.c]);
  for (const { a, c } of areas) rasterRings([a.pts, ...(a.holes || [])], minX, minZ, CELL, n, (iz, i0, i1) => cls.fill(c, iz * n + i0, iz * n + i1 + 1));

  // Building footprints, then a chamfer distance transform (cells → m)
  let bcells = 0;
  for (const b of tile.buildings || []) {
    if (!b.pts || b.pts.length < 6) continue;
    rasterRings([b.pts], minX, minZ, CELL, n, (iz, i0, i1) => { bld.fill(0, iz * n + i0, iz * n + i1 + 1); bcells += i1 - i0 + 1; });
    // Small footprints fall between cell centres: mark the cell under their first vertex
    const k = at(b.pts[0], b.pts[1]);
    if (k >= 0 && bld[k] > 0) { bld[k] = 0; bcells++; }
  }
  const D = CELL, DD = CELL * Math.SQRT2;
  for (let iz = 0; iz < n && bcells; iz++) {
    for (let ix = 0; ix < n; ix++) {
      const k = iz * n + ix;
      let v = bld[k];
      if (ix > 0) v = Math.min(v, bld[k - 1] + D);
      if (iz > 0) {
        v = Math.min(v, bld[k - n] + D);
        if (ix > 0) v = Math.min(v, bld[k - n - 1] + DD);
        if (ix < n - 1) v = Math.min(v, bld[k - n + 1] + DD);
      }
      bld[k] = v;
    }
  }
  for (let iz = n - 1; iz >= 0 && bcells; iz--) {
    for (let ix = n - 1; ix >= 0; ix--) {
      const k = iz * n + ix;
      let v = bld[k];
      if (ix < n - 1) v = Math.min(v, bld[k + 1] + D);
      if (iz < n - 1) {
        v = Math.min(v, bld[k + n] + D);
        if (ix < n - 1) v = Math.min(v, bld[k + n + 1] + DD);
        if (ix > 0) v = Math.min(v, bld[k + n - 1] + DD);
      }
      bld[k] = v;
    }
  }

  yield;

  // Carriageway clearance (tunnels run under the ground: the hill above keeps its trees)
  const reach = 12;
  const stamp = (ax, az, bx, bz, half, extra) => {
    const r = half + extra + reach;
    const i0 = Math.max(0, Math.floor((Math.min(ax, bx) - r - minX) / CELL)), i1 = Math.min(n - 1, Math.floor((Math.max(ax, bx) + r - minX) / CELL));
    const j0 = Math.max(0, Math.floor((Math.min(az, bz) - r - minZ) / CELL)), j1 = Math.min(n - 1, Math.floor((Math.max(az, bz) + r - minZ) / CELL));
    const sx = bx - ax, sz = bz - az, l2 = sx * sx + sz * sz || 1e-9;
    for (let iz = j0; iz <= j1; iz++) {
      const pz = minZ + (iz + 0.5) * CELL - az;
      for (let ix = i0; ix <= i1; ix++) {
        const px = minX + (ix + 0.5) * CELL - ax;
        const t = Math.max(0, Math.min(1, (px * sx + pz * sz) / l2));
        const ex = px - sx * t, ez = pz - sz * t;
        const k = iz * n + ix;
        const d = Math.sqrt(ex * ex + ez * ez) - half - extra;
        if (d < road[k]) road[k] = d;
      }
    }
  };
  for (const r of tile.roads || []) {
    if (r.tunnel || !r.pts) continue;
    const half = (r.width || 6) / 2, extra = roadExtra(r.highway);
    for (let i = 0; i + 3 < r.pts.length; i += 2) stamp(r.pts[i], r.pts[i + 1], r.pts[i + 2], r.pts[i + 3], half, extra);
  }
  // The route itself, also where its carriageway runs just across the tile border
  if (index) {
    const seen = new Set();
    const c = index.grid.cell;
    for (let ix = Math.floor((minX - 40) / c); ix <= Math.floor((maxX + 40) / c); ix++) {
      for (let iz = Math.floor((minZ - 40) / c); iz <= Math.floor((minZ + size + 40) / c); iz++) {
        for (const s of index.grid.map.get(index.grid.key(ix, iz)) || []) {
          if (seen.has(s)) continue;
          seen.add(s);
          const seg = index.segAt(s.ref);
          if (seg?.tunnel) continue;
          stamp(s.ax, s.az, s.bx, s.bz, Math.max(3.3, (seg?.lanes || 2) * 1.75), roadExtra(seg?.highway));
        }
      }
    }
  }

  yield;

  // Slope from the terrain normal, sampled per 2 × 2 cells (the terrain grid is 7.8 m anyway)
  for (let iz = 0; iz < n; iz += 2) {
    for (let ix = 0; ix < n; ix += 2) {
      const nm = sampler.normalAt(minX + (ix + 1) * CELL, minZ + (iz + 1) * CELL);
      const v = Math.sqrt(Math.max(0, 1 - nm.y * nm.y)) / Math.max(nm.y, 0.05);
      const k = iz * n + ix;
      slope[k] = v;
      if (ix + 1 < n) slope[k + 1] = v;
      if (iz + 1 < n) {
        slope[k + n] = v;
        if (ix + 1 < n) slope[k + n + 1] = v;
      }
    }
  }

  const builtShare = bcells / N;
  const urbanArea = areas.reduce((s, { a, c }) => s + (c === C.URBAN || c === C.INDUSTRY ? Math.abs(ringArea(a.pts)) : 0), 0) / (size * size);
  return {
    n, cell: CELL, minX, minZ, size, cls, slope, road, bld, at, builtShare,
    // Countryside: few footprints and little urban land use
    rural: builtShare < 0.03 && (tile.buildings || []).length < 120 && urbanArea < 0.35,
    // Unmapped, flat, clear land in the countryside farms as fields
    farmable: (k) => cls[k] === C.FARM || cls[k] === C.GREENHOUSE || cls[k] === C.ORCHARD || (cls[k] === C.NONE && slope[k] < 0.07)
  };
}

const tileSeed = (tile, seed = 0) => hashId(tile.tx * 92821 + tile.tz * 7, seed + 17);

// ---------------------------------------------------------------------------------------------------------------------
// Villages & industry
// ---------------------------------------------------------------------------------------------------------------------
const MINOR = new Set(['residential', 'unclassified', 'tertiary', 'track', 'service', 'living_street', 'secondary']);

/**
 * House, shed & factory lots: houses fill mapped residential / farmyard land where OSM has few footprints, hamlets of
 * 4–12 houses sit on unmapped flat land by a minor road (mostly at the foot of a hill), factories fill industrial land.
 * Each lot: { x, z, yaw, w, d, storeys, kind: 'house' | 'factory' }. Lots are stamped into the mask as YARD.
 */
function villageLots(tile, mask, seed = 0) {
  const lots = [];
  const { n, minX, minZ, size, cls, slope, road, bld, at } = mask;
  if (!mask.rural && mask.builtShare > 0.06) return lots;
  const free = (x, z, r, minBld = 6) => {
    for (const [ox, oz] of [[0, 0], [r, 0], [-r, 0], [0, r], [0, -r]]) {
      const k = at(x + ox, z + oz);
      if (k < 0 || road[k] < 3 || bld[k] < minBld || slope[k] > 0.22) return false;
      const c = cls[k];
      if (c === C.WATER || c === C.URBAN || c === C.YARD || c === C.FOREST) return false;
    }
    return true;
  };
  const taken = [];
  const clash = (x, z, r) => taken.some((t) => Math.hypot(t.x - x, t.z - z) < t.r + r);
  const add = (lot, r) => {
    lots.push(lot);
    taken.push({ x: lot.x, z: lot.z, r });
    // Stamp the yard
    const i0 = Math.max(0, Math.floor((lot.x - r - minX) / CELL)), i1 = Math.min(n - 1, Math.floor((lot.x + r - minX) / CELL));
    const j0 = Math.max(0, Math.floor((lot.z - r - minZ) / CELL)), j1 = Math.min(n - 1, Math.floor((lot.z + r - minZ) / CELL));
    for (let iz = j0; iz <= j1; iz++) for (let ix = i0; ix <= i1; ix++) cls[iz * n + ix] = C.YARD;
  };
  const house = (x, z, rng) => {
    const w = 8 + rng() * 5, d = 6 + rng() * 3;
    // Houses face south (남향), give or take
    return { x, z, yaw: (rng() - 0.5) * 0.6, w, d, storeys: rng() < 0.3 ? 2 : 1, kind: 'house', seed: Math.floor(rng() * 1e9) };
  };

  // Mapped residential / industrial land: a jittered world-aligned grid
  for (const [kind, step, want] of [['house', 22, C.VILLAGE], ['factory', 48, C.INDUSTRY]]) {
    for (let gz = Math.floor(minZ / step); gz * step < minZ + size; gz++) {
      for (let gx = Math.floor(minX / step); gx * step < minX + size; gx++) {
        const rng = mulberry32(hashId(gx * 7919 + gz, seed + (kind === 'house' ? 3 : 4)));
        const x = (gx + 0.2 + rng() * 0.6) * step, z = (gz + 0.2 + rng() * 0.6) * step;
        const k = at(x, z);
        if (k < 0 || cls[k] !== want || rng() > 0.75) continue;
        if (kind === 'house') {
          const lot = house(x, z, rng);
          if (free(x, z, 8, 10) && !clash(x, z, 9)) add(lot, 9);
        } else {
          const w = 22 + rng() * 22, d = 14 + rng() * 12;
          const r = Math.hypot(w, d) / 2 + 2;
          if (free(x, z, r * 0.7, 12) && !clash(x, z, r)) add({ x, z, yaw: (rng() - 0.5) * 0.3, w, d, storeys: 1, kind: 'factory', seed: Math.floor(rng() * 1e9) }, r);
        }
      }
    }
  }

  // Hamlets on unmapped land of rural tiles
  if (mask.rural) {
    const minor = new SegmentGrid(40);
    for (const r of tile.roads || []) if (MINOR.has(r.highway) && !r.tunnel) minor.add(r.pts, (r.width || 4) / 2, r);
    const step = 120;
    for (let gz = Math.floor(minZ / step); gz * step < minZ + size; gz++) {
      for (let gx = Math.floor(minX / step); gx * step < minX + size; gx++) {
        const rng = mulberry32(hashId(gx * 15485863 + gz, seed + 5));
        const x = (gx + 0.25 + rng() * 0.5) * step, z = (gz + 0.25 + rng() * 0.5) * step;
        const k = at(x, z);
        if (k < 0 || !(cls[k] === C.NONE || cls[k] === C.FARM) || slope[k] > 0.12 || road[k] < 12) continue;
        if (minor.nearest(x, z, 80) > 70) continue;
        // 배산임수: hamlets huddle at the foot of a hill
        let foot = false;
        for (let a = 0; a < 8 && !foot; a++) {
          const q = at(x + Math.cos(a * 0.785) * 110, z + Math.sin(a * 0.785) * 110);
          if (q >= 0 && slope[q] > 0.18) foot = true;
        }
        if (rng() > (foot ? 0.45 : 0.12)) continue;
        const want = 4 + Math.floor(rng() * 9);
        for (let t = 0, got = 0; t < want * 4 && got < want; t++) {
          const a = rng() * Math.PI * 2, r = Math.sqrt(rng()) * 65;
          const hx = x + Math.cos(a) * r, hz = z + Math.sin(a) * r;
          if (!free(hx, hz, 7) || clash(hx, hz, 8)) continue;
          add(house(hx, hz, rng), 8);
          got++;
        }
      }
    }
  }
  return lots;
}

// ---------------------------------------------------------------------------------------------------------------------
// Farmland parcels
// ---------------------------------------------------------------------------------------------------------------------

// Parcel grid direction for the tile: along the longest edge of its biggest farmland, else along its minor roads
function parcelDirection(tile) {
  let best = 0, dir = null;
  for (const a of tile.areas || []) {
    if (KIND_CLASS[a.kind] !== C.FARM || !a.pts) continue;
    const ar = Math.abs(ringArea(a.pts));
    if (ar <= best) continue;
    best = ar;
    const m = a.pts.length >> 1;
    let L = 0;
    for (let i = 0; i < m; i++) {
      const j = (i + 1) % m;
      const dx = a.pts[j * 2] - a.pts[i * 2], dz = a.pts[j * 2 + 1] - a.pts[i * 2 + 1];
      const l = Math.hypot(dx, dz);
      if (l > L) { L = l; dir = Math.atan2(dz, dx); }
    }
  }
  if (dir !== null) return dir;
  // Length-weighted mean of the doubled angle (direction without sense)
  let sx = 0, sz = 0;
  for (const r of tile.roads || []) {
    if (!MINOR.has(r.highway)) continue;
    for (let i = 0; i + 3 < r.pts.length; i += 2) {
      const dx = r.pts[i + 2] - r.pts[i], dz = r.pts[i + 3] - r.pts[i + 1];
      const a = 2 * Math.atan2(dz, dx), l = Math.hypot(dx, dz);
      sx += Math.cos(a) * l;
      sz += Math.sin(a) * l;
    }
  }
  return sx || sz ? Math.atan2(sz, sx) / 2 : 0;
}

/**
 * Field parcels on an oriented grid over the tile, kept where the farmland mask holds at the centre & corners:
 * { cx, cz, ux, uz (long axis), lu, lv (lengths), type: 'paddy' | 'field' | 'greenhouse' | 'orchard' | 'barn' | 'fallow', seed }
 */
function farmParcels(tile, mask, seed = 0) {
  const out = [];
  const { minX, minZ, size, cls, slope, road, bld, at } = mask;
  const ang = parcelDirection(tile);
  const ux = Math.cos(ang), uz = Math.sin(ang), vx = -uz, vz = ux;
  const cx0 = minX + size / 2, cz0 = minZ + size / 2;
  const R = size * 0.75;
  const rng = mulberry32(tileSeed(tile, seed + 6));
  const ok = (x, z) => {
    const k = at(x, z);
    return k >= 0 && road[k] > 1.5 && bld[k] > 5 && (mask.farmable(k) && (mask.rural || cls[k] !== C.NONE));
  };
  for (let v = -R; v < R;) {
    const lv = 18 + rng() * 16;
    for (let u = -R + rng() * 30; u < R;) {
      const lu = 35 + rng() * 55;
      const cx = cx0 + ux * (u + lu / 2) + vx * (v + lv / 2), cz = cz0 + uz * (u + lu / 2) + vz * (v + lv / 2);
      u += lu;
      const k = at(cx, cz);
      if (k < 0) continue;
      let good = ok(cx, cz) ? 1 : 0;
      let maxSlope = 0;
      for (const [a, b] of [[-0.5, -0.5], [0.5, -0.5], [0.5, 0.5], [-0.5, 0.5]]) {
        const x = cx + ux * a * (lu - 2) + vx * b * (lv - 2), z = cz + uz * a * (lu - 2) + vz * b * (lv - 2);
        if (!ok(x, z)) { good = 0; break; }
        maxSlope = Math.max(maxSlope, slope[at(x, z)]);
      }
      if (!good) continue;
      const r = mulberry32(hashId(Math.round(cx) * 31 + Math.round(cz), seed + 7));
      const c = cls[k];
      let type;
      const flat = maxSlope < 0.06;
      if (c === C.ORCHARD) type = 'orchard';
      else if (c === C.GREENHOUSE) type = 'greenhouse';
      else {
        const p = r();
        if (flat) type = p < 0.62 ? 'paddy' : p < 0.8 ? 'field' : p < 0.9 ? 'greenhouse' : p < 0.94 ? 'orchard' : p < 0.97 ? 'barn' : 'fallow';
        else type = p < 0.7 ? 'field' : p < 0.85 ? 'orchard' : p < 0.9 ? 'barn' : 'fallow';
      }
      out.push({ cx, cz, ux, uz, lu: lu - 1.5, lv: lv - 1.5, type, seed: Math.floor(r() * 1e9) });
    }
    v += lv;
  }
  return out;
}

// ---------------------------------------------------------------------------------------------------------------------
// Forest
// ---------------------------------------------------------------------------------------------------------------------
const FOREST_STEP = 6.5; // m, jittered grid of tree sites (≈ 225 trees / ha in a mapped wood)

/**
 * Tree sites: woods & forests, scrub (small), and unmapped slopes (dense above ~10°, patchy below; in built-up tiles
 * only the steep ones away from buildings). { x, z, sp: 0 pine (소나무) | 1 oak (참나무), s (scale) }
 */
function forestSites(tile, mask, seed = 0) {
  const out = [];
  const { minX, minZ, size, cls, slope, road, bld, at } = mask;
  const g0x = Math.ceil(minX / FOREST_STEP), g0z = Math.ceil(minZ / FOREST_STEP);
  const g1x = Math.ceil((minX + size) / FOREST_STEP), g1z = Math.ceil((minZ + size) / FOREST_STEP);
  for (let gz = g0z; gz < g1z; gz++) {
    for (let gx = g0x; gx < g1x; gx++) {
      const h = hashId(gx * 73856093 + gz, seed + 9);
      const rng = mulberry32(h);
      const x = (gx + rng() * 0.9) * FOREST_STEP, z = (gz + rng() * 0.9) * FOREST_STEP;
      const k = at(x, z);
      if (k < 0 || road[k] < 3.5) continue;
      const c = cls[k], sl = slope[k];
      let p = 0, s = 1;
      if (c === C.FOREST) p = 0.95;
      else if (c === C.SCRUB) { p = 0.35; s = 0.55; }
      else if (c === C.NONE) {
        if (mask.rural) p = sl > 0.2 ? 0.92 : sl > 0.08 ? (sl - 0.08) * 6 : 0;
        else p = sl > 0.3 && bld[k] > 30 ? 0.85 : 0;
      }
      if (p <= 0 || bld[k] < 4 || rng() > p) continue;
      // Stands: pine on the ridges & steep ground, oak in the hollows, mixed in 45 m patches
      const stand = (hashId(Math.floor(x / 45) * 7 + Math.floor(z / 45) * 131, seed + 10) % 1000) / 1000;
      const sp = rng() < 0.15 + stand * 0.55 + Math.min(sl, 0.5) * 0.4 ? 0 : 1;
      // Saplings at the forest's road edge
      const edge = Math.min(1, (road[k] - 3.5) / 12);
      out.push({ x, z, sp, s: s * (0.85 + rng() * 0.55) * (0.7 + edge * 0.3) });
    }
  }
  return out;
}

// ---------------------------------------------------------------------------------------------------------------------
// Transmission lines
// ---------------------------------------------------------------------------------------------------------------------
const LINE_CELL = 6000;
const LINE_HALF = 7000;

/**
 * The 송전탑 lines whose towers may fall in [minX, maxX) × [minZ, maxZ): each { id, towers: [{ k, x, z }] } in order
 * along the line; `avoid(x, z)` (global data only, e.g. the route) nudges a tower 45 m along, or drops it.
 */
function powerLines(minX, minZ, maxX, maxZ, seed = 0, avoid = null) {
  const lines = [];
  const pad = LINE_HALF + 600;
  for (let cj = Math.floor((minZ - pad) / LINE_CELL); cj <= Math.floor((maxZ + pad) / LINE_CELL); cj++) {
    for (let ci = Math.floor((minX - pad) / LINE_CELL); ci <= Math.floor((maxX + pad) / LINE_CELL); ci++) {
      const rng = mulberry32(hashId(ci * 48271 + cj * 69621, seed + 11));
      if (rng() > 0.85) continue;
      const ax = (ci + rng()) * LINE_CELL, az = (cj + rng()) * LINE_CELL;
      const a = rng() * Math.PI, dx = Math.cos(a), dz = Math.sin(a);
      const spacing = 330 + rng() * 140;
      const kmax = Math.floor(LINE_HALF / spacing);
      // Quick reject: the line's segment far from the box
      const ex = dx * LINE_HALF, ez = dz * LINE_HALF;
      const bx = Math.max(minX - 600, Math.min(maxX + 600, ax)), bz = Math.max(minZ - 600, Math.min(maxZ + 600, az));
      if (distToSegment(bx, bz, ax - ex, az - ez, ax + ex, az + ez) > 1200 + Math.hypot(maxX - minX, maxZ - minZ)) continue;
      const towers = [];
      for (let k = -kmax; k <= kmax; k++) {
        let s = k * spacing + (rng() - 0.5) * 60;
        let x = ax + dx * s, z = az + dz * s;
        if (x < minX - 600 || x > maxX + 600 || z < minZ - 600 || z > maxZ + 600) continue;
        if (avoid && avoid(x, z)) {
          s += 45;
          x = ax + dx * s;
          z = az + dz * s;
          if (avoid(x, z)) continue;
        }
        towers.push({ k, x, z });
      }
      if (towers.length) lines.push({ id: hashId(ci, cj + seed), dx, dz, towers });
    }
  }
  return lines;
}

// ---------------------------------------------------------------------------------------------------------------------
// Highway furniture
// ---------------------------------------------------------------------------------------------------------------------

// Every multiple of `period` (+ offset) crossed going from chainage c0 to c1 (either sense): [{ m, t (0..1 c0→c1) }]
function marksBetween(c0, c1, period, offset = 0) {
  const out = [];
  const lo = Math.min(c0, c1), hi = Math.max(c0, c1);
  if (hi - lo < 1e-9) return out;
  for (let m = Math.ceil((lo - offset) / period) * period + offset; m < hi; m += period) {
    if (m < lo) continue;
    out.push({ m, t: (m - c0) / (c1 - c0) });
  }
  return out;
}

/**
 * Furniture along the tile's motorway / trunk carriageways (not in tunnels). Items are
 * { type, x, y (road surface), z, dx, dz (travel direction), rx, rz (right), half, bridge, ...data }:
 * - 'delineator' every 20 m on the right edge
 * - 'post' (거리표) every 100 m of route chainage: label "123.4"; whole km → 'km' marker
 * - 'phone' (비상전화) at every km + 530 m (clear of the 거리표)
 * - 'sign' (이정표) every 2 km: rows of { name, km }; 'shield' every 5 km: ref + road name; 'gantry' every 5 km: ref,
 *   name and the next destination, spanning the carriageway
 * Chainage-keyed items appear only on carriageways along the route (within 40 m of it, parallel).
 */
function highwayPlan(tile, index) {
  const items = [];
  for (const r of tile.roads || []) {
    if (!MAJOR.has(r.highway) || r.tunnel || !r.pts || r.pts.length < 4) continue;
    const dirs = r.oneway ? [1] : [1, -1];
    for (const sense of dirs) {
      const m = r.pts.length >> 1;
      const P = (i) => (sense > 0 ? i : m - 1 - i);
      let acc = 0;
      let prev = null;
      for (let j = 0; j + 1 < m; j++) {
        const a = P(j), b = P(j + 1);
        const ax = r.pts[a * 2], az = r.pts[a * 2 + 1], bx = r.pts[b * 2], bz = r.pts[b * 2 + 1];
        const ay = r.ys ? r.ys[a] : 0, by = r.ys ? r.ys[b] : 0;
        const len = Math.hypot(bx - ax, bz - az);
        if (len < 1e-3) continue;
        const dx = (bx - ax) / len, dz = (bz - az) / len;
        const rx = -dz, rz = dx;
        const edge = (r.width || 7) / 2; // right edge (of the whole road when it carries both directions)
        const at = (t, off) => ({ x: ax + (bx - ax) * t + rx * off, y: ay + (by - ay) * t, z: az + (bz - az) * t + rz * off });
        const base = { dx, dz, rx, rz, half: edge, bridge: !!r.bridge, road: r };
        // Delineators by the carriageway's own length
        for (const { t } of marksBetween(acc, acc + len, 20, (hashId(r.id, sense) % 20))) items.push({ type: 'delineator', ...at(t, edge + 0.9), ...base });

        // Chainage of both ends (only when running along the route)
        const na = prev || index?.nearest(ax, az, 40);
        const nb = index?.nearest(bx, bz, 40);
        prev = nb;
        acc += len;
        if (!na || !nb || Math.abs(nb.chainage - na.chainage) > len * 1.5 + 5) continue;
        const along = dx * nb.dx + dz * nb.dz;
        if (Math.abs(along) < 0.8) continue;
        const dir = along > 0 ? 1 : -1;
        const seg = nb.segment || {};
        const ref = seg.ref || null;
        const name = seg.name || r.name || null;
        const c0 = na.chainage, c1 = nb.chainage;
        for (const { m: c, t } of marksBetween(c0, c1, 100)) {
          const km = c / 1000;
          if (c % 1000 === 0) items.push({ type: 'km', label: String(Math.round(km)), ...at(t, edge + 2.2), ...base });
          else items.push({ type: 'post', label: km.toFixed(1), ...at(t, edge + 2.2), ...base });
        }
        for (const { t } of marksBetween(c0, c1, 1000, 530)) items.push({ type: 'phone', ...at(t, edge + 2.6), ...base });
        // Signs are keyed to the chainage in the travel direction, so the two carriageways don't stack them together
        for (const { m: c, t } of marksBetween(c0, c1, 2000, dir > 0 ? 1200 : 200)) {
          const rows = destinations(index.cities, c, dir);
          if (rows.length) items.push({ type: 'sign', rows, ...at(t, edge + 3.5), ...base });
        }
        for (const { t } of marksBetween(c0, c1, 5000, dir > 0 ? 3000 : 1800)) if (ref || name) items.push({ type: 'shield', ref, name, ...at(t, edge + 3.2), ...base });
        if (r.oneway && !r.bridge) {
          for (const { m: c, t } of marksBetween(c0, c1, 5000, dir > 0 ? 4300 : 600)) {
            const next = destinations(index.cities, c, dir)[0] || null;
            items.push({ type: 'gantry', ref, name, next, width: r.width || 7, ...at(t, 0), ...base });
          }
        }
      }
    }
  }
  return items;
}

export {
  CELL,
  C as LAND,
  CITIES,
  routeIndex,
  destinations,
  rasterRings,
  createRuralMask,
  ruralMask,
  tileSeed,
  villageLots,
  parcelDirection,
  farmParcels,
  forestSites,
  powerLines,
  marksBetween,
  highwayPlan
};
