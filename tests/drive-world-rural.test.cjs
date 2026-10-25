const assert = require('node:assert/strict');
const { readFileSync } = require('node:fs');
const { join } = require('node:path');
const test = require('node:test');
const { loadModule } = require('./helpers/module.cjs');

const read = (name) => readFileSync(join(__dirname, '../js/drive', name), 'utf8');
const geo = loadModule(read('world-geometry.js'), { filename: 'world-geometry.js' });
const L = loadModule(read('world-rural-layout.js'), { imports: { './world-geometry.js': geo }, filename: 'world-rural-layout.js' });

// Tile 0_0 (x, z in 0..500) over a plane h = k·x (slope k), with optional areas / roads / buildings
const plane = (k) => ({
  heightAt: (x) => 50 + k * x,
  normalAt: () => { const l = Math.hypot(k, 1); return { x: -k / l, y: 1 / l, z: 0 }; }
});
const tileOf = (extra = {}) => ({ tx: 0, tz: 0, key: '0_0', bounds: [0, 0, 500, 500], roads: [], buildings: [], areas: [], points: [], ...extra });
const plain = (v) => JSON.parse(JSON.stringify(v)); // objects from the module's own realm
const square = (x0, z0, x1, z1) => [x0, z0, x1, z0, x1, z1, x0, z1];

// A straight route north → south along x = 250 (z from -2000 to 2000), 25 m steps
function straightRoute() {
  const path = [];
  for (let z = -2000; z <= 2000; z += 25) path.push(250, z);
  return {
    path, tileSize: 500, tiles: ['0_0', '0_-1', '0_1'],
    origin: { lat: 36, lon: 127.5 },
    segments: [{ i0: 0, i1: path.length / 2 - 1, highway: 'motorway', name: '경부고속도로', ref: '1', lanes: 2, tunnel: false }]
  };
}

test('rasterRings: even-odd fill of cell centres, holes left out', () => {
  const hits = new Set();
  L.rasterRings([square(0, 0, 40, 40), square(12, 12, 28, 28)], 0, 0, 4, 20, (iz, i0, i1) => { for (let i = i0; i <= i1; i++) hits.add(`${i},${iz}`); });
  assert.equal(hits.size, 100 - 16); // 10 × 10 cells, the 4 × 4 hole out
  assert.ok(hits.has('0,0') && hits.has('9,9') && hits.has('2,5'));
  assert.ok(!hits.has('4,4') && !hits.has('6,5') && !hits.has('10,0'));
});

test('mask: land classes by priority, road clearance with motorway verge, building distance, slope', () => {
  const tile = tileOf({
    areas: [
      { key: 'natural', kind: 'wood', pts: square(0, 0, 500, 500), holes: [] },
      { key: 'landuse', kind: 'farmland', pts: square(0, 0, 200, 200), holes: [] },
      { key: 'natural', kind: 'water', pts: square(100, 100, 150, 150), holes: [] }
    ],
    roads: [{ id: 1, highway: 'motorway', width: 7, pts: [400, 0, 400, 500] }],
    buildings: [{ id: 2, pts: square(300, 300, 310, 310) }]
  });
  const m = L.createRuralMask(tile, plane(0.3));
  const { LAND } = L;
  assert.equal(m.cls[m.at(300, 50)], LAND.FOREST);
  assert.equal(m.cls[m.at(50, 50)], LAND.FARM);
  assert.equal(m.cls[m.at(120, 120)], LAND.WATER);
  // 3.5 m half width + 8 m motorway verge
  assert.ok(Math.abs(m.road[m.at(414, 250)] - (14 - 3.5 - 8)) < 0.01); // cell centre x = 414
  assert.ok(m.road[m.at(401, 250)] < 0);
  assert.equal(m.road[m.at(100, 250)], 99);
  assert.equal(m.bld[m.at(305, 305)], 0);
  assert.ok(Math.abs(m.bld[m.at(330, 305)] - 20) <= 4);
  assert.ok(Math.abs(m.slope[m.at(250, 250)] - 0.3) < 1e-6);
  assert.equal(m.rural, true);
});

test('forest: dense on unmapped rural slopes, none on flat open land, clear of the carriageway; deterministic', () => {
  const road = { id: 1, highway: 'primary', width: 10, pts: [250, 0, 250, 500] };
  const steep = L.createRuralMask(tileOf({ roads: [road] }), plane(0.35));
  const a = L.forestSites(tileOf({ roads: [road] }), steep, 3);
  const b = L.forestSites(tileOf({ roads: [road] }), steep, 3);
  assert.deepEqual(a, b);
  assert.ok(a.length > 4000, `${a.length} trees`);
  for (const t of a) assert.ok(Math.abs(t.x - 250) > 5 + 3.5 - 0.01, `tree at ${t.x}`);
  assert.ok(a.some((t) => t.sp === 0) && a.some((t) => t.sp === 1));
  const flat = L.createRuralMask(tileOf(), plane(0));
  assert.equal(L.forestSites(tileOf(), flat, 3).length, 0);
});

test('farm parcels: inside the farmland, on the oriented grid, off the roads; paddies on flat ground', () => {
  const farm = { key: 'landuse', kind: 'farmland', pts: square(0, 0, 500, 300), holes: [] };
  const road = { id: 1, highway: 'unclassified', width: 6, pts: [0, 150, 500, 150] };
  const wood = { key: 'natural', kind: 'wood', pts: square(0, 300, 500, 500), holes: [] }; // unmapped flat land would farm too
  const tile = tileOf({ areas: [farm, wood], roads: [road] });
  const m = L.createRuralMask(tile, plane(0));
  const parcels = L.farmParcels(tile, m, 1);
  assert.ok(parcels.length > 40, `${parcels.length} parcels`);
  for (const p of parcels) {
    assert.ok(p.cz < 300, 'within the farmland');
    // rectangle (lu × lv, axis along the edge direction) never covers the road centreline
    const hv = p.lv / 2, dz = Math.abs(p.cz - 150);
    assert.ok(Math.abs(p.uz) > 0.01 || dz > hv, `parcel over the road at ${p.cx}, ${p.cz}`);
  }
  const types = new Set(parcels.map((p) => p.type));
  assert.ok(types.has('paddy'));
});

test('villages: houses fill residential land away from OSM footprints and roads', () => {
  const res = { key: 'landuse', kind: 'residential', pts: square(0, 0, 300, 300), holes: [] };
  const bld = { id: 9, pts: square(100, 100, 140, 140) };
  const road = { id: 1, highway: 'residential', width: 5, pts: [0, 200, 300, 200] };
  const tile = tileOf({ areas: [res], buildings: [bld], roads: [road] });
  const m = L.createRuralMask(tile, plane(0));
  const lots = L.villageLots(tile, m, 2);
  assert.ok(lots.length > 20, `${lots.length} houses`);
  for (const l of lots) {
    assert.equal(l.kind, 'house');
    assert.ok(!(l.x > 95 && l.x < 145 && l.z > 95 && l.z < 145), 'not on the mapped building');
    assert.ok(Math.abs(l.z - 200) > 2.5 + 3, 'not on the road');
    assert.ok(l.x < 310 && l.z < 310);
  }
});

test('power lines: the same towers whichever tile asks, ordered along each line', () => {
  const a = L.powerLines(0, 0, 500, 500, 7);
  const b = L.powerLines(500, 0, 1000, 500, 7);
  const key = (l) => l.towers.map((t) => `${l.id}:${t.k}:${t.x.toFixed(3)},${t.z.toFixed(3)}`);
  const ta = new Map(a.flatMap((l) => key(l).map((k) => [k.split(':').slice(0, 2).join(':'), k])));
  let shared = 0;
  for (const l of b) for (const k of key(l)) {
    const id = k.split(':').slice(0, 2).join(':');
    if (ta.has(id)) { assert.equal(ta.get(id), k); shared++; }
  }
  assert.ok(shared > 0);
  for (const l of a) for (let i = 1; i < l.towers.length; i++) assert.ok(l.towers[i].k > l.towers[i - 1].k);
  // avoid() moves or drops towers deterministically
  const none = L.powerLines(0, 0, 500, 500, 7, () => true);
  assert.equal(none.length, 0);
});

test('marksBetween: chainage marks crossed in either direction, with their fraction', () => {
  assert.deepEqual(plain(L.marksBetween(950, 1250, 100).map((m) => m.m)), [1000, 1100, 1200]);
  const back = L.marksBetween(1250, 950, 100);
  assert.deepEqual(plain(back.map((m) => m.m)), [1000, 1100, 1200]);
  assert.ok(Math.abs(back[0].t - 250 / 300) < 1e-9);
  assert.deepEqual(plain(L.marksBetween(0, 4000, 2000, 1200).map((m) => m.m)), [1200, 3200]);
  assert.equal(L.marksBetween(10, 10, 100).length, 0);
});

test('destinations: the next two cities ahead and the final one, rounded km', () => {
  const cities = [{ name: '부산', chainage: 0 }, { name: '대구', chainage: 100000 }, { name: '대전', chainage: 250000 }, { name: '천안', chainage: 320000 }, { name: '서울', chainage: 400000 }];
  assert.deepEqual(plain(L.destinations(cities, 50000, 1)), [{ name: '대구', km: 50 }, { name: '대전', km: 200 }, { name: '서울', km: 350 }]);
  assert.deepEqual(plain(L.destinations(cities, 330000, -1)), [{ name: '천안', km: 10 }, { name: '대전', km: 80 }, { name: '부산', km: 330 }]);
  assert.deepEqual(plain(L.destinations(cities, 399000, 1)), []);
});

test('highway plan: posts every 100 m of route chainage on the right, km markers, signs facing the traffic', () => {
  const route = straightRoute();
  const index = L.routeIndex(route);
  assert.equal(L.routeIndex(route), index); // cached
  // The route's carriageway through the tile, southbound like the route, 7 m wide
  const pts = [], ys = [];
  for (let z = 0; z <= 500; z += 25) { pts.push(250, z); ys.push(30); }
  const tile = tileOf({ roads: [{ id: 5, highway: 'motorway', width: 7, oneway: true, pts, ys, name: '경부고속도로' }] });
  const items = L.highwayPlan(tile, index);
  const posts = items.filter((i) => i.type === 'post' || i.type === 'km');
  // chainage at z is z + 2000: marks in [2000, 2500) → the km marker at z = 0, posts at 100 … 400
  assert.deepEqual(plain(posts.map((p) => Math.round(p.z))), [0, 100, 200, 300, 400]);
  assert.deepEqual(plain(posts.map((p) => p.label)), ['2', '2.1', '2.2', '2.3', '2.4']);
  // southbound (+z): right is -x
  for (const p of posts) assert.ok(p.x < 250 - 3.5, `post at x ${p.x}`);
  for (const p of items) assert.equal(p.y, 30);
  assert.ok(items.filter((i) => i.type === 'delineator').length >= 24);
  // A carriageway from chainage 2450 to 3100: the phone at 2500 and the km marker at 3000
  const pts2 = [], ys2 = [];
  for (let z = 450; z <= 1100; z += 25) { pts2.push(250, z); ys2.push(30); }
  const tile2 = tileOf({ tz: 1, bounds: [0, 500, 500, 1000], roads: [{ id: 6, highway: 'motorway', width: 7, oneway: true, pts: pts2, ys: ys2 }] });
  const it2 = L.highwayPlan(tile2, index);
  assert.ok(it2.some((i) => i.type === 'km' && i.label === '3'));
  assert.ok(it2.some((i) => i.type === 'phone'));
});
