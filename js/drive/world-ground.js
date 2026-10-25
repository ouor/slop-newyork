import { MeshData, addFlatPolygon, pointInPolygon, distToSegment, ringArea, ringBounds } from './world-geometry.js';

// js/drive/world-ground.js
// Ground of one tile: a paved base at y = 0, landuse / leisure / natural areas as tinted flat polygons a few mm above it
// (higher kinds drawn over lower ones), small ponds as flat water, and rivers (the Han) as a water plane at y = -3
// inside a ground heightfield whose vertices in the water sink below it, so the banks slope down as a revetment.

const WATER_Y = -3;
const GRID = 5; // m between heightfield vertices
const BIG_WATER = 5000; // m² of water inside a tile that is lowered (smaller ponds stay flat)
const BASE_TINT = [0.5, 0.49, 0.46];

// kind → [tint, y]
const AREA_STYLE = {
  residential: [[0.56, 0.55, 0.52], 0.002], commercial: [[0.54, 0.53, 0.51], 0.002], retail: [[0.54, 0.53, 0.51], 0.002],
  religious: [[0.55, 0.54, 0.5], 0.002], industrial: [[0.5, 0.5, 0.49], 0.002],
  military: [[0.38, 0.45, 0.3], 0.002], railway: [[0.43, 0.4, 0.37], 0.003],
  construction: [[0.55, 0.47, 0.38], 0.003], brownfield: [[0.55, 0.47, 0.38], 0.003],
  park: [[0.3, 0.45, 0.22], 0.004], garden: [[0.3, 0.47, 0.22], 0.004], grass: [[0.33, 0.49, 0.23], 0.004],
  greenery: [[0.33, 0.49, 0.23], 0.004], village_green: [[0.33, 0.49, 0.23], 0.004], grassland: [[0.38, 0.47, 0.25], 0.004],
  recreation_ground: [[0.35, 0.48, 0.24], 0.004], golf_course: [[0.32, 0.52, 0.24], 0.004], allotments: [[0.4, 0.42, 0.26], 0.004],
  wood: [[0.2, 0.31, 0.15], 0.005], forest: [[0.2, 0.31, 0.15], 0.005], scrub: [[0.27, 0.36, 0.19], 0.005],
  pitch: [[0.24, 0.5, 0.3], 0.006], track: [[0.62, 0.3, 0.24], 0.007], playground: [[0.6, 0.5, 0.38], 0.006],
  sports_centre: [[0.45, 0.47, 0.42], 0.005], swimming_pool: [[0.3, 0.55, 0.7], 0.006], fitness_station: [[0.6, 0.5, 0.38], 0.006]
};

const isWater = (a) => a.kind === 'water' || a.key === 'water' || a.kind === 'riverbank';

function* buildGround(tile, triangulate) {
  const ground = new MeshData({ tint: 3 });
  const water = new MeshData();
  const [x0, z0, x1, z1] = tile.bounds || [tile.tx * 500, tile.tz * 500, tile.tx * 500 + 500, tile.tz * 500 + 500];

  const waters = (tile.areas || []).filter(isWater).filter((a) => a.pts.length >= 6);
  const big = waters.filter((a) => Math.abs(ringArea(a.pts)) >= BIG_WATER);
  for (const a of waters) if (!big.includes(a)) addFlatPolygon(water, a.pts, a.holes || [], 0.02, triangulate);

  ground.set('tint', ...BASE_TINT);
  if (!big.length) {
    ground.quad([[x0, 0, z0], [x1, 0, z0], [x1, 0, z1], [x0, 0, z1]], 0, 1, 0);
  } else {
    // Edges of the water polygons that are real shores (not cuts along the tile border)
    const onB = (x, z) => Math.abs(x - x0) < 0.3 || Math.abs(x - x1) < 0.3 || Math.abs(z - z0) < 0.3 || Math.abs(z - z1) < 0.3;
    const shores = [];
    for (const a of big) {
      for (const ring of [a.pts, ...(a.holes || [])]) {
        const n = ring.length >> 1;
        for (let i = 0; i < n; i++) {
          const j = (i + 1) % n;
          const ax = ring[i * 2], az = ring[i * 2 + 1], bx = ring[j * 2], bz = ring[j * 2 + 1];
          const sameSide = (Math.abs(ax - bx) < 0.3 && onB(ax, az) && onB(bx, bz)) || (Math.abs(az - bz) < 0.3 && onB(ax, az) && onB(bx, bz));
          if (!sameSide) shores.push([ax, az, bx, bz]);
        }
      }
    }
    const boxes = big.map((a) => ringBounds(a.pts));
    const nx = Math.round((x1 - x0) / GRID), nz = Math.round((z1 - z0) / GRID);
    const H = new Float32Array((nx + 1) * (nz + 1));
    for (let j = 0; j <= nz; j++) {
      for (let i = 0; i <= nx; i++) {
        // Test points nudged off the tile border, where the clipped polygons have their cut edges
        const x = Math.min(x1 - 0.05, Math.max(x0 + 0.05, x0 + i * GRID));
        const z = Math.min(z1 - 0.05, Math.max(z0 + 0.05, z0 + j * GRID));
        let wet = false;
        for (let k = 0; k < big.length && !wet; k++) {
          const b = boxes[k];
          wet = x >= b.minX && x <= b.maxX && z >= b.minZ && z <= b.maxZ && pointInPolygon(big[k].pts, big[k].holes, x, z);
        }
        if (!wet) continue;
        let d = 6;
        for (const s of shores) d = Math.min(d, distToSegment(x, z, s[0], s[1], s[2], s[3]));
        H[j * (nx + 1) + i] = -Math.min(5, 1 + d * 0.9);
      }
      if (j % 25 === 0) yield;
    }
    const idx = [];
    for (let j = 0; j <= nz; j++) {
      for (let i = 0; i <= nx; i++) {
        const h = (a, b) => H[Math.min(nz, Math.max(0, b)) * (nx + 1) + Math.min(nx, Math.max(0, a))];
        const gx = (h(i + 1, j) - h(i - 1, j)) / (2 * GRID), gz = (h(i, j + 1) - h(i, j - 1)) / (2 * GRID);
        const l = Math.hypot(gx, 1, gz);
        idx.push(ground.vert(x0 + i * GRID, H[j * (nx + 1) + i], z0 + j * GRID, -gx / l, 1 / l, -gz / l));
      }
    }
    for (let j = 0; j < nz; j++) {
      for (let i = 0; i < nx; i++) {
        const a = idx[j * (nx + 1) + i], b = idx[j * (nx + 1) + i + 1], c = idx[(j + 1) * (nx + 1) + i], d = idx[(j + 1) * (nx + 1) + i + 1];
        ground.tri(a, c, b, 0, 1, 0);
        ground.tri(b, c, d, 0, 1, 0);
      }
    }
    // One water plane over the lowered part of the tile; the land around it stands above it
    let wx0 = Infinity, wz0 = Infinity, wx1 = -Infinity, wz1 = -Infinity;
    for (const b of boxes) { wx0 = Math.min(wx0, b.minX); wz0 = Math.min(wz0, b.minZ); wx1 = Math.max(wx1, b.maxX); wz1 = Math.max(wz1, b.maxZ); }
    wx0 = Math.max(x0, wx0 - GRID); wz0 = Math.max(z0, wz0 - GRID); wx1 = Math.min(x1, wx1 + GRID); wz1 = Math.min(z1, wz1 + GRID);
    water.quad([[wx0, WATER_Y, wz0], [wx1, WATER_Y, wz0], [wx1, WATER_Y, wz1], [wx0, WATER_Y, wz1]], 0, 1, 0);
  }
  yield;

  // Landuse & leisure areas
  for (const a of tile.areas || []) {
    if (isWater(a) || a.pts.length < 6) continue;
    const style = AREA_STYLE[a.kind];
    if (!style) continue;
    ground.set('tint', ...style[0]);
    addFlatPolygon(ground, a.pts, (a.holes || []).filter((h) => h.length >= 6), style[1], triangulate);
  }
  return { ground, water };
}

export { buildGround, WATER_Y };
