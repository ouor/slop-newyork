import * as THREE from 'three/webgpu';
import { MeshData } from './world-geometry.js';

// js/drive/world-rural-signs.js
// Korean expressway furniture from the plan of world-rural-layout.js (highwayPlan), written into two merged meshes
// per tile: `metal` (posts, beams, panel backs, phone boxes; per-vertex tint) and `face` (sign faces and lettering,
// uv into one shared CanvasTexture atlas). The atlas holds every word, digit, route shield and plain colour once,
// drawn on demand (white on 고속도로 green, a few other plates), so no sign owns a texture:
// - 이정표: ground-mounted green panels with the next destinations and their distance ("대전 23 km")
// - overhead gantries every 5 km: route shield + expressway name, and the next destination
// - route confirmation signs: the blue / red 고속도로 shield with the `ref` number over the road's name
// - 거리표 posts every 100 m ("123.4"), larger km markers, orange 비상전화 boxes, amber delineators

const ATLAS = 2048;
const ROW = 128; // px per entry row
const PAD = 6;
const FONT = '"Malgun Gothic", "Apple SD Gothic Neo", "Noto Sans KR", sans-serif';
const GREEN = '#0d6a43';
const STYLE = {
  g: { bg: GREEN, fg: '#ffffff' },
  o: { bg: '#f08a12', fg: '#1a1a1a' },
  w: { bg: '#f4f4f0', fg: '#1d1d1d' }
};

let atlas = null;

function getAtlas() {
  if (atlas) return atlas;
  const canvas = typeof OffscreenCanvas !== 'undefined' ? new OffscreenCanvas(ATLAS, ATLAS) : Object.assign(document.createElement('canvas'), { width: ATLAS, height: ATLAS });
  const ctx = canvas.getContext('2d');
  const texture = new THREE.CanvasTexture(canvas);
  texture.colorSpace = THREE.SRGBColorSpace;
  texture.anisotropy = 8;
  atlas = { canvas, ctx, texture, entries: new Map(), x: 0, y: 0 };
  return atlas;
}

// Atlas entry `key`, w px wide, drawn by draw(ctx, x, y, w, h) the first time: { u0, v0, u1, v1, aspect }
function entry(key, w, draw) {
  const A = getAtlas();
  let e = A.entries.get(key);
  if (e) return e;
  w = Math.ceil(w);
  if (A.x + w + PAD * 2 > ATLAS) { A.x = 0; A.y += ROW + PAD * 2; }
  // shortcut: a full atlas reuses its last row (wrong words on new signs); 2048² holds ~400 words, far more than a route uses
  if (A.y + ROW + PAD * 2 > ATLAS) A.y = ATLAS - ROW - PAD * 2;
  const x = A.x + PAD, y = A.y + PAD;
  A.ctx.save();
  draw(A.ctx, x, y, w, ROW);
  A.ctx.restore();
  A.x += w + PAD * 2;
  A.texture.needsUpdate = true;
  // uv inset half a pixel; the texture is flipped (v up)
  e = { u0: (x + 1) / ATLAS, u1: (x + w - 1) / ATLAS, v0: 1 - (y + ROW - 1) / ATLAS, v1: 1 - (y + 1) / ATLAS, aspect: w / ROW };
  A.entries.set(key, e);
  return e;
}

// Plain colour (backgrounds, reflectors), painted into the gutter too so mip levels don't bleed
const solid = (css) => entry(`solid:${css}`, 24, (c, x, y, w, h) => { c.fillStyle = css; c.fillRect(x - PAD, y - PAD, w + PAD * 2, h + PAD * 2); });

// One word / number in a style, on its plate colour
function word(text, style = 'g') {
  const s = STYLE[style];
  const A = getAtlas();
  A.ctx.font = `bold 92px ${FONT}`;
  const w = A.ctx.measureText(text).width + (text.length > 1 ? 20 : 4);
  return entry(`${style}:${text}`, w, (c, x, y, ew, h) => {
    c.fillStyle = s.bg;
    c.fillRect(x - PAD, y - PAD, ew + PAD * 2, h + PAD * 2);
    c.fillStyle = s.fg;
    c.font = `bold 92px ${FONT}`;
    c.textAlign = 'center';
    c.textBaseline = 'middle';
    c.fillText(text, x + ew / 2, y + h / 2 + 4);
  });
}

// Korean expressway route shield (blue body under a red crown, white number) on sign green
function shield(ref) {
  return entry(`shield:${ref}`, ROW, (c, x, y, w, h) => {
    c.fillStyle = GREEN;
    c.fillRect(x - PAD, y - PAD, w + PAD * 2, h + PAD * 2);
    const path = () => {
      c.beginPath();
      c.moveTo(x + 10, y + 12);
      c.quadraticCurveTo(x + w / 2, y + 2, x + w - 10, y + 12);
      c.lineTo(x + w - 10, y + h * 0.62);
      c.quadraticCurveTo(x + w - 12, y + h * 0.9, x + w / 2, y + h - 6);
      c.quadraticCurveTo(x + 12, y + h * 0.9, x + 10, y + h * 0.62);
      c.closePath();
    };
    path();
    c.fillStyle = '#ffffff';
    c.fill();
    c.save();
    c.translate(x + w / 2, y + h / 2);
    c.scale(0.9, 0.9);
    c.translate(-(x + w / 2), -(y + h / 2));
    path();
    c.clip();
    c.fillStyle = '#1d4fa0';
    c.fillRect(x, y, w, h);
    c.fillStyle = '#d32a2a';
    c.fillRect(x, y, w, h * 0.27);
    c.restore();
    c.fillStyle = '#ffffff';
    const label = String(ref);
    c.font = `bold ${label.length > 2 ? 46 : 62}px ${FONT}`;
    c.textAlign = 'center';
    c.textBaseline = 'middle';
    c.fillText(label, x + w / 2, y + h * 0.6);
  });
}

// Straight-ahead arrow (fonts draw ↑ too thin to read at a distance)
const arrow = () => entry('arrow', 84, (c, x, y, w, h) => {
  c.fillStyle = GREEN;
  c.fillRect(x - PAD, y - PAD, w + PAD * 2, h + PAD * 2);
  c.fillStyle = '#ffffff';
  c.beginPath();
  c.moveTo(x + w / 2, y + 8);
  c.lineTo(x + w - 6, y + 56);
  c.lineTo(x + w / 2 + 12, y + 50);
  c.lineTo(x + w / 2 + 12, y + h - 8);
  c.lineTo(x + w / 2 - 12, y + h - 8);
  c.lineTo(x + w / 2 - 12, y + 50);
  c.lineTo(x + 6, y + 56);
  c.closePath();
  c.fill();
});

// Tokens of a label: digits / '.' one by one (any number from ten glyphs), everything else as whole words
function tokens(text, style = 'g') {
  const out = [];
  for (const part of String(text).match(/[0-9.]|[^0-9.\s]+/g) || []) out.push(word(part, style));
  return out;
}

// ---------------------------------------------------------------------------------------------------------------------
// Writers
// ---------------------------------------------------------------------------------------------------------------------

// Upright quad centred at (cx, cy, cz), facing (nx, nz), `w` along the viewer's right (rx, rz), with atlas entry e
function face(md, cx, cy, cz, rx, rz, nx, nz, w, h, e) {
  const hw = w / 2, hh = h / 2;
  md.quad([
    [cx - rx * hw, cy - hh, cz - rz * hw], [cx + rx * hw, cy - hh, cz + rz * hw],
    [cx + rx * hw, cy + hh, cz + rz * hw], [cx - rx * hw, cy + hh, cz - rz * hw]
  ], nx, 0, nz, [[e.u0, e.v0], [e.u1, e.v0], [e.u1, e.v1], [e.u0, e.v1]]);
}

// A row of tokens `h` high, starting at offset u0 (along the right vector) from (cx, cz) — or centred when u0 is null.
// Returns the row's width.
function row(md, cx, cy, cz, rx, rz, nx, nz, h, toks, u0 = null) {
  const total = toks.reduce((s, e) => s + e.aspect * h, 0);
  let u = u0 === null ? -total / 2 : u0;
  for (const e of toks) {
    const w = e.aspect * h;
    face(md, cx + rx * (u + w / 2), cy, cz + rz * (u + w / 2), rx, rz, nx, nz, w, h, e);
    u += w;
  }
  return total;
}

const rowWidth = (toks, h) => toks.reduce((s, e) => s + e.aspect * h, 0);

// Square beam between two points (posts, gantry members), into a tint MeshData
function beam(md, ax, ay, az, bx, by, bz, r) {
  const dx = bx - ax, dy = by - ay, dz = bz - az;
  const L = Math.hypot(dx, dy, dz) || 1;
  // two unit vectors across the beam
  let px = -dz, py = 0, pz = dx;
  let pl = Math.hypot(px, pz);
  if (pl < 1e-6) { px = 1; pz = 0; pl = 1; }
  px /= pl; pz /= pl;
  const qx = (dy * pz - dz * py) / L, qy = (dz * px - dx * pz) / L, qz = (dx * py - dy * px) / L;
  const c = [[1, 1], [-1, 1], [-1, -1], [1, -1]];
  for (let k = 0; k < 4; k++) {
    const [a1, b1] = c[k], [a2, b2] = c[(k + 1) % 4];
    const o1 = [(px * a1 + qx * b1) * r, (py * a1 + qy * b1) * r, (pz * a1 + qz * b1) * r];
    const o2 = [(px * a2 + qx * b2) * r, (py * a2 + qy * b2) * r, (pz * a2 + qz * b2) * r];
    const nx = o1[0] + o2[0], ny = o1[1] + o2[1], nz = o1[2] + o2[2];
    md.quad([
      [ax + o1[0], ay + o1[1], az + o1[2]], [bx + o1[0], by + o1[1], bz + o1[2]],
      [bx + o2[0], by + o2[1], bz + o2[2]], [ax + o2[0], ay + o2[1], az + o2[2]]
    ], nx, ny, nz);
  }
}

const METAL = [0.55, 0.57, 0.58];
const POST_WHITE = [0.86, 0.87, 0.85];

/**
 * Writes the plan's furniture: metal (MeshData { tint }) and face (MeshData { uv }). `groundAt(x, z)` gives the
 * ground under off-road posts (the road surface y is used on bridges).
 */
function writeFurniture(items, metal, faceMd, groundAt) {
  for (const it of items) {
    const { x, z, dx, dz, rx, rz } = it;
    const nx = -dx, nz = -dz; // faces look back at the approaching traffic
    const yaw = Math.atan2(rx, rz); // a box's local z along the right vector
    const g = it.bridge ? it.y : Math.max(groundAt(x, z), it.y - 4);
    switch (it.type) {
      case 'delineator': {
        metal.set('tint', ...POST_WHITE);
        metal.box(x, g, z, 0.1, 1.0, 0.1, yaw);
        face(faceMd, x + nx * 0.052, g + 0.88, z + nz * 0.052, rx, rz, nx, nz, 0.08, 0.16, solid('#ffb000'));
        break;
      }
      case 'post':
      case 'km': {
        const big = it.type === 'km';
        const w = big ? 0.8 : 0.55, h = big ? 0.62 : 0.3, top = big ? 1.9 : 1.45;
        metal.set('tint', ...POST_WHITE);
        metal.box(x, g, z, 0.08, top - h, 0.08, yaw);
        metal.set('tint', ...METAL);
        metal.box(x, g + top - h, z, 0.04, h, w, yaw);
        const fx = x + nx * 0.025, fz = z + nz * 0.025;
        face(faceMd, fx, g + top - h / 2, fz, rx, rz, nx, nz, w, h, solid(GREEN));
        const lx = fx + nx * 0.01, lz = fz + nz * 0.01;
        if (big) {
          row(faceMd, lx, g + top - h * 0.33, lz, rx, rz, nx, nz, h * 0.42, tokens(it.label));
          row(faceMd, lx, g + top - h * 0.76, lz, rx, rz, nx, nz, h * 0.3, [word('km')]);
        } else {
          const t = tokens(it.label);
          row(faceMd, lx, g + top - h / 2, lz, rx, rz, nx, nz, Math.min(h * 0.75, (w * 0.92) / (rowWidth(t, 1) || 1)), t);
        }
        break;
      }
      case 'phone': {
        metal.set('tint', ...METAL);
        metal.box(x, g, z, 0.1, 1.0, 0.1, yaw);
        metal.set('tint', 0.94, 0.55, 0.08);
        metal.box(x, g + 1.0, z, 0.4, 0.75, 0.55, yaw);
        metal.set('tint', 0.3, 0.3, 0.3);
        metal.box(x, g + 1.75, z, 0.5, 0.06, 0.65, yaw);
        const t = tokens('비상전화', 'o');
        const fx = x + nx * 0.21, fz = z + nz * 0.21;
        row(faceMd, fx, g + 1.55, fz, rx, rz, nx, nz, Math.min(0.16, 0.5 / (rowWidth(t, 1) || 1)), t);
        face(faceMd, fx - nx * 0.003, g + 1.25, fz - nz * 0.003, rx, rz, nx, nz, 0.3, 0.25, solid('#3a3a3a'));
        break;
      }
      case 'sign': {
        const lh = 0.62, gap = 0.28;
        const lines = it.rows.map((r) => ({ name: tokens(r.name), km: tokens(`${r.km}`).concat(word('km')) }));
        const w = Math.max(3.2, ...lines.map((l) => rowWidth(l.name, lh) + rowWidth(l.km, lh) + 1.6));
        const h = lines.length * (lh + gap) + gap;
        const bottom = g + 2.2;
        // Two posts and the panel's back
        metal.set('tint', ...METAL);
        for (const s of [-0.32, 0.32]) {
          const px = x + rx * s * w, pz = z + rz * s * w;
          metal.box(px - nx * 0.15, Math.min(g, groundAt(px, pz)) - 0.3, pz - nz * 0.15, 0.2, bottom + h - g + 0.4, 0.2, yaw);
        }
        metal.box(x - nx * 0.05, bottom, z - nz * 0.05, 0.08, h, w + 0.1, yaw);
        const fx = x + nx * 0.005, fz = z + nz * 0.005;
        face(faceMd, fx, bottom + h / 2, fz, rx, rz, nx, nz, w, h, solid(GREEN));
        lines.forEach((l, i) => {
          const cy = bottom + h - gap - lh / 2 - i * (lh + gap);
          row(faceMd, fx + nx * 0.02, cy, fz + nz * 0.02, rx, rz, nx, nz, lh, l.name, -w / 2 + 0.4);
          row(faceMd, fx + nx * 0.02, cy, fz + nz * 0.02, rx, rz, nx, nz, lh, l.km, w / 2 - 0.4 - rowWidth(l.km, lh));
        });
        break;
      }
      case 'shield': {
        const top = g + 4.2;
        metal.set('tint', ...METAL);
        metal.box(x - nx * 0.12, g - 0.3, z - nz * 0.12, 0.16, top - g + 0.3, 0.16, yaw);
        const fx = x + nx * 0.03, fz = z + nz * 0.03;
        if (it.ref) {
          const refs = String(it.ref).split(';').slice(0, 2);
          refs.forEach((ref, i) => {
            const ox = (i - (refs.length - 1) / 2) * 1.35;
            metal.box(x + rx * ox - nx * 0.02, top - 1.3, z + rz * ox - nz * 0.02, 0.05, 1.3, 1.3, yaw);
            face(faceMd, fx + rx * ox, top - 0.65, fz + rz * ox, rx, rz, nx, nz, 1.3, 1.3, shield(ref));
          });
        }
        if (it.name) {
          const t = tokens(it.name);
          const h = 0.45, w = rowWidth(t, h) + 0.4;
          metal.box(x - nx * 0.02, top - 2.05, z - nz * 0.02, 0.05, 0.65, w, yaw);
          face(faceMd, fx, top - 1.725, fz, rx, rz, nx, nz, w, 0.65, solid(GREEN));
          row(faceMd, fx + nx * 0.02, top - 1.725, fz + nz * 0.02, rx, rz, nx, nz, h, t);
        }
        break;
      }
      case 'gantry': {
        const span = it.width / 2 + 2.2;
        const y = it.y;
        const beamY = y + 7.4;
        metal.set('tint', ...METAL);
        for (const s of [-span, span]) {
          const px = x + rx * s, pz = z + rz * s;
          metal.box(px, Math.min(groundAt(px, pz), y) - 0.3, pz, 0.45, beamY + 0.9 - Math.min(groundAt(px, pz), y) + 0.3, 0.45, yaw);
        }
        // Truss: two chords and the diagonals between them
        for (const oy of [0, 0.9]) beam(metal, x - rx * span, beamY + oy, z - rz * span, x + rx * span, beamY + oy, z + rz * span, 0.08);
        for (let k = 0; k < Math.ceil(span); k++) {
          const u0 = -span + k * 2, u1 = Math.min(span, u0 + 2);
          beam(metal, x + rx * u0, beamY, z + rz * u0, x + rx * u1, beamY + 0.9, z + rz * u1, 0.04);
        }
        // Panels hanging in front of the truss: [shield + name] [next destination ↑ km]
        const ph = 2.6, lh = 0.8;
        const p1 = (it.ref ? [shield(String(it.ref).split(';')[0])] : []);
        const n1 = it.name ? tokens(it.name) : [];
        const w1 = Math.max(3, rowWidth(n1, lh * 0.8) + 0.8);
        const n2 = it.next ? tokens(it.next.name) : [];
        const k2 = it.next ? [arrow()].concat(tokens(`${it.next.km}`), word('km')) : [];
        const w2 = it.next ? Math.max(3, rowWidth(n2, lh) + 0.8, rowWidth(k2, lh * 0.8) + 0.8) : 0;
        const total = w1 + (w2 ? w2 + 0.4 : 0);
        const fx = x + nx * 0.35, fz = z + nz * 0.35, cy = beamY + 0.2;
        let u = -total / 2;
        for (const [w, kind] of [[w1, 1], [w2, 2]]) {
          if (!w) continue;
          const cx = fx + rx * (u + w / 2), cz = fz + rz * (u + w / 2);
          metal.box(cx - nx * 0.06, cy - ph / 2, cz - nz * 0.06, 0.1, ph, w + 0.1, yaw);
          face(faceMd, cx, cy, cz, rx, rz, nx, nz, w, ph, solid(GREEN));
          const tx = cx + nx * 0.02, tz = cz + nz * 0.02;
          if (kind === 1) {
            if (p1.length) face(faceMd, tx, cy + 0.45, tz, rx, rz, nx, nz, 1.4, 1.4, p1[0]);
            row(faceMd, tx, cy - 0.75, tz, rx, rz, nx, nz, lh * 0.8, n1);
          } else {
            row(faceMd, tx, cy + 0.55, tz, rx, rz, nx, nz, lh, n2);
            row(faceMd, tx, cy - 0.5, tz, rx, rz, nx, nz, lh * 0.8, k2);
          }
          u += w + 0.4;
        }
        break;
      }
    }
  }
}

export { getAtlas, writeFurniture, beam, solid, word, shield, tokens };
