// js/drive/main.js — Korea Drive: wires the route data, the procedural world, the autopilot, the car cabin and the
// sky/weather together (contracts in docs/drive.md). Route: ?route=<id> under data/drive/ (default 서울역 → 강남역).
import * as THREE from 'three/webgpu';
import { pass, mrt, output, normalView, positionView, metalness, roughness, vec2, smoothstep } from 'three/tsl';
import { ssr } from 'three/addons/tsl/display/SSRNode.js';
import { LightingSystem } from '../lighting.js';
import { createPostProcessing } from '../post-processing.js';
import { loadRoute, TileStreamer } from './route-data.js';
import { createWorldBuilder } from './world-builder.js';
import { createAutopilot } from './autopilot.js';
import { createCarCabin } from './car-cabin.js';
import { createEnvironment } from './environment.js';

const params = new URLSearchParams(location.search);
const ROUTE_ID = /^[\w-]+$/.test(params.get('route') || '') ? params.get('route') : 'seoul-station-gangnam';
const BASE_URL = `data/drive/${ROUTE_ID}/`;

const $ = (id) => document.getElementById(id);
const status = (text) => { if ($('loading-status')) $('loading-status').textContent = text; };

async function initDrive() {
  const renderer = new THREE.WebGPURenderer({ antialias: true, powerPreference: 'high-performance', reversedDepthBuffer: true });
  renderer.setPixelRatio(1.0);
  renderer.setSize(window.innerWidth, window.innerHeight);
  renderer.shadowMap.enabled = true;
  $('canvas-container').appendChild(renderer.domElement);
  await renderer.init();

  status('Loading route…');
  const route = await loadRoute(BASE_URL);
  $('route-name').textContent = route.name;
  document.title = `${route.name} · Korea Drive`;

  const scene = new THREE.Scene();
  const lighting = new LightingSystem(scene, renderer);
  const world = createWorldBuilder(scene, { route });
  const autopilot = createAutopilot(route, { lane: 'right' });
  const cabin = createCarCabin(scene, {});
  const camera = cabin.camera;
  camera.aspect = window.innerWidth / window.innerHeight;
  camera.updateProjectionMatrix();
  const environment = createEnvironment({ scene, renderer, lighting, route });
  environment.attachWindshield(cabin.windshield);

  // Tiles stream in around the car; small instanced meshes move their matrices to storage buffers on WebGPU (see
  // js/main.js: uniform-buffer instancing re-uploads every draw)
  const loading = new Set();
  const toStorage = (root) => {
    if (!renderer.backend.isWebGPUBackend) return;
    root.traverse((o) => {
      if (o.isInstancedMesh && !o.instanceMatrix.isStorageInstancedBufferAttribute) {
        o.instanceMatrix = new THREE.StorageInstancedBufferAttribute(o.instanceMatrix.array, 16);
      }
    });
  };
  const streamer = new TileStreamer({
    baseUrl: BASE_URL,
    route,
    onLoad: (tile) => {
      const key = `${tile.tx}_${tile.tz}`;
      loading.add(key);
      world.buildTile(tile)
        .then((root) => {
          if (!root) return;
          if (!root.parent) scene.add(root);
          toStorage(root);
        })
        .catch((e) => console.warn('[drive] tile', key, e))
        .finally(() => loading.delete(key));
    },
    onUnload: (key) => world.removeTile(key)
  });

  // Post-processing: the Manhattan chain (SSR for wet roads & glass, bloom, grade)
  const scenePass = pass(scene, camera);
  scenePass.renderTarget.storeMultisampledColorBuffer = false;
  const ssrFade = smoothstep(360.0, 180.0, positionView.z.negate());
  const maxSSRRoughness = 0.75;
  const sceneMRT = mrt({
    output: output,
    normal: normalView,
    metalRough: vec2(roughness.lessThan(maxSSRRoughness).select(metalness.mul(ssrFade), 0), roughness)
  });
  sceneMRT.setBlendMode('normal', new THREE.BlendMode(THREE.MaterialBlending));
  sceneMRT.setBlendMode('metalRough', new THREE.BlendMode(THREE.MaterialBlending));
  scenePass.setMRT(sceneMRT);
  const scenePassColor = scenePass.getTextureNode('output');
  const scenePassMetalRough = scenePass.getTextureNode('metalRough');
  const ssrPass = ssr(scenePassColor, scenePass.getTextureNode('depth'), scenePass.getTextureNode('normal'), {
    metalnessNode: scenePassMetalRough.r,
    roughnessNode: scenePassMetalRough.g,
    camera
  });
  ssrPass.resolutionScale = 0.5;
  ssrPass.maxDistance.value = 42;
  ssrPass.thickness.value = 0.85;
  ssrPass.quality.value = 0.25;
  ssrPass.binaryRefine = true;
  ssrPass.intensity.value = 0.5;
  ssrPass.screenEdgeFadeBlack = true;
  const reflectionMask = scenePassMetalRough.r.greaterThan(0).select(smoothstep(maxSSRRoughness, 0.55, scenePassMetalRough.g), 0);
  const colorGrade = createPostProcessing(renderer, scenePassColor, ssrPass.mul(reflectionMask));
  const renderPipeline = new THREE.RenderPipeline(renderer, colorGrade.outputNode);

  // Wait for the tiles around the start before showing anything, so the first frames are not empty streets
  status('Building the streets around the start…');
  cabin.setPose(autopilot.state);
  // update() starts at most 2 fetches, so keep calling it until nothing near the start is still in flight
  for (let i = 0; i < 600; i++) {
    streamer.update(autopilot.state.position.x, autopilot.state.position.z);
    if (i > 2 && streamer.pending.size === 0 && loading.size === 0) break;
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  status('Compiling shaders…');
  // Into the scene pass's target with its MRT (as js/main.js does): the pipelines the frames use, and materials that
  // write only some MRT outputs (lane paint) don't fail against the canvas
  renderer.setRenderTarget(scenePass.renderTarget);
  renderer.setMRT(sceneMRT);
  await renderer.compileAsync(scene, camera);
  renderer.setMRT(null);
  renderer.setRenderTarget(null);

  // UI
  let timeScale = 1;
  const setActive = (selector, el) => document.querySelectorAll(selector).forEach((b) => b.classList.toggle('active', b === el));
  const setTime = (h) => {
    environment.setTime(h);
    const hh = Math.floor(h) % 24;
    const mm = Math.floor((h % 1) * 60);
    $('time-label').textContent = `${String(hh).padStart(2, '0')}:${String(mm).padStart(2, '0')}`;
  };
  $('time-slider').addEventListener('input', (e) => setTime(Number(e.target.value)));
  setTime(Number($('time-slider').value));
  document.querySelectorAll('[data-weather]').forEach((b) => b.addEventListener('click', () => {
    environment.setWeather(b.dataset.weather);
    setActive('[data-weather]', b);
  }));
  document.querySelectorAll('[data-view]').forEach((b) => b.addEventListener('click', () => {
    cabin.setView(b.dataset.view);
    setActive('[data-view]', b);
  }));
  document.querySelectorAll('[data-speed]').forEach((b) => b.addEventListener('click', () => {
    timeScale = Number(b.dataset.speed);
    setActive('[data-speed]', b);
  }));
  $('seek-slider').addEventListener('change', (e) => autopilot.jumpTo(Number(e.target.value) * route.lengthM));

  // Drag to look around from the seat
  const look = { dx: 0, dy: 0 };
  let dragging = null;
  renderer.domElement.addEventListener('pointerdown', (e) => { dragging = { x: e.clientX, y: e.clientY }; renderer.domElement.setPointerCapture(e.pointerId); });
  renderer.domElement.addEventListener('pointermove', (e) => {
    if (!dragging) return;
    look.dx += e.clientX - dragging.x;
    look.dy += e.clientY - dragging.y;
    dragging = { x: e.clientX, y: e.clientY };
  });
  const endDrag = () => { dragging = null; };
  renderer.domElement.addEventListener('pointerup', endDrag);
  renderer.domElement.addEventListener('pointercancel', endDrag);

  window.addEventListener('resize', () => {
    camera.aspect = window.innerWidth / window.innerHeight;
    camera.updateProjectionMatrix();
    renderer.setSize(window.innerWidth, window.innerHeight);
  });

  $('loading-overlay').classList.add('hidden');

  let lastTime = performance.now();
  let fpsFrames = 0;
  let fpsTimer = 0;
  let hudTimer = 0;
  let gradeLook = null;
  renderer.setAnimationLoop((now) => {
    const dt = Math.min(Math.max((now - lastTime) * 0.001, 0.001), 0.05);
    lastTime = now;

    const state = autopilot.update(dt, timeScale);
    cabin.setPose(state);
    cabin.update(dt, { lookDX: look.dx, lookDY: look.dy });
    look.dx = 0;
    look.dy = 0;
    streamer.update(state.position.x, state.position.z);
    world.update(camera);
    environment.update(dt, camera, state);
    if (environment.state.look !== gradeLook) colorGrade.applyPreset((gradeLook = environment.state.look));
    lighting.update(camera.position);
    renderPipeline.render();

    fpsFrames++;
    fpsTimer += dt;
    hudTimer += dt;
    if (fpsTimer >= 1) {
      $('hud-fps').textContent = `${Math.round(fpsFrames / fpsTimer)} fps`;
      fpsFrames = 0;
      fpsTimer = 0;
    }
    if (hudTimer >= 0.2) {
      hudTimer = 0;
      const seg = state.segment;
      $('hud-speed').textContent = String(Math.round(state.speed * 3.6));
      $('route-road').textContent = (seg && (seg.name || seg.ref)) || '—';
      $('route-remaining').textContent = `${((route.lengthM - state.distance) / 1000).toFixed(1)} km 남음`;
      $('route-progress').style.width = `${Math.min(100, (state.distance / route.lengthM) * 100)}%`;
      if (document.activeElement !== $('seek-slider')) $('seek-slider').value = String(state.distance / route.lengthM);
    }
  });
}

initDrive().catch((e) => {
  console.error(e);
  status(`Failed to start: ${e.message}`);
});
