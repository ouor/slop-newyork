// tools/fetch-three.mjs — copies the Three.js dev build files the app imports into vendor/three, so it runs offline
// usage: node tools/fetch-three.mjs [ref]   (ref: a three.js branch, tag or commit; default dev)
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const REF = process.argv[2] || 'dev';
// raw GitHub, not jsDelivr: jsDelivr answers 403 for some files at a pinned commit
const BASE = `https://raw.githubusercontent.com/mrdoob/three.js/${REF}/`;
const OUT = fileURLToPath(new URL('../vendor/three/', import.meta.url));
const ADDONS = 'examples/jsm/';
const BARE = { three: 'build/three.webgpu.js', 'three/webgpu': 'build/three.webgpu.js', 'three/tsl': 'build/three.tsl.js' };

// Entry points: every 'three/...' specifier under js/
const js = fileURLToPath(new URL('../js/', import.meta.url));
const queue = new Set();
for (const file of fs.readdirSync(js)) {
  for (const [, spec] of fs.readFileSync(path.join(js, file), 'utf8').matchAll(/from\s+'(three[^']*)'/g)) {
    queue.add(BARE[spec] || spec.replace(/^three\/addons\//, ADDONS));
  }
}

// Fetch each file and follow its static relative and 'three/...' imports
const done = new Set();
for (const rel of queue) {
  if (done.has(rel)) continue;
  done.add(rel);
  const res = await fetch(BASE + rel);
  if (!res.ok) throw new Error(`${res.status} ${BASE + rel}`);
  const src = await res.text();
  fs.mkdirSync(path.dirname(path.join(OUT, rel)), { recursive: true });
  fs.writeFileSync(path.join(OUT, rel), src);
  for (const [, spec] of src.matchAll(/(?:from|import)\s*['"]([^'"]+)['"]/g)) {
    if (BARE[spec]) queue.add(BARE[spec]);
    else if (spec.startsWith('three/addons/')) queue.add(spec.replace(/^three\/addons\//, ADDONS));
    else if (spec.startsWith('.')) queue.add(path.posix.normalize(path.posix.join(path.posix.dirname(rel), spec)));
  }
}
fs.writeFileSync(path.join(OUT, 'REF'), `${REF}\n`);
console.log(`${done.size} files from three.js@${REF} -> vendor/three`);
