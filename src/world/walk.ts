// Where a two-block-tall walker can stand. Villagers, livestock and wildlife
// all use this one definition so that the village generator, pathfinding and
// animation agree about floors, steps, doors and gates. Headless.

import { SOLID, TOP_HEIGHT, WALK_COST, WATER_LEVEL, isDoor, isGate } from './blocks';
import type { World } from './world';

/** Deepest water (in sixteenths) a walker will wade through. */
export const WADE_LEVEL = 6;

export interface WalkOptions {
  /** Villagers open gates; animals are stopped by them. Doors are passable to anyone who can reach them. */
  opensGates?: boolean;
  /** Animals may not pass doors either. */
  opensDoors?: boolean;
}

function passable(state: number, opt: WalkOptions): boolean {
  if (!SOLID[state]) return (WATER_LEVEL[state] as number) <= WADE_LEVEL;
  if (isDoor(state)) return opt.opensDoors !== false;
  if (isGate(state)) return opt.opensGates === true;
  return false;
}

/**
 * Height of the surface a walker stands on when its feet are in cell (x, y, z),
 * or NaN when the cell cannot be stood in. A walker needs the feet cell and the
 * cell above clear, and something with a walkable top beneath its feet: either
 * a full-height block in the cell below, or a low step (slab, stair, path) in
 * the feet cell itself.
 */
export function standHeight(world: World, x: number, y: number, z: number, opt: WalkOptions = {}): number {
  const here = world.get(x, y, z);
  if (SOLID[here] && !isDoor(here) && !isGate(here)) {
    // A low step occupying the feet cell: stand on top of it.
    const top = TOP_HEIGHT[here] as number;
    if (top > 0.5 || (WALK_COST[here] as number) <= 0) return NaN;
    if (!passable(world.get(x, y + 1, z), opt) || !passable(world.get(x, y + 2, z), opt)) return NaN;
    return y + top;
  }
  if (!passable(here, opt) || !passable(world.get(x, y + 1, z), opt)) return NaN;
  const below = world.get(x, y - 1, z);
  const top = TOP_HEIGHT[below] as number;
  if ((WALK_COST[below] as number) <= 0 || top <= 0.5) return NaN;
  return y - 1 + top;
}

export function isStandable(world: World, x: number, y: number, z: number, opt: WalkOptions = {}): boolean {
  return !Number.isNaN(standHeight(world, x, y, z, opt));
}

/**
 * Feet cell of the standable spot in this column nearest to `nearY`, searching
 * `range` cells up and down, or -1. Used to drop a walker onto the ground and
 * to follow steps and slopes.
 */
export function standCellNear(world: World, x: number, z: number, nearY: number, range = 3, opt: WalkOptions = {}): number {
  for (let d = 0; d <= range; d++) {
    if (isStandable(world, x, nearY + d, z, opt)) return nearY + d;
    if (d > 0 && isStandable(world, x, nearY - d, z, opt)) return nearY - d;
  }
  return -1;
}

/** Cost multiplier of walking through the feet cell (x, y, z): the surface underfoot, plus a penalty for wading. */
export function walkCost(world: World, x: number, y: number, z: number): number {
  const here = world.get(x, y, z);
  const surface = SOLID[here] && !isDoor(here) && !isGate(here) ? here : world.get(x, y - 1, z);
  const base = (WALK_COST[surface] as number) || 1.3;
  const water = WATER_LEVEL[here] as number;
  return water > 0 ? base + 2 + water * 0.5 : base;
}
