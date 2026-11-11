// Collision shapes derived from the block table, for both sides of the
// rigid-body world: how a state fills the half-block voxel grid the terrain
// collider is made of, how a body's cells merge into a few cuboids, and how a
// state turns when a body that came to rest at an angle goes back into the grid.

import { BLOCKS, COLLISION, IS_LOG, MATERIAL, SHAPE, SHAPE_CONNECT, SHAPE_CUBE, STATE_COUNT, type BlockState } from '../world/blocks';
import type { BodyCell } from './types';

/**
 * Per state: which of the cell's eight half-block octants its collision
 * fills, when its boxes line up with the half-block grid (full cubes, slabs,
 * stairs). Bit k is the octant at x half (k & 1), y half (k >> 1 & 1), z half
 * (k >> 2 & 1). Zero for states with no collision and for irregular ones.
 */
export const VOXEL_MASK = new Uint8Array(STATE_COUNT);
/** Per state: 1 when it has collision that the half-block grid cannot hold (paths, fences, furniture). */
export const IRREGULAR = new Uint8Array(STATE_COUNT);
/** Per state: solid volume in cubic metres. */
export const SOLID_VOLUME = new Float32Array(STATE_COUNT);

for (let s = 0; s < STATE_COUNT; s++) {
  const boxes = COLLISION[s] as Float32Array;
  if (boxes.length === 0) continue;
  let mask = 0;
  let regular = SHAPE[s] !== SHAPE_CONNECT;
  let volume = 0;
  for (let i = 0; i < boxes.length; i += 6) {
    const x0 = boxes[i] as number;
    const y0 = boxes[i + 1] as number;
    const z0 = boxes[i + 2] as number;
    const x1 = boxes[i + 3] as number;
    const y1 = boxes[i + 4] as number;
    const z1 = boxes[i + 5] as number;
    volume += (x1 - x0) * (y1 - y0) * (z1 - z0);
    for (const v of [x0, y0, z0, x1, y1, z1]) {
      if ((v * 2) % 1 !== 0 || v > 1) regular = false;
    }
    for (let k = 0; k < 8 && regular; k++) {
      const ox = (k & 1) * 0.5;
      const oy = ((k >> 1) & 1) * 0.5;
      const oz = ((k >> 2) & 1) * 0.5;
      if (ox >= x0 && ox < x1 && oy >= y0 && oy < y1 && oz >= z0 && oz < z1) mask |= 1 << k;
    }
  }
  SOLID_VOLUME[s] = Math.min(1, volume);
  if (regular) VOXEL_MASK[s] = mask;
  else IRREGULAR[s] = 1;
}

/** An axis-aligned box: centre and half extents, with the material it is made of. */
export interface MergedBox {
  x: number;
  y: number;
  z: number;
  hx: number;
  hy: number;
  hz: number;
  material: number;
}

/**
 * The colliders of a body: full-cube cells of one material merged greedily
 * into larger cuboids, every other cell as its own collision boxes. Positions
 * are body-local, with cell (dx, dy, dz) centred on (dx, dy, dz).
 */
export function mergeCells(cells: readonly BodyCell[]): MergedBox[] {
  const out: MergedBox[] = [];
  const full = new Map<string, number>();
  const key = (x: number, y: number, z: number): string => `${x},${y},${z}`;
  for (const c of cells) {
    if (VOXEL_MASK[c.state] === 0xff) {
      full.set(key(c.dx, c.dy, c.dz), MATERIAL[c.state] as number);
      continue;
    }
    const boxes = COLLISION[c.state] as Float32Array;
    const material = MATERIAL[c.state] as number;
    // A state with no collision of its own (a plant thrown as a block) still needs something to land on.
    if (boxes.length === 0) out.push({ x: c.dx, y: c.dy, z: c.dz, hx: 0.5, hy: 0.5, hz: 0.5, material });
    for (let i = 0; i < boxes.length; i += 6) {
      const x0 = boxes[i] as number;
      const y0 = boxes[i + 1] as number;
      const z0 = boxes[i + 2] as number;
      const x1 = boxes[i + 3] as number;
      const y1 = boxes[i + 4] as number;
      const z1 = boxes[i + 5] as number;
      out.push({
        x: c.dx - 0.5 + (x0 + x1) / 2, y: c.dy - 0.5 + (y0 + y1) / 2, z: c.dz - 0.5 + (z0 + z1) / 2,
        hx: (x1 - x0) / 2, hy: (y1 - y0) / 2, hz: (z1 - z0) / 2, material,
      });
    }
  }
  // Greedy boxes over the full cells, in a fixed order so the same body always gets the same colliders.
  const order = cells.filter((c) => VOXEL_MASK[c.state] === 0xff).sort((a, b) => a.dy - b.dy || a.dz - b.dz || a.dx - b.dx);
  for (const c of order) {
    const material = full.get(key(c.dx, c.dy, c.dz));
    if (material === undefined) continue;
    let nx = 1;
    while (full.get(key(c.dx + nx, c.dy, c.dz)) === material) nx++;
    let nz = 1;
    const rowFits = (dy: number, dz: number): boolean => {
      for (let i = 0; i < nx; i++) if (full.get(key(c.dx + i, c.dy + dy, c.dz + dz)) !== material) return false;
      return true;
    };
    while (rowFits(0, nz)) nz++;
    let ny = 1;
    const slabFits = (dy: number): boolean => {
      for (let j = 0; j < nz; j++) if (!rowFits(dy, j)) return false;
      return true;
    };
    while (slabFits(ny)) ny++;
    for (let j = 0; j < ny; j++) for (let k = 0; k < nz; k++) for (let i = 0; i < nx; i++) full.delete(key(c.dx + i, c.dy + j, c.dz + k));
    out.push({ x: c.dx + (nx - 1) / 2, y: c.dy + (ny - 1) / 2, z: c.dz + (nz - 1) / 2, hx: nx / 2, hy: ny / 2, hz: nz / 2, material });
  }
  return out;
}

/**
 * Merge touching boxes that share a cross-section: first along x, then along
 * z. Used for the irregular terrain colliders, so a run of path blocks is one
 * collider instead of a seam every metre. Boxes are (x0, y0, z0, x1, y1, z1, material) runs of seven.
 */
export function mergeBoxes(boxes: number[]): number[] {
  const eq = (a: number, b: number): boolean => Math.abs(a - b) < 1e-6;
  const pass = (src: number[], lo: number, hi: number, o1: number, o2: number): number[] => {
    const n = src.length / 7;
    const idx = Array.from({ length: n }, (_, i) => i * 7);
    // Sort so boxes with the same cross-section and material are neighbours, ordered along the merge axis.
    const k = (i: number, f: number): number => src[i + f] as number;
    idx.sort((a, b) => k(a, 6) - k(b, 6) || k(a, 1) - k(b, 1) || k(a, 4) - k(b, 4) || k(a, o1) - k(b, o1) || k(a, o2) - k(b, o2) || k(a, lo) - k(b, lo));
    const out: number[] = [];
    for (const i of idx) {
      const last = out.length - 7;
      if (last >= 0 && eq(out[last + 6] as number, k(i, 6)) && eq(out[last + 1] as number, k(i, 1)) && eq(out[last + 4] as number, k(i, 4))
        && eq(out[last + o1] as number, k(i, o1)) && eq(out[last + o2] as number, k(i, o2)) && eq(out[last + hi] as number, k(i, lo))) {
        out[last + hi] = k(i, hi);
        continue;
      }
      for (let f = 0; f < 7; f++) out.push(k(i, f));
    }
    return out;
  };
  // Along x: same z extent. Then along z: same x extent.
  return pass(pass(boxes, 0, 3, 2, 5), 2, 5, 0, 3);
}

// ---------------------------------------------------------------------------
// Turning states
// ---------------------------------------------------------------------------

const KIND_PLAIN = 0;
const KIND_AXIS = 1;
const KIND_SLAB = 2;
const KIND_STAIRS = 3;
const KIND_FIXED = 4;

const KIND = new Uint8Array(STATE_COUNT);
const BASE = new Uint16Array(STATE_COUNT);
for (let s = 0; s < STATE_COUNT; s++) {
  const b = BLOCKS[s] as BlockState;
  BASE[s] = s - b.variant;
  if (IS_LOG[s] || b.family === 'beam') KIND[s] = KIND_AXIS;
  else if (b.family.endsWith('_slab')) KIND[s] = KIND_SLAB;
  else if (b.family.endsWith('_stairs')) KIND[s] = KIND_STAIRS;
  else if (SHAPE[s] === SHAPE_CUBE && b.variant === 0 && (BLOCKS[s + 1]?.family !== b.family)) KIND[s] = KIND_PLAIN;
  else KIND[s] = KIND_FIXED;
}

/**
 * The state a block becomes when it re-enters the grid turned by `m`, a
 * rotation matrix of 0 and +-1 in row-major order (it maps body axes to world
 * axes). Returns -1 when the block table has no such orientation: a slab on
 * its edge, stairs on their side, furniture not upright.
 */
export function rotateState(state: number, m: ArrayLike<number>): number {
  const kind = KIND[state] as number;
  if (kind === KIND_PLAIN) return state;
  const base = BASE[state] as number;
  const variant = state - base;
  if (kind === KIND_AXIS) {
    // Variant is the axis the grain runs along: 0 = y, 1 = x, 2 = z. Find where that axis went.
    const from = variant === 0 ? 1 : variant === 1 ? 0 : 2;
    const to = m[from] !== 0 ? 0 : m[3 + from] !== 0 ? 1 : 2;
    return base + (to === 1 ? 0 : to === 0 ? 1 : 2);
  }
  // Everything else must at least keep its vertical axis vertical.
  const up = m[4] as number;
  if (up === 0) return -1;
  if (kind === KIND_SLAB) return up > 0 ? state : base + (1 - variant);
  if (up < 0) return -1;
  // Quarter turns about y, clockwise seen from above (north -> east -> south -> west), from where +x went.
  const turns = m[0] === 1 ? 0 : m[6] === 1 ? 1 : m[0] === -1 ? 2 : 3;
  if (kind === KIND_STAIRS) return base + ((variant + turns) & 3);
  return turns === 0 ? state : -1;
}

/**
 * The grid-aligned rotation nearest to a unit quaternion: writes the matrix
 * (row-major, entries 0 and +-1) into `out` and returns the angle between the
 * two in radians.
 */
export function nearestGridRotation(qx: number, qy: number, qz: number, qw: number, out: Int8Array): number {
  const r = [
    1 - 2 * (qy * qy + qz * qz), 2 * (qx * qy - qz * qw), 2 * (qx * qz + qy * qw),
    2 * (qx * qy + qz * qw), 1 - 2 * (qx * qx + qz * qz), 2 * (qy * qz - qx * qw),
    2 * (qx * qz - qy * qw), 2 * (qy * qz + qx * qw), 1 - 2 * (qx * qx + qy * qy),
  ];
  // Snap the first two columns to their largest component, then take the third as their cross product so the result is a proper rotation.
  const snapColumn = (c: number, skipRow: number): number => {
    let best = -1;
    for (let row = 0; row < 3; row++) {
      if (row === skipRow) continue;
      if (best < 0 || Math.abs(r[row * 3 + c] as number) > Math.abs(r[best * 3 + c] as number)) best = row;
    }
    return best;
  };
  out.fill(0);
  const row0 = snapColumn(0, -1);
  out[row0 * 3] = (r[row0 * 3] as number) < 0 ? -1 : 1;
  const row1 = snapColumn(1, row0);
  out[row1 * 3 + 1] = (r[row1 * 3 + 1] as number) < 0 ? -1 : 1;
  const a = [out[0] as number, out[3] as number, out[6] as number];
  const b = [out[1] as number, out[4] as number, out[7] as number];
  out[2] = (a[1] as number) * (b[2] as number) - (a[2] as number) * (b[1] as number);
  out[5] = (a[2] as number) * (b[0] as number) - (a[0] as number) * (b[2] as number);
  out[8] = (a[0] as number) * (b[1] as number) - (a[1] as number) * (b[0] as number);
  // Angle between R and the snapped S: trace of S^T R.
  let trace = 0;
  for (let i = 0; i < 9; i++) trace += (out[i] as number) * (r[i] as number);
  return Math.acos(Math.max(-1, Math.min(1, (trace - 1) / 2)));
}
