// Things that are fixed to a neighbouring block come away when it goes: plants
// need ground, torches and lanterns need something to stand on or hang from,
// ladders need their wall, a door needs its sill and its other half. Headless.

import {
  B, BLOCKS, FACING_STEP, SHAPE, SHAPE_CROP, SHAPE_CROSS, SOLID, WATER_LEVEL, isDoor,
} from './blocks';
import type { BlockChange, World } from './world';

export type Detached = (x: number, y: number, z: number, state: number) => void;

const WALL_MOUNT: Record<string, true> = { wall_torch: true, ladder: true };
const NEEDS_FLOOR: Record<string, true> = { torch: true, lantern: true, campfire: true };

/** Does the block in this cell still have what it is fixed to? */
function held(world: World, x: number, y: number, z: number, state: number): boolean {
  const def = BLOCKS[state] as (typeof BLOCKS)[number];
  const family = def.family;
  const below = world.get(x, y - 1, z);
  const shape = SHAPE[state] as number;
  if (family === 'lily_pad') return (WATER_LEVEL[below] as number) > 0;
  if (family === 'seagrass') return SOLID[below] === 1 || below === B.seagrass;
  if (shape === SHAPE_CROSS || shape === SHAPE_CROP) return SOLID[below] === 1;
  if (NEEDS_FLOOR[family]) return SOLID[below] === 1;
  if (family === 'hanging_lantern') return SOLID[world.get(x, y + 1, z)] === 1;
  if (WALL_MOUNT[family]) {
    // A wall torch facing f is mounted on the block behind it; a ladder facing f lies against the wall on its f side.
    const [dx, dz] = FACING_STEP[def.variant & 3] as readonly [number, number];
    const wall = family === 'ladder' ? world.get(x + dx, y, z + dz) : world.get(x - dx, y, z - dz);
    return SOLID[wall] === 1;
  }
  if (isDoor(state)) {
    const upper = ((state - B.door) & 2) !== 0;
    return upper ? isDoor(below) : SOLID[below] === 1 && isDoor(world.get(x, y + 1, z));
  }
  return true;
}

/**
 * Subscribe to a world so unsupported fittings fall away after every change.
 * `detached` is told what came off (to drop it as an item). Returns the
 * unsubscribe function.
 */
export function watchAttachments(world: World, detached: Detached): () => void {
  const check = (x: number, y: number, z: number): void => {
    const state = world.get(x, y, z);
    if (state === B.air || held(world, x, y, z, state)) return;
    world.set(x, y, z, state === B.seagrass ? B.water_source : B.air);
    detached(x, y, z, state);
  };
  return world.changed.on((c: BlockChange) => {
    check(c.x, c.y + 1, c.z);
    check(c.x, c.y - 1, c.z);
    check(c.x + 1, c.y, c.z);
    check(c.x - 1, c.y, c.z);
    check(c.x, c.y, c.z + 1);
    check(c.x, c.y, c.z - 1);
  });
}
