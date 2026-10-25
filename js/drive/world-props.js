import * as THREE from 'three/webgpu';
import { buildTreeGeometries, TREE_SPECIES } from '../trees.js';
import { MeshData, mulberry32, hashId, pointInPolygon, ringArea, ringBounds } from './world-geometry.js';

// js/drive/world-props.js
// Street furniture of one tile, instanced on templates built once:
// - street trees (London plane & elm-like 느티나무 from js/trees.js) along the sidewalks every ~9–12 m, the mapped
//   trees, and groves scattered through parks (and through woods in city tiles: countryside woods are world-rural.js's);
//   two levels of detail per 125 m cell, picked in update()
// Everything stands on the sidewalk / road profile it was placed along, or on the tile's ground (heightAt).
// - tall single-arm street lamps along the main roads and on the bridge parapets, heads lit at night
// - cantilever traffic signals with horizontal heads at the approaches of main-road intersections & mapped signals
// - concrete utility poles with sagging wires along the small streets (characteristic Seoul overhead cabling)
// - bus shelters every few hundred metres on the main roads

const TREE_CELL = 125;
const TREE_NEAR = 150; // m from a cell's box: branch-level trees within, whole-crown cards beyond
const TREE_FAR = 700;
const PROP_FAR = 450; // lamps, signals, poles & wires beyond this are hidden

let templates = null;

function geometryFrom(md) {
  const a = md.arrays();
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.BufferAttribute(a.position, 3));
  g.setAttribute('normal', new THREE.BufferAttribute(a.normal, 3));
  for (const e of md.extra) g.setAttribute(e.name, new THREE.BufferAttribute(a[e.name], e.size));
  g.setIndex(new THREE.BufferAttribute(a.index, 1));
  g.computeBoundingSphere();
  return g;
}

// Templates in their own frame: arms reach along +x, signal lenses face -z, the base at y = 0
function getTemplates(atlas) {
  if (templates) return templates;
  const lamp = new MeshData({ tint: 3 });
  lamp.set('tint', 0.5, 0.52, 0.55);
  lamp.cylinder(0, 0, 0, 0.11, 9.2, 8);
  lamp.box(1.3, 9.0, 0, 2.6, 0.12, 0.12);
  lamp.box(2.7, 8.88, 0, 0.9, 0.22, 0.38);
  const lampHead = new MeshData({ glow: 4 });
  lampHead.set('glow', 1.0, 0.82, 0.55, 0);
  lampHead.box(2.75, 8.84, 0, 0.7, 0.05, 0.28);

  const signal = new MeshData({ tint: 3 });
  signal.set('tint', 0.36, 0.38, 0.4);
  signal.cylinder(0, 0, 0, 0.15, 6.6, 8);
  signal.box(2.9, 6.1, 0, 5.8, 0.18, 0.18);
  signal.set('tint', 0.1, 0.1, 0.11);
  signal.box(4.6, 5.55, 0, 1.55, 0.5, 0.35);
  signal.box(1.0, 2.6, 0.05, 0.4, 0.8, 0.25); // pedestrian head on the pole
  const lenses = new MeshData({ glow: 4 });
  for (const [k, c] of [[0, [0.25, 0.04, 0.03, 1]], [1, [0.3, 0.2, 0.02, 1]], [2, [0.1, 1.0, 0.55, 1]]]) {
    lenses.set('glow', ...c);
    lenses.box(4.1 + k * 0.48, 5.6, -0.19, 0.3, 0.3, 0.04);
  }

  const pole = new MeshData({ tint: 3 });
  pole.set('tint', 0.62, 0.61, 0.58);
  pole.cylinder(0, 0, 0, 0.17, 10.5, 8);
  pole.set('tint', 0.3, 0.3, 0.3);
  pole.box(0, 9.6, 0, 1.8, 0.12, 0.12);
  pole.box(0, 8.4, 0, 1.2, 0.1, 0.1);
  pole.set('tint', 0.55, 0.57, 0.58);
  pole.cylinder(0.35, 7.0, 0, 0.28, 1.0, 8); // transformer

  const tree = [0, 2].map((sp) => buildTreeGeometries(sp, 0, atlas.tileMeters));
  templates = {
    lamp: geometryFrom(lamp), lampHead: geometryFrom(lampHead), signal: geometryFrom(signal), lenses: geometryFrom(lenses),
    pole: geometryFrom(pole),
    // [species slot][lod: 0 = branches (lod 1 of trees.js), 1 = crown cards (lod 2)]
    tree: tree.map((lods) => [lods[1], lods[2]])
  };
  return templates;
}

const dummy = new THREE.Object3D();
function instanced(geometry, material, list, name) {
  const mesh = new THREE.InstancedMesh(geometry, material, list.length);
  list.forEach((t, i) => {
    dummy.position.set(t.x, t.y || 0, t.z);
    dummy.rotation.set(0, t.yaw || 0, 0);
    dummy.scale.setScalar(t.s || 1);
    dummy.updateMatrix();
    mesh.setMatrixAt(i, dummy.matrix);
  });
  mesh.name = name;
  mesh.castShadow = true;
  mesh.receiveShadow = true;
  mesh.computeBoundingSphere();
  return mesh;
}

// yaw turning a template's +x onto (ax, az)
const yawOf = (ax, az) => Math.atan2(-az, ax);

/**
 * Builds the tile's props from the road analysis (world-roads.js) and areas. Returns
 * { group, update(cameraPosition), dispose() }; a generator so the builder can slice it.
 */
function* buildProps(tile, roads, materials, buildingsBlock, heightAt = () => 0) {
  const T = getTemplates(materials.leafAtlas);
  const group = new THREE.Group();
  group.name = `Props_${tile.key}`;
  const owned = []; // per-tile geometries to dispose
  const wrappers = []; // tree geometries sharing the template's attributes
  const { grid, roads: list, walkSites, lampSites, signalSites, smallStreets } = roads;
  const blocked = (x, z) => grid.covering(x, z, 0.4) || buildingsBlock(x, z);

  // Street trees, lamps & bus stops along the sidewalks
  const trees = [];
  const lamps = [];
  const shelters = new MeshData({ tint: 3 });
  for (const w of walkSites) {
    const id = w.road.src.id;
    const spacing = 9 + (hashId(id, w.side) % 1000) / 333;
    if (w.sw >= 2.5 && w.s % spacing < 3 && !grid.covering(w.x, w.z, 0.6)) {
      trees.push({ x: w.x, y: w.y, z: w.z, sp: hashId(id, 3) % 5 < 3 ? 0 : 1, seed: hashId(Math.round(w.x * 10), Math.round(w.z * 10)) });
    }
    // One shelter every ~350 m of main road, on the right-hand sidewalk
    if ((w.road.hw === 'primary' || w.road.hw === 'secondary') && w.side > 0 && w.sw >= 3.5 && w.s % 350 >= 170 && w.s % 350 < 173 &&
      hashId(id, Math.floor(w.s / 350)) % 3 === 0) {
      const yaw = yawOf(w.dx, w.dz);
      const ox = w.x + w.rx * 0.4, oz = w.z + w.rz * 0.4;
      const y = w.y;
      shelters.set('tint', 0.32, 0.36, 0.42);
      shelters.box(ox, y + 2.5, oz, 4.2, 0.12, 1.7, yaw);
      shelters.box(ox + w.rx * 0.75 + w.dx * 2, y, oz + w.rz * 0.75 + w.dz * 2, 0.1, 2.5, 0.1, yaw);
      shelters.box(ox + w.rx * 0.75 - w.dx * 2, y, oz + w.rz * 0.75 - w.dz * 2, 0.1, 2.5, 0.1, yaw);
      shelters.set('tint', 0.55, 0.66, 0.72);
      shelters.box(ox + w.rx * 0.8, y + 0.3, oz + w.rz * 0.8, 4.0, 2.1, 0.05, yaw);
      shelters.set('tint', 0.4, 0.42, 0.45);
      shelters.box(ox + w.rx * 0.5, y + 0.15, oz + w.rz * 0.5, 2.6, 0.3, 0.4, yaw);
    }
  }
  for (const l of lampSites) {
    if (!l.bridge && (!l.road || !(l.road.hw === 'primary' || l.road.hw === 'secondary' || l.road.hw === 'tertiary' || l.road.hw === 'trunk'))) continue;
    if (!l.bridge && (l.s + (hashId(l.road.src.id, l.side) % 30)) % 32 >= 3) continue;
    lamps.push({ x: l.x, y: l.y, z: l.z, yaw: yawOf(l.ax, l.az) });
  }
  for (const p of tile.points || []) {
    if (p.kind === 'tree') trees.push({ x: p.x, y: heightAt(p.x, p.z), z: p.z, sp: 0, seed: hashId(Math.round(p.x * 10), Math.round(p.z * 10)) });
    else if (p.kind === 'street_lamp' && !lamps.some((l) => Math.hypot(l.x - p.x, l.z - p.z) < 8)) lamps.push({ x: p.x, z: p.z, y: heightAt(p.x, p.z) + 0.15, yaw: 0 });
  }
  yield;

  // Groves in parks, and woods in the city (seeded per area, capped)
  const city = (tile.buildings || []).length >= 30;
  for (const a of tile.areas || []) {
    const kind = a.kind;
    const dense = city && (kind === 'wood' || kind === 'forest');
    if (!(dense || kind === 'park' || kind === 'garden' || kind === 'grass' || kind === 'greenery' || kind === 'military')) continue;
    const area = Math.abs(ringArea(a.pts));
    const box = ringBounds(a.pts);
    const rng = mulberry32(hashId(Math.round(box.minX * 7 + box.minZ * 13), 5));
    const want = Math.min(dense ? 260 : 90, Math.floor(area / (dense ? 70 : kind === 'military' ? 600 : 220)));
    for (let k = 0, tries = 0; k < want && tries < want * 3; tries++) {
      const x = box.minX + rng() * (box.maxX - box.minX), z = box.minZ + rng() * (box.maxZ - box.minZ);
      if (!pointInPolygon(a.pts, a.holes, x, z) || blocked(x, z)) continue;
      trees.push({ x, y: heightAt(x, z), z, sp: rng() < 0.5 ? 0 : 1, seed: Math.floor(rng() * 1e9), park: true });
      k++;
    }
  }
  yield;

  // Trees: per 125 m cell, per species, a near & a far instanced mesh (update() shows one of them)
  const cells = new Map();
  const tint = new THREE.Color();
  for (const t of trees) {
    const key = `${Math.floor(t.x / TREE_CELL)},${Math.floor(t.z / TREE_CELL)}`;
    if (!cells.has(key)) cells.set(key, { box: new THREE.Box3(), lists: [[], []], meshes: [] });
    const c = cells.get(key);
    c.lists[t.sp].push(t);
    c.box.expandByPoint(new THREE.Vector3(t.x, t.y, t.z));
  }
  const treeCells = [];
  for (const c of cells.values()) {
    c.box.expandByScalar(4);
    for (let sp = 0; sp < 2; sp++) {
      const list = c.lists[sp];
      if (!list.length) continue;
      const speciesIndex = sp === 0 ? 0 : 2;
      const data = new Float32Array(list.length * 4);
      const sites = list.map((t, i) => {
        const r = mulberry32(t.seed);
        const s = (t.park ? 0.75 : 0.62) + r() * 0.25;
        tint.setHex(TREE_SPECIES[speciesIndex].tints[Math.floor(r() * 2.999)]).multiplyScalar(0.82 + r() * 0.36);
        data.set([tint.r, tint.g, tint.b, speciesIndex + r() * 0.999], i * 4);
        return { x: t.x, y: t.y, z: t.z, yaw: r() * Math.PI * 2, s };
      });
      for (let lod = 0; lod < 2; lod++) {
        const src = T.tree[sp][lod];
        const geo = new THREE.BufferGeometry();
        for (const name of Object.keys(src.attributes)) geo.setAttribute(name, src.attributes[name]);
        geo.setIndex(src.index);
        geo.setAttribute('aTreeData', new THREE.InstancedBufferAttribute(data, 4));
        wrappers.push(geo);
        const mesh = instanced(geo, materials.tree, sites, `Trees_${sp}_${lod}`);
        mesh.boundingSphere.radius += 3; // wind sway
        mesh.visible = false;
        c.meshes[lod] = (c.meshes[lod] || []).concat(mesh);
        group.add(mesh);
      }
    }
    treeCells.push(c);
  }
  yield;

  // Lamps, signals, utility poles
  const near = new THREE.Group();
  near.name = 'NearProps';
  group.add(near);
  if (lamps.length) {
    near.add(instanced(T.lamp, materials.prop, lamps, 'Lamps'));
    near.add(instanced(T.lampHead, materials.glow, lamps, 'LampHeads'));
  }
  const signals = signalSites.map((s) => ({ x: s.x, y: s.y, z: s.z, yaw: yawOf(s.tz, -s.tx) }));
  if (signals.length) {
    near.add(instanced(T.signal, materials.prop, signals, 'Signals'));
    near.add(instanced(T.lenses, materials.glow, signals, 'SignalLenses'));
  }

  // Utility poles every ~28 m on one side of the small streets, wires sagging between them
  const poles = [];
  const wire = [];
  for (const r of smallStreets) {
    const side = hashId(r.src.id, 2) % 2 ? 1 : -1;
    let prev = null;
    let s = (hashId(r.src.id, 4) % 20);
    const pts = r.src.pts;
    let acc = 0;
    for (let i = 0; i + 3 < pts.length; i += 2) {
      const ax = pts[i], az = pts[i + 1], bx = pts[i + 2], bz = pts[i + 3];
      const len = Math.hypot(bx - ax, bz - az);
      if (len < 1e-3) continue;
      const dx = (bx - ax) / len, dz = (bz - az) / len;
      for (; s < acc + len; s += 28) {
        const t = s - acc;
        const x = ax + dx * t - dz * side * (r.half + 0.45), z = az + dz * t + dx * side * (r.half + 0.45);
        if (grid.covering(x, z, 0.3)) { prev = null; continue; }
        const y = heightAt(x, z);
        poles.push({ x, y, z, yaw: yawOf(-dz * side, dx * side) });
        if (prev) {
          for (const [h, o] of [[9.75, 0.75], [9.75, -0.75], [8.55, 0.5]]) {
            const ox = -dz * o, oz = dx * o;
            for (let k = 0; k < 6; k++) {
              const u0 = k / 6, u1 = (k + 1) / 6;
              const y0 = prev.y + (y - prev.y) * u0 + h - Math.sin(u0 * Math.PI) * 0.55, y1 = prev.y + (y - prev.y) * u1 + h - Math.sin(u1 * Math.PI) * 0.55;
              wire.push(prev.x + (x - prev.x) * u0 + ox, y0, prev.z + (z - prev.z) * u0 + oz,
                prev.x + (x - prev.x) * u1 + ox, y1, prev.z + (z - prev.z) * u1 + oz);
            }
          }
        }
        prev = { x, y, z };
      }
      acc += len;
    }
  }
  if (poles.length) near.add(instanced(T.pole, materials.concrete, poles, 'UtilityPoles'));
  if (wire.length) {
    const g = new THREE.BufferGeometry();
    g.setAttribute('position', new THREE.Float32BufferAttribute(wire, 3));
    g.computeBoundingSphere();
    owned.push(g);
    const lines = new THREE.LineSegments(g, materials.wire);
    lines.name = 'Wires';
    near.add(lines);
  }
  if (!shelters.empty) {
    const g = geometryFrom(shelters);
    owned.push(g);
    const m = new THREE.Mesh(g, materials.prop);
    m.name = 'BusShelters';
    m.castShadow = m.receiveShadow = true;
    near.add(m);
  }
  const nearBox = new THREE.Box3().setFromObject(near);

  function update(cam) {
    near.visible = nearBox.isEmpty() ? false : nearBox.distanceToPoint(cam) < PROP_FAR;
    for (const c of treeCells) {
      const d = c.box.distanceToPoint(cam);
      for (const m of c.meshes[0]) m.visible = d < TREE_NEAR;
      for (const m of c.meshes[1]) m.visible = d >= TREE_NEAR && d < TREE_FAR;
    }
  }
  function dispose() {
    for (const g of owned) g.dispose();
    // Disposing a geometry frees its attributes' GPU buffers: detach the shared template ones first
    for (const g of wrappers) {
      for (const name of Object.keys(g.attributes)) if (name !== 'aTreeData') g.deleteAttribute(name);
      g.setIndex(null);
      g.dispose();
    }
    group.traverse((o) => { if (o.isInstancedMesh) o.dispose(); });
  }
  return { group, update, dispose };
}

export { buildProps, geometryFrom };
