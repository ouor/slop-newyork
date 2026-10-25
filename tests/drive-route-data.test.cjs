const assert = require('node:assert/strict');
const { readFileSync } = require('node:fs');
const { join } = require('node:path');
const test = require('node:test');
const { loadModule } = require('./helpers/module.cjs');

const source = readFileSync(join(__dirname, '../js/drive/route-data.js'), 'utf8');

// fetch stub: every request stays pending until the test resolves or rejects it
function harness() {
  const requests = [];
  const clock = { now: 0 };
  const warnings = [];
  const fetch = (url) => new Promise((resolve, reject) => {
    requests.push({
      url,
      ok: (body) => resolve({ ok: true, status: 200, json: async () => body, arrayBuffer: async () => body }),
      fail: (status = 404) => resolve({ ok: false, status, json: async () => ({}) }),
      error: () => reject(new Error('network down'))
    });
  });
  const module = loadModule(source, {
    globals: { fetch, Date: { now: () => clock.now }, console: { warn: (msg) => warnings.push(msg) } }
  });
  return { ...module, requests, clock, warnings };
}

const settle = () => new Promise((resolve) => setImmediate(resolve));
const close = (a, b) => assert.ok(Math.abs(a - b) < 1e-9, `${a} != ${b}`);

test('pointAt samples the path by distance, with heading 0 = north and clockwise positive', async () => {
  const h = harness();
  // north 100 m, east 100 m, then a duplicated end point
  const route = {
    path: [0, 0, 0, -100, 100, -100, 100, -100],
    segments: [{ i0: 0, i1: 1, name: 'a' }, { i0: 1, i1: 3, name: 'b' }],
    tiles: [],
    tileSize: 500
  };
  const loading = h.loadRoute('data/drive/x');
  assert.equal(h.requests[0].url, 'data/drive/x/route.json');
  h.requests[0].ok(route);
  const r = await loading;
  assert.deepEqual([...r.cumulative], [0, 100, 200, 200]);

  let p = r.pointAt(50);
  close(p.x, 0); close(p.z, -50); close(p.heading, 0); assert.equal(p.segment.name, 'a');
  p = r.pointAt(150);
  close(p.x, 50); close(p.z, -100); close(p.heading, Math.PI / 2); assert.equal(p.segment.name, 'b');
  p = r.pointAt(100); // a vertex belongs to the segment that starts there
  close(p.z, -100); assert.equal(p.segment.name, 'b');
  p = r.pointAt(-10);
  close(p.x, 0); close(p.z, 0); close(p.heading, 0);
  p = r.pointAt(1e9); // clamped to the end; the zero-length last edge still yields a heading
  close(p.x, 100); close(p.z, -100); close(p.heading, Math.PI / 2); assert.equal(p.segment.name, 'b');
});

test('loadRoute rejects on HTTP errors', async () => {
  const h = harness();
  const loading = h.loadRoute('data/drive/x/');
  h.requests[0].fail(404);
  await assert.rejects(loading, /HTTP 404/);
});

function streamer(h, opts = {}) {
  const events = [];
  const route = { tileSize: 500, tiles: ['0_0', '1_0', '2_0', '6_0'] };
  const s = new h.TileStreamer({
    baseUrl: 'base', route, radius: 800,
    onLoad: (tile) => events.push(`load ${tile.key}`), onUnload: (key) => events.push(`unload ${key}`), ...opts
  });
  const reply = (req) => {
    const [, tx, tz] = /(-?\d+)_(-?\d+)\.json$/.exec(req.url).map(Number);
    req.ok({ tx, tz, roads: [] });
  };
  return { s, events, reply };
}

test('TileStreamer loads nearest corridor tiles first, at most two in flight, without duplicates', async () => {
  const h = harness();
  const { s, events, reply } = streamer(h);
  s.update(1250, 250); // inside 2_0; 1_0 at 250 m, 0_0 at 750 m, 6_0 far away
  s.update(1250, 250);
  assert.deepEqual(h.requests.map((r) => r.url), ['base/tiles/2_0.json', 'base/tiles/1_0.json']);
  reply(h.requests[1]);
  await settle();
  assert.deepEqual(events, ['load 1_0']);
  assert.equal(h.requests.length, 3);
  assert.equal(h.requests[2].url, 'base/tiles/0_0.json');
  reply(h.requests[0]);
  reply(h.requests[2]);
  await settle();
  s.update(1250, 250);
  assert.equal(h.requests.length, 3);
  assert.deepEqual([...s.loaded.keys()].sort(), ['0_0', '1_0', '2_0']);
});

test('TileStreamer unloads beyond radius + 200 and drops tiles that arrive out of range', async () => {
  const h = harness();
  const { s, events, reply } = streamer(h);
  s.update(250, 250);
  reply(h.requests[0]); // 0_0
  await settle();
  s.update(1250 + 700, 250); // 0_0 now 1450 m away: unloaded; 1_0 (in flight) 450 m: kept
  assert.deepEqual(events, ['load 0_0', 'unload 0_0']);
  s.update(6000, 250); // 1_0 still in flight, now 5000 m away
  reply(h.requests[1]);
  await settle();
  assert.ok(!s.loaded.has('1_0'));
  assert.ok(!events.includes('load 1_0'));
});

test('TileStreamer retries failed fetches after a delay', async () => {
  const h = harness();
  const { s, reply } = streamer(h, { route: { tileSize: 500, tiles: ['0_0'] } });
  s.update(0, 0);
  h.requests[0].error();
  await settle();
  assert.equal(h.warnings.length, 1);
  s.update(0, 0);
  assert.equal(h.requests.length, 1);
  h.clock.now = 6000;
  s.update(0, 0);
  assert.equal(h.requests.length, 2);
  reply(h.requests[1]);
  await settle();
  assert.ok(s.loaded.has('0_0'));
});

test('loadRoute fetches far.bin of a version 2 route into route.far', async () => {
  const h = harness();
  const far = { url: 'far.bin', minX: -200, minZ: -200, step: 200, nx: 2, nz: 2 };
  const loading = h.loadRoute('data/drive/x');
  h.requests[0].ok({ version: 2, path: [0, 0, 0, -100], pathY: [5, 6], segments: [], tiles: [], tileSize: 500, terrain: { tileN: 65, far } });
  await settle();
  assert.equal(h.requests[1].url, 'data/drive/x/far.bin');
  h.requests[1].ok(Int16Array.from([10, 20, 30, 40]).buffer);
  const r = await loading;
  assert.equal(r.far.nx, 2);
  assert.equal(r.far.heights.constructor.name, 'Int16Array');
  assert.deepEqual([...r.far.heights], [10, 20, 30, 40]);
});

// A straight route east along z = 250 through tiles 0_0 .. 9_0, with a version 2 terrain block
function v2(h, opts = {}) {
  const events = [];
  const path = [];
  for (let x = 0; x <= 5000; x += 25) path.push(x, 250);
  const tiles = Array.from({ length: 10 }, (_, i) => `${i}_0`);
  const route = { tileSize: 500, tiles, path, terrain: { tileN: 65 } };
  const s = new h.TileStreamer({
    baseUrl: 'base', route, radius: 700,
    onLoad: (tile) => events.push(tile), onUnload: (key) => events.push(`unload ${key}`), ...opts
  });
  const replyAll = () => {
    for (const req of h.requests.splice(0)) {
      const m = /(-?\d+)_(-?\d+)\.(json|terrain\.bin)$/.exec(req.url);
      if (m[3] === 'json') req.ok({ tx: +m[1], tz: +m[2], roads: [] });
      else req.ok(new Int16Array(65 * 65).fill(+m[1]).buffer);
    }
  };
  return { s, events, replyAll };
}

test('TileStreamer delivers a version 2 tile only once both its JSON and terrain.bin arrived', async () => {
  const h = harness();
  const { s, events } = v2(h);
  s.update(250, 250);
  assert.deepEqual(h.requests.map((r) => r.url), ['base/tiles/0_0.json', 'base/tiles/0_0.terrain.bin', 'base/tiles/1_0.json', 'base/tiles/1_0.terrain.bin']);
  h.requests[0].ok({ tx: 0, tz: 0, roads: [] });
  await settle();
  assert.equal(events.length, 0);
  assert.ok(s.pending.has('0_0'));
  h.requests[1].ok(new Int16Array(65 * 65).fill(7).buffer);
  await settle();
  assert.equal(events.length, 1);
  assert.equal(events[0].key, '0_0');
  assert.equal(events[0].terrain.constructor.name, 'Int16Array');
  assert.equal(events[0].terrain.length, 65 * 65);
  assert.equal(events[0].terrain[100], 7);
  // a failed terrain.bin fails the whole tile (retried later)
  h.requests[3].fail(404);
  h.requests[2].ok({ tx: 1, tz: 0, roads: [] });
  await settle();
  assert.ok(!s.loaded.has('1_0'));
  assert.equal(h.warnings.length, 1);
});

test('TileStreamer with route distance and speed loads ahead along the route, more in flight when fast', async () => {
  const h = harness();
  const { s, events, replyAll } = v2(h);
  // standstill: two in flight, nearest first (the tile behind, as near as the one ahead, comes last)
  s.update(2250, 250, { distance: 2250, speed: 0 });
  assert.deepEqual(h.requests.filter((r) => r.url.endsWith('.json')).map((r) => r.url), ['base/tiles/4_0.json', 'base/tiles/5_0.json']);
  replyAll();
  await settle();
  assert.deepEqual(h.requests.filter((r) => r.url.endsWith('.json')).map((r) => r.url), ['base/tiles/3_0.json']);
  replyAll();
  await settle();
  // 600 m/s (e.g. 20x at 108 km/h): 6 in flight, a look-ahead of 700 + 3600 m along the route, nearest first
  s.update(2250, 250, { distance: 2250, speed: 600 });
  const keys = () => h.requests.filter((r) => r.url.endsWith('.json')).map((r) => /(\d+)_0/.exec(r.url)[1]);
  assert.deepEqual(keys(), ['6', '7', '8', '9']);
  replyAll();
  await settle();
  assert.ok(['6_0', '7_0', '8_0', '9_0'].every((k) => s.loaded.has(k)));
  // moving on fast: tiles behind are unloaded once beyond radius + 200, tiles ahead are kept
  s.update(4250, 250, { distance: 4250, speed: 600 });
  assert.deepEqual(events.filter((e) => typeof e === 'string'), ['unload 3_0', 'unload 4_0', 'unload 5_0']);
  assert.ok(s.loaded.has('6_0') && s.loaded.has('9_0'));
});

test('TileStreamer keeps far route tiles ahead and orders them by route distance, not straight-line distance', async () => {
  const h = harness();
  // a U-shaped route: east along z = 250 to x = 1750, south, then back west along z = 2250
  const path = [];
  for (let x = 0; x <= 1750; x += 25) path.push(x, 250);
  for (let z = 275; z <= 2250; z += 25) path.push(1750, z);
  for (let x = 1725; x >= 0; x -= 25) path.push(x, 2250);
  const route = { tileSize: 500, tiles: ['0_0', '1_0', '2_0', '3_0', '3_1', '3_2', '3_3', '3_4', '2_4', '1_4', '0_4'], path, terrain: { tileN: 65 } };
  const s = new h.TileStreamer({ baseUrl: 'base', route, radius: 300 });
  s.update(250, 250, { distance: 250, speed: 1800 }); // 60x motorway: 8 in flight
  const keys = h.requests.filter((r) => r.url.endsWith('.json')).map((r) => /tiles\/(.+)\.json/.exec(r.url)[1]);
  assert.equal(keys.length, 8);
  // 0_4 is 1.75 km away in a straight line but last along the route
  assert.deepEqual(keys, ['0_0', '1_0', '2_0', '3_0', '3_1', '3_2', '3_3', '3_4']);
});
