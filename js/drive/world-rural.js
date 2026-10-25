// js/drive/world-rural.js
// Rural scenery of one tile (forests, fields, greenhouses, villages, transmission lines, highway signs): placeholder
// until the rural builder lands. Called by world-builder.js once per tile with
// ctx = { route, tile, sampler (tile ground: heightAt / normalAt), far (far-grid sampler or null), materials (shared,
// world-materials.js), seed }; returns null or { root (Object3D), update?(camera), dispose?() }.

function buildRural(_tile, _ctx) {
  return null;
}

export { buildRural };
