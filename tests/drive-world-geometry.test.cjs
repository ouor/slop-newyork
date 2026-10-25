const assert = require('node:assert/strict');
const { readFileSync, readdirSync } = require('node:fs');
const { join } = require('node:path');
const test = require('node:test');
const { loadModule } = require('./helpers/module.cjs');

const read = (name) => readFileSync(join(__dirname, '../js/drive', name), 'utf8');
const geo = loadModule(read('world-geometry.js'), { filename: 'world-geometry.js' });
const roadsModule = loadModule(read('world-roads.js'), { imports: { './world-geometry.js': geo }, filename: 'world-roads.js' });
const groundModule = loadModule(read('world-ground.js'), { imports: { './world-geometry.js': geo }, filename: 'world-ground.js' });

// Fan triangulation: enough for the convex test shapes (the app uses THREE.ShapeUtils / earcut)
const fan = (outer) => {
  const faces = [];
  for (let i = 1; i + 1 < outer.length / 2; i++) faces.push([0, i, i + 1]);
  return faces;
};
const finish = (gen) => { for (;;) { const r = gen.next(); if (r.done) return r.value; } };
const close = (a, b, eps = 1e-6) => assert.ok(Math.abs(a - b) < eps, `${a} != ${b}`);

test('ring helpers: area sign, containment with holes, segment distance', () => {
  const sq = [0, 0, 10, 0, 10, 10, 0, 10];
  close(geo.ringArea(sq), 100);
  close(geo.ringArea([0, 0, 0, 10, 10, 10, 10, 0]), -100);
  const hole = [4, 4, 6, 4, 6, 6, 4, 6];
  assert.equal(geo.pointInPolygon(sq, [hole], 2, 2), true);
  assert.equal(geo.pointInPolygon(sq, [hole], 5, 5), false);
  assert.equal(geo.pointInPolygon(sq, [], 11, 5), false);
  close(geo.distToSegment(5, 3, 0, 0, 10, 0), 3);
  close(geo.distToSegment(-4, 3, 0, 0, 10, 0), 5);
  const m = geo.footprintMetrics([0, 0, 40, 0, 40, 10, 0, 10]);
  close(m.area, 400);
  close(m.aspect, 4);
});

test('walls of a footprint face out of the solid (into courtyards for holes), with per-wall uv', () => {
  for (const ring of [[0, 0, 10, 0, 10, 10, 0, 10], [0, 0, 0, 10, 10, 10, 10, 0]]) {
    const mesh = new geo.MeshData({ uv: 2 });
    const lens = [];
    geo.addRingWalls(mesh, ring, false, 0, 9, (len) => lens.push(len));
    assert.deepEqual(lens, [10, 10, 10, 10]);
    const a = mesh.arrays();
    assert.equal(a.index.length, 4 * 6);
    // Every triangle's face normal points away from the centre (5, 5), and matches the stored vertex normal
    for (let t = 0; t < a.index.length; t += 3) {
      const [i, j, k] = [a.index[t], a.index[t + 1], a.index[t + 2]];
      const P = (n) => [a.position[n * 3], a.position[n * 3 + 1], a.position[n * 3 + 2]];
      const [p, q, r] = [P(i), P(j), P(k)];
      const u = [q[0] - p[0], q[1] - p[1], q[2] - p[2]], v = [r[0] - p[0], r[1] - p[1], r[2] - p[2]];
      const nx = u[1] * v[2] - u[2] * v[1], nz = u[0] * v[1] - u[1] * v[0];
      const cx = (p[0] + q[0] + r[0]) / 3 - 5, cz = (p[2] + q[2] + r[2]) / 3 - 5;
      assert.ok(nx * cx + nz * cz > 0, 'wall faces outwards');
      assert.ok(a.normal[i * 3] * cx + a.normal[i * 3 + 2] * cz > 0, 'vertex normal outwards');
    }
    assert.equal(Math.max(...a.uv.filter((_, n) => n % 2 === 1)), 9);
    // A courtyard wall faces into the hole
    const inner = new geo.MeshData();
    geo.addRingWalls(inner, ring, true, 0, 3);
    const b = inner.arrays();
    assert.ok(b.normal[0] * (b.position[0] - 5) + b.normal[2] * (b.position[2] - 5) < 0);
  }
});

test('flat polygons and boxes face up', () => {
  const mesh = new geo.MeshData();
  geo.addFlatPolygon(mesh, [0, 0, 0, 10, 10, 10, 10, 0], [], 2, fan);
  mesh.box(0, 0, 0, 2, 3, 4, 0.7);
  const a = mesh.arrays();
  for (let t = 0; t < 6; t += 3) {
    const [i, j, k] = [a.index[t], a.index[t + 1], a.index[t + 2]];
    const ux = a.position[j * 3] - a.position[i * 3], uz = a.position[j * 3 + 2] - a.position[i * 3 + 2];
    const vx = a.position[k * 3] - a.position[i * 3], vz = a.position[k * 3 + 2] - a.position[i * 3 + 2];
    assert.ok(uz * vx - ux * vz > 0, 'polygon triangle faces +y');
  }
  const ys = a.position.filter((_, n) => n % 3 === 1);
  assert.equal(Math.max(...ys), 3);
});

test('polyline resampling keeps vertices, spaces samples and mitres the corner', () => {
  const S = geo.resamplePolyline([0, 0, 10, 0, 10, 10], 4);
  assert.equal(S.length, 7); // 3 per edge + the end
  close(S[3].x, 10); close(S[3].z, 0); close(S[3].s, 10);
  close(S[6].s, 20);
  close(S[0].rx, 0); close(S[0].rz, 1); // right of +x travel is +z (south)
  close(S[3].miter, Math.SQRT2, 1e-9);
  const w = geo.walkPolyline([0, 0, 10, 0, 10, 10], 0, 1, 15);
  close(w.x, 10); close(w.z, 5);
  assert.equal(geo.walkPolyline([0, 0, 10, 0], 0, 1, 50), null);
});

test('segment grid answers carriageway coverage and nearest-centreline distance', () => {
  const g = new geo.SegmentGrid(20);
  g.add([0, 0, 100, 0], 6, 'a');
  g.add([50, -50, 50, 50], 3, 'b');
  assert.equal(g.covering(10, 5, 0).ref, 'a');
  assert.equal(g.covering(10, 7, 0), null);
  assert.equal(g.covering(50, 20, 0).ref, 'b');
  assert.equal(g.covering(50, 2, 0, (r) => r === 'a').ref, 'b');
  close(g.nearest(30, 30, 40), 20);
  close(g.nearest(30, 30, 40, (r) => r === 'a'), 30);
});

test('building estimates are deterministic per id and respect tagged heights and levels', () => {
  const box = (w, d) => [0, 0, w, 0, w, d, 0, d];
  const b = { id: 123456, pts: box(20, 12), type: 'yes', levels: null, height: null };
  const a1 = geo.estimateBuilding(b, { nearMajor: 200 });
  const a2 = geo.estimateBuilding({ ...b }, { nearMajor: 200 });
  assert.deepEqual({ ...a1, metrics: null }, { ...a2, metrics: null });
  // Variety across ids
  const heights = new Set();
  for (let id = 1; id < 60; id++) heights.add(geo.estimateBuilding({ ...b, id }, {}).height.toFixed(2));
  assert.ok(heights.size > 10);
  // Tags
  const tall = geo.estimateBuilding({ ...b, height: 47.5 }, {});
  close(tall.height, 47.5);
  for (let id = 1; id < 40; id++) {
    const l = geo.estimateBuilding({ ...b, id, levels: 7 }, {});
    assert.equal(l.floors, 7);
    assert.ok(l.height >= 21 - 1e-9 && l.height <= 7 * 3.3 + 1e-9, `levels height ${l.height}`);
  }
  // Rules: apartments are tall slabs, houses low, schools their own style
  const apt = geo.estimateBuilding({ ...b, id: 9, pts: box(60, 14), type: 'apartments' }, {});
  assert.equal(apt.style, geo.STYLE.apartment);
  assert.ok(apt.floors >= 15 && apt.floors <= 25);
  const house = geo.estimateBuilding({ ...b, id: 9, pts: box(10, 8), type: 'house' }, {});
  assert.ok(house.floors >= 2 && house.floors <= 3);
  assert.equal(geo.estimateBuilding({ ...b, type: 'school' }, {}).style, geo.STYLE.school);
  // Untyped slab in a residential area reads as an 아파트; near a main road a mid-size block is a 상가
  assert.equal(geo.estimateBuilding({ ...b, pts: box(70, 15) }, { residential: true, nearMajor: 200 }).style, geo.STYLE.apartment);
  assert.equal(geo.estimateBuilding({ ...b, pts: box(20, 15) }, { nearMajor: 10 }).style, geo.STYLE.shop);
});

test('every route tile builds roads & ground, and the asphalt covers the whole route centreline', () => {
  const dir = join(__dirname, '../data/drive/seoul-station-gangnam');
  const route = JSON.parse(readFileSync(join(dir, 'route.json'), 'utf8'));
  const routeGrid = new geo.SegmentGrid(20);
  routeGrid.add(route.path, 2.5, 0);
  const grids = new Map();
  for (const file of readdirSync(join(dir, 'tiles')).filter((f) => f.endsWith('.json'))) { // skip <key>.terrain.bin
    const tile = JSON.parse(readFileSync(join(dir, 'tiles', file), 'utf8'));
    const roads = finish(roadsModule.buildRoads(tile, routeGrid));
    grids.set(`${tile.tx}_${tile.tz}`, roads.grid);
    const { position, index } = roads.meshes.road.arrays();
    for (const v of position) assert.ok(Number.isFinite(v));
    for (const i of index) assert.ok(i < position.length / 3);
    const ground = finish(groundModule.buildGround(tile, fan));
    assert.ok(!ground.ground.empty);
  }
  // Route vertices more than a metre inside their tile lie on a drawn road (none hidden under another deck)
  let missing = 0;
  for (let i = 0; i < route.path.length; i += 2) {
    const x = route.path[i], z = route.path[i + 1];
    const tx = Math.floor(x / 500), tz = Math.floor(z / 500);
    if (Math.min(x - tx * 500, z - tz * 500, (tx + 1) * 500 - x, (tz + 1) * 500 - z) < 1) continue;
    if (!grids.get(`${tx}_${tz}`)?.covering(x, z, 0.5)) missing++;
  }
  assert.equal(missing, 0);
});
