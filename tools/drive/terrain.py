"""tools/drive/terrain.py — phase 2 terrain for build_route.py (contract: docs/drive.md, "Phase 2").

- Dem: Copernicus GLO-30 tiles (downloaded once into a cache), sampled bilinearly in the world frame. Two de-spiked
  surfaces per tile: a small grey opening everywhere (houses, pylons, lone trees) and a large one blended in where the
  corridor is built up (apartment blocks, towers); forest canopy is left alone (it reads as hills).
- RoadNet: one sparse least-squares solve for the height of every road node in the corridor (route included), so
  roads meet at shared nodes: data term = ground under the node, membrane smoothing with a per-class length, no data
  on bridges / tunnels (straight lines between abutments / portals), grade limits and overpass clearance by
  iterative reweighting.
- conform(): a tile's height grid with the ground cut / filled to the roads at 1:2 slopes.
"""

import math
import os
import shutil
import urllib.error
import urllib.request

import numpy as np
from scipy import ndimage
from scipy.sparse import coo_matrix
from scipy.sparse.linalg import spsolve

DEM_URL = 'https://copernicus-dem-30m.s3.amazonaws.com/{0}/{0}.tif'
ATTRIBUTION = ('Copernicus DEM © DLR e.V. 2010-2014 and © Airbus Defence and Space GmbH 2014-2018, provided under '
               'COPERNICUS by the European Union and ESA')
PX = 3600            # GLO-30 samples per degree, both axes below 50° (PixelIsPoint, row 0 on the tile's north edge)
COARSE = 6           # far terrain: DEM block-averaged 6 x 6 (~180 m)
OPEN_PX = 5          # grey opening everywhere (~150 m)
URBAN_PX = 9         # grey opening where built up (~270 m): finds the ground in the gaps between apartment slabs
URBAN_CELL = 125.0   # m, built-up weight grid
URBAN_LANDUSE = {'residential', 'commercial', 'industrial', 'retail'}
TILE_N = 65
SPACING = 25.0       # m, longest edge between road height nodes (path / road pts are densified to this)
SHOULDER = 2.0
GRID_SLACK = 2.0     # extra flat ground beyond the shoulder so the 7.8 m grid can't poke through a road edge
ROAD_DROP = 0.3
BRIDGE_GAP = 1.5     # natural ground under a bridge is trimmed to at least this far below the deck
CUT_SLOPE = 0.5      # 1:2 vertical : horizontal
FAR_STEP = 200.0
FAR_MARGIN = 15000.0
# highway -> (smoothing length m, max grade)
PROFILE = {'motorway': (150.0, 0.06), 'trunk': (120.0, 0.07), 'motorway_link': (60.0, 0.08),
           'trunk_link': (60.0, 0.08), 'primary': (60.0, 0.10), 'primary_link': (40.0, 0.10)}
DEFAULT_PROFILE = (30.0, 0.15)
RANK = {'motorway': 6, 'trunk': 5, 'motorway_link': 4, 'trunk_link': 4, 'primary': 3, 'primary_link': 3,
        'secondary': 2, 'secondary_link': 2, 'tertiary': 1, 'tertiary_link': 1}


# ---------------------------------------------------------------------------------------------------------------------
# DEM
# ---------------------------------------------------------------------------------------------------------------------

def dem_name(lat, lon):
    return (f'Copernicus_DSM_COG_10_{"N" if lat >= 0 else "S"}{abs(lat):02d}_00_'
            f'{"E" if lon >= 0 else "W"}{abs(lon):03d}_00_DEM')


def valid_tiff(path):
    try:
        if os.path.getsize(path) < 100_000:
            return False
        with open(path, 'rb') as f:
            return f.read(4) in (b'II*\x00', b'II+\x00')
    except OSError:
        return False


def fetch(cache, lat, lon):
    """Cached path of one 1° tile (downloading it if needed), or None for open sea. -> (path, bytes downloaded)"""
    name = dem_name(lat, lon)
    path = os.path.join(cache, name + '.tif')
    sea = path + '.missing'
    if valid_tiff(path):
        return path, 0
    if os.path.exists(sea):
        return None, 0
    os.makedirs(cache, exist_ok=True)
    try:
        with urllib.request.urlopen(DEM_URL.format(name), timeout=300) as res, open(path + '.part', 'wb') as f:
            shutil.copyfileobj(res, f)
    except urllib.error.HTTPError as e:
        if e.code in (403, 404):  # the bucket has no object for all-sea tiles
            open(sea, 'w').close()
            return None, 0
        raise
    os.replace(path + '.part', path)
    if not valid_tiff(path):
        os.remove(path)
        raise RuntimeError(f'{name}: download is not a TIFF')
    return path, os.path.getsize(path)


def read_tile(path):
    import tifffile  # only needed when sampling real DEM tiles
    with tifffile.TiffFile(path) as tf:
        page = tf.pages[0]
        scale = page.tags['ModelPixelScaleTag'].value
        tie = page.tags['ModelTiepointTag'].value
        a = page.asarray().astype(np.float32)
    name = os.path.basename(path)
    lat = int(name[23:25]) * (1 if name[22] == 'N' else -1)
    lon = int(name[30:33]) * (1 if name[29] == 'E' else -1)
    if a.shape != (PX, PX) or abs(scale[0] * PX - 1) > 1e-9 or abs(scale[1] * PX - 1) > 1e-9 or \
            (tie[3], tie[4]) != (lon, lat + 1):
        raise RuntimeError(f'{name}: unexpected grid {a.shape} scale {scale[:2]} tiepoint {tie[3:5]}')
    a[~np.isfinite(a) | (a < -1000)] = 0
    return a


def to_dm(a):
    return np.clip(np.round(a * 10), -32768, 32767).astype(np.int16)


class Dem:
    """Ground height in the world frame. `allowed`: the 1° tiles that may be read (others count as sea level)."""

    def __init__(self, cache, frame, allowed, log=print):
        self.cache, self.frame, self.allowed, self.log = cache, frame, set(allowed), log
        self.paths, self.fine, self.coarse = {}, {}, {}
        self.downloaded = []
        self.urban = None   # (x0, z0, weights[nz, nx]) on URBAN_CELL

    def prefetch(self):
        for key in sorted(self.allowed):
            path, size = fetch(self.cache, *key)
            self.paths[key] = path
            if size:
                self.downloaded.append((key, size))
                self.log(f'  downloaded {dem_name(*key)} ({size / 1e6:.1f} MB)')
        present = [k for k, p in self.paths.items() if p]
        self.log(f'  DEM: {len(present)} tiles present, {len(self.paths) - len(present)} sea, '
                 f'{len(self.downloaded)} downloaded ({sum(s for _, s in self.downloaded) / 1e6:.0f} MB)')

    def _path(self, key):
        if key not in self.allowed:
            return None
        if key not in self.paths:
            self.paths[key] = fetch(self.cache, *key)[0]
        return self.paths[key]

    def _fine(self, key):
        if key not in self.fine:
            path = self._path(key)
            if path is None:
                self.fine[key] = None
            else:
                a = read_tile(path)
                o = ndimage.grey_opening(a, size=(OPEN_PX, OPEN_PX))
                u = ndimage.gaussian_filter(ndimage.grey_opening(a, size=(URBAN_PX, URBAN_PX)), 1.0)
                self.fine[key] = (to_dm(o), to_dm(np.minimum(u, o)))
        return self.fine[key]

    def _coarse(self, key):
        if key not in self.coarse:
            path = self._path(key)
            if path is None:
                self.coarse[key] = None
            else:
                n = PX // COARSE
                self.coarse[key] = (read_tile(path).reshape(n, COARSE, n, COARSE).mean(axis=(1, 3)),)
        return self.coarse[key]

    def latlon(self, x, z):
        f = self.frame
        return f.lat0 - np.asarray(z, float) / 110540.0, f.lon0 + np.asarray(x, float) / f.kx

    def ground(self, x, z):
        """Natural ground (m above sea level) at world points: opened DSM, more strongly opened where built up."""
        lat, lon = self.latlon(x, z)
        o, u = bilinear(lat, lon, PX, 0.0, self._fine, 2)
        o *= 0.1
        u *= 0.1
        if self.urban is None:
            return o
        x0, z0, w = self.urban
        wt = ndimage.map_coordinates(w, [(np.asarray(z, float) - z0) / URBAN_CELL, (np.asarray(x, float) - x0) / URBAN_CELL],
                                     order=1, mode='constant', cval=0.0)
        return o + wt * (u - o)

    def far(self, x, z):
        lat, lon = self.latlon(x, z)
        return bilinear(lat, lon, PX // COARSE, (COARSE - 1) / 2, self._coarse, 1)[0]


def bilinear(lat, lon, n, offset, get, layers):
    """Bilinear samples over the global mosaic of 1° tiles with n samples per degree; sample k of a tile lies
    (k * PX / n + offset) / PX degrees from its north / west edge. get((lat, lon)) -> tuple of arrays or None (sea)."""
    gr = ((90.0 - lat) * PX - offset) * n / PX
    gc = (lon * PX - offset) * n / PX
    r0 = np.floor(gr).astype(np.int64)
    c0 = np.floor(gc).astype(np.int64)
    fr = (gr - r0).astype(np.float32)
    fc = (gc - c0).astype(np.float32)
    out = [np.zeros(len(r0), np.float32) for _ in range(layers)]
    for dr, dc, w in ((0, 0, (1 - fr) * (1 - fc)), (0, 1, (1 - fr) * fc), (1, 0, fr * (1 - fc)), (1, 1, fr * fc)):
        vals = gather(r0 + dr, c0 + dc, n, get, layers)
        for o, v in zip(out, vals):
            o += w * v
    return out


def gather(r, c, n, get, layers):
    tla = 89 - r // n
    tlo = c // n
    kid = (tla + 100) * 1000 + tlo
    out = [np.zeros(len(r), np.float32) for _ in range(layers)]
    for k in np.unique(kid):
        arrs = get((int(k // 1000) - 100, int(k % 1000)))
        if arrs is None:
            continue
        m = kid == k
        rr, cc = r[m] % n, c[m] % n
        for o, a in zip(out, arrs):
            o[m] = a[rr, cc]
    return out


def tiles_for_bbox(frame, x0, z0, x1, z1):
    lat_a = frame.lat0 - z1 / 110540.0
    lat_b = frame.lat0 - z0 / 110540.0
    lon_a = frame.lon0 + x0 / frame.kx
    lon_b = frame.lon0 + x1 / frame.kx
    return {(la, lo) for la in range(math.floor(lat_a), math.floor(lat_b) + 1)
            for lo in range(math.floor(lon_a), math.floor(lon_b) + 1)}


# ---------------------------------------------------------------------------------------------------------------------
# Built-up weight
# ---------------------------------------------------------------------------------------------------------------------

def points_in_ring(px, pz, flat_ring):
    xs = np.asarray(flat_ring[0::2], float)
    zs = np.asarray(flat_ring[1::2], float)
    x1, z1 = np.roll(xs, 1), np.roll(zs, 1)
    inside = np.zeros(len(px), bool)
    for i in range(0, len(px), 4096):
        X, Z = px[i:i + 4096, None], pz[i:i + 4096, None]
        cross = ((zs > Z) != (z1 > Z)) & (X < (x1 - xs) * (Z - zs) / np.where(z1 == zs, 1e-12, z1 - zs) + xs)
        inside[i:i + 4096] = np.count_nonzero(cross, axis=1) % 2 == 1
    return inside


def urban_weight(tiles, tile_size):
    """Built-up weight (0..1) on a URBAN_CELL grid over the corridor: building cover and urban landuse."""
    txs = [t['tx'] for t in tiles]
    tzs = [t['tz'] for t in tiles]
    x0, z0 = min(txs) * tile_size, min(tzs) * tile_size
    nx = int((max(txs) + 1 - min(txs)) * tile_size / URBAN_CELL)
    nz = int((max(tzs) + 1 - min(tzs)) * tile_size / URBAN_CELL)
    cover = np.zeros((nz, nx), np.float32)
    landuse = np.zeros((nz, nx), np.float32)
    for t in tiles:
        for b in t['buildings']:
            p = b['pts']
            xs, zs = np.asarray(p[0::2]), np.asarray(p[1::2])
            area = abs(np.dot(xs, np.roll(zs, -1)) - np.dot(zs, np.roll(xs, -1))) / 2
            i, j = int((zs.mean() - z0) // URBAN_CELL), int((xs.mean() - x0) // URBAN_CELL)
            if 0 <= i < nz and 0 <= j < nx:
                cover[i, j] += area
        for a in t['areas']:
            if a['key'] != 'landuse' or a['kind'] not in URBAN_LANDUSE:
                continue
            p = a['pts']
            j0, j1 = int((min(p[0::2]) - x0) // URBAN_CELL), int((max(p[0::2]) - x0) // URBAN_CELL)
            i0, i1 = int((min(p[1::2]) - z0) // URBAN_CELL), int((max(p[1::2]) - z0) // URBAN_CELL)
            j0, i0, j1, i1 = max(j0, 0), max(i0, 0), min(j1, nx - 1), min(i1, nz - 1)
            if j1 < j0 or i1 < i0:
                continue
            jj, ii = np.meshgrid(np.arange(j0, j1 + 1), np.arange(i0, i1 + 1))
            px, pz = x0 + (jj.ravel() + 0.5) * URBAN_CELL, z0 + (ii.ravel() + 0.5) * URBAN_CELL
            m = points_in_ring(px, pz, p)
            for h in a['holes']:
                m &= ~points_in_ring(px, pz, h)
            landuse[ii.ravel()[m], jj.ravel()[m]] = 1
    cover = ndimage.gaussian_filter(cover / URBAN_CELL ** 2, 1.0)
    w = np.maximum(np.clip((cover - 0.06) / 0.12, 0, 1), landuse)
    # sampled at cell centres: shift the origin by half a cell
    return x0 + URBAN_CELL / 2, z0 + URBAN_CELL / 2, ndimage.gaussian_filter(w, 1.0).astype(np.float32)


# ---------------------------------------------------------------------------------------------------------------------
# Road heights
# ---------------------------------------------------------------------------------------------------------------------

def densify(refs, pts):
    """Insert height nodes so no edge exceeds SPACING. Keys: OSM node ids, or (lo, hi, k) for the k-th inner node
    from `lo` on the edge between nodes lo < hi, so every way using an edge shares its inner nodes.
    -> keys, points, index of each input point in the output"""
    keys, out, where = [refs[0]], [pts[0]], [0]
    for a, b, pa, pb in zip(refs, refs[1:], pts, pts[1:]):
        if b == keys[-1]:
            where.append(len(keys) - 1)
            continue
        n = max(1, math.ceil(math.hypot(pb[0] - pa[0], pb[1] - pa[1]) / SPACING))
        for i in range(1, n):
            keys.append((a, b, i) if a < b else (b, a, n - i))
            out.append((pa[0] + (pb[0] - pa[0]) * i / n, pa[1] + (pb[1] - pa[1]) * i / n))
        keys.append(b)
        out.append(pb)
        where.append(len(keys) - 1)
    return keys, out, where


class RoadNet:
    def __init__(self):
        self.index = {}
        self.xs, self.zs = [], []
        self.ways = []   # (node indices, highway, bridge, tunnel)
        self.y = self.ground = None

    def add(self, refs, pts, highway, bridge, tunnel):
        keys, dense, where = densify(refs, pts)
        ids = np.empty(len(keys), np.int64)
        for n, (k, p) in enumerate(zip(keys, dense)):
            i = self.index.get(k)
            if i is None:
                i = self.index[k] = len(self.xs)
                self.xs.append(p[0])
                self.zs.append(p[1])
            ids[n] = i
        self.ways.append((ids, highway, bool(bridge), bool(tunnel)))
        return ids, dense, where

    def solve(self, ground, iters=6, log=print):
        n = len(self.xs)
        xs, zs = np.array(self.xs), np.array(self.zs)
        G = np.asarray(ground(xs, zs), float)
        ei, ej, el, elam, egmax = [], [], [], [], []
        W = np.zeros(n)
        need = np.zeros(n)   # clearance wanted over the ground at bridge nodes (> 0) / under it in tunnels (< 0)
        for ids, hw, br, tn in self.ways:
            if len(ids) < 2:
                continue
            L, gmax = PROFILE.get(hw, DEFAULT_PROFILE)
            l = np.maximum(np.hypot(np.diff(xs[ids]), np.diff(zs[ids])), 0.5)
            ei.append(ids[:-1])
            ej.append(ids[1:])
            el.append(l)
            elam.append(L * L / l)
            egmax.append(np.full(len(l), gmax))
            if br or tn:
                # short bridges (culverts) barely rise, long ones over roads clear ~6 m; underpasses dip ~7 m
                c = min(6.0, l.sum() / 15.0) if br else -min(7.0, l.sum() / 15.0)
                need[ids] = np.where(np.abs(c) > np.abs(need[ids]), c, need[ids])
                continue
            np.add.at(W, ids[:-1], l / 2)
            np.add.at(W, ids[1:], l / 2)
        ei, ej, el, lam, gmax = (np.concatenate(a) for a in (ei, ej, el, elam, egmax))
        need[W > 0] = 0   # abutments sit on the ground
        extra_w = np.zeros(n)
        extra_t = np.zeros(n)
        y = G.copy()
        for it in range(iters):
            wd = W * np.minimum(1.0, 5.0 / np.maximum(np.abs(y - G), 1e-9))   # Huber: DSM outliers pull less
            # the 1e-6 pull to the ground keeps data-less components (all-bridge pieces) solvable
            diag = wd + extra_w + 1e-6 + np.bincount(ei, lam, n) + np.bincount(ej, lam, n)
            A = coo_matrix((np.concatenate([diag, -lam, -lam]),
                            (np.concatenate([np.arange(n), ei, ej]), np.concatenate([np.arange(n), ej, ei]))),
                           shape=(n, n)).tocsc()
            y = spsolve(A, wd * G + extra_w * extra_t + 1e-6 * G)
            grade = np.abs(y[ei] - y[ej]) / el
            over = grade > gmax * 0.97
            lam[over] *= np.minimum((grade[over] / gmax[over]) ** 2 * 2.0, 50.0)
            low = ((need > 0) & (y < G + need - 0.2)) | ((need < 0) & (y > G + need + 0.2))
            extra_w[low] = 10 * SPACING   # outweighs the ground pull on the untagged approach ramps
            extra_t[low] = G[low] + need[low]
            log(f'  height solve {it + 1}/{iters}: {n} nodes, {len(el)} edges, {np.count_nonzero(over)} edges over '
                f'grade, max {grade.max() * 100:.1f} %, {np.count_nonzero(low)} bridge / tunnel nodes moved')
        self.y, self.ground = y, G
        return y


# ---------------------------------------------------------------------------------------------------------------------
# Road-conformed tile grids
# ---------------------------------------------------------------------------------------------------------------------

def conform(x0, z0, size, ground, roads):
    """Height grid TILE_N x TILE_N (row-major from (x0, z0), x fastest) of `ground` (H[iz, ix]) cut / filled to the
    roads. roads: dicts with pts (k, 2), ys (k), half (flat half-width), reach, portal0 / portal1 (end is a tunnel
    portal: no cut beyond it), under (a bridge: the ground is only trimmed below the deck), in ascending priority
    (later roads win where slopes overlap)."""
    step = size / (TILE_N - 1)
    gx = x0 + np.arange(TILE_N) * step
    gz = z0 + np.arange(TILE_N) * step
    H = ground.astype(float).copy()
    for r in roads:
        P, Y, reach = r['pts'], r['ys'], r['half'] + r['reach']   # reach: from the centreline
        a, b = P[:-1], P[1:]
        sel = ((np.maximum(a[:, 0], b[:, 0]) > x0 - reach) & (np.minimum(a[:, 0], b[:, 0]) < x0 + size + reach) &
               (np.maximum(a[:, 1], b[:, 1]) > z0 - reach) & (np.minimum(a[:, 1], b[:, 1]) < z0 + size + reach))
        if not sel.any():
            continue
        segs = np.nonzero(sel)[0]
        a, b, ya, yb = a[segs], b[segs], Y[:-1][segs], Y[1:][segs]
        lo = np.minimum(a, b).min(axis=0) - reach
        hi = np.maximum(a, b).max(axis=0) + reach
        ix = np.nonzero((gx >= lo[0]) & (gx <= hi[0]))[0]
        iz = np.nonzero((gz >= lo[1]) & (gz <= hi[1]))[0]
        if not len(ix) or not len(iz):
            continue
        PX_, PZ_ = np.meshgrid(gx[ix], gz[iz])
        px, pz = PX_.ravel()[:, None], PZ_.ravel()[:, None]
        d = b - a
        l2 = np.maximum((d ** 2).sum(axis=1), 1e-9)
        t_raw = ((px - a[:, 0]) * d[:, 0] + (pz - a[:, 1]) * d[:, 1]) / l2
        t = np.clip(t_raw, 0, 1)
        dist2 = (px - a[:, 0] - t * d[:, 0]) ** 2 + (pz - a[:, 1] - t * d[:, 1]) ** 2
        k = np.argmin(dist2, axis=1)
        rows = np.arange(len(k))
        dist = np.sqrt(dist2[rows, k])
        tk = t[rows, k]
        y = ya[k] + tk * (yb[k] - ya[k]) - ROAD_DROP
        m = dist < reach
        if r['portal0']:
            m &= ~((segs[k] == 0) & (t_raw[rows, k] < 0))
        if r['portal1']:
            m &= ~((segs[k] == len(P) - 2) & (t_raw[rows, k] > 1))
        slack = np.maximum(dist - r['half'], 0) * CUT_SLOPE
        sub = H[np.ix_(iz, ix)].ravel()
        if r.get('under'):
            sub[m] = np.minimum(sub[m], y[m] + ROAD_DROP - BRIDGE_GAP + slack[m])
        else:
            sub[m] = np.clip(sub[m], y[m] - slack[m], y[m] + slack[m])
        H[np.ix_(iz, ix)] = sub.reshape(len(iz), len(ix))
    return H


def sample_grid(H, x0, z0, size, x, z):
    """Bilinear sample of a TILE_N grid at points (clamped to the tile)."""
    s = (TILE_N - 1) / size
    fx = np.clip((np.asarray(x, float) - x0) * s, 0, TILE_N - 1)
    fz = np.clip((np.asarray(z, float) - z0) * s, 0, TILE_N - 1)
    return ndimage.map_coordinates(H, [fz, fx], order=1, mode='nearest')


# ---------------------------------------------------------------------------------------------------------------------
# Self-test (no DEM needed)
# ---------------------------------------------------------------------------------------------------------------------

def self_test():
    # mosaic gather across a 1° seam: two synthetic tiles holding their global row index
    n = 4
    tiles = {(37, 127): (np.arange(n)[:, None].repeat(n, 1).astype(np.float32),),
             (36, 127): ((np.arange(n) + n)[:, None].repeat(n, 1).astype(np.float32),)}
    # n = 4 per degree: row k of N37 at lat 38 - k/4; lat 37.1 -> global row 3.6 -> 0.4 * 3 + 0.6 * 4 (tile N36 row 0)
    v = bilinear(np.array([37.1]), np.array([127.3]), n, 0.0, tiles.get, 1)[0]
    assert abs(v[0] - 3.6) < 1e-5, v
    v = bilinear(np.array([37.1]), np.array([128.3]), n, 0.0, tiles.get, 1)[0]   # east neighbour missing: sea
    assert v[0] == 0
    keys, pts, where = densify([1, 2], [(0, 0), (60, 0)])
    keys2, _, _ = densify([2, 1], [(60, 0), (0, 0)])
    assert len(keys) == 4 and keys[1:3] == keys2[2:0:-1] and where == [0, 3]
    # a valley crossed by a bridge (straight between abutments) then a hill crossed by a tunnel
    net = RoadNet()
    ground = lambda x, z: np.where((x > 400) & (x < 600), 0.0, np.where((x > 1000) & (x < 1400), 80.0, 20.0))
    net.add([1, 2], [(0, 0), (400, 0)], 'motorway', False, False)
    net.add([2, 3], [(400, 0), (600, 0)], 'motorway', True, False)
    net.add([3, 4], [(600, 0), (1000, 0)], 'motorway', False, False)
    net.add([4, 5], [(1000, 0), (1400, 0)], 'motorway', False, True)
    net.add([5, 6], [(1400, 0), (2000, 0)], 'motorway', False, False)
    y = net.solve(ground, log=lambda *_: None)
    xs = np.array(net.xs)
    span = (xs >= 400) & (xs <= 600)
    assert np.all(np.abs(y[span] - 20) < 0.5), y[span]
    tun = (xs >= 1000) & (xs <= 1400)
    assert np.all(np.abs(y[tun] - 20) < 0.5)   # mountain tunnel: straight between the portals
    # a 200 m underpass beneath flat ground dips below it
    net = RoadNet()
    net.add([1, 2], [(0, 0), (600, 0)], 'primary', False, False)
    net.add([2, 3], [(600, 0), (800, 0)], 'primary', False, True)
    net.add([3, 4], [(800, 0), (1400, 0)], 'primary', False, False)
    y = net.solve(lambda x, z: np.full(len(x), 20.0), log=lambda *_: None)
    assert y[np.argmin(np.abs(np.array(net.xs) - 700))] < 15
    # conform: a flat road at 10 m through ground at 20 m: flat under the road, 1:2 slopes, untouched far away
    G = np.full((TILE_N, TILE_N), 20.0)
    road = {'pts': np.array([[-100.0, 250.0], [600.0, 250.0]]), 'ys': np.array([10.3, 10.3]), 'half': 5.0,
            'reach': 40.0, 'portal0': False, 'portal1': False}
    H = conform(0, 0, 500, G, [road])
    step = 500 / (TILE_N - 1)
    col = H[:, 10]
    assert col[32] == 10.0 and abs(col[33] - (10 + (step - 5) * 0.5)) < 1e-9 and col[0] == 20.0
    road['portal1'], road['pts'][1, 0] = True, 250.0
    H = conform(0, 0, 500, G, [road])
    assert H[32, 20] == 10.0 and H[32, 40] == 20.0   # beyond the portal the hill stays
    # a bridge deck at 21 m over ground at 20 m (canopy / DSM noise): trimmed to 19.5 under it, kept away from it
    road.update(ys=np.array([21.0, 21.0]), under=True, portal1=False)
    H = conform(0, 0, 500, G, [road])
    assert H[32, 20] == 19.5 and H[33, 20] == 20.0 and H[32, 40] == 20.0
    print('terrain self-test ok')
