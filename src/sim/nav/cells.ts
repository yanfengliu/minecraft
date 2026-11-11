// Cell keys, paths and small standability helpers shared by the pathfinder,
// the route cache and the path follower. Headless.

import { SOLID, WATER_LEVEL, isDoor, isGate } from '../../world/blocks';
import { WADE_LEVEL, isStandable, type WalkOptions } from '../../world/walk';
import type { World } from '../../world/world';

/** Largest horizontal world extent a packed key can hold (10 bits per axis; y has 8). */
export const MAX_SPAN = 1024;

/** Villagers open doors and gates. Animals use `ANIMAL_WALK`. */
export const VILLAGER_WALK: WalkOptions = { opensGates: true, opensDoors: true };
export const ANIMAL_WALK: WalkOptions = { opensGates: false, opensDoors: false };

export function packCell(x: number, y: number, z: number): number {
  return (y << 20) | (z << 10) | x;
}

export const cellX = (key: number): number => key & 1023;
export const cellZ = (key: number): number => (key >> 10) & 1023;
export const cellY = (key: number): number => key >> 20;

/** A route as feet cells, start and goal included. Immutable once built, so it can be shared by many walkers. */
export interface Path {
  readonly length: number;
  readonly xs: Int16Array;
  readonly ys: Int16Array;
  readonly zs: Int16Array;
  readonly cost: number;
  /** Set when a block edit near the route means it can no longer be trusted. */
  stale: boolean;
}

export function makePath(xs: number[], ys: number[], zs: number[], cost: number): Path {
  return { length: xs.length, xs: Int16Array.from(xs), ys: Int16Array.from(ys), zs: Int16Array.from(zs), cost, stale: false };
}

export function reversePath(p: Path): Path {
  return {
    length: p.length,
    xs: p.xs.slice().reverse(),
    ys: p.ys.slice().reverse(),
    zs: p.zs.slice().reverse(),
    cost: p.cost,
    stale: false,
  };
}

/** Join routes end to start; the shared cell between two legs is kept once. */
export function joinPaths(parts: readonly Path[]): Path {
  const xs: number[] = [];
  const ys: number[] = [];
  const zs: number[] = [];
  let cost = 0;
  for (const p of parts) {
    cost += p.cost;
    for (let i = 0; i < p.length; i++) {
      const n = xs.length;
      if (i === 0 && n > 0 && xs[n - 1] === p.xs[i] && ys[n - 1] === p.ys[i] && zs[n - 1] === p.zs[i]) continue;
      xs.push(p.xs[i] as number);
      ys.push(p.ys[i] as number);
      zs.push(p.zs[i] as number);
    }
  }
  return makePath(xs, ys, zs, cost);
}

/** True when a walker's body may occupy a cell holding this state. */
export function isClear(state: number): boolean {
  if (!SOLID[state]) return (WATER_LEVEL[state] as number) <= WADE_LEVEL;
  return isDoor(state) || isGate(state);
}

const LEVEL_ORDER = [0, 1, -1, 2, -2];

/**
 * The standable cell closest to (x, y, z) within `radius` columns and two
 * levels, as a packed key, or -1. Used to turn "beside this block" into a cell
 * a walker can actually reach, and to recover a walker pushed off the grid.
 */
export function nearestStandable(world: World, x: number, y: number, z: number, radius: number, opt: WalkOptions = VILLAGER_WALK): number {
  for (let r = 0; r <= radius; r++) {
    let best = -1;
    let bestD = Infinity;
    for (let dz = -r; dz <= r; dz++) {
      for (let dx = -r; dx <= r; dx++) {
        // Ring by ring, so nearer columns always win.
        if (Math.max(Math.abs(dx), Math.abs(dz)) !== r) continue;
        for (const dy of LEVEL_ORDER) {
          if (!world.inBounds(x + dx, y + dy, z + dz) || !isStandable(world, x + dx, y + dy, z + dz, opt)) continue;
          const d = dx * dx + dz * dz + dy * dy * 0.5;
          if (d < bestD) {
            bestD = d;
            best = packCell(x + dx, y + dy, z + dz);
          }
          break;
        }
      }
    }
    if (best >= 0) return best;
  }
  return -1;
}

/**
 * Feet y of the highest standable cell in a column, searching down from the
 * rain heightmap so it finds the ground under a tree canopy, or -1.
 */
export function groundLevel(world: World, x: number, z: number, opt: WalkOptions = VILLAGER_WALK): number {
  if (x < 0 || z < 0 || x >= world.sx || z >= world.sz) return -1;
  const top = Math.min(world.sy - 2, world.height(x, z));
  for (let y = top; y >= Math.max(1, top - 40); y--) {
    if (isStandable(world, x, y, z, opt)) return y;
  }
  return -1;
}
