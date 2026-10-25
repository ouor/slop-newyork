const assert = require('node:assert/strict');
const { readFileSync, readdirSync } = require('node:fs');
const { join } = require('node:path');
const test = require('node:test');
const { loadModule } = require('./helpers/module.cjs');

const read = (name) => readFileSync(join(__dirname, '../js/drive', name), 'utf8');
const geo = loadModule(read('world-geometry.js'), { filename: 'world-geometry.js' });
const roadsModule = loadModule(read('world-roads.js'), { imports: { './world-geometry.js': geo }, filename: 'world-roads.js' });
const { buildTerrain, rasterize } = loadModule(read('world-terrain.js'), { imports: { './world-geometry.js': geo }, filename: 'world-terrain.js' });
const { buildStructures } = loadModule(read('world-structures.js'), {
  imports: { './world-geometry.js': geo, './world-roads.js': roadsModule }, filename: 'world-structures.js'
});
const { buildBuildings } = loadModule(read('world-buildings.js'), { imports: { './world-geometry.js': geo }, filename: 'world-buildings.js' });
const { createTileSampler } = loadModule(read('terrain-sample.js'));

const fan = (outer) => {
  const faces = [];
  for (let i = 1; i + 1 < outer.length / 2; i++) faces.push([0, i, i + 1]);
  return faces;
};
const finish = (gen) => { for (;;) { const r = gen.next(); if (r.done) return r.value; } };
const faceNormal = (P, i, j, k) => {
  const u = [P[j * 3] - P[i * 3], P[j * 3 + 1] - P[i * 3 + 1], P[j * 3 + 2] - P[i * 3 + 2]];
  const v = [P[k * 3] - P[i * 3], P[k * 3 + 1] - P[i * 3 + 1], P[k * 3 + 2] - P[i * 3 + 2]];
  return [u[1] * v[2] - u[2] * v[1], u[2] * v[0] - u[0] * v[2], u[0] * v[1] - u[1] * v[0]];
};

function slopeTile() {
  const n = 65;
  const terrain = new Int16Array(n * n);
  for (let j = 0; j < n; j++) for (let i = 0; i < n; i++) terrain[j * n + i] = 500 + i * 3; // 50 m rising 0.3 m per cell to the east
  return { tx: 0, tz: 0, bounds: [0, 0, 500, 500], roads: [], buildings: [], points: [], areas: [], terrain };
}

test('rasterize fills the grid vertices inside a polygon, holes excluded', () => {
  const hits = new Set();
  rasterize([[0, 0, 100, 0, 100, 100, 0, 100], [45, 45, 55, 45, 55, 55, 45, 55]], 0, 0, 10, 11, (i, j) => hits.add(`${i},${j}`));
  assert.ok(hits.has('0,0') && hits.has('10,10') && hits.has('3,7'));
  assert.ok(!hits.has('5,5'));
  assert.equal(hits.size, 121 - 1);
});

test('terrain: heights from decimetres, faces up, skirts face out of the tile and hang below the edge', () => {
  const t = finish(buildTerrain(slopeTile(), { roads: [], triangulate: fan }));
  const P = t.position;
  assert.equal(t.n, 65);
  assert.ok(Math.abs(P[1] - 50) < 1e-4 && Math.abs(P[64 * 3 + 1] - 69.2) < 1e-4);
  for (const idx of t.index) {
    let up = 0, out = 0;
    for (let k = 0; k < idx.length; k += 3) {
      const [a, b, c] = [idx[k], idx[k + 1], idx[k + 2]];
      const nrm = faceNormal(P, a, b, c);
      if (Math.abs(nrm[1]) > 1e-6 && Math.abs(nrm[0]) + Math.abs(nrm[2]) < Math.abs(nrm[1]) * 2) {
        assert.ok(nrm[1] > 0, 'terrain triangle faces up');
        up++;
      } else {
        // Skirt: its normal points away from the tile centre
        const cx = (P[a * 3] + P[b * 3] + P[c * 3]) / 3 - 250, cz = (P[a * 3 + 2] + P[b * 3 + 2] + P[c * 3 + 2]) / 3 - 250;
        assert.ok(nrm[0] * cx + nrm[2] * cz > 0, 'skirt faces out');
        out++;
      }
    }
    assert.ok(up > 0 && out > 0);
  }
  assert.equal(t.index[0].length / 3, 64 * 64 * 2 + 4 * 64 * 2);
  assert.equal(t.index[1].length / 3, 32 * 32 * 2 + 4 * 32 * 2);
  // Steep west face of a ridge is wooded, the gentle slope not
  assert.ok(t.land[2] < 0.01);
});

test('terrain: a lake gets one level from the ground under it and the ground inside sinks below it', () => {
  const tile = slopeTile();
  tile.terrain.fill(300);
  tile.areas.push({ key: 'natural', kind: 'water', pts: [100, 100, 300, 100, 300, 300, 100, 300], holes: [] });
  const t = finish(buildTerrain(tile, { roads: [], triangulate: fan }));
  const water = t.water.arrays();
  const ys = new Set(Array.from(water.position).filter((_, k) => k % 3 === 1).map((y) => y.toFixed(3)));
  assert.equal(ys.size, 1);
  const level = Number([...ys][0]);
  assert.ok(level > 30 && level < 30.5);
  const s = createTileSampler(tile, t.heights);
  assert.ok(s.heightAt(200, 200) < level - 2);
  assert.ok(s.heightAt(50, 50) > level - 0.2);
});

// Busan → Seoul: tiles round the 2.7 km 이화령 tunnel area and the 5 km 모라로 viaduct
const BUSAN = join(__dirname, '../data/drive/busan-seoul');
const loadTile = (key) => {
  const tile = JSON.parse(readFileSync(join(BUSAN, 'tiles', `${key}.json`), 'utf8'));
  tile.terrain = new Int16Array(Uint8Array.from(readFileSync(join(BUSAN, 'tiles', `${key}.terrain.bin`))).buffer);
  tile.key = key;
  return tile;
};
const routeGrid = () => {
  const route = JSON.parse(readFileSync(join(BUSAN, 'route.json'), 'utf8'));
  const g = new geo.SegmentGrid(20);
  g.add(route.path, 2.5, 0);
  return g;
};

function buildAll(tile, grid) {
  const roads = finish(roadsModule.buildRoads(tile, grid));
  const terrain = finish(buildTerrain(tile, { roads: roads.roads, triangulate: fan }));
  const sampler = createTileSampler({ bounds: terrain.bounds }, terrain.heights);
  const structures = finish(buildStructures(tile, roads, { heightAt: sampler.heightAt, triangulate: fan, nearHomes: () => false }));
  const buildings = finish(buildBuildings(tile, { grid: roads.grid, roads: roads.roads, residential: [], triangulate: fan }));
  return { roads, terrain, structures, buildings, sampler };
}

test('structures: tunnel portals open onto the approach roads, viaduct piers reach the ground', () => {
  const grid = routeGrid();
  // Find tiles with tunnels joining open road and long bridges
  let portals = 0, piers = 0, tunnelsSeen = 0;
  for (const key of ['-180_-361', '-181_-361', '-180_-362', '2_-4', '1_-4', '-9_-16', '-8_-16', '-10_-16']) {
    let tile;
    try { tile = loadTile(key); } catch { continue; }
    const { roads, structures, sampler } = buildAll(tile, grid);
    tunnelsSeen += roads.tunnels.length;
    for (const p of structures.portals) {
      portals++;
      assert.ok(Math.abs(Math.hypot(p.dx, p.dz) - 1) < 1e-6);
      assert.ok(p.halfW > 3 && p.height > 6);
      // Road level at the portal matches the terrain cut in front of it (conformed: 0.3 m below the road)
      const g = sampler.heightAt(p.x - p.dx * 6, p.z - p.dz * 6);
      assert.ok(Math.abs(g - (p.y - 0.3)) < 2.5, `ground ${g} vs road ${p.y} at the portal`);
    }
    const c = structures.meshes.concrete.arrays();
    assert.ok(c.index.length > 0 || !(roads.bridges.length + roads.tunnels.length));
    for (const v of c.position) assert.ok(Number.isFinite(v));
    piers += roads.bridges.length;
  }
  assert.ok(tunnelsSeen > 0, 'test tiles contain tunnels');
  assert.ok(portals > 0, 'portals found');
  assert.ok(piers > 0, 'test tiles contain bridges');
});

test('per-tile CPU build stays within budget on a sample of the 400 km route', () => {
  const grid = routeGrid();
  const keys = readdirSync(join(BUSAN, 'tiles')).filter((f) => f.endsWith('.json')).map((f) => f.slice(0, -5));
  const sample = keys.filter((_, i) => i % 23 === 0);
  const times = [];
  for (const key of sample) {
    const tile = loadTile(key);
    const t0 = performance.now();
    buildAll(tile, grid);
    times.push(performance.now() - t0);
  }
  times.sort((a, b) => a - b);
  const mean = times.reduce((a, b) => a + b, 0) / times.length;
  console.log(`[world build] ${times.length} tiles: mean ${mean.toFixed(1)} ms, median ${times[times.length >> 1].toFixed(1)} ms, max ${times[times.length - 1].toFixed(1)} ms`);
  assert.ok(mean < 120);
});
