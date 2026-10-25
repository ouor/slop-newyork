import * as THREE from 'three/webgpu';
import { SegmentGrid, pointInPolygon, ringBounds } from './world-geometry.js';
import { getWorldMaterials } from './world-materials.js';
import { buildGround } from './world-ground.js';
import { buildRoads } from './world-roads.js';
import { buildBuildings, residentialAreas } from './world-buildings.js';
import { buildProps, geometryFrom } from './world-props.js';

// js/drive/world-builder.js
// Procedural Seoul for Korea Drive (contract in docs/drive.md): turns each streamed 500 m tile into a group of a few
// merged meshes per material — ground & water (world-ground.js), roads, paint, sidewalks, curbs, bridges & fences
// (world-roads.js), buildings, roofs & signs (world-buildings.js) — plus instanced street furniture (world-props.js).
// Materials are shared by every tile (world-materials.js). The work runs as generators sliced into ≈ 8 ms chunks
// with a yield to the browser between them, so streaming tiles in never hitches the drive.

const SLICE_MS = 8;
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
  const tiles = new Map(); // key → { root, owned, props, state }

  // The route centreline, so the roads it drives on are never hidden under another deck
  const routeGrid = new SegmentGrid(20);
  if (route?.path?.length >= 4) routeGrid.add(route.path, 2.5, 0);

  // Runs a generator to completion in ≈ SLICE_MS slices; throws CANCELLED once the tile was removed meanwhile
  async function run(gen, state) {
    let t0 = performance.now();
    for (;;) {
      const { done, value } = gen.next();
      if (done) return value;
      if (performance.now() - t0 > SLICE_MS) {
        await yieldToBrowser();
        if (state.cancelled) throw CANCELLED;
        t0 = performance.now();
      }
    }
  }

  async function buildTile(tile) {
    const key = tile.key ?? `${tile.tx}_${tile.tz}`;
    if (tiles.has(key)) removeTile(key);
    const state = { cancelled: false };
    const root = new THREE.Group();
    root.name = `Tile_${key}`;
    const entry = { root, owned: [], props: null, state };
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
      const ground = await run(buildGround({ ...tile, key }, triangulate), state);
      add(ground.ground, materials.ground, 'Ground');
      add(ground.water, materials.water, 'Water');

      const roads = await run(buildRoads(tile, routeGrid), state);
      const m = roads.meshes;
      add(m.road, materials.road, 'Roads');
      add(m.paint, materials.paint, 'RoadMarkings', { order: -1 });
      add(m.sidewalk, materials.sidewalk, 'Sidewalks');
      add(m.curb, materials.curb, 'Curbs');
      add(m.concrete, materials.concrete, 'Bridges & medians', { cast: true });
      add(m.prop, materials.prop, 'Fences & guardrails', { cast: true });
      if (state.cancelled) throw CANCELLED;
      await yieldToBrowser();

      const buildings = await run(buildBuildings(tile, { grid: roads.grid, roads: roads.roads, residential: residentialAreas(tile), triangulate }), state);
      add(buildings.meshes.facade, materials.facade, 'Buildings', { cast: true });
      add(buildings.meshes.roof, materials.roof, 'Roofs', { cast: true });
      add(buildings.meshes.glow, materials.glow, 'Signs');
      if (state.cancelled) throw CANCELLED;
      await yieldToBrowser();

      // Footprint lookup for the props (no trees inside buildings)
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
      const props = await run(buildProps({ ...tile, key }, roads, materials, inBuilding), state);
      root.add(props.group);
      entry.props = props;
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
    scene.add(root);
    return root;
  }

  function disposeEntry(entry) {
    entry.root.removeFromParent();
    for (const g of entry.owned) g.dispose();
    if (entry.props) entry.props.dispose();
    entry.owned.length = 0;
  }

  function removeTile(key) {
    const entry = tiles.get(key);
    if (!entry) return;
    entry.state.cancelled = true;
    disposeEntry(entry);
    tiles.delete(key);
  }

  const camPos = new THREE.Vector3();
  function update(camera) {
    camPos.setFromMatrixPosition(camera.matrixWorld);
    for (const entry of tiles.values()) if (entry.props) entry.props.update(camPos);
  }

  return { buildTile, removeTile, update };
}

export { createWorldBuilder };
