// js/drive/route-data.js
// Runtime access to a Korea Drive route built by tools/drive/build_route.py (contract: docs/drive.md):
// - loadRoute(baseUrl): fetches route.json and adds `cumulative` (distance at each path point) and
//   pointAt(distanceM) -> { x, z, heading, segment } for sampling the centreline by distance; version 2 routes also
//   get `far` = { ...route.terrain.far, heights: Int16Array } (far.bin)
// - TileStreamer: keeps the corridor tiles around a moving point loaded and drops the ones it left behind. With the
//   car's route distance and speed it loads the tiles ahead along the route first, looking further ahead and keeping
//   more fetches in flight the faster it goes (60x playback on a motorway is ~1.8 km per real second). Version 2
//   tiles arrive with `tile.terrain` (Int16Array of <key>.terrain.bin). Failed fetches are retried after a delay.

const UNLOAD_MARGIN = 200; // m of hysteresis between loading and unloading, so a tile on the edge doesn't flicker
const MAX_IN_FLIGHT = 2; // tiles being fetched at standstill
const MAX_IN_FLIGHT_FAST = 8;
const IN_FLIGHT_PER_SPEED = 1 / 150; // one more tile in flight per 150 m/s
const LOOKAHEAD_S = 6; // route look-ahead in seconds of travel at the current speed
const RETRY_MS = 5000;
const CORRIDOR = 400; // m, build_route.py: tiles within this distance of the path exist

const withSlash = (url) => (url.endsWith('/') ? url : `${url}/`);

async function fetchOk(url) {
  const res = await fetch(url);
  if (!res.ok) throw new Error(`${url}: HTTP ${res.status}`);
  return res;
}

const fetchJson = async (url) => (await fetchOk(url)).json();
// Little-endian on disk; every platform a browser runs on is little-endian too
const fetchInt16 = async (url) => new Int16Array(await (await fetchOk(url)).arrayBuffer());

// Distance from (x, z) to the square tile (tx, tz) of side `size` (0 inside it)
function tileDistance(x, z, tx, tz, size) {
  const dx = Math.max(tx * size - x, 0, x - (tx + 1) * size);
  const dz = Math.max(tz * size - z, 0, z - (tz + 1) * size);
  return Math.hypot(dx, dz);
}

function cumulativeOf(path) {
  const count = path.length / 2;
  const cumulative = new Float64Array(count);
  for (let i = 1; i < count; i++) {
    cumulative[i] = cumulative[i - 1] + Math.hypot(path[2 * i] - path[2 * i - 2], path[2 * i + 1] - path[2 * i - 1]);
  }
  return cumulative;
}

// =====================================================================================================================
// ROUTE
// =====================================================================================================================

export const loadRoute = async (baseUrl) => {
  const base = withSlash(baseUrl);
  const route = await fetchJson(`${base}route.json`);
  route.cumulative = cumulativeOf(route.path);
  route.pointAt = (distanceM) => pointAt(route, distanceM);
  const far = route.terrain?.far;
  if (far) route.far = { ...far, heights: await fetchInt16(`${base}${far.url}`) };
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

// Route distance at which the path is closest to the middle of each tile: the midpoint of the stretch over which it
// passes within `reach` of the tile (missing when never)
function routeMids(route, tiles, reach) {
  const spans = new Map();
  if (!route.path) return spans;
  const { path, tileSize: size } = route;
  const cumulative = route.cumulative ?? cumulativeOf(path);
  const byKey = new Set(tiles.map((t) => t.key));
  const n = Math.ceil(reach / size);
  for (let i = 0; i < cumulative.length; i++) {
    const x = path[2 * i];
    const z = path[2 * i + 1];
    const cx = Math.floor(x / size);
    const cz = Math.floor(z / size);
    for (let tx = cx - n; tx <= cx + n; tx++) {
      for (let tz = cz - n; tz <= cz + n; tz++) {
        const key = `${tx}_${tz}`;
        if (!byKey.has(key) || tileDistance(x, z, tx, tz, size) > reach) continue;
        const span = spans.get(key);
        if (span) span.last = cumulative[i];
        else spans.set(key, { first: cumulative[i], last: cumulative[i] });
      }
    }
  }
  return new Map([...spans].map(([key, { first, last }]) => [key, (first + last) / 2]));
}

export class TileStreamer {
  constructor({ baseUrl, route, radius = 700, onLoad = () => {}, onUnload = () => {} }) {
    this.baseUrl = withSlash(baseUrl);
    this.radius = radius;
    this.onLoad = onLoad;
    this.onUnload = onUnload;
    this.size = route.tileSize;
    this.terrain = Boolean(route.terrain);
    // Only corridor tiles exist on disk: never request anything else
    this.tiles = route.tiles.map((key) => {
      const [tx, tz] = key.split('_').map(Number);
      return { key, tx, tz };
    });
    // Path points are at most ~25 m apart: a tile is "on the route" while the path passes within the corridor width
    const mids = routeMids(route, this.tiles, CORRIDOR);
    for (const tile of this.tiles) tile.along = mids.get(tile.key) ?? null;
    this.loaded = new Map(); // key -> tile JSON
    this.pending = new Set(); // keys being fetched
    this.failedAt = new Map(); // key -> time of the last failed fetch
    this.x = 0;
    this.z = 0;
    this.distance = null; // car's route distance (null: plain nearest-first streaming)
    this.lookAhead = 0;
    this.maxInFlight = MAX_IN_FLIGHT;
  }

  // (x, z): car position. Optional { distance (m along the route), speed (world m per real second, i.e. including
  // the playback time scale) } switches to route-ahead priority.
  update(x, z, { distance = null, speed = 0 } = {}) {
    this.x = x;
    this.z = z;
    this.distance = distance;
    this.lookAhead = distance === null ? 0 : this.radius + Math.max(speed, 0) * LOOKAHEAD_S;
    this.maxInFlight = Math.min(MAX_IN_FLIGHT_FAST, MAX_IN_FLIGHT + Math.floor(Math.max(speed, 0) * IN_FLIGHT_PER_SPEED));
    for (const tile of this.tiles) {
      if (this.loaded.has(tile.key) && !this._keep(tile)) {
        this.loaded.delete(tile.key);
        this.onUnload(tile.key);
      }
    }
    this._pump();
  }

  // Route distance from the car to (the middle of) the tile: > 0 ahead, < 0 behind (null without route info)
  _ahead(tile) {
    return this.distance === null || tile.along === null ? null : tile.along - this.distance;
  }

  // Not yet passed: ahead, or beside the car (within half a tile of route distance)
  _upcoming(ahead, lookAhead) {
    return ahead !== null && ahead >= -this.size / 2 && ahead <= lookAhead;
  }

  // Load priority (lower first) or Infinity when not wanted. Within `radius`: straight-line distance, with tiles
  // beside the car first and the ones already passed (unless within a quarter tile: a route can pass a tile twice) last;
  // beyond it: route distance, for tiles within the look-ahead.
  _priority(tile) {
    const near = tileDistance(this.x, this.z, tile.tx, tile.tz, this.size);
    const ahead = this._ahead(tile);
    if (ahead === null) return near <= this.radius ? near : Infinity;
    if (this._upcoming(ahead, this.lookAhead)) return near <= this.radius ? Math.min(near, Math.max(ahead, 0)) : ahead;
    if (near > this.radius) return Infinity;
    return near < this.size / 4 ? near : near + this.radius;
  }

  _keep(tile) {
    if (this._upcoming(this._ahead(tile), this.lookAhead + UNLOAD_MARGIN)) return true;
    return tileDistance(this.x, this.z, tile.tx, tile.tz, this.size) <= this.radius + UNLOAD_MARGIN;
  }

  _pump() {
    if (this.pending.size >= this.maxInFlight) return;
    const now = Date.now();
    const wanted = [];
    for (const tile of this.tiles) {
      if (this.loaded.has(tile.key) || this.pending.has(tile.key)) continue;
      if (now - (this.failedAt.get(tile.key) ?? -Infinity) < RETRY_MS) continue;
      const priority = this._priority(tile);
      if (priority < Infinity) wanted.push({ tile, priority });
    }
    wanted.sort((a, b) => a.priority - b.priority);
    for (const { tile } of wanted.slice(0, this.maxInFlight - this.pending.size)) this._fetch(tile);
  }

  async _fetch(entry) {
    const { key } = entry;
    this.pending.add(key);
    let tile = null;
    try {
      const url = `${this.baseUrl}tiles/${key}`;
      const [json, terrain] = await Promise.all([fetchJson(`${url}.json`), this.terrain ? fetchInt16(`${url}.terrain.bin`) : null]);
      tile = json;
      if (terrain) tile.terrain = terrain;
      this.failedAt.delete(key);
    } catch (error) {
      this.failedAt.set(key, Date.now());
      console.warn(`TileStreamer: ${key} failed (${error.message}), retrying in ${RETRY_MS / 1000} s`);
    }
    this.pending.delete(key);
    // The point may have moved on while the fetch was in flight
    if (tile && this._keep(entry)) {
      tile.key = key;
      this.loaded.set(key, tile);
      this.onLoad(tile);
    }
    this._pump();
  }
}
