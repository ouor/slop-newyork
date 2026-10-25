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
  fwidth
} from 'three/tsl';
import {
  cityUniforms,
  createRoadSurfaceMaterial,
  createRoadPaintMaterial,
  createSidewalkMaterial,
  createCurbMaterial,
  createWaterMaterial,
  createTreeMaterial
} from '../tsl-materials.js';
import { createLeafAtlas } from '../trees.js';

// js/drive/world-materials.js
// Materials shared by every Korea Drive tile, created once on first use. The roadway, lane paint, sidewalk, curb and
// river reuse the Manhattan TSL materials (so cityUniforms.uRoadWetness wets them in rain); buildings get a Korean
// facade shader driven by per-vertex style attributes (one material for every building of every tile):
//   bstyle = (style, storey height, seed, wall height), bwall = (wall length, accent), uv = metres along / up the wall
// Styles (world-geometry.js STYLE): 0 아파트 slab · 1 다세대/빌라 · 2 상가 · 3 glass office · 4 school · 5 plain.

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

// Ground: per-vertex landuse tint with grain; the lowered river banks turn into a stone revetment
function createGroundMaterial() {
  const mat = new THREE.MeshStandardNodeMaterial({ roughness: 0.95, metalness: 0.0 });
  const tint = srgb(attribute('tint', 'vec3'));
  mat.colorNode = Fn(() => {
    const xz = positionWorld.xz;
    const grain = hash21(floor(xz.mul(2.3))).mul(0.08).add(hash21(floor(xz.mul(0.11))).mul(0.14)).add(0.89);
    const bank = smoothstep(-0.15, -0.9, positionWorld.y);
    const blocks = band(fract(positionWorld.y.mul(1.4).add(xz.x.mul(0.02))), 0.06, 0.94, 0.05).mul(0.15).add(0.85);
    const wetFilm = smoothstep(0.2, 0.8, cityUniforms.uRoadWetness);
    return mix(tint.mul(grain), color(0x8a877c).mul(blocks), bank).mul(mix(float(1.0), float(0.8), wetFilm));
  })();
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
    ground: createGroundMaterial(),
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

export { getWorldMaterials };
