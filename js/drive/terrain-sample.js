// js/drive/terrain-sample.js
// Height lookups over the terrain grids of docs/drive.md (phase 2), pure functions over the raw Int16 decimetre arrays:
// - createTileSampler(tile, heights): a tile's tileN x tileN road-conformed grid (tiles/<key>.terrain.bin)
// - createFarSampler(far, heights): the coarse far.bin grid (route.far)
// Both return { heightAt(x, z) -> m, normalAt(x, z) -> { x, y, z } (unit, up = +y) }, bilinear within a cell and
// clamped to the grid's edge outside it.

function createGridSampler(minX, minZ, step, nx, nz, heights) {
  // Cell corners and offsets of (x, z): shared by both lookups
  const cell = (x, z) => {
    const fx = Math.min(Math.max((x - minX) / step, 0), nx - 1);
    const fz = Math.min(Math.max((z - minZ) / step, 0), nz - 1);
    const ix = Math.min(Math.floor(fx), nx - 2);
    const iz = Math.min(Math.floor(fz), nz - 2);
    const i = iz * nx + ix;
    return { tx: fx - ix, tz: fz - iz, h00: heights[i], h10: heights[i + 1], h01: heights[i + nx], h11: heights[i + nx + 1] };
  };

  const heightAt = (x, z) => {
    const { tx, tz, h00, h10, h01, h11 } = cell(x, z);
    return 0.1 * (h00 + (h10 - h00) * tx + (h01 - h00) * tz + (h00 - h10 - h01 + h11) * tx * tz);
  };

  const normalAt = (x, z) => {
    const { tx, tz, h00, h10, h01, h11 } = cell(x, z);
    const twist = h00 - h10 - h01 + h11;
    const dx = (0.1 * (h10 - h00 + twist * tz)) / step; // dh/dx
    const dz = (0.1 * (h01 - h00 + twist * tx)) / step; // dh/dz
    const len = Math.hypot(dx, 1, dz);
    return { x: -dx / len, y: 1 / len, z: -dz / len };
  };

  return { heightAt, normalAt };
}

export const createTileSampler = (tile, heights) => {
  const [minX, minZ, maxX] = tile.bounds;
  const n = Math.round(Math.sqrt(heights.length));
  return createGridSampler(minX, minZ, (maxX - minX) / (n - 1), n, n, heights);
};

export const createFarSampler = (far, heights) => createGridSampler(far.minX, far.minZ, far.step, far.nx, far.nz, heights);
