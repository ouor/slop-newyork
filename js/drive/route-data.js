// js/drive/route-data.js
// Runtime access to a Korea Drive route built by tools/drive/build_route.py (contract: docs/drive.md):
// - loadRoute(baseUrl): fetches route.json and adds `cumulative` (distance at each path point) and
//   pointAt(distanceM) -> { x, z, heading, segment } for sampling the centreline by distance
// - TileStreamer: keeps the corridor tiles within `radius` of a moving point loaded (nearest first, at most two
//   fetches in flight) and drops the ones beyond radius + UNLOAD_MARGIN; failed fetches are retried after a delay

const UNLOAD_MARGIN = 200; // m of hysteresis between loading and unloading, so a tile on the edge doesn't flicker
const MAX_IN_FLIGHT = 2;
const RETRY_MS = 5000;

const withSlash = (url) => (url.endsWith('/') ? url : `${url}/`);

async function fetchJson(url) {
  const res = await fetch(url);
  if (!res.ok) throw new Error(`${url}: HTTP ${res.status}`);
  return res.json();
}

// Distance from (x, z) to the square tile (tx, tz) of side `size` (0 inside it)
function tileDistance(x, z, tx, tz, size) {
  const dx = Math.max(tx * size - x, 0, x - (tx + 1) * size);
  const dz = Math.max(tz * size - z, 0, z - (tz + 1) * size);
  return Math.hypot(dx, dz);
}

// =====================================================================================================================
// ROUTE
// =====================================================================================================================

export const loadRoute = async (baseUrl) => {
  const route = await fetchJson(`${withSlash(baseUrl)}route.json`);
  const path = route.path;
  const count = path.length / 2;
  const cumulative = new Float64Array(count);
  for (let i = 1; i < count; i++) {
    cumulative[i] = cumulative[i - 1] + Math.hypot(path[2 * i] - path[2 * i - 2], path[2 * i + 1] - path[2 * i - 1]);
  }
  route.cumulative = cumulative;
  route.pointAt = (distanceM) => pointAt(route, distanceM);
  return route;
};

// Largest index i in a sorted array with values[i] <= v (0 if v is below the first value)
function floorIndex(values, v, valueOf = (x) => x) {
  let lo = 0;
  let hi = values.length - 1;
  while (lo < hi) {
    const mid = (lo + hi + 1) >> 1;
    if (valueOf(values[mid]) <= v) lo = mid;
    else hi = mid - 1;
  }
  return lo;
}

// Position on the centreline `distanceM` metres from the start (clamped to the route). heading: 0 = -z (north),
// clockwise positive seen from above, so +x (east) is PI / 2.
function pointAt(route, distanceM) {
  const { path, cumulative, segments } = route;
  const last = cumulative.length - 1;
  const d = Math.min(Math.max(distanceM, 0), cumulative[last]);
  let i = Math.min(floorIndex(cumulative, d), last - 1);
  // Duplicate points give zero-length edges: step back to one with a direction (only possible at the very end)
  while (i > 0 && cumulative[i + 1] === cumulative[i]) i--;
  const ax = path[2 * i];
  const az = path[2 * i + 1];
  const dx = path[2 * i + 2] - ax;
  const dz = path[2 * i + 3] - az;
  const len = cumulative[i + 1] - cumulative[i];
  const t = len > 0 ? Math.min(Math.max((d - cumulative[i]) / len, 0), 1) : 0;
  return {
    x: ax + dx * t,
    z: az + dz * t,
    heading: Math.atan2(dx, -dz),
    segment: segments[floorIndex(segments, i, (s) => s.i0)]
  };
}

// =====================================================================================================================
// TILE STREAMING
// =====================================================================================================================

export class TileStreamer {
  constructor({ baseUrl, route, radius = 700, onLoad = () => {}, onUnload = () => {} }) {
    this.baseUrl = withSlash(baseUrl);
    this.radius = radius;
    this.onLoad = onLoad;
    this.onUnload = onUnload;
    this.size = route.tileSize;
    // Only corridor tiles exist on disk: never request anything else
    this.tiles = route.tiles.map((key) => {
      const [tx, tz] = key.split('_').map(Number);
      return { key, tx, tz };
    });
    this.loaded = new Map(); // key -> tile JSON
    this.pending = new Set(); // keys being fetched
    this.failedAt = new Map(); // key -> time of the last failed fetch
    this.x = 0;
    this.z = 0;
  }

  update(x, z) {
    this.x = x;
    this.z = z;
    const far = this.radius + UNLOAD_MARGIN;
    for (const { key, tx, tz } of this.tiles) {
      if (this.loaded.has(key) && tileDistance(x, z, tx, tz, this.size) > far) {
        this.loaded.delete(key);
        this.onUnload(key);
      }
    }
    this._pump();
  }

  _pump() {
    if (this.pending.size >= MAX_IN_FLIGHT) return;
    const now = Date.now();
    const wanted = [];
    for (const tile of this.tiles) {
      if (this.loaded.has(tile.key) || this.pending.has(tile.key)) continue;
      if (now - (this.failedAt.get(tile.key) ?? -Infinity) < RETRY_MS) continue;
      const distance = tileDistance(this.x, this.z, tile.tx, tile.tz, this.size);
      if (distance <= this.radius) wanted.push({ key: tile.key, distance });
    }
    wanted.sort((a, b) => a.distance - b.distance);
    for (const { key } of wanted.slice(0, MAX_IN_FLIGHT - this.pending.size)) this._fetch(key);
  }

  async _fetch(key) {
    this.pending.add(key);
    let tile = null;
    try {
      tile = await fetchJson(`${this.baseUrl}tiles/${key}.json`);
      this.failedAt.delete(key);
    } catch (error) {
      this.failedAt.set(key, Date.now());
      console.warn(`TileStreamer: ${key} failed (${error.message}), retrying in ${RETRY_MS / 1000} s`);
    }
    this.pending.delete(key);
    // The point may have moved on while the fetch was in flight
    if (tile && tileDistance(this.x, this.z, tile.tx, tile.tz, this.size) <= this.radius + UNLOAD_MARGIN) {
      tile.key = key;
      this.loaded.set(key, tile);
      this.onLoad(tile);
    }
    this._pump();
  }
}
