#!/usr/bin/env python3
"""tools/drive/build_route.py — offline route + corridor tile builder for Korea Drive (contract: docs/drive.md).

Reads a .osm.pbf extract (pyosmium), routes a car between two points over the OSM highway graph (Dijkstra on
travel time, scipy), and writes data/drive/<id>/route.json plus one JSON tile per 500 m corridor cell.

  python tools/drive/build_route.py --pbf south-korea.osm.pbf --from 37.5547,126.9707 --to 37.4979,127.0276 \
      --id seoul-station-gangnam --name "서울역 → 강남역"
  python tools/drive/build_route.py --self-test

Terrain (phase 2, tools/drive/terrain.py): Copernicus GLO-30 tiles covering the route bbox + 15 km are downloaded once
into --dem-cache; the output gains pathY, tile road ys, building baseY, tiles/<key>.terrain.bin and far.bin.

Passes over the PBF (each ~2-60 s for all of South Korea):
  0. named nodes (only when --from/--to is a name)
  1. tagged point nodes (traffic signals, trees, street lamps)
  2. routing ways (node locations from an in-memory index of every node: ~0.6 GB for South Korea)
  3. multipolygon relations (member way ids)
  4. multipolygon member ways
  5. corridor feature ways (roads, buildings, areas)

Output notes (see also docs/drive.md): rings are stored without the repeated closing point; multipolygon features
use the negated relation id as `id`; areas spanning several tiles are clipped to each corridor tile instead of being
stored once at their centroid; footways/cycleways/paths/steps and building:part are not exported.
"""

import argparse
import json
import math
import os
import re
import shutil
import sys
import time
from array import array

import numpy as np
import osmium

import terrain
from scipy.sparse import csr_matrix
from scipy.sparse.csgraph import dijkstra

TILE = 500.0
CORRIDOR = 400.0        # tiles within this distance of the path are emitted
NEAR_END = 5000.0       # minor roads are routable only this close to an endpoint
SERVICE_NEAR = 1000.0   # service roads only this close
LANE_WIDTH = 3.3

# class -> (default km/h, default lanes two-way, default lanes one-way)
CLASSES = {
    'motorway': (100, 4, 2), 'trunk': (80, 4, 2), 'primary': (60, 4, 2), 'secondary': (50, 4, 2),
    'tertiary': (50, 2, 1), 'unclassified': (40, 2, 1), 'residential': (30, 2, 1), 'living_street': (20, 1, 1),
    'service': (20, 1, 1),
    'motorway_link': (60, 2, 1), 'trunk_link': (50, 2, 1), 'primary_link': (40, 2, 1),
    'secondary_link': (40, 2, 1), 'tertiary_link': (30, 2, 1),
}
MAJOR = {'motorway', 'trunk', 'primary', 'secondary', 'motorway_link', 'trunk_link', 'primary_link', 'secondary_link'}
# Roads written to tiles: the routable classes plus non-car streets the city builder may still pave
TILE_ROADS = set(CLASSES) | {'pedestrian', 'track', 'busway', 'road'}
POINT_TAGS = {('highway', 'traffic_signals'): 'traffic_signals', ('natural', 'tree'): 'tree',
              ('highway', 'street_lamp'): 'street_lamp'}
AREA_KEYS = ('landuse', 'natural', 'leisure')
NOT_AREA = {'coastline', 'tree_row', 'cliff', 'ridge', 'arete', 'valley', 'tree', 'peak'}

T0 = time.time()


def log(msg):
    print(f'[{time.time() - T0:7.1f}s] {msg}', flush=True)


# ---------------------------------------------------------------------------------------------------------------------
# Frame & small geometry helpers
# ---------------------------------------------------------------------------------------------------------------------

class Frame:
    """Local tangent plane about (lat0, lon0): x east, z south, metres (docs/drive.md)."""

    def __init__(self, lat0, lon0):
        self.lat0, self.lon0 = lat0, lon0
        self.kx = 111320.0 * math.cos(math.radians(lat0))

    def xz(self, lon, lat):
        return (lon - self.lon0) * self.kx, -(lat - self.lat0) * 110540.0


def r1(v):
    v = round(v, 1)
    return int(v) if v == int(v) else v


def r2(v):
    return round(float(v), 2)


def flat(pts):
    return [r1(c) for p in pts for c in p]


def signed_area(ring):
    """Shoelace sum in (x, z). Negative = counter-clockwise seen from above (+y), since z points south."""
    s = 0.0
    n = len(ring)
    for i in range(n):
        x0, z0 = ring[i]
        x1, z1 = ring[(i + 1) % n]
        s += x0 * z1 - x1 * z0
    return s / 2.0


def orient(ring, ccw):
    return ring if (signed_area(ring) < 0) == ccw else ring[::-1]


def centroid(ring):
    a = signed_area(ring)
    if abs(a) < 1e-6:
        return sum(p[0] for p in ring) / len(ring), sum(p[1] for p in ring) / len(ring)
    cx = cz = 0.0
    n = len(ring)
    for i in range(n):
        x0, z0 = ring[i]
        x1, z1 = ring[(i + 1) % n]
        f = x0 * z1 - x1 * z0
        cx += (x0 + x1) * f
        cz += (z0 + z1) * f
    return cx / (6 * a), cz / (6 * a)


def point_in_ring(x, z, ring):
    inside = False
    n = len(ring)
    for i in range(n):
        x0, z0 = ring[i]
        x1, z1 = ring[i - 1]
        if (z0 > z) != (z1 > z) and x < (x1 - x0) * (z - z0) / (z1 - z0) + x0:
            inside = not inside
    return inside


def tile_of(x, z):
    return math.floor(x / TILE), math.floor(z / TILE)


def key_of(tx, tz):
    return f'{tx}_{tz}'


def rect_dist(x, z, tx, tz):
    dx = max(tx * TILE - x, 0.0, x - (tx + 1) * TILE)
    dz = max(tz * TILE - z, 0.0, z - (tz + 1) * TILE)
    return math.hypot(dx, dz)


def clip_ring(ring, x0, z0, x1, z1):
    """Sutherland-Hodgman clip of a closed ring (no repeated end point) against an axis-aligned rectangle."""
    def clip(pts, inside, cut):
        out = []
        for i in range(len(pts)):
            a, b = pts[i - 1], pts[i]
            ia, ib = inside(a), inside(b)
            if ib:
                if not ia:
                    out.append(cut(a, b))
                out.append(b)
            elif ia:
                out.append(cut(a, b))
        return out

    def cx(v):
        return lambda a, b: (v, a[1] + (b[1] - a[1]) * (v - a[0]) / (b[0] - a[0]))

    def cz(v):
        return lambda a, b: (a[0] + (b[0] - a[0]) * (v - a[1]) / (b[1] - a[1]), v)

    pts = ring
    for inside, cut in ((lambda p: p[0] >= x0, cx(x0)), (lambda p: p[0] <= x1, cx(x1)),
                        (lambda p: p[1] >= z0, cz(z0)), (lambda p: p[1] <= z1, cz(z1))):
        if not pts:
            break
        pts = clip(pts, inside, cut)
    return pts


def split_by_tiles(pts):
    """Split a polyline at tile borders -> [((tx, tz), [pts])]; border points are shared by both pieces. Points are
    (x, z, ...) tuples: extra values (e.g. y) are interpolated at the borders."""
    dense = [pts[0]]
    for pa, pb in zip(pts, pts[1:]):
        ts = []
        for i in (0, 1):
            a, b = pa[i], pb[i]
            if a == b:
                continue
            lo, hi = sorted((a, b))
            k = math.floor(lo / TILE) + 1
            while k * TILE < hi:
                ts.append((k * TILE - a) / (b - a))
                k += 1
        for t in sorted(ts):
            dense.append(tuple(u + (v - u) * t for u, v in zip(pa, pb)))
        dense.append(pb)
    pieces = []
    for a, b in zip(dense, dense[1:]):
        if a[:2] == b[:2]:
            continue
        key = tile_of((a[0] + b[0]) / 2, (a[1] + b[1]) / 2)
        if pieces and pieces[-1][0] == key:
            pieces[-1][1].append(b)
        else:
            pieces.append((key, [a, b]))
    return pieces


def assemble_rings(parts):
    """Join way chains [(node_ids, pts)] into closed rings (lists of pts without the repeated end point)."""
    pending = [(list(i), list(p)) for i, p in parts if len(i) >= 2]
    rings = []
    while pending:
        ids, pts = pending.pop()
        while ids[0] != ids[-1]:
            for k, (i2, p2) in enumerate(pending):
                if i2[0] == ids[-1]:
                    ids, pts = ids + i2[1:], pts + p2[1:]
                elif i2[-1] == ids[-1]:
                    ids, pts = ids + i2[-2::-1], pts + p2[-2::-1]
                elif i2[-1] == ids[0]:
                    ids, pts = i2[:-1] + ids, p2[:-1] + pts
                elif i2[0] == ids[0]:
                    ids, pts = i2[:0:-1] + ids, p2[:0:-1] + pts
                else:
                    continue
                pending.pop(k)
                break
            else:
                break   # open chain (members missing from the extract): dropped
        if ids[0] == ids[-1] and len(ids) >= 4:
            rings.append(pts[:-1])
    return rings


# ---------------------------------------------------------------------------------------------------------------------
# Tag parsing
# ---------------------------------------------------------------------------------------------------------------------

def num(value):
    if value is None:
        return None
    m = re.match(r'\s*(-?\d+(?:\.\d+)?)', value.replace(',', '.'))
    return float(m.group(1)) if m else None


def parse_speed(value):
    v = num(value)
    if v is None:
        return None
    return round(v * 1.609) if 'mph' in value else round(v)


def way_attrs(tags, highway):
    """Route segment / tile road attributes with class defaults (docs/drive.md)."""
    ow = tags.get('oneway', '')
    implied = highway in ('motorway', 'motorway_link') or tags.get('junction') in ('roundabout', 'circular')
    oneway = -1 if ow in ('-1', 'reverse') else 1 if ow in ('yes', 'true', '1') or (implied and ow != 'no') else 0
    speed, lanes2, lanes1 = CLASSES.get(highway, (20, 1, 1))
    lanes = num(tags.get('lanes'))
    maxspeed = parse_speed(tags.get('maxspeed'))
    return {
        'highway': highway, 'name': tags.get('name'), 'ref': tags.get('ref'),
        'lanes': int(lanes) if lanes else (lanes1 if oneway else lanes2), 'lanesTagged': bool(lanes),
        'oneway': oneway != 0, 'maxspeed': maxspeed or speed, 'maxspeedTagged': bool(maxspeed),
        'tunnel': tags.get('tunnel', 'no') not in ('no', ''), 'bridge': tags.get('bridge', 'no') not in ('no', ''),
        'layer': int(num(tags.get('layer')) or 0), '_dir': oneway,
    }


def blocked(tags):
    if tags.get('area') == 'yes':
        return True
    mv = tags.get('motor_vehicle') or tags.get('motorcar')
    if mv in ('no', 'private'):
        return True
    return tags.get('access') in ('no', 'private') and mv not in ('yes', 'designated', 'permissive', 'destination')


# ---------------------------------------------------------------------------------------------------------------------
# PBF passes
# ---------------------------------------------------------------------------------------------------------------------

def way_reader(pbf, *filters):
    """Ways with node locations; nodes feed the location index in C++ and never reach Python."""
    fp = osmium.FileProcessor(pbf, osmium.osm.NODE | osmium.osm.WAY).with_locations('sparse_mem_array')
    fp.with_filter(osmium.filter.EntityFilter(osmium.osm.WAY))
    for f in filters:
        fp.with_filter(f)
    return fp


def node_xz(frame, nd):
    loc = nd.location
    return frame.xz(loc.lon, loc.lat) if loc.valid() else None


def resolve_names(pbf, specs):
    """--from/--to: 'lat,lon' or an exact OSM name / name:ko of a place, station or subway entrance node."""
    out, wanted = {}, {}
    for s in specs:
        m = re.fullmatch(r'\s*(-?\d+(?:\.\d+)?)\s*,\s*(-?\d+(?:\.\d+)?)\s*', s)
        if m:
            out[s] = (None, float(m.group(1)), float(m.group(2)))
        else:
            wanted[s] = None
    if not wanted:
        return out
    log(f'pass 0: looking up {", ".join(wanted)}')
    rank_of = lambda t: (0 if 'place' in t else 1 if t.get('railway') in ('station', 'halt') else
                         2 if t.get('public_transport') == 'station' else
                         3 if t.get('railway') == 'subway_entrance' else None)
    best = {}
    for n in osmium.FileProcessor(pbf, osmium.osm.NODE).with_filter(osmium.filter.KeyFilter('name')):
        t = n.tags
        names = {t.get('name'), t.get('name:ko')}
        for s in wanted:
            if s in names:
                rank = rank_of(t)
                if rank is not None and (s not in best or rank < best[s][0]):
                    best[s] = (rank, n.location.lat, n.location.lon)
    for s in wanted:
        if s not in best:
            sys.exit(f'no place/station node named {s!r}')
        out[s] = (s, best[s][1], best[s][2])
        log(f'  {s} -> {best[s][1]:.5f},{best[s][2]:.5f}')
    return out


def read_points(pbf):
    log('pass 1: signal / tree / lamp nodes')
    pts = []
    flt = osmium.filter.TagFilter(*POINT_TAGS.keys())
    for n in osmium.FileProcessor(pbf, osmium.osm.NODE).with_filter(flt):
        t = n.tags
        for (k, v), kind in POINT_TAGS.items():
            if t.get(k) == v:
                pts.append((n.id, n.location.lon, n.location.lat, kind))
                break
    log(f'  {len(pts)} point nodes')
    return pts


def build_graph(pbf, frame, ends, bbox):
    """Directed road graph inside bbox (x0, z0, x1, z1); minor classes only near the endpoints."""
    log('pass 2: routing graph')
    x0, z0, x1, z1 = bbox
    index, xs, zs, snappable = {}, [], [], []
    us, vs, ws, wy = [], [], [], []
    ways = []

    def near(p, d):
        return any(math.hypot(p[0] - ex, p[1] - ez) < d for ex, ez in ends)

    flt = osmium.filter.TagFilter(*[('highway', c) for c in CLASSES])
    for w in way_reader(pbf, flt):
        tags = w.tags
        hw = tags['highway']
        if blocked(tags):
            continue
        nodes = w.nodes
        n = len(nodes)
        if n < 2:
            continue
        samples = [p for p in (node_xz(frame, nodes[0]), node_xz(frame, nodes[n // 2]), node_xz(frame, nodes[-1])) if p]
        if not any(x0 <= x <= x1 and z0 <= z <= z1 for x, z in samples):
            continue
        if hw not in MAJOR and not any(near(p, SERVICE_NEAR if hw == 'service' else NEAR_END) for p in samples):
            continue
        attrs = way_attrs(tags, hw)
        attrs['id'] = w.id
        wi = len(ways)
        ways.append(attrs)
        speed = attrs['maxspeed'] / 3.6
        snap = hw not in ('motorway', 'motorway_link') and not attrs['tunnel'] and not attrs['bridge']
        prev = prev_p = None
        for nd in nodes:
            p = node_xz(frame, nd)
            if p is None:
                prev = None
                continue
            gi = index.get(nd.ref)
            if gi is None:
                gi = index[nd.ref] = len(xs)
                xs.append(p[0])
                zs.append(p[1])
                snappable.append(snap)
            elif snap:
                snappable[gi] = True
            if prev is not None and prev != gi:
                t = max(math.hypot(p[0] - prev_p[0], p[1] - prev_p[1]) / speed, 1e-4)
                if attrs['_dir'] >= 0:
                    us.append(prev), vs.append(gi), ws.append(t), wy.append(wi)
                if attrs['_dir'] <= 0:
                    us.append(gi), vs.append(prev), ws.append(t), wy.append(wi)
            prev, prev_p = gi, p
    n = len(xs)
    u, v, wt, way = (np.array(a) for a in (us, vs, ws, wy))
    order = np.lexsort((wt, v, u))  # sort by (u, v), cheapest first, then keep one edge per (u, v)
    u, v, wt, way = u[order], v[order], wt[order], way[order]
    keep = np.ones(len(u), bool)
    keep[1:] = (u[1:] != u[:-1]) | (v[1:] != v[:-1])
    u, v, wt, way = u[keep], v[keep], wt[keep], way[keep]
    indptr = np.searchsorted(u, np.arange(n + 1))
    graph = csr_matrix((wt, v, indptr), shape=(n, n))
    ids = np.empty(n, np.int64)
    for osm_id, gi in index.items():
        ids[gi] = osm_id
    log(f'  {len(ways)} ways, {n} nodes, {len(u)} edges')
    return {'graph': graph, 'indptr': indptr, 'v': v, 'way': way, 'ways': ways, 'ids': ids,
            'xs': np.array(xs), 'zs': np.array(zs), 'snappable': np.array(snappable, bool)}


def route(g, start, end):
    """Dijkstra on travel time between the snappable nodes nearest to start / end."""
    xs, zs, snap = g['xs'], g['zs'], g['snappable']

    def nearest(p, k=8):
        d = np.hypot(xs - p[0], zs - p[1])
        d[~snap] = np.inf
        return np.argsort(d)[:k]

    targets = nearest(end)
    for src in nearest(start):
        dist, pred = dijkstra(g['graph'], indices=int(src), return_predecessors=True)
        reach = [t for t in targets if np.isfinite(dist[t])]
        if reach:
            node, path = int(reach[0]), []
            while node >= 0:
                path.append(node)
                node = pred[node]
            log(f'  route found: {len(path)} nodes, {dist[reach[0]] / 60:.1f} min')
            return path[::-1]
    sys.exit('no route between the endpoints (disconnected graph inside the bbox?)')


def edge_way(g, a, b):
    lo, hi = g['indptr'][a], g['indptr'][a + 1]
    k = lo + int(np.nonzero(g['v'][lo:hi] == b)[0][0])
    return int(g['way'][k])


# ---------------------------------------------------------------------------------------------------------------------
# Corridor features
# ---------------------------------------------------------------------------------------------------------------------

def read_relations(pbf):
    log('pass 3: multipolygon relations')
    rels, members = [], {}
    for r in osmium.FileProcessor(pbf, osmium.osm.RELATION).with_filter(osmium.filter.KeyFilter('type')):
        t = r.tags
        if t.get('type') != 'multipolygon':
            continue
        if not (t.get('building', 'no') != 'no' or any(k in t for k in AREA_KEYS) or t.get('waterway') == 'riverbank'):
            continue
        ms = [(m.ref, m.role) for m in r.members if m.type == 'w']
        rels.append((r.id, dict(t), ms))
        for ref, _ in ms:
            members[ref] = None
    log(f'  {len(rels)} relations, {len(members)} member ways')
    return rels, members


def building_props(id_, tags):
    lv = num(tags.get('building:levels'))
    use = tags.get('amenity') or ('retail' if 'shop' in tags else 'office' if 'office' in tags else None)
    return {'id': id_, 'levels': int(lv) if lv is not None else None, 'height': num(tags.get('height')),
            'minHeight': num(tags.get('min_height')) or 0, 'type': tags.get('building'), 'name': tags.get('name'),
            'use': use}


def area_kind(tags):
    if tags.get('waterway') == 'riverbank':
        return 'natural', 'water'
    for k in AREA_KEYS:
        v = tags.get(k)
        if v and v not in NOT_AREA:
            return k, v
    return None


class Tiles:
    def __init__(self, keys):
        self.keys = keys  # ordered dict-like: key -> (tx, tz)
        self.data = {k: {'tx': tx, 'tz': tz,
                         'bounds': [r1(tx * TILE), r1(tz * TILE), r1((tx + 1) * TILE), r1((tz + 1) * TILE)],
                         'roads': [], 'buildings': [], 'areas': [], 'points': []} for k, (tx, tz) in keys.items()}

    def get(self, tx, tz):
        return self.data.get(key_of(tx, tz))

    def add_polygon(self, field, props, outer, holes):
        """Small polygons go to their centroid's tile; ones spanning several tiles are clipped per tile."""
        xs = [p[0] for p in outer]
        zs = [p[1] for p in outer]
        t0, t1 = tile_of(min(xs), min(zs)), tile_of(max(xs), max(zs))
        outer = orient(outer, True)
        holes = [orient(h, False) for h in holes]
        if t0 == t1 or field == 'buildings':
            tile = self.get(*tile_of(*centroid(outer)))
            if tile is not None:
                tile[field].append({**props, 'pts': flat(outer), 'holes': [flat(h) for h in holes]})
            return
        for tx in range(t0[0], t1[0] + 1):
            for tz in range(t0[1], t1[1] + 1):
                tile = self.get(tx, tz)
                if tile is None:
                    continue
                rect = (tx * TILE, tz * TILE, (tx + 1) * TILE, (tz + 1) * TILE)
                o = clip_ring(outer, *rect)
                if len(o) < 3 or abs(signed_area(o)) < 1.0:
                    continue
                hs = [flat(c) for c in (clip_ring(h, *rect) for h in holes) if len(c) >= 3]
                tile[field].append({**props, 'pts': flat(o), 'holes': hs})


def corridor_tiles(path):
    """Tiles within CORRIDOR of the path, in route order: (tx, tz) by key."""
    keys = {}
    reach = math.ceil(CORRIDOR / TILE)
    for (xa, za), (xb, zb) in zip(path, path[1:]):
        n = max(1, math.ceil(math.hypot(xb - xa, zb - za) / 25.0))
        for i in range(n + 1):
            x, z = xa + (xb - xa) * i / n, za + (zb - za) * i / n
            cx, cz = tile_of(x, z)
            cand = [(tx, tz) for tx in range(cx - reach, cx + reach + 1) for tz in range(cz - reach, cz + reach + 1)
                    if rect_dist(x, z, tx, tz) <= CORRIDOR]
            for tx, tz in sorted(cand, key=lambda t: rect_dist(x, z, *t)):
                keys.setdefault(key_of(tx, tz), (tx, tz))
    return keys


def fill_tiles(pbf, frame, tiles, rels, members, points):
    near = set()  # corridor dilated by 4 tiles: cheap first-node prefilter before reading whole ways
    for tx, tz in tiles.keys.values():
        for dx in range(-4, 5):
            for dz in range(-4, 5):
                near.add((tx + dx, tz + dz))

    for _id, lon, lat, kind in points:
        x, z = frame.xz(lon, lat)
        tile = tiles.get(*tile_of(x, z))
        if tile is not None:
            tile['points'].append({'kind': kind, 'x': r1(x), 'z': r1(z)})

    log('pass 4: multipolygon member ways')
    for w in way_reader(pbf, osmium.filter.IdFilter(members.keys())):
        pts = [node_xz(frame, nd) for nd in w.nodes]
        if len(pts) >= 2 and all(pts):  # else incomplete at the extract edge: its relation is dropped
            # compact arrays: members of every multipolygon in the extract are held until the corridor test below
            members[w.id] = (array('q', [nd.ref for nd in w.nodes]), array('d', [c for p in pts for c in p]))

    log('pass 5: corridor roads, buildings, areas')
    counts = dict(roads=0, buildings=0, areas=0)
    roads = []
    flt = osmium.filter.KeyFilter('highway', 'building', 'waterway', *AREA_KEYS)
    for w in way_reader(pbf, flt):
        nodes = w.nodes
        n = len(nodes)
        if n < 2:
            continue
        samples = [p for p in (node_xz(frame, nodes[0]), node_xz(frame, nodes[n // 2]), node_xz(frame, nodes[-1])) if p]
        if not any(tile_of(*p) in near for p in samples):
            continue
        pts = [p for p in (node_xz(frame, nd) for nd in nodes) if p]
        if len(pts) < 2:
            continue
        tags = w.tags
        closed = nodes[0].ref == nodes[-1].ref and n >= 4
        hw = tags.get('highway')
        if hw in TILE_ROADS and tags.get('area') != 'yes':
            if not any(tiles.get(*k) is not None for k, _ in split_by_tiles(pts)):
                continue
            a = way_attrs(tags, hw)
            refs = [nd.ref for nd in nodes if nd.location.valid()]
            if a['_dir'] < 0:
                pts, refs = pts[::-1], refs[::-1]  # oneway=-1: store in driving direction
            width = num(tags.get('width'))
            props = {'id': w.id, 'highway': hw, 'name': a['name'], 'lanes': a['lanes'],
                     'width': r1(width or a['lanes'] * LANE_WIDTH), 'oneway': a['oneway'], 'tunnel': a['tunnel'],
                     'bridge': a['bridge'], 'layer': a['layer']}
            roads.append({'props': props, 'refs': refs, 'pts': pts})  # split into tiles once heights are known
            counts['roads'] += 1
            continue
        if not closed:
            continue
        ring = pts[:-1]
        if tags.get('building', 'no') != 'no':
            tiles.add_polygon('buildings', building_props(w.id, tags), ring, [])
            counts['buildings'] += 1
            continue
        kind = area_kind(tags)
        if kind:
            tiles.add_polygon('areas', {'key': kind[0], 'kind': kind[1]}, ring, [])
            counts['areas'] += 1

    xs = [tx for tx, _ in tiles.keys.values()]
    zs = [tz for _, tz in tiles.keys.values()]
    cx0, cz0, cx1, cz1 = min(xs) * TILE, min(zs) * TILE, (max(xs) + 1) * TILE, (max(zs) + 1) * TILE
    for rid, tags, ms in rels:
        if not ms or any(members.get(ref) is None for ref, _ in ms):
            continue  # a member is missing from the extract
        flats = [members[ref][1] for ref, _ in ms]
        if max(max(f[0::2]) for f in flats) < cx0 or min(min(f[0::2]) for f in flats) > cx1 or \
                max(max(f[1::2]) for f in flats) < cz0 or min(min(f[1::2]) for f in flats) > cz1:
            continue
        parts = {ref: (list(members[ref][0]), list(zip(members[ref][1][0::2], members[ref][1][1::2]))) for ref, _ in ms}
        outers = assemble_rings([parts[ref] for ref, role in ms if role != 'inner'])
        inners = assemble_rings([parts[ref] for ref, role in ms if role == 'inner'])
        building = tags.get('building', 'no') != 'no'
        kind = None if building else area_kind(tags)
        if not building and not kind:
            continue
        for outer in outers:
            holes = [h for h in inners if point_in_ring(h[0][0], h[0][1], outer)]
            if building:
                tiles.add_polygon('buildings', building_props(-rid, tags), outer, holes)
                counts['buildings'] += 1
            else:
                tiles.add_polygon('areas', {'key': kind[0], 'kind': kind[1]}, outer, holes)
                counts['areas'] += 1
    log(f'  near-corridor features: {counts}')
    return roads


# ---------------------------------------------------------------------------------------------------------------------
# Terrain (phase 2)
# ---------------------------------------------------------------------------------------------------------------------

def build_terrain(args, frame, out, path, refs, segments, signals, tiles, roads):
    """Road heights, conformed tile grids, building bases and far.bin. Densifies the path (and tile roads) to
    terrain.SPACING so the vertical profile has points between far-apart OSM nodes; segment / signal indices are
    remapped. -> path, pathY, segments, signals, route.json `terrain`, {key: tile grid}"""
    log('terrain: DEM')
    xs, zs = [p[0] for p in path], [p[1] for p in path]
    step = terrain.FAR_STEP
    fx0 = math.floor((min(xs) - terrain.FAR_MARGIN) / step) * step
    fz0 = math.floor((min(zs) - terrain.FAR_MARGIN) / step) * step
    nx = math.ceil((max(xs) + terrain.FAR_MARGIN - fx0) / step) + 1
    nz = math.ceil((max(zs) + terrain.FAR_MARGIN - fz0) / step) + 1
    dem = terrain.Dem(args.dem_cache, frame,
                      terrain.tiles_for_bbox(frame, fx0, fz0, fx0 + (nx - 1) * step, fz0 + (nz - 1) * step), log)
    dem.prefetch()
    dem.urban = terrain.urban_weight(list(tiles.data.values()), TILE)
    log(f'  built-up weight: {np.count_nonzero(dem.urban[2] > 0.5)} of {dem.urban[2].size} cells')

    log('terrain: road heights')
    net = terrain.RoadNet()
    tunnel_ends = set()
    for r in roads:
        p = r['props']
        r['ids'], r['dense'], _ = net.add(r['refs'], r['pts'], p['highway'], p['bridge'], p['tunnel'])
        if p['tunnel']:
            tunnel_ends.update((r['refs'][0], r['refs'][-1]))
    route_ways = []
    for s in segments:
        ids, dense, _ = net.add(refs[s['i0']:s['i1'] + 1], path[s['i0']:s['i1'] + 1], s['highway'], s['bridge'],
                                s['tunnel'])
        route_ways.append((s, ids, dense))
        if s['tunnel']:
            tunnel_ends.update((refs[s['i0']], refs[s['i1']]))
    y = net.solve(dem.ground, log=log)

    keys, dpath, where = terrain.densify(refs, path)
    path_y = [float(y[net.index[k]]) for k in keys]
    segments = [{**s, 'i0': where[s['i0']], 'i1': where[s['i1']]} for s in segments]
    signals = [where[k] for k in signals]
    log(f'  path densified {len(path)} -> {len(dpath)} points')

    for r in roads:
        p = r['props']
        pts3 = [(x, z, y[i]) for (x, z), i in zip(r['dense'], r['ids'])]
        for (tx, tz), piece in split_by_tiles(pts3):
            tile = tiles.get(tx, tz)
            if tile is not None:
                tile['roads'].append({**p, 'pts': flat([q[:2] for q in piece]), 'ys': [r2(q[2]) for q in piece]})

    log('terrain: conformed tile grids')
    REACH = 120.0
    conform_ways = []   # (priority, way) for every road the ground meets
    for r in roads:
        p = r['props']
        if not p['tunnel']:   # bridges first: only trim the ground poking through their decks
            conform_ways.append(((-1 if p['bridge'] else 0, terrain.RANK.get(p['highway'], 0), p['layer']), {
                'pts': np.array(r['dense']), 'ys': y[r['ids']], 'half': p['width'] / 2, 'under': p['bridge'],
                'portal0': r['refs'][0] in tunnel_ends, 'portal1': r['refs'][-1] in tunnel_ends}))
    for s, ids, dense in route_ways:
        if not s['tunnel']:
            conform_ways.append(((-1 if s['bridge'] else 1, 0, 0), {
                'pts': np.array(dense), 'ys': y[ids], 'half': s['lanes'] * LANE_WIDTH / 2, 'under': s['bridge'],
                'portal0': refs[s['i0']] in tunnel_ends, 'portal1': refs[s['i1']] in tunnel_ends}))
    conform_ways.sort(key=lambda e: e[0])
    by_tile = {}
    for _prio, w in conform_ways:
        w['half'] += terrain.SHOULDER + terrain.GRID_SLACK
        w['ymin'], w['ymax'] = float(w['ys'].min()), float(w['ys'].max())
        (x0, z0), (x1, z1) = w['pts'].min(axis=0) - REACH, w['pts'].max(axis=0) + REACH
        for tx in range(math.floor(x0 / TILE), math.floor(x1 / TILE) + 1):
            for tz in range(math.floor(z0 / TILE), math.floor(z1 / TILE) + 1):
                if tiles.get(tx, tz) is not None:
                    by_tile.setdefault(key_of(tx, tz), []).append(w)
    n = terrain.TILE_N
    grids = {}
    for key, tile in tiles.data.items():
        tx0, tz0 = tile['tx'] * TILE, tile['tz'] * TILE
        gx, gz = np.meshgrid(tx0 + np.arange(n) * TILE / (n - 1), tz0 + np.arange(n) * TILE / (n - 1))
        G = dem.ground(gx.ravel(), gz.ravel()).reshape(n, n)
        gmin, gmax = float(G.min()), float(G.max())
        ways = by_tile.get(key, [])
        for w in ways:  # reach where the 1:2 slopes can still differ from this tile's ground: no step at its edge
            w['reach'] = min(REACH, 2 * max(gmax - w['ymin'], w['ymax'] - gmin, 0) + 2)
        grids[key] = terrain.conform(tx0, tz0, TILE, G, ways)
        for b in tile['buildings']:
            # shortcut: footprints reaching into the next tile are sampled clamped to this tile's grid
            bx, bz = b['pts'][0::2], b['pts'][1::2]
            b['baseY'] = r1(float(terrain.sample_grid(grids[key], tx0, tz0, TILE,
                                                      bx + [sum(bx) / len(bx)], bz + [sum(bz) / len(bz)]).min()))

    log('terrain: far grid')
    fgx, fgz = np.meshgrid(fx0 + np.arange(nx) * step, fz0 + np.arange(nz) * step)
    terrain.to_dm(dem.far(fgx.ravel(), fgz.ravel())).astype('<i2').tofile(os.path.join(out, 'far.bin'))
    meta = {'tileN': n, 'far': {'url': 'far.bin', 'minX': r1(fx0), 'minZ': r1(fz0), 'step': int(step),
                                'nx': nx, 'nz': nz}, 'attribution': terrain.ATTRIBUTION}
    profile_report(dpath, path_y, segments, dem)
    return dpath, path_y, segments, signals, meta, grids


def profile_report(path, path_y, segments, dem):
    """Sanity numbers on the route profile: steps, grades, tunnel cover, bridge clearance."""
    P = np.array(path)
    Y = np.array(path_y)
    l = np.hypot(*np.diff(P, axis=0).T)
    dy = np.diff(Y)
    steps = np.abs(dy[l < 0.5])
    grade = np.abs(dy) / np.maximum(l, 1e-9)
    G = dem.ground(P[:, 0], P[:, 1])
    log(f'  profile: y {Y.min():.1f} .. {Y.max():.1f} m, max step at coincident points '
        f'{steps.max() if len(steps) else 0:.3f} m')
    for name, classes in (('motorway/trunk', ('motorway', 'trunk')), ('other', None)):
        m = np.zeros(len(l), bool)
        for s in segments:
            if (s['highway'] in classes) if classes else (s['highway'] not in ('motorway', 'trunk')):
                m[s['i0']:s['i1']] = True
        m &= l >= 1
        if m.any():
            g = grade[m]
            log(f'  grade {name}: max {g.max() * 100:.1f} %, p99 {np.percentile(g, 99) * 100:.1f} %, '
                f'{l[m][g > 0.06].sum() / 1000:.2f} km over 6 %')
    for kind in ('tunnel', 'bridge'):
        segs = [s for s in segments if s[kind]]
        if not segs:
            continue
        idx = np.concatenate([np.arange(s['i0'], s['i1'] + 1) for s in segs])
        d = (G[idx] - Y[idx]) if kind == 'tunnel' else (Y[idx] - G[idx])
        what = 'cover (terrain above)' if kind == 'tunnel' else 'clearance (deck above ground)'
        log(f'  {len(segs)} {kind} segments, {len(idx)} points: {what} min {d.min():.1f} m, median '
            f'{np.median(d):.1f} m, {np.count_nonzero(d < 0) / len(d) * 100:.0f} % negative')


# ---------------------------------------------------------------------------------------------------------------------
# Main
# ---------------------------------------------------------------------------------------------------------------------

def build(args):
    ends = resolve_names(args.pbf, [args.from_, args.to])
    (fname, flat_, flon), (tname, tlat, tlon) = ends[args.from_], ends[args.to]
    if args.name and '→' in args.name:
        fname, tname = (fname or args.name.split('→')[0].strip()), (tname or args.name.split('→')[1].strip())
    frame = Frame(flat_, flon)
    start, end = (0.0, 0.0), frame.xz(tlon, tlat)
    span = math.hypot(*end)
    margin = max(5000.0, 0.15 * span)
    bbox = (min(0, end[0]) - margin, min(0, end[1]) - margin, max(0, end[0]) + margin, max(0, end[1]) + margin)
    log(f'straight-line distance {span / 1000:.1f} km, bbox margin {margin / 1000:.1f} km')

    points = read_points(args.pbf)
    signal_ids = {pid for pid, _lon, _lat, kind in points if kind == 'traffic_signals'}
    g = build_graph(args.pbf, frame, [start, end], bbox)
    nodes = route(g, start, end)
    del g['graph']

    path = [(float(g['xs'][i]), float(g['zs'][i])) for i in nodes]
    segments = []
    for k in range(len(nodes) - 1):
        wi = edge_way(g, nodes[k], nodes[k + 1])
        if segments and segments[-1][0] == wi:
            segments[-1][2] = k + 1
        else:
            segments.append([wi, k, k + 1])
    seg_out = []
    for wi, i0, i1 in segments:
        a = {key: val for key, val in g['ways'][wi].items() if key not in ('_dir', 'id')}
        seg_out.append({'i0': i0, 'i1': i1, **a})
    signals = [k for k, i in enumerate(nodes) if int(g['ids'][i]) in signal_ids]
    length = sum(math.hypot(b[0] - a[0], b[1] - a[1]) for a, b in zip(path, path[1:]))
    log(f'route {length / 1000:.2f} km, {len(path)} points, {len(seg_out)} segments, {len(signals)} signals')

    refs = [int(g['ids'][i]) for i in nodes]
    del g

    tiles = Tiles(corridor_tiles(path))
    log(f'corridor: {len(tiles.keys)} tiles')
    rels, members = read_relations(args.pbf)
    roads = fill_tiles(args.pbf, frame, tiles, rels, members, points)
    del rels, members, points

    out = os.path.join(args.out, args.id)
    if os.path.isdir(os.path.join(out, 'tiles')):
        shutil.rmtree(os.path.join(out, 'tiles'))
    os.makedirs(os.path.join(out, 'tiles'), exist_ok=True)
    path, path_y, seg_out, signals, terrain_meta, grids = build_terrain(args, frame, out, path, refs, seg_out,
                                                                       signals, tiles, roads)
    route_json = {
        'version': 2, 'id': args.id, 'name': args.name or f'{fname or args.from_} → {tname or args.to}',
        'from': {'name': fname, 'lat': flat_, 'lon': flon}, 'to': {'name': tname, 'lat': tlat, 'lon': tlon},
        'origin': {'lat': flat_, 'lon': flon}, 'lengthM': r1(length), 'tileSize': int(TILE),
        'path': flat(path), 'pathY': [r2(v) for v in path_y], 'segments': seg_out, 'signals': signals,
        'tiles': list(tiles.keys), 'terrain': terrain_meta,
    }
    dump = lambda obj: json.dumps(obj, ensure_ascii=False, separators=(',', ':'))
    with open(os.path.join(out, 'route.json'), 'w', encoding='utf-8') as f:
        f.write(dump(route_json))
    for key, tile in tiles.data.items():
        p = os.path.join(out, 'tiles', key + '.json')
        with open(p, 'w', encoding='utf-8') as f:
            f.write(dump(tile))
        terrain.to_dm(grids[key]).astype('<i2').tofile(os.path.join(out, 'tiles', key + '.terrain.bin'))
    total = sum(e.stat().st_size for d in (out, os.path.join(out, 'tiles')) for e in os.scandir(d) if e.is_file())

    check(route_json, tiles)
    nb = [len(t['buildings']) for t in tiles.data.values()]
    nr = [len(t['roads']) for t in tiles.data.values()]
    log(f'wrote {out}: {total / 1e6:.2f} MB, {len(tiles.data)} tiles, {sum(nb)} buildings '
        f'(max {max(nb)}/tile), {sum(nr)} road pieces (max {max(nr)}/tile), '
        f'{sum(len(t["areas"]) for t in tiles.data.values())} areas, '
        f'{sum(len(t["points"]) for t in tiles.data.values())} points')
    try:
        import psutil
        info = psutil.Process().memory_info()
        log(f'peak memory {getattr(info, "peak_wset", info.rss) / 1e9:.2f} GB')
    except ImportError:
        pass


def check(route_json, tiles):
    """Sanity checks on the output: contiguous segments, every path point inside a corridor tile."""
    path = route_json['path']
    n = len(path) // 2
    segs = route_json['segments']
    assert segs[0]['i0'] == 0 and segs[-1]['i1'] == n - 1, 'segments must cover the path'
    assert all(a['i1'] == b['i0'] for a, b in zip(segs, segs[1:])), 'segments must be contiguous'
    gaps = [math.hypot(path[2 * i + 2] - path[2 * i], path[2 * i + 3] - path[2 * i + 1]) for i in range(n - 1)]
    log(f'check: longest path step {max(gaps):.0f} m')
    for i in range(n):
        assert tiles.get(*tile_of(path[2 * i], path[2 * i + 1])) is not None, f'path point {i} outside the corridor'
    assert len(route_json['pathY']) == n, 'pathY must have one height per path point'
    for t in tiles.data.values():
        assert all(len(r['ys']) * 2 == len(r['pts']) for r in t['roads']), 'road ys must match pts'
        assert all('baseY' in b for b in t['buildings'])


def self_test():
    sq = [(0, 0), (10, 0), (10, 10), (0, 10)]  # x east, z south: E, then south... clockwise seen from above
    assert signed_area(sq) > 0 and signed_area(orient(sq, True)) < 0
    assert point_in_ring(5, 5, sq) and not point_in_ring(15, 5, sq)
    assert centroid(sq) == (5, 5)
    c = clip_ring([(-100, 100), (600, 100), (600, 200), (-100, 200)], 0, 0, 500, 500)
    assert abs(abs(signed_area(c)) - 500 * 100) < 1e-6
    pieces = split_by_tiles([(-10, 10), (510, 10), (510, 520)])
    assert [k for k, _ in pieces] == [(-1, 0), (0, 0), (1, 0), (1, 1)] and pieces[1][1] == [(0, 10), (500, 10)]
    pieces = split_by_tiles([(-10, 0, 1.0), (490, 0, 51.0)])   # extra values are interpolated at the border
    assert pieces[0][1][-1] == (0, 0, 2.0) and pieces[1][1][0] == (0, 0, 2.0)
    rings = assemble_rings([([1, 2, 3], [(0, 0), (1, 0), (1, 1)]), ([1, 4, 3], [(0, 0), (0, 1), (1, 1)])])
    assert len(rings) == 1 and len(rings[0]) == 4
    a = way_attrs({'oneway': '-1', 'lanes': '3', 'maxspeed': '60'}, 'primary')
    assert a['_dir'] == -1 and a['lanes'] == 3 and a['lanesTagged'] and a['maxspeed'] == 60
    assert way_attrs({}, 'motorway')['oneway'] and not way_attrs({}, 'residential')['maxspeedTagged']
    print('self-test ok')
    terrain.self_test()


def main():
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument('--pbf')
    ap.add_argument('--from', dest='from_', help='lat,lon or an OSM place/station name')
    ap.add_argument('--to')
    ap.add_argument('--id')
    ap.add_argument('--name')
    ap.add_argument('--out', default='data/drive')
    ap.add_argument('--dem-cache', default=r'C:\Users\ouor\Downloads\_\dem-copernicus',
                    help='folder of Copernicus GLO-30 tiles (missing ones are downloaded)')
    ap.add_argument('--self-test', action='store_true')
    args = ap.parse_args()
    if args.self_test:
        return self_test()
    if not (args.pbf and args.from_ and args.to and args.id):
        ap.error('--pbf, --from, --to and --id are required')
    build(args)


if __name__ == '__main__':
    main()
