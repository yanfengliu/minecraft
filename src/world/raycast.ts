// Ray casting through the block grid: walks cells along the ray and tests the
// boxes of whatever is in each, so partial blocks, fences and plants are hit
// where they are, not at the edge of their cell. Headless.

import { BLOCKS, SHAPE, SHAPE_CROP, SHAPE_CROSS, SHAPE_LIQUID, SHAPE_NONE, SOLID } from './blocks';
import type { World } from './world';

export interface RayHit {
  /** The cell that was hit. */
  x: number;
  y: number;
  z: number;
  state: number;
  /** Outward normal of the face that was hit. */
  nx: number;
  ny: number;
  nz: number;
  /** Distance along the ray, and the point of impact. */
  t: number;
  px: number;
  py: number;
  pz: number;
}

const scratch: number[] = [];

/** Boxes a ray can hit for the block in a cell, in world coordinates. Plants get a slim box; liquids none. */
function targetBoxes(world: World, x: number, y: number, z: number, state: number, out: number[]): void {
  out.length = 0;
  const shape = SHAPE[state] as number;
  if (shape === SHAPE_NONE || shape === SHAPE_LIQUID) return;
  if (shape === SHAPE_CROSS || shape === SHAPE_CROP) {
    out.push(x + 0.15, y, z + 0.15, x + 0.85, y + 0.85, z + 0.85);
    return;
  }
  if (SOLID[state]) {
    world.collisionBoxes(x, y, z, out);
    // Selection stops at the top of the cell even where collision does not (fences).
    for (let i = 4; i < out.length; i += 6) out[i] = Math.min(out[i] as number, y + 1);
    return;
  }
  // Non-solid fittings (torches, ladders, open gates): use the model's boxes.
  for (const b of (BLOCKS[state] as (typeof BLOCKS)[number]).boxes) {
    out.push(x + b.x0 / 16, y + b.y0 / 16, z + b.z0 / 16, x + b.x1 / 16, y + Math.min(b.y1, 16) / 16, z + b.z1 / 16);
  }
}

/** Bounding box of what a ray can hit in a cell, as [x0, y0, z0, x1, y1, z1], or null if nothing. */
export function selectionBox(world: World, x: number, y: number, z: number): number[] | null {
  const out: number[] = [];
  targetBoxes(world, x, y, z, world.get(x, y, z), out);
  if (out.length === 0) return null;
  const box = out.slice(0, 6);
  for (let i = 6; i < out.length; i += 6) {
    for (let a = 0; a < 3; a++) {
      box[a] = Math.min(box[a] as number, out[i + a] as number);
      box[a + 3] = Math.max(box[a + 3] as number, out[i + 3 + a] as number);
    }
  }
  return box;
}

/**
 * Nearest block hit by the ray from (ox, oy, oz) along the unit vector
 * (dx, dy, dz) within `reach`, or null. With `liquids` the first water cell
 * counts as a hit on its bounding cell.
 */
export function raycast(world: World, ox: number, oy: number, oz: number, dx: number, dy: number, dz: number, reach: number, liquids = false): RayHit | null {
  let cx = Math.floor(ox);
  let cy = Math.floor(oy);
  let cz = Math.floor(oz);
  const sx = dx > 0 ? 1 : -1;
  const sy = dy > 0 ? 1 : -1;
  const sz = dz > 0 ? 1 : -1;
  const tdx = dx !== 0 ? Math.abs(1 / dx) : Infinity;
  const tdy = dy !== 0 ? Math.abs(1 / dy) : Infinity;
  const tdz = dz !== 0 ? Math.abs(1 / dz) : Infinity;
  let tmx = dx !== 0 ? (dx > 0 ? cx + 1 - ox : ox - cx) * tdx : Infinity;
  let tmy = dy !== 0 ? (dy > 0 ? cy + 1 - oy : oy - cy) * tdy : Infinity;
  let tmz = dz !== 0 ? (dz > 0 ? cz + 1 - oz : oz - cz) * tdz : Infinity;
  let entered = 0;

  for (let guard = 0; guard < 256 && entered <= reach; guard++) {
    const state = world.get(cx, cy, cz);
    if (state !== 0) {
      if (liquids && SHAPE[state] === SHAPE_LIQUID) {
        scratch.length = 0;
        scratch.push(cx, cy, cz, cx + 1, cy + 1, cz + 1);
      } else {
        targetBoxes(world, cx, cy, cz, state, scratch);
      }
      let best = Infinity;
      let bn = 0;
      for (let i = 0; i < scratch.length; i += 6) {
        // Slab test against one box.
        let t0 = 0;
        let t1 = reach;
        let n = 0;
        let ok = true;
        for (let a = 0; a < 3 && ok; a++) {
          const o = a === 0 ? ox : a === 1 ? oy : oz;
          const d = a === 0 ? dx : a === 1 ? dy : dz;
          const lo = scratch[i + a] as number;
          const hi = scratch[i + 3 + a] as number;
          if (Math.abs(d) < 1e-9) {
            if (o < lo || o > hi) ok = false;
            continue;
          }
          let ta = (lo - o) / d;
          let tb = (hi - o) / d;
          let face = a * 2 + 1;
          if (ta > tb) { const s = ta; ta = tb; tb = s; face = a * 2; }
          if (ta > t0) { t0 = ta; n = face; }
          if (tb < t1) t1 = tb;
          if (t0 > t1) ok = false;
        }
        if (ok && t0 < best) { best = t0; bn = n; }
      }
      if (best <= reach) {
        const axis = bn >> 1;
        const sign = (bn & 1) === 0 ? 1 : -1;
        return {
          x: cx, y: cy, z: cz, state, t: best,
          nx: axis === 0 ? sign : 0, ny: axis === 1 ? sign : 0, nz: axis === 2 ? sign : 0,
          px: ox + dx * best, py: oy + dy * best, pz: oz + dz * best,
        };
      }
    }
    if (tmx < tmy && tmx < tmz) { entered = tmx; tmx += tdx; cx += sx; }
    else if (tmy < tmz) { entered = tmy; tmy += tdy; cy += sy; }
    else { entered = tmz; tmz += tdz; cz += sz; }
  }
  return null;
}
