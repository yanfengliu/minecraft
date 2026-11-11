// How the wildlife reads the shape of the ground: where a plant would stand in
// a column, how low a bird may fly over it, and where the top of the water is.
// The world's heightmap answers for open ground in one read; these helpers
// look beneath tree crowns and at the surface of water, which it does not.

import { B, BLOCKS, IS_LEAVES, IS_LOG, SHAPE, SHAPE_CROSS, SOLID, STATE_COUNT, WATER_LEVEL, WATER_SOURCE } from '../../world/blocks';
import type { World } from '../../world/world';
import { FOOD_BERRY, FOOD_FLOWER, FOOD_GRASS, FOOD_MUSHROOM } from './species';

/** States a look downward through a tree passes through: air, foliage, trunks and small plants. */
export const SOFT = new Uint8Array(STATE_COUNT);
for (const s of BLOCKS) {
  if (s.id === B.air || IS_LEAVES[s.id] || IS_LOG[s.id] || (SHAPE[s.id] === SHAPE_CROSS && !SOLID[s.id])) SOFT[s.id] = 1;
}

/** What each block state is as food: one of the FOOD_* bits, or 0 for the inedible. */
export const FOOD = new Uint8Array(STATE_COUNT);
FOOD[B.tall_grass] = FOOD_GRASS;
FOOD[B.fern] = FOOD_GRASS;
FOOD[B.poppy] = FOOD_FLOWER;
FOOD[B.daisy] = FOOD_FLOWER;
FOOD[B.bluebell] = FOOD_FLOWER;
FOOD[B.buttercup] = FOOD_FLOWER;
// Only a ripe bush is worth a visit, and only the brown mushroom is safe to eat.
FOOD[B.berry_bush + 1] = FOOD_BERRY;
FOOD[B.mushroom_brown] = FOOD_MUSHROOM;

/** True when the top of this column is a tree: foliage or a bare trunk. */
export function isCanopy(state: number): boolean {
  return IS_LEAVES[state] === 1 || IS_LOG[state] === 1;
}

/**
 * y of the cell resting on the ground in this column, where a plant would
 * stand, looking beneath any tree crown. In a trunk's own column this is the
 * lowest log.
 */
export function floorCellY(world: World, x: number, z: number): number {
  let y = world.height(x, z);
  if (y < 1 || !isCanopy(world.get(x, y - 1, z))) return y;
  y -= 2;
  while (y > 0 && SOFT[world.get(x, y, z)]) y--;
  return y + 1;
}

/**
 * The lowest height a flier can be at over this column: the top of the ground,
 * roof or canopy, or the surface of the water where there is any.
 */
export function airFloor(world: World, x: number, z: number): number {
  let y = world.height(x, z);
  while (y < world.sy && WATER_LEVEL[world.get(x, y, z)]) y++;
  return y;
}

/** y of the top water cell of infinite water in this column within one cell of `nearY`, or -1. */
export function surfaceNear(world: World, x: number, z: number, nearY: number): number {
  for (let k = 0; k < 3; k++) {
    const y = k === 0 ? nearY : k === 1 ? nearY - 1 : nearY + 1;
    if (!WATER_SOURCE[world.get(x, y, z)]) continue;
    const above = world.get(x, y + 1, z);
    if (!WATER_LEVEL[above] && !SOLID[above]) return y;
  }
  return -1;
}

/** y of the top water cell of infinite water in this column, or -1 when the column is dry or roofed over. */
export function waterTop(world: World, x: number, z: number): number {
  let y = world.height(x, z);
  if (!WATER_SOURCE[world.get(x, y, z)]) return -1;
  while (y + 1 < world.sy && WATER_SOURCE[world.get(x, y + 1, z)]) y++;
  return y;
}

/** Count columns whose ground-level cell satisfies `match`. A full scan: for tests and tuning, not for the tick. */
export function countFloor(world: World, match: (state: number) => boolean): number {
  let n = 0;
  for (let z = 0; z < world.sz; z++) {
    for (let x = 0; x < world.sx; x++) {
      if (match(world.get(x, floorCellY(world, x, z), z))) n++;
    }
  }
  return n;
}
