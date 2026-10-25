import * as THREE from 'three/webgpu';
import { SegmentGrid, pointInPolygon, ringBounds } from './world-geometry.js';
import { getWorldMaterials, portalUniforms, MAX_PORTALS } from './world-materials.js';
import { buildTerrain } from './world-terrain.js';
import { buildRoads } from './world-roads.js';
import { buildStructures } from './world-structures.js';
import { buildBuildings, residentialAreas } from './world-buildings.js';
import { buildProps, geometryFrom } from './world-props.js';
import { buildRural } from './world-rural.js';
import { createFarTerrain } from './world-far.js';
import { createTileSampler, createFarSampler } from './terrain-sample.js';

// js/drive/world-builder.js
// Procedural Korea for Korea Drive (contract in docs/drive.md): turns each streamed 500 m tile into a group of a few
// merged meshes per material — terrain & water (world-terrain.js), roads, paint, sidewalks, curbs & fences
// (world-roads.js), bridges, tunnels, barriers & retaining walls (world-structures.js), buildings, roofs & signs
// (world-buildings.js) — plus instanced street furniture (world-props.js) and the rural scenery of world-rural.js.
// Materials are shared by every tile (world-materials.js). The work runs as generators sliced into ≈ 8 ms chunks
// with a yield to the browser between them, so streaming tiles in never hitches the drive.
// Around it all, a far-terrain grid out to the horizon (world-far.js, phase 2 routes). update(camera) picks each
// tile's terrain detail (every other vertex beyond 1.2 km), culls far tiles, and hands the terrain shader the tunnel
// mouths nearest the camera.

const SLICE_MS = 8;
const TERRAIN_LOD_M = 1200; // m from the camera beyond which a tile's terrain drops to every other vertex
const CULL_M = 9000; // tiles beyond this are hidden (the far terrain stands in)
const yieldToBrowser = () => (globalThis.scheduler?.yield ? globalThis.scheduler.yield() : new Promise((resolve) => setTimeout(resolve, 0)));
const CANCELLED = Symbol('cancelled');

const toV2 = (ring) => {
  const out = [];
  for (let i = 0; i < ring.length; i += 2) out.push(new THREE.Vector2(ring[i], ring[i + 1]));
  return out;
};
const triangulate = (outer, holes) => THREE.ShapeUtils.triangulateShape(toV2(outer), holes.map(toV2));

function createWorldBuilder(scene, { route } = {}) {
  const materials = getWorldMaterials();
  const tiles = new Map(); // key → { root, owned, props, rural, terrain: [near, coarse], portals, box, state }
  const far = route?.far ? createFarTerrain(scene, route) : null;
  const farSampler = route?.far ? createFarSampler(route.far, route.far.heights) : null;
  const stats = { tiles: 0, totalMs: 0, maxMs: 0 }; // CPU time of buildTile (excluding the yields)

  // The route centreline, so the roads it drives on are never hidden under another deck
  const routeGrid = new SegmentGrid(20);
  if (route?.path?.length >= 4) routeGrid.add(route.path, 2.5, 0);

  // Runs a generator to completion in ≈ SLICE_MS slices; throws CANCELLED once the tile was removed meanwhile
  async function run(gen, state) {
    let t0 = performance.now();
    for (;;) {
      const { done, value } = gen.next();
      if (done) {
        state.ms += performance.now() - t0;
        return value;
      }
      if (performance.now() - t0 > SLICE_MS) {
        state.ms += performance.now() - t0;
        await yieldToBrowser();
        if (state.cancelled) throw CANCELLED;
        t0 = performance.now();
      }
    }
  }
  const pause = async (state) => {
    await yieldToBrowser();
    if (state.cancelled) throw CANCELLED;
  };

  async function buildTile(tile) {
    const key = tile.key ?? `${tile.tx}_${tile.tz}`;
    if (tiles.has(key)) removeTile(key);
    const state = { cancelled: false, ms: 0 };
    const root = new THREE.Group();
    root.name = `Tile_${key}`;
    const entry = { root, owned: [], props: null, rural: null, terrain: null, portals: [], box: new THREE.Box3(), state };
    tiles.set(key, entry);

    const add = (md, material, name, { cast = false, receive = true, order = 0 } = {}) => {
      if (!md || md.empty) return null;
      const geometry = geometryFrom(md);
      entry.owned.push(geometry);
      const mesh = new THREE.Mesh(geometry, material);
      mesh.name = name;
      mesh.castShadow = cast;
      mesh.receiveShadow = receive;
      mesh.renderOrder = order;
      root.add(mesh);
      return mesh;
    };
    try {
      const roads = await run(buildRoads(tile, routeGrid), state);
      const m = roads.meshes;
      add(m.road, materials.road, 'Roads');
      add(m.paint, materials.paint, 'RoadMarkings', { order: -1 });
      add(m.sidewalk, materials.sidewalk, 'Sidewalks');
      add(m.curb, materials.curb, 'Curbs');
      add(m.concrete, materials.concrete, 'Medians', { cast: true });
      add(m.prop, materials.prop, 'Fences', { cast: true });
      await pause(state);

      const terrain = await run(buildTerrain({ ...tile, key }, { roads: roads.roads, triangulate }), state);
      entry.terrain = terrainMeshes(terrain, materials.terrain, entry.owned);
      for (const mesh of entry.terrain) root.add(mesh);
      add(terrain.water, materials.water, 'Water');
      if (terrain.sea) {
        const [x0, z0, x1, z1] = terrain.bounds;
        const sea = new THREE.Mesh(new THREE.PlaneGeometry(x1 - x0, z1 - z0).rotateX(-Math.PI / 2).translate((x0 + x1) / 2, 0, (z0 + z1) / 2), materials.water);
        sea.name = 'Sea';
        entry.owned.push(sea.geometry);
        root.add(sea);
      }
      const sampler = createTileSampler({ bounds: terrain.bounds }, terrain.heights);
      await pause(state);

      // Footprint lookup (homes near the expressways, no trees inside buildings)
      const cells = new Map();
      for (const b of tile.buildings || []) {
        if (!b.pts || b.pts.length < 6) continue;
        const box = ringBounds(b.pts);
        for (let ix = Math.floor(box.minX / 25); ix <= Math.floor(box.maxX / 25); ix++) {
          for (let iz = Math.floor(box.minZ / 25); iz <= Math.floor(box.maxZ / 25); iz++) {
            const k = `${ix},${iz}`;
            if (!cells.has(k)) cells.set(k, []);
            cells.get(k).push(b);
          }
        }
      }
      const inBuilding = (x, z) => (cells.get(`${Math.floor(x / 25)},${Math.floor(z / 25)}`) || []).some((b) => pointInPolygon(b.pts, b.holes, x, z));
      const residential = residentialAreas(tile);
      const nearHomes = (x, z) => {
        for (let dx = -2; dx <= 2; dx++) for (let dz = -2; dz <= 2; dz++) if (cells.has(`${Math.floor(x / 25) + dx},${Math.floor(z / 25) + dz}`)) return true;
        return residential.some((a) => x >= a.box.minX && x <= a.box.maxX && z >= a.box.minZ && z <= a.box.maxZ && pointInPolygon(a.pts, a.holes, x, z));
      };

      const structures = await run(buildStructures(tile, roads, { heightAt: sampler.heightAt, triangulate, nearHomes }), state);
      const s = structures.meshes;
      add(s.concrete, materials.concrete, 'Structures', { cast: true });
      add(s.prop, materials.prop, 'Guardrails', { cast: true });
      add(s.lining, materials.lining, 'TunnelLining');
      add(s.lamp, materials.tunnelLamp, 'TunnelLamps', { receive: false });
      add(s.glow, materials.glow, 'TunnelSigns', { receive: false });
      add(s.glass, materials.glass, 'NoiseBarrierPanels', { receive: false, order: 1 });
      entry.portals = structures.portals;
      await pause(state);

      const buildings = await run(buildBuildings(tile, { grid: roads.grid, roads: roads.roads, residential, triangulate }), state);
      add(buildings.meshes.facade, materials.facade, 'Buildings', { cast: true });
      add(buildings.meshes.roof, materials.roof, 'Roofs', { cast: true });
      add(buildings.meshes.glow, materials.glow, 'Signs');
      await pause(state);

      const props = await run(buildProps({ ...tile, key }, roads, materials, inBuilding, sampler.heightAt), state);
      root.add(props.group);
      entry.props = props;

      // Rural scenery (world-rural.js, async, slices itself, not cancellable): { root, update(camera), dispose() } or
      // null; its root comes with its matrices set and is added after the traverse below
      const rural = await buildRural(tile, { route, tile, sampler, far: farSampler, materials, seed: hashKey(key) });
      if (state.cancelled) {
        rural?.dispose?.();
        throw CANCELLED;
      }
      entry.rural = rural || null;
    } catch (e) {
      disposeEntry(entry);
      if (e === CANCELLED) return null;
      if (tiles.get(key) === entry) tiles.delete(key);
      throw e;
    }
    if (state.cancelled) {
      disposeEntry(entry);
      return null;
    }

    root.traverse((o) => {
      o.updateMatrix();
      o.matrixAutoUpdate = false;
    });
    root.updateMatrixWorld(true);
    if (entry.rural?.root) root.add(entry.rural.root);
    entry.box.setFromObject(entry.terrain[0]);
    scene.add(root);
    far?.setTile(tile.tx, tile.tz, true);
    stats.tiles++;
    stats.totalMs += state.ms;
    stats.maxMs = Math.max(stats.maxMs, state.ms);
    return root;
  }

  function disposeEntry(entry) {
    entry.root.removeFromParent();
    for (const g of entry.owned) g.dispose();
    if (entry.props) entry.props.dispose();
    if (entry.rural?.dispose) entry.rural.dispose();
    entry.owned.length = 0;
  }

  function removeTile(key) {
    const entry = tiles.get(key);
    if (!entry) return;
    entry.state.cancelled = true;
    disposeEntry(entry);
    tiles.delete(key);
    const [tx, tz] = key.split('_').map(Number);
    far?.setTile(tx, tz, false);
  }

  const camPos = new THREE.Vector3();
  const nearest = [];
  function update(camera) {
    camPos.setFromMatrixPosition(camera.matrixWorld);
    far?.update(camPos);
    nearest.length = 0;
    for (const entry of tiles.values()) {
      if (!entry.terrain) continue;
      const d = entry.box.distanceToPoint(camPos);
      entry.root.visible = d < CULL_M;
      entry.terrain[0].visible = d < TERRAIN_LOD_M;
      entry.terrain[1].visible = d >= TERRAIN_LOD_M;
      if (!entry.root.visible) continue;
      if (entry.props) entry.props.update(camPos);
      if (entry.rural?.update) entry.rural.update(camera);
      for (const p of entry.portals) nearest.push({ p, d: Math.hypot(p.x - camPos.x, p.z - camPos.z) });
    }
    // The tunnel mouths nearest the camera are cut out of the terrain
    nearest.sort((a, b) => a.d - b.d);
    const a = portalUniforms.array;
    for (let k = 0; k < MAX_PORTALS; k++) {
      const p = nearest[k]?.p;
      if (p) {
        a[k * 2].set(p.x, p.z, p.dx, p.dz);
        a[k * 2 + 1].set(p.y, p.grade, p.halfW, p.height);
      } else a[k * 2 + 1].set(0, 0, -1, 0);
    }
  }

  return { buildTile, removeTile, update, stats };
}

// Terrain arrays → two meshes sharing one vertex buffer: every vertex (near) and every other vertex (far)
function terrainMeshes(t, material, owned) {
  const attrs = {
    position: new THREE.BufferAttribute(t.position, 3),
    normal: new THREE.BufferAttribute(t.normal, 3),
    tint: new THREE.BufferAttribute(t.tint, 3),
    land: new THREE.BufferAttribute(t.land, 4)
  };
  return t.index.map((idx, lod) => {
    const g = new THREE.BufferGeometry();
    for (const [name, attr] of Object.entries(attrs)) g.setAttribute(name, attr);
    g.setIndex(new THREE.BufferAttribute(idx, 1));
    g.computeBoundingSphere();
    // The coarse geometry only owns its index: the shared attributes are freed with the near one
    owned.push(lod === 0 ? g : { dispose: () => { for (const name of Object.keys(attrs)) g.deleteAttribute(name); g.dispose(); } });
    const mesh = new THREE.Mesh(g, material);
    mesh.name = lod ? 'TerrainCoarse' : 'Terrain';
    mesh.receiveShadow = true;
    mesh.visible = lod === 0;
    return mesh;
  });
}

const hashKey = (key) => {
  let h = 2166136261;
  for (let i = 0; i < key.length; i++) h = Math.imul(h ^ key.charCodeAt(i), 16777619);
  return h >>> 0;
};

export { createWorldBuilder };
