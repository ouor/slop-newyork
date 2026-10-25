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
      ok: (body) => resolve({ ok: true, status: 200, json: async () => body }),
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
