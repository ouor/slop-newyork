import * as THREE from 'three/webgpu';
import {
  Fn,
  float,
  vec2,
  vec3,
  vec4,
  pow,
  color,
  attribute,
  uv,
  positionWorld,
  abs,
  floor,
  fract,
  sin,
  cos,
  dot,
  min,
  max,
  mix,
  step,
  smoothstep,
  fwidth,
  clamp,
  normalize,
  time,
  uniformArray,
  Loop,
  If,
  Discard,
  mx_noise_float,
  mx_noise_vec3,
  normalWorldGeometry,
  cameraPosition,
  cameraViewMatrix
} from 'three/tsl';
import {
  cityUniforms,
  createRoadSurfaceMaterial,
  createRoadPaintMaterial,
  createSidewalkMaterial,
  createCurbMaterial,
  createTreeMaterial
} from '../tsl-materials.js';
import { createLeafAtlas } from '../trees.js';
import { tunnelUniforms } from './environment.js';

// js/drive/world-materials.js
// Materials shared by every Korea Drive tile, created once on first use. The roadway, lane paint, sidewalk, curb and
// river reuse the Manhattan TSL materials (so cityUniforms.uRoadWetness wets them in rain); buildings get a Korean
// facade shader driven by per-vertex style attributes (one material for every building of every tile):
//   bstyle = (style, storey height, seed, wall height), bwall = (wall length, accent), uv = metres along / up the wall
// Styles (world-geometry.js STYLE): 0 아파트 slab · 1 다세대/빌라 · 2 상가 · 3 glass office · 4 school · 5 plain.
// Phase 2: the terrain (landuse / slope shading, tunnel mouths cut out of it), rivers & reservoirs at any elevation,
// tunnel linings and lamps lit by tunnelUniforms (environment.js), transparent noise-barrier panels.

const hash21 = Fn(([p]) => fract(sin(dot(p, vec2(127.1, 311.7))).mul(43758.5453)));

// Tints in the mesh data are sRGB (as picked by eye), the shading is linear
const srgb = (c) => pow(c, vec3(2.2));

// Night factor from the interior glow the environment drives (≈ 0.25–0.5 by day, 1.25–1.55 at night)
const nightFactor = () => smoothstep(0.55, 1.2, cityUniforms.uInteriorGlow);

// Filtered box 1 on [a, b] of a coordinate that repeats (fract of a grid coordinate), widened by its pixel footprint
function band(x, a, b, aa) {
  return smoothstep(float(a).sub(aa), float(a).add(aa), x).mul(float(1.0).sub(smoothstep(float(b).sub(aa), float(b).add(aa), x)));
}

// Saturated signage colour from a hash (red, orange, yellow, green, blue, magenta…) washed a little towards white
function signColour(h) {
  const c = vec3(0.5).add(cos(h.mul(6.2832).add(vec3(0.0, 2.1, 4.2))).mul(0.5));
  return mix(c.mul(c), vec3(1.0), step(0.82, fract(h.mul(7.3))).mul(0.85));
}

function createFacadeMaterial() {
  const mat = new THREE.MeshStandardNodeMaterial({ metalness: 0.0, roughness: 0.85 });
  const st = attribute('bstyle', 'vec4');
  const bw = attribute('bwall', 'vec2');
  const tint = srgb(attribute('tint', 'vec3'));
  const style = st.x;
  const floorH = st.y;
  // The seed rounded to an integer: interpolating a per-building constant is off by an ulp from pixel to pixel, which
  // the sin-hash would blow up into static
  const seed = floor(st.z.mul(1000.0).add(0.5));
  const H = st.w;
  const wallLen = bw.x;
  const accentH = bw.y;
  const is = (k) => float(1.0).sub(step(0.5, abs(style.sub(k))));
  const isApt = is(0), isVilla = is(1), isShop = is(2), isOffice = is(3), isSchool = is(4), isPlain = is(5);
  const pick = (vals) => isApt.mul(vals[0]).add(isVilla.mul(vals[1])).add(isShop.mul(vals[2])).add(isOffice.mul(vals[3]))
    .add(isSchool.mul(vals[4])).add(isPlain.mul(vals[5]));

  const p = uv();
  const u = p.x;
  const v = p.y;
  const bayW = pick([3.2, 2.6, 3.4, 1.5, 3.6, 3.0]);
  const bays = max(floor(wallLen.div(bayW)), 1.0);
  const gu = u.div(wallLen.div(bays));
  const gv = v.div(floorH);
  const cell = floor(vec2(gu, gv));
  const fu = fract(gu);
  const fv = fract(gv);
  const floorIdx = cell.y;
  const aaU = fwidth(gu).mul(0.75).add(0.002);
  const aaV = fwidth(gv).mul(0.75).add(0.002);
  const far = smoothstep(0.25, 0.7, max(fwidth(gu), fwidth(gv)));
  const cellHash = hash21(cell.add(vec2(seed.mul(0.37), seed.mul(0.71))));

  // Window opening per style: [u0, u1, v0, v1] inside the bay × storey cell
  const u0 = pick([0.05, 0.22, 0.06, 0.03, 0.06, 0.3]);
  const u1 = pick([0.95, 0.78, 0.94, 0.97, 0.94, 0.7]);
  const v0 = pick([0.1, 0.3, 0.3, 0.14, 0.32, 0.28]);
  const v1 = pick([0.8, 0.78, 0.92, 0.98, 0.82, 0.8]);
  const winSharp = band(fu, u0, u1, aaU).mul(band(fv, v0, v1, aaV));
  const winMean = u1.sub(u0).mul(v1.sub(v0));
  // Blank: very short walls, 아파트 gable ends (the brand emblem goes there), the coping at the top
  const endWall = isApt.mul(float(1.0).sub(step(13.0, wallLen)));
  const coping = step(H.sub(0.4), v);
  // 필로티: most 빌라 stand on an open parking storey
  const piloti = isVilla.mul(float(1.0).sub(step(0.5, floorIdx))).mul(step(hash21(vec2(seed, 3.1)), 0.65));
  const shopFloor0 = isShop.mul(float(1.0).sub(step(0.5, floorIdx)));
  const open = step(2.0, wallLen).mul(float(1.0).sub(endWall)).mul(float(1.0).sub(coping)).mul(float(1.0).sub(piloti));
  const win = mix(winSharp, winMean, far).mul(open).mul(float(1.0).sub(shopFloor0));
  // Ground-floor shopfronts: glass below a sign fascia, on 상가 (and 빌라 next to a road share the look through tint)
  const storefront = shopFloor0.mul(band(fv, 0.04, 0.74, aaV)).mul(band(fu, 0.04, 0.96, aaU)).mul(step(2.0, wallLen));
  const fascia = shopFloor0.mul(band(fv, 0.78, 0.97, aaV)).mul(step(2.0, wallLen));

  // 상가 signage: a coloured band under the windows of every upper floor, per pair of bays, and the fascia
  const signGroup = floor(cell.x.div(2.0));
  const signH = hash21(vec2(signGroup, floorIdx).add(seed.mul(0.41)));
  // (thinning out up the building: the upper storeys of a 상가 are offices, clinics, academies with fewer boards)
  const hasSign = isShop.mul(step(0.5, floorIdx)).mul(step(floorIdx.mul(0.14).add(0.12), signH)).mul(band(fv, 0.04, 0.27, aaV)).mul(band(fract(gu.div(2.0)), 0.04, 0.96, aaU));
  const signs = max(hasSign, fascia.mul(step(0.12, signH)));
  const signCol = signColour(signH.add(seed.mul(0.001)));

  // 아파트 brand emblem near the top of the gable ends (lettering blocks), and a name band along the long walls
  const top = v.sub(H.sub(floorH.mul(2.2)));
  const inTop = step(0.0, top).mul(step(top, floorH.mul(1.6)));
  const emblemU = abs(u.sub(wallLen.mul(0.5)));
  const letters = step(0.35, hash21(vec2(floor(u.div(1.3)), seed.mul(0.05)))).mul(band(fract(u.div(1.3)), 0.1, 0.9, fwidth(u.div(1.3)).add(0.002)));
  const emblem = isApt.mul(inTop).mul(mix(
    step(emblemU, wallLen.mul(0.32)).mul(letters),
    step(emblemU, min(wallLen.mul(0.3), 7.0)).mul(letters).mul(band(top.div(floorH.mul(1.6)), 0.25, 0.75, 0.02)),
    float(1.0).sub(endWall)
  ));
  const emblemCol = mix(signColour(accentH), vec3(0.95, 0.95, 0.92), step(0.5, fract(accentH.mul(3.1))));

  // 아파트 balcony slab edges & school colour band under the sills
  const slab = isApt.mul(float(1.0).sub(band(fv, 0.08, 1.0, aaV))).mul(float(1.0).sub(endWall));
  const schoolBand = isSchool.mul(band(fv, 0.18, 0.28, aaV));

  const night = nightFactor();
  const lit = step(cellHash, pick([0.55, 0.45, 0.4, 0.35, 0.2, 0.3]));
  const warm = mix(color(0xffd49a), color(0xe6eeff), step(0.55, hash21(cell.add(3.7))));

  mat.colorNode = Fn(() => {
    let wall = tint.mul(hash21(floor(vec2(u.div(0.6), v.div(0.4)))).mul(0.06).add(0.97));
    wall = mix(wall, wall.mul(1.18).min(vec3(1.0)), slab.mul(0.8));
    wall = mix(wall, signColour(accentH).mul(0.8), schoolBand);
    wall = mix(wall, vec3(0.07, 0.07, 0.075), piloti.mul(band(fu, 0.12, 0.88, aaU)));
    wall = wall.mul(mix(float(1.0), float(0.78), coping)).mul(mix(float(0.86), float(1.0), smoothstep(0.0, 0.8, v)));
    // Glass: dark sky-tinted panes with some drawn curtains; offices are tinted curtain wall
    const glass = mix(color(0x27313b), color(0x8e8a80), step(0.82, cellHash).mul(float(1.0).sub(isOffice)))
      .mul(cellHash.mul(0.3).add(0.85));
    const officeGlass = mix(color(0x1d3a4a), color(0x2a3d52), hash21(vec2(seed, 7.0)));
    const pane = mix(glass, officeGlass, isOffice);
    let c = mix(wall, pane, max(win, storefront));
    c = mix(c, signCol.mul(0.85), signs);
    c = mix(c, emblemCol, emblem);
    return c;
  })();

  const glassAmount = max(win, storefront);
  mat.roughnessNode = mix(float(0.85), mix(float(0.22), float(0.08), isOffice), glassAmount).mul(float(1.0).sub(signs.mul(0.4)));
  // Only curtain walls are metallic: SSR (main.js) mirrors metallic pixels, which turns ordinary panes into noise
  mat.metalnessNode = glassAmount.mul(isOffice).mul(0.7);
  mat.emissiveNode = Fn(() => {
    const rooms = warm.mul(win.mul(lit).mul(mix(float(1.0), float(0.6), far)).mul(1.3));
    const shops = color(0xfff0d6).mul(storefront.mul(1.6));
    const signGlow = signCol.mul(signs).mul(2.2);
    const emblemGlow = emblemCol.mul(emblem).mul(1.6);
    return rooms.add(shops).add(signGlow).add(emblemGlow).mul(night).add(signCol.mul(signs).mul(0.08));
  })();
  return mat;
}

// Flat roofs (Seoul's green waterproof paint, grey concrete, 아파트 roofs) and the rooftop clutter: per-vertex tint
function createTintMaterial({ roughness = 0.85, metalness = 0.0, noise = 0.12 } = {}) {
  const mat = new THREE.MeshStandardNodeMaterial({ roughness, metalness });
  const tint = srgb(attribute('tint', 'vec3'));
  mat.colorNode = tint.mul(hash21(floor(positionWorld.xz.mul(1.7))).mul(noise).add(1.0 - noise * 0.5));
  return mat;
}

// Tunnel mouths cut out of the terrain (world-structures.js portals, the nearest MAX_PORTALS set by world-builder.js):
// per portal vec4(x, z, dx, dz) (dx, dz into the tunnel) and vec4(road y, grade, half width, height); unused ones have
// a negative half width
const MAX_PORTALS = 16;
const portalUniforms = uniformArray(Array.from({ length: MAX_PORTALS * 2 }, (_, k) => new THREE.Vector4(0, 0, k % 2 ? -1 : 1, 0)), 'vec4');

// Terrain (world-terrain.js): per-vertex tint & land = (urban, farmland, forest, cut slope) weights, shaded by slope:
// grain everywhere, a blotchy canopy over the woods, 논 / 밭 plots with their dikes on farmland, bare granite on very
// steep ground, shotcrete with a 격자블록 frame on the road cuts; darker in rain. The hillside inside a tunnel mouth is
// discarded (the portal's headwall and lining stand there).
function createTerrainMaterial() {
  const mat = new THREE.MeshStandardNodeMaterial({ roughness: 0.95, metalness: 0.0 });
  const tint = srgb(attribute('tint', 'vec3'));
  const land = attribute('land', 'vec4');
  mat.colorNode = Fn(() => {
    const xz = positionWorld.xz;
    const y = positionWorld.y;
    Loop(MAX_PORTALS, ({ i }) => {
      const a = portalUniforms.element(i.mul(2));
      const b = portalUniforms.element(i.mul(2).add(1));
      const rel = xz.sub(a.xy);
      const along = dot(rel, a.zw);
      const lateral = abs(rel.x.mul(a.w).sub(rel.y.mul(a.z)));
      const h = y.sub(b.x.add(b.y.mul(along)));
      If(along.greaterThan(-10.0).and(along.lessThan(30.0)).and(lateral.lessThan(b.z)).and(h.greaterThan(0.05)).and(h.lessThan(b.w)), () => {
        Discard();
      });
    });
    const slope = float(1.0).sub(normalWorldGeometry.y);
    const grain = hash21(floor(xz.mul(2.3))).mul(0.08).add(hash21(floor(xz.mul(0.11))).mul(0.14)).add(0.89);
    const c = tint.mul(grain).toVar();

    // Woods: crowns ~6 m across in clumps, their shadows between
    const crowns = mx_noise_float(vec3(xz.mul(0.17), 0.0)).mul(0.5).add(0.5);
    const clumps = mx_noise_float(vec3(xz.mul(0.023), 4.1)).mul(0.5).add(0.5);
    const canopy = mix(float(0.55), float(1.3), smoothstep(0.25, 0.8, crowns.mul(0.65).add(clumps.mul(0.35))));
    c.assign(mix(c, c.mul(canopy).mul(vec3(0.95, 1.05, 0.9)), land.z));

    // Farmland: plots of ~30 × 70 m, flat ones as 논 (green or ripening rice), sloping ones as 밭 in furrows
    const plotSize = vec2(31.0, 67.0);
    const plotUV = xz.div(plotSize);
    const ph = hash21(floor(plotUV).add(0.37));
    const rice = mix(color(0x55752e), color(0x8d8a43), step(0.72, ph));
    const soil = mix(color(0x6e5a42), color(0x5d7a35), step(0.5, fract(ph.mul(5.3))));
    const furrows = sin(xz.x.mul(2.4).add(ph.mul(20.0))).mul(0.12).add(0.94);
    const paddy = smoothstep(0.03, 0.008, slope);
    const pf = fract(plotUV);
    const aaP = fwidth(plotUV).mul(1.5).add(0.0005);
    const inPlot = band(pf.x, 0.6 / 31.0, 1.0 - 0.6 / 31.0, aaP.x).mul(band(pf.y, 0.6 / 67.0, 1.0 - 0.6 / 67.0, aaP.y));
    const field = mix(color(0x6f8a45), mix(soil.mul(furrows), rice, paddy).mul(grain), inPlot.mul(0.8).add(0.2));
    c.assign(mix(c, field, land.y));

    // Bare rock where it is too steep for soil (not on the dressed cuts or in town)
    const rockN = mx_noise_float(vec3(xz.mul(0.09), y.mul(0.09))).mul(0.5).add(0.5);
    const rock = smoothstep(0.48, 0.68, slope.add(rockN.mul(0.12))).mul(float(1.0).sub(land.w)).mul(float(1.0).sub(land.x));
    c.assign(mix(c, srgb(vec3(0.4, 0.39, 0.36)).mul(rockN.mul(0.3).add(0.8)), rock));

    // Road cuts: a concrete grid frame (2.8 m along the contour × 2.5 m up), grass or shotcrete in its cells
    const contour = normalize(vec2(normalWorldGeometry.z.negate(), normalWorldGeometry.x).add(vec2(0.0001, 0.0)));
    const gridUV = vec2(dot(xz, contour).mul(0.36), y.mul(0.4));
    const gf = fract(gridUV);
    const aaG = fwidth(gridUV).add(0.002);
    const frame = float(1.0).sub(band(gf.x, 0.1, 0.9, aaG.x).mul(band(gf.y, 0.1, 0.9, aaG.y)));
    const grass = srgb(vec3(0.38, 0.45, 0.26)), shotcrete = srgb(vec3(0.5, 0.5, 0.47)), frameCol = srgb(vec3(0.58, 0.57, 0.54));
    const cell = mix(grass, shotcrete, step(0.65, hash21(floor(gridUV).add(2.3))));
    // Cells below a pixel settle to their mean, so the pattern can't alias into stripes at grazing angles
    const coarse = smoothstep(0.15, 0.45, max(aaG.x, aaG.y));
    const cutCol = mix(mix(cell, frameCol, frame.mul(0.85)), mix(mix(grass, shotcrete, 0.35), frameCol, 0.3), coarse);
    c.assign(mix(c, cutCol.mul(grain), land.w));

    const wetFilm = smoothstep(0.2, 0.8, cityUniforms.uRoadWetness);
    return c.mul(mix(float(1.0), float(0.72), wetFilm));
  })();
  mat.roughnessNode = mix(float(0.95), float(0.7), smoothstep(0.2, 0.8, cityUniforms.uRoadWetness));
  return mat;
}

// Rivers, reservoirs, ponds and the sea at any elevation: drifting wave normals from MaterialX noise, Fresnel through
// metalness (as js/tsl-materials.js's estuary, so SSR mirrors the banks), a murky green-grey body
function createWaterMaterial() {
  const mat = new THREE.MeshStandardNodeMaterial({ roughness: 0.12, metalness: 0.0 });
  const p = positionWorld.xz;
  const a = mx_noise_vec3(vec3(p.mul(0.07), time.mul(0.22)));
  const b = mx_noise_vec3(vec3(p.mul(0.29).add(17.0), time.mul(0.55)));
  const slope = a.xy.mul(0.05).add(b.xy.mul(0.025)).mul(mix(float(1.0), float(1.8), cityUniforms.uRoadWetness));
  const n = normalize(vec3(slope.x.negate(), 1.0, slope.y.negate()));
  mat.normalNode = cameraViewMatrix.transformDirection(n);
  const viewDir = normalize(cameraPosition.sub(positionWorld));
  const fresnel = pow(float(1.0).sub(clamp(dot(n, viewDir), 0.0, 1.0)), 5.0).mul(0.98).add(0.02);
  mat.metalnessNode = clamp(fresnel.mul(1.6), 0.0, 0.9);
  const silt = mx_noise_float(vec3(p.mul(0.004), 7.3)).mul(0.5).add(0.5);
  mat.colorNode = mix(color(0x18302c), color(0x34432f), silt);
  return mat;
}

// Tunnel lining (world-structures.js; uv = metres along, metres round the section from the left wall foot, folded so
// both walls read the same): light panels up to 2.6 m with their joints, dark sooty shotcrete above; lit by the lamp
// rows (tunnelUniforms.uLampColor) whatever the sun does, a little brighter under each lamp
function createTunnelLiningMaterial() {
  const mat = new THREE.MeshStandardNodeMaterial({ roughness: 0.75, metalness: 0.0, side: THREE.DoubleSide });
  const u = uv().x;
  const v = uv().y;
  const panelUV = vec2(u.div(1.2), v.div(0.6));
  const aa = fwidth(panelUV).add(0.002);
  const joints = band(fract(panelUV.x), 0.03, 0.97, aa.x).mul(band(fract(panelUV.y), 0.04, 0.96, aa.y));
  const panels = mix(color(0x6f6f6a), color(0xd8d6cf), joints.mul(0.85).add(0.15));
  const soot = mx_noise_float(vec3(u.mul(0.15), v.mul(0.4), 1.7)).mul(0.5).add(0.5);
  const shotcrete = mix(color(0x2a2a29), color(0x484744), soot);
  const isPanel = smoothstep(2.65, 2.55, v);
  const albedo = mix(shotcrete, panels, isPanel);
  mat.colorNode = albedo;
  const pool = cos(u.mul(Math.PI / 3)).mul(0.25).add(0.75); // lamps every 6 m
  mat.emissiveNode = albedo.mul(tunnelUniforms.uLampColor).mul(pool).mul(mix(float(0.35), float(0.22), isPanel));
  return mat;
}

function createTunnelLampMaterial() {
  const mat = new THREE.MeshStandardNodeMaterial({ roughness: 0.4, metalness: 0.0 });
  mat.colorNode = vec3(0.1);
  mat.emissiveNode = tunnelUniforms.uLampColor.mul(5.0);
  return mat;
}

// Noise-barrier panels: clear, slightly blue
function createGlassMaterial() {
  const mat = new THREE.MeshStandardNodeMaterial({ roughness: 0.08, metalness: 0.0, transparent: true, depthWrite: false, side: THREE.DoubleSide });
  mat.colorNode = srgb(attribute('tint', 'vec3'));
  mat.opacity = 0.32;
  return mat;
}

// Lamps, signal lenses, sign boxes: vec4 glow attribute (rgb, a = 1 lit around the clock / 0 only at night)
function createGlowMaterial() {
  const mat = new THREE.MeshStandardNodeMaterial({ roughness: 0.4, metalness: 0.0 });
  const glowAttr = attribute('glow', 'vec4');
  const glow = vec4(srgb(glowAttr.rgb), glowAttr.a);
  mat.colorNode = glow.rgb.mul(0.35);
  mat.emissiveNode = glow.rgb.mul(mix(nightFactor().mul(2.4), float(1.8), glow.a)).add(glow.rgb.mul(0.1));
  return mat;
}

let shared = null;

function getWorldMaterials() {
  if (shared) return shared;
  const atlas = createLeafAtlas();
  shared = {
    road: createRoadSurfaceMaterial(),
    paint: createRoadPaintMaterial(),
    sidewalk: createSidewalkMaterial(),
    curb: createCurbMaterial(),
    water: createWaterMaterial(),
    terrain: createTerrainMaterial(),
    lining: createTunnelLiningMaterial(),
    tunnelLamp: createTunnelLampMaterial(),
    glass: createGlassMaterial(),
    facade: createFacadeMaterial(),
    roof: createTintMaterial({ roughness: 0.9 }),
    prop: createTintMaterial({ roughness: 0.55, metalness: 0.25, noise: 0.04 }),
    concrete: createTintMaterial({ roughness: 0.8, noise: 0.1 }),
    glow: createGlowMaterial(),
    wire: new THREE.LineBasicNodeMaterial({ color: 0x15161a }),
    leafAtlas: atlas,
    tree: createTreeMaterial(atlas.texture)
  };
  return shared;
}

export { getWorldMaterials, portalUniforms, MAX_PORTALS };
