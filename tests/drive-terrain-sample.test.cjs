const assert = require('node:assert/strict');
const { readFileSync } = require('node:fs');
const { join } = require('node:path');
const test = require('node:test');
const { loadModule } = require('./helpers/module.cjs');

const { createTileSampler, createFarSampler } = loadModule(readFileSync(join(__dirname, '../js/drive/terrain-sample.js'), 'utf8'));
const close = (a, b, eps = 1e-9) => assert.ok(Math.abs(a - b) < eps, `${a} != ${b}`);

// 65 x 65 grid over the tile 1_-1 (x 500..1000, z -500..0) holding the plane h = 10 + 0.1 x - 0.05 z (decimetres)
function planeTile() {
  const n = 65;
  const step = 500 / (n - 1);
  const heights = new Int16Array(n * n);
  for (let iz = 0; iz < n; iz++) {
    for (let ix = 0; ix < n; ix++) heights[iz * n + ix] = Math.round((10 + 0.1 * (500 + ix * step) - 0.05 * (-500 + iz * step)) * 10);
  }
  return { tile: { tx: 1, tz: -1, bounds: [500, -500, 1000, 0] }, heights };
}

test('tile sampler: bilinear heights in metres from decimetres, rows from the tile minZ corner, x fastest', () => {
  const { tile, heights } = planeTile();
  const s = createTileSampler(tile, heights);
  const plane = (x, z) => 10 + 0.1 * x - 0.05 * z;
  for (const [x, z] of [[500, -500], [731.3, -123.4], [999.9, -0.1], [1000, 0]]) close(s.heightAt(x, z), plane(x, z), 0.06);
  close(s.heightAt(400, -600), plane(500, -500), 0.06); // clamped outside
  const n = s.normalAt(700, -250);
  const len = Math.hypot(0.1, 1, -0.05);
  close(n.x, -0.1 / len, 5e-3); close(n.y, 1 / len, 5e-3); close(n.z, 0.05 / len, 5e-3); // dm rounding
});

test('tile sampler: exact at grid nodes, linear along an edge between two nodes', () => {
  const heights = new Int16Array(65 * 65);
  heights[0] = 100; // 10 m at (0, 0)
  heights[1] = 200; // 20 m at (7.8125, 0)
  const s = createTileSampler({ bounds: [0, 0, 500, 500] }, heights);
  close(s.heightAt(0, 0), 10);
  close(s.heightAt(7.8125, 0), 20);
  close(s.heightAt(7.8125 / 4, 0), 12.5);
  close(s.heightAt(7.8125 / 2, 7.8125 / 2), 7.5);
});

test('far sampler uses minX / minZ / step / nx / nz', () => {
  const far = { minX: -400, minZ: 0, step: 200, nx: 3, nz: 2 };
  const heights = Int16Array.from([0, 10, 20, 30, 40, 50]); // rows z = 0, 200; columns x = -400, -200, 0
  const s = createFarSampler(far, heights);
  close(s.heightAt(-300, 100), 2); // centre of the first cell: mean of 0, 10, 30, 40 dm
  close(s.heightAt(0, 200), 5);
  close(s.heightAt(1e6, 1e6), 5);
  const n = s.normalAt(-100, 50);
  assert.ok(n.y > 0.99 && n.x < 0 && n.z < 0);
});
