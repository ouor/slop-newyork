// js/drive/world-geometry.js
// Pure geometry & rule helpers for the Korea Drive world builder (no three.js, unit-tested in
// tests/drive-world-geometry.test.cjs): seeded PRNG, ring maths, a growable typed-array mesh writer, polyline
// resampling with miter offsets, a segment grid for "is this point on a carriageway" queries, footprint extrusion and
// the seeded height / style rules that fill in what OpenStreetMap does not say about a Seoul building.

// Seeded PRNG (mulberry32), as in js/buildings.js
function mulberry32(seed) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

// Integer hash of an OSM id (negative ids are relations) mixed with a salt
function hashId(id, salt = 0) {
  let h = (Math.imul((id | 0) ^ 0x9e3779b9, 0x85ebca6b) ^ Math.imul(Math.floor(id / 4294967296) + salt, 0xc2b2ae35)) >>> 0;
  h = Math.imul(h ^ (h >>> 16), 0x7feb352d) >>> 0;
  return (h ^ (h >>> 15)) >>> 0;
}

// ---------------------------------------------------------------------------------------------------------------------
// Rings: flat [x0, z0, x1, z1, …], not closed (the first point is not repeated)
// ---------------------------------------------------------------------------------------------------------------------

// Shoelace sum in (x, z): positive when the ring runs from +x towards +z (clockwise on a north-up map)
function ringArea(pts) {
  let a = 0;
  const n = pts.length >> 1;
  for (let i = 0, j = n - 1; i < n; j = i++) a += pts[j * 2] * pts[i * 2 + 1] - pts[i * 2] * pts[j * 2 + 1];
  return a * 0.5;
}

function pointInRing(pts, x, z) {
  let inside = false;
  const n = pts.length >> 1;
  for (let i = 0, j = n - 1; i < n; j = i++) {
    const xi = pts[i * 2], zi = pts[i * 2 + 1], xj = pts[j * 2], zj = pts[j * 2 + 1];
    if ((zi > z) !== (zj > z) && x < ((xj - xi) * (z - zi)) / (zj - zi) + xi) inside = !inside;
  }
  return inside;
}

function pointInPolygon(outer, holes, x, z) {
  if (!pointInRing(outer, x, z)) return false;
  for (const h of holes || []) if (pointInRing(h, x, z)) return false;
  return true;
}

function distToSegment(px, pz, ax, az, bx, bz) {
  const dx = bx - ax, dz = bz - az;
  const l2 = dx * dx + dz * dz;
  const t = l2 > 0 ? Math.max(0, Math.min(1, ((px - ax) * dx + (pz - az) * dz) / l2)) : 0;
  return Math.hypot(px - ax - dx * t, pz - az - dz * t);
}

function ringBounds(pts) {
  let minX = Infinity, minZ = Infinity, maxX = -Infinity, maxZ = -Infinity;
  for (let i = 0; i < pts.length; i += 2) {
    if (pts[i] < minX) minX = pts[i];
    if (pts[i] > maxX) maxX = pts[i];
    if (pts[i + 1] < minZ) minZ = pts[i + 1];
    if (pts[i + 1] > maxZ) maxZ = pts[i + 1];
  }
  return { minX, minZ, maxX, maxZ };
}

// Footprint metrics: area, centroid and the extents along / across the longest edge (oriented box aspect)
function footprintMetrics(pts) {
  const area = Math.abs(ringArea(pts));
  const n = pts.length >> 1;
  let cx = 0, cz = 0, best = 0, ux = 1, uz = 0;
  for (let i = 0; i < n; i++) {
    cx += pts[i * 2];
    cz += pts[i * 2 + 1];
    const j = (i + 1) % n;
    const dx = pts[j * 2] - pts[i * 2], dz = pts[j * 2 + 1] - pts[i * 2 + 1];
    const l = Math.hypot(dx, dz);
    if (l > best) { best = l; ux = dx / l; uz = dz / l; }
  }
  cx /= n;
  cz /= n;
  let a0 = Infinity, a1 = -Infinity, b0 = Infinity, b1 = -Infinity;
  for (let i = 0; i < n; i++) {
    const x = pts[i * 2] - cx, z = pts[i * 2 + 1] - cz;
    const a = x * ux + z * uz, b = -x * uz + z * ux;
    a0 = Math.min(a0, a); a1 = Math.max(a1, a); b0 = Math.min(b0, b); b1 = Math.max(b1, b);
  }
  const long = Math.max(a1 - a0, b1 - b0);
  const short = Math.max(0.5, Math.min(a1 - a0, b1 - b0));
  return { area, cx, cz, long, short, aspect: long / short, ux, uz };
}

// ---------------------------------------------------------------------------------------------------------------------
// MeshData: position + normal, plus named attributes copied from a "current value" for every vertex written
// (set them once per building / road, then emit vertices), and a 32-bit index list. Typed arrays that grow.
// ---------------------------------------------------------------------------------------------------------------------
class FloatList {
  constructor(n = 1024) { this.a = new Float32Array(n); this.n = 0; }
  reserve(k) {
    if (this.n + k <= this.a.length) return;
    const b = new Float32Array(Math.max(this.a.length * 2, this.n + k));
    b.set(this.a.subarray(0, this.n));
    this.a = b;
  }
  view() { return this.a.slice(0, this.n); }
}

class MeshData {
  constructor(extra = {}) {
    this.pos = new FloatList(3072);
    this.nrm = new FloatList(3072);
    this.idx = [];
    this.count = 0;
    this.extra = Object.entries(extra).map(([name, size]) => ({ name, size, list: new FloatList(size * 1024), cur: new Float32Array(size) }));
    this.cur = Object.fromEntries(this.extra.map((e) => [e.name, e.cur]));
  }
  set(name, ...v) { this.cur[name].set(v); return this; }
  vert(x, y, z, nx, ny, nz) {
    const p = this.pos, q = this.nrm;
    p.reserve(3); q.reserve(3);
    p.a[p.n++] = x; p.a[p.n++] = y; p.a[p.n++] = z;
    q.a[q.n++] = nx; q.a[q.n++] = ny; q.a[q.n++] = nz;
    for (const e of this.extra) {
      e.list.reserve(e.size);
      e.list.a.set(e.cur, e.list.n);
      e.list.n += e.size;
    }
    return this.count++;
  }
  // Triangle a, b, c turned so its face normal points along (nx, ny, nz)
  tri(a, b, c, nx, ny, nz) {
    const P = this.pos.a;
    const ux = P[b * 3] - P[a * 3], uy = P[b * 3 + 1] - P[a * 3 + 1], uz = P[b * 3 + 2] - P[a * 3 + 2];
    const vx = P[c * 3] - P[a * 3], vy = P[c * 3 + 1] - P[a * 3 + 1], vz = P[c * 3 + 2] - P[a * 3 + 2];
    const d = (uy * vz - uz * vy) * nx + (uz * vx - ux * vz) * ny + (ux * vy - uy * vx) * nz;
    if (d >= 0) this.idx.push(a, b, c);
    else this.idx.push(a, c, b);
  }
  // Quad of four vertices (in order round its edge) facing (nx, ny, nz); u/v per corner go to `uv` if present
  quad(p, nx, ny, nz, uvs) {
    const i = [];
    for (let k = 0; k < 4; k++) {
      if (uvs) this.cur.uv.set(uvs[k]);
      i.push(this.vert(p[k][0], p[k][1], p[k][2], nx, ny, nz));
    }
    this.tri(i[0], i[1], i[2], nx, ny, nz);
    this.tri(i[0], i[2], i[3], nx, ny, nz);
  }
  // Axis-free box: centre (cx, cz), bottom y0, size w (along yaw's x) × h × d, turned by yaw about +y; no bottom face
  box(cx, y0, cz, w, h, d, yaw = 0) {
    const c = Math.cos(yaw), s = Math.sin(yaw);
    const P = (lx, y, lz) => [cx + lx * c + lz * s, y, cz - lx * s + lz * c];
    const hw = w / 2, hd = d / 2, y1 = y0 + h;
    const faces = [
      [[hw, -hd], [hw, hd], 1, 0], [[-hw, hd], [-hw, -hd], -1, 0],
      [[hw, hd], [-hw, hd], 0, 1], [[-hw, -hd], [hw, -hd], 0, -1]
    ];
    for (const [a, b, nx, nz] of faces) {
      const wx = nx * c + nz * s, wz = -nx * s + nz * c;
      this.quad([P(a[0], y0, a[1]), P(b[0], y0, b[1]), P(b[0], y1, b[1]), P(a[0], y1, a[1])], wx, 0, wz);
    }
    this.quad([P(-hw, y1, -hd), P(hw, y1, -hd), P(hw, y1, hd), P(-hw, y1, hd)], 0, 1, 0);
  }
  // Upright prism with `seg` sides (poles, tanks), with a top cap
  cylinder(x, y0, z, r, h, seg = 6) {
    const y1 = y0 + h;
    for (let k = 0; k < seg; k++) {
      const a0 = (k / seg) * Math.PI * 2, a1 = ((k + 1) / seg) * Math.PI * 2, am = (a0 + a1) / 2;
      const p0 = [x + Math.cos(a0) * r, z + Math.sin(a0) * r], p1 = [x + Math.cos(a1) * r, z + Math.sin(a1) * r];
      this.quad([[p0[0], y0, p0[1]], [p1[0], y0, p1[1]], [p1[0], y1, p1[1]], [p0[0], y1, p0[1]]], Math.cos(am), 0, Math.sin(am));
    }
    const c = this.vert(x, y1, z, 0, 1, 0);
    const ring = [];
    for (let k = 0; k < seg; k++) ring.push(this.vert(x + Math.cos((k / seg) * Math.PI * 2) * r, y1, z + Math.sin((k / seg) * Math.PI * 2) * r, 0, 1, 0));
    for (let k = 0; k < seg; k++) this.tri(c, ring[k], ring[(k + 1) % seg], 0, 1, 0);
  }
  get empty() { return this.idx.length === 0; }
  // Plain typed arrays, ready for a BufferGeometry: { position, normal, index, <extra names> }
  arrays() {
    const out = { position: this.pos.view(), normal: this.nrm.view(), index: new Uint32Array(this.idx) };
    for (const e of this.extra) out[e.name] = e.list.view();
    return out;
  }
}

// Flat polygon (outer + holes, rings as flat arrays) at height y, triangulated by `triangulate(outer, holes)` →
// [[a, b, c], …] over the concatenated points (THREE.ShapeUtils.triangulateShape in the app), facing up
function addFlatPolygon(mesh, outer, holes, y, triangulate) {
  const all = [outer, ...(holes || [])];
  const base = mesh.count;
  const hasUV = !!mesh.cur.uv;
  for (const ring of all) {
    for (let i = 0; i < ring.length; i += 2) {
      if (hasUV) mesh.cur.uv.set([ring[i], ring[i + 1]]);
      mesh.vert(ring[i], y, ring[i + 1], 0, 1, 0);
    }
  }
  const faces = triangulate(outer, holes || []);
  for (const f of faces) mesh.tri(base + f[0], base + f[1], base + f[2], 0, 1, 0);
  return faces.length;
}

// Walls of a footprint ring from y0 to y1, facing out of the solid (into the courtyard for holes). uv = (metres from
// the wall's own start corner, metres above the building's base y0); onWall(len) runs before each wall is written so
// the caller can set per-wall attributes. Edges shorter than 5 cm are skipped.
function addRingWalls(mesh, ring, isHole, y0, y1, onWall, v0 = 0) {
  const n = ring.length >> 1;
  const sign = Math.sign(ringArea(ring)) * (isHole ? -1 : 1);
  for (let i = 0; i < n; i++) {
    const j = (i + 1) % n;
    const ax = ring[i * 2], az = ring[i * 2 + 1], bx = ring[j * 2], bz = ring[j * 2 + 1];
    const len = Math.hypot(bx - ax, bz - az);
    if (len < 0.05) continue;
    const nx = ((bz - az) / len) * sign, nz = (-(bx - ax) / len) * sign;
    if (onWall) onWall(len, i);
    const v1 = v0 + y1 - y0;
    mesh.quad([[ax, y0, az], [bx, y0, bz], [bx, y1, bz], [ax, y1, az]], nx, 0, nz, mesh.cur.uv ? [[0, v0], [len, v0], [len, v1], [0, v1]] : null);
  }
}

// ---------------------------------------------------------------------------------------------------------------------
// Polylines
// ---------------------------------------------------------------------------------------------------------------------

// Resamples a polyline (flat [x, z, …]) at most `step` m apart, keeping every original vertex. Each sample:
// { x, z, s (metres from the start), dx, dz (unit direction), rx, rz (unit right = (-dz, dx)), miter (offset scale) }.
// Miter joins at vertices, the scale capped at 2 so hairpins don't spike. With `ys` (elevation per point, phase 2 tile
// roads) every sample also gets `y`, linear between points (0 without).
function resamplePolyline(pts, step, ys = null) {
  const n = pts.length >> 1;
  const out = [];
  if (n < 2) return out;
  let s = 0;
  for (let i = 0; i < n - 1; i++) {
    const ax = pts[i * 2], az = pts[i * 2 + 1], bx = pts[i * 2 + 2], bz = pts[i * 2 + 3];
    const len = Math.hypot(bx - ax, bz - az);
    if (len < 1e-6) continue;
    const k = Math.max(1, Math.ceil(len / step));
    const ya = ys ? ys[i] : 0, yb = ys ? ys[i + 1] : 0;
    for (let j = 0; j < k; j++) out.push({ x: ax + ((bx - ax) * j) / k, y: ya + ((yb - ya) * j) / k, z: az + ((bz - az) * j) / k, s: s + (len * j) / k, dx: (bx - ax) / len, dz: (bz - az) / len, vertex: j === 0 ? i : -1 });
    s += len;
  }
  if (!out.length) return out;
  const last = out[out.length - 1];
  out.push({ x: pts[n * 2 - 2], y: ys ? ys[n - 1] : 0, z: pts[n * 2 - 1], s, dx: last.dx, dz: last.dz, vertex: n - 1 });
  // Join directions at vertices: average of the incoming and outgoing edge, offset scaled by 1 / cos(half angle)
  for (let i = 0; i < out.length; i++) {
    const p = out[i];
    let mx = p.dx, mz = p.dz, miter = 1;
    if (i > 0 && p.vertex >= 0) {
      const q = out[i - 1];
      mx = p.dx + q.dx;
      mz = p.dz + q.dz;
      const l = Math.hypot(mx, mz);
      if (l > 1e-6) {
        mx /= l;
        mz /= l;
        miter = Math.min(2, 1 / Math.max(0.5, mx * p.dx + mz * p.dz));
      } else {
        mx = p.dx;
        mz = p.dz;
      }
    }
    p.rx = -mz;
    p.rz = mx;
    p.miter = miter;
  }
  return out;
}

// Point `dist` metres along a polyline from vertex i, walking forward (dir = 1) or back (dir = -1); null past its end.
// `y` is interpolated from `ys` when given (0 without).
function walkPolyline(pts, i, dir, dist, ys = null) {
  const n = pts.length >> 1;
  let x = pts[i * 2], z = pts[i * 2 + 1], y = ys ? ys[i] : 0;
  for (let j = i + dir; j >= 0 && j < n; j += dir) {
    const nx = pts[j * 2], nz = pts[j * 2 + 1], ny = ys ? ys[j] : 0;
    const len = Math.hypot(nx - x, nz - z);
    if (len >= dist && len > 1e-6) {
      const t = dist / len;
      return { x: x + (nx - x) * t, y: y + (ny - y) * t, z: z + (nz - z) * t, dx: (nx - x) / len, dz: (nz - z) / len };
    }
    dist -= len;
    x = nx;
    z = nz;
    y = ny;
  }
  return null;
}

// ---------------------------------------------------------------------------------------------------------------------
// SegmentGrid: road centreline segments bucketed in square cells, for "how far is the nearest carriageway"
// ---------------------------------------------------------------------------------------------------------------------
class SegmentGrid {
  constructor(cell = 20) { this.cell = cell; this.map = new Map(); }
  key(ix, iz) { return ix * 73856093 ^ iz * 19349663; }
  // Adds every segment of polyline pts with half-width `half`; `ref` is handed back by queries
  add(pts, half, ref) {
    const c = this.cell;
    for (let i = 0; i + 3 < pts.length; i += 2) {
      const ax = pts[i], az = pts[i + 1], bx = pts[i + 2], bz = pts[i + 3];
      const seg = { ax, az, bx, bz, half, ref };
      const x0 = Math.floor((Math.min(ax, bx) - half) / c), x1 = Math.floor((Math.max(ax, bx) + half) / c);
      const z0 = Math.floor((Math.min(az, bz) - half) / c), z1 = Math.floor((Math.max(az, bz) + half) / c);
      for (let ix = x0; ix <= x1; ix++) {
        for (let iz = z0; iz <= z1; iz++) {
          const k = this.key(ix, iz);
          let list = this.map.get(k);
          if (!list) this.map.set(k, (list = []));
          list.push(seg);
        }
      }
    }
  }
  // The first segment (other than those whose ref passes `skip`) whose carriageway (half-width + margin) covers (x, z)
  covering(x, z, margin = 0, skip = null) {
    const list = this.map.get(this.key(Math.floor(x / this.cell), Math.floor(z / this.cell)));
    if (!list) return null;
    for (const s of list) {
      if (skip && skip(s.ref)) continue;
      if (distToSegment(x, z, s.ax, s.az, s.bx, s.bz) < s.half + margin) return s;
    }
    return null;
  }
  // Distance from (x, z) to the nearest centreline whose ref passes `accept`, searched up to `radius` m
  nearest(x, z, radius, accept = null) {
    const c = this.cell;
    let best = Infinity;
    const seen = new Set();
    for (let ix = Math.floor((x - radius) / c); ix <= Math.floor((x + radius) / c); ix++) {
      for (let iz = Math.floor((z - radius) / c); iz <= Math.floor((z + radius) / c); iz++) {
        for (const s of this.map.get(this.key(ix, iz)) || []) {
          if (seen.has(s) || (accept && !accept(s.ref))) continue;
          seen.add(s);
          best = Math.min(best, distToSegment(x, z, s.ax, s.az, s.bx, s.bz));
        }
      }
    }
    return best;
  }
}

// ---------------------------------------------------------------------------------------------------------------------
// Building rules
// ---------------------------------------------------------------------------------------------------------------------

// Facade styles (the `bstyle.x` attribute read by the wall shader in world-materials.js)
const STYLE = { apartment: 0, villa: 1, shop: 2, office: 3, school: 4, plain: 5 };

const SHOP_USES = new Set(['restaurant', 'cafe', 'retail', 'bank', 'pub', 'fast_food', 'bar', 'pharmacy', 'clinic', 'dentist',
  'marketplace', 'supermarket', 'convenience', 'fuel', 'cinema', 'karaoke', 'shop']);
const PUBLIC_USES = new Set(['library', 'police', 'townhall', 'courthouse', 'post_office', 'community_centre', 'social_facility',
  'fire_station', 'childcare', 'toilets', 'shelter', 'parking', 'hospital', 'school']);

/**
 * Height, storeys and facade style of an OSM building, seeded by its id so it always comes out the same.
 * ctx: { nearMajor (m to the nearest primary/secondary/trunk centreline), residential (inside landuse=residential) }.
 * Returns { height, floors, floorH, style, base, seed }.
 */
function estimateBuilding(b, ctx = {}) {
  const rng = mulberry32(hashId(b.id, 17));
  const R = (lo, hi) => lo + (hi - lo) * rng();
  const I = (lo, hi) => Math.floor(R(lo, hi + 0.999));
  const m = footprintMetrics(b.pts);
  const type = String(b.type || 'yes').split(';').pop();
  const use = b.use || null;
  const near = ctx.nearMajor ?? Infinity;
  const resi = !!ctx.residential;
  const seed = rng();
  let style = STYLE.villa;
  let floors = 3;
  let floorH = R(3.0, 3.3);
  let base = b.minHeight || 0;

  if (type === 'apartments' || type === 'dormitory') {
    if (m.area >= 350 || (m.aspect >= 2.2 && m.area >= 250)) { style = STYLE.apartment; floors = I(15, 25); }
    else { style = STYLE.villa; floors = I(4, 5); }
  } else if (['house', 'detached', 'residential', 'semidetached_house', 'terrace'].includes(type)) {
    floors = type === 'residential' ? I(3, 5) : I(2, 3);
  } else if (['commercial', 'retail', 'supermarket', 'kiosk'].includes(type)) {
    style = STYLE.shop; floors = m.area < 120 ? I(2, 4) : I(4, 8);
  } else if (type === 'hotel') {
    style = STYLE.office; floors = I(10, 18);
  } else if (['office', 'government'].includes(type)) {
    if (m.area > 600) { style = STYLE.office; floors = I(8, 20); } else { style = STYLE.shop; floors = I(4, 8); }
  } else if (['hospital', 'public', 'civic', 'train_station', 'transportation'].includes(type)) {
    style = STYLE.plain; floors = type === 'hospital' ? I(6, 12) : I(3, 6);
  } else if (['school', 'kindergarten', 'university', 'college'].includes(type)) {
    style = STYLE.school; floors = type === 'kindergarten' ? I(2, 3) : type === 'school' ? I(4, 5) : I(4, 8);
  } else if (['church', 'chapel', 'cathedral', 'temple'].includes(type) || use === 'place_of_worship') {
    style = STYLE.plain; floors = I(3, 4);
  } else if (type === 'roof') {
    style = STYLE.plain; floors = 1; floorH = 1; base = Math.max(base, 4); // canopies (fuel stations, platforms)
  } else if (type === 'parking') {
    style = STYLE.plain; floors = I(4, 6); floorH = 3.0;
  } else if (['warehouse', 'industrial', 'greenhouse', 'shed', 'garage', 'garages', 'hut', 'container', 'ruins', 'construction'].includes(type)) {
    style = STYLE.plain; floors = 1; floorH = R(3.5, 6);
  } else if (use === 'office') {
    if (m.area > 600) { style = STYLE.office; floors = I(10, 22); } else { style = STYLE.shop; floors = I(4, 8); }
  } else if (use && SHOP_USES.has(use)) {
    style = STYLE.shop; floors = m.area < 150 ? I(2, 4) : I(3, 7);
  } else if (use && PUBLIC_USES.has(use)) {
    style = STYLE.plain; floors = I(3, 6);
  } else {
    // Untyped (most of Seoul): footprint size, shape, landuse and a main road nearby decide
    const slab = resi && m.aspect >= 2.2 && m.short >= 9;
    if (m.area < 60) { floors = I(1, 2); }
    else if (m.area < 200) { if (near < 25) { style = STYLE.shop; floors = I(3, 5); } else floors = I(3, 5); }
    else if (m.area < 600) {
      if (near < 35) { style = STYLE.shop; floors = I(4, 8); }
      else if (slab && m.area > 350) { style = STYLE.apartment; floors = I(12, 20); }
      else if (rng() < 0.35) { style = STYLE.shop; floors = I(4, 6); }
      else floors = I(4, 6);
    } else if (m.area < 2000) {
      if (slab) { style = STYLE.apartment; floors = I(13, 25); }
      else if (near < 50) { style = rng() < 0.5 ? STYLE.office : STYLE.shop; floors = style === STYLE.office ? I(10, 20) : I(5, 10); }
      else { style = rng() < 0.6 ? STYLE.shop : STYLE.plain; floors = I(4, 8); }
    } else if (resi && m.aspect >= 2) { style = STYLE.apartment; floors = I(15, 25); }
    else if (near < 80) { style = STYLE.office; floors = I(12, 30); }
    else { style = STYLE.plain; floors = I(3, 6); }
  }

  // Tags win over the rules: levels keep the style's storey height, a tagged height keeps its storey count
  if (b.levels > 0) floors = Math.round(b.levels);
  else if (style === STYLE.office) floorH = R(3.6, 4.0); // untagged towers: taller office storeys
  let height = base + floors * floorH;
  if (b.height > 0) {
    height = Math.max(b.height, base + 2.5);
    if (!(b.levels > 0)) floors = Math.max(1, Math.round((height - base) / 3.2));
    floorH = (height - base) / floors;
  }
  height = Math.min(height, 320);
  return { height, floors, floorH, style, base, seed, metrics: m };
}

export {
  mulberry32,
  hashId,
  ringArea,
  pointInRing,
  pointInPolygon,
  distToSegment,
  ringBounds,
  footprintMetrics,
  MeshData,
  addFlatPolygon,
  addRingWalls,
  resamplePolyline,
  walkPolyline,
  SegmentGrid,
  STYLE,
  estimateBuilding
};
