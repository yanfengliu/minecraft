// Checks on a generated world that more than one generation test makes: where
// water stands that could not stay there, and where a villager can walk to.
// For tests; nothing in the game imports this.

import { B, SOLID, WATER_LEVEL, WATER_SOURCE, isDoor, isGate } from '../blocks';
import type { Cell } from '../plan';
import { WADE_LEVEL, type WalkOptions, standHeight } from '../walk';
import type { World } from '../world';

const SIDES: readonly (readonly [number, number])[] = [[1, 0], [-1, 0], [0, 1], [0, -1]];

const isRiver = (state: number): boolean => state >= B.river && state < B.river + 8;
const holdsWater = (state: number): boolean => SOLID[state] === 1 || WATER_SOURCE[state] === 1;

export interface WaterFaults {
  /** Water cells with neither ground nor water beneath them. */
  hanging: number;
  /** Still water (sea, lake) with open air beside it: a hole in the lake, a wall of sea. */
  stillOpen: number;
  /** River water with open air beside it over dry ground: a bank lower than the water it should hold. */
  overBank: number;
  /** Where the first of each kind was found, for the failure message. */
  first: string[];
}

/**
 * Look at every cell of infinite water from `fromY` to `toY`. The only water
 * that may show a side to the air is a river where it steps down, over the
 * lower reach it falls into.
 */
export function waterFaults(world: World, fromY = 1, toY = world.sy - 2): WaterFaults {
  const faults: WaterFaults = { hanging: 0, stillOpen: 0, overBank: 0, first: [] };
  const note = (count: number, what: string, x: number, y: number, z: number): void => {
    if (count === 1) faults.first.push(`${what} at ${x},${y},${z}`);
  };
  for (let z = 1; z < world.sz - 1; z++) {
    for (let x = 1; x < world.sx - 1; x++) {
      for (let y = fromY; y <= toY; y++) {
        const s = world.get(x, y, z);
        if (!WATER_SOURCE[s]) continue;
        if (!holdsWater(world.get(x, y - 1, z))) note(++faults.hanging, 'water over nothing', x, y, z);
        for (const [dx, dz] of SIDES) {
          if (holdsWater(world.get(x + dx, y, z + dz))) continue;
          if (!isRiver(s)) {
            note(++faults.stillOpen, 'still water beside open air', x, y, z);
            continue;
          }
          let yy = y - 1;
          while (yy > 0 && !holdsWater(world.get(x + dx, yy, z + dz))) yy--;
          if (!WATER_SOURCE[world.get(x + dx, yy, z + dz)]) note(++faults.overBank, 'river above its bank', x, y, z);
        }
      }
    }
  }
  return faults;
}

/**
 * Cells of the lake that are not still water to the brim, out to three quarters
 * of its nominal radius (its shore wanders between 0.78 and 1.22 of that, so
 * all of this is lake). A channel cut into the lake shows up here.
 */
export function lakeHoles(world: World, lake: { x: number; z: number; radius: number; level: number }): number {
  const r = lake.radius * 0.75;
  let holes = 0;
  for (let dz = -Math.ceil(r); dz <= Math.ceil(r); dz++) {
    for (let dx = -Math.ceil(r); dx <= Math.ceil(r); dx++) {
      if (Math.hypot(dx, dz) > r) continue;
      if (world.get(lake.x + dx, lake.level, lake.z + dz) !== B.water_source || WATER_SOURCE[world.get(lake.x + dx, lake.level + 1, lake.z + dz)]) holes++;
    }
  }
  return holes;
}

/** Tallest rise or drop the path search takes in one step: `MAX_STEP` in src/sim/nav/astar.ts. */
const MAX_STEP = 1.07;

/** True when a walker's body may be in a cell holding this state: `isClear` in src/sim/nav/cells.ts. */
function clear(state: number): boolean {
  if (!SOLID[state]) return (WATER_LEVEL[state] as number) <= WADE_LEVEL;
  return isDoor(state) || isGate(state);
}

export const cellKey = (x: number, y: number, z: number): number => (y * 1024 + z) * 1024 + x;

/**
 * Every feet cell within `radius` columns of `start` that can be walked to
 * from it, as `cellKey`s. The rule for one step is the path search's own
 * (`reach` in src/sim/nav/astar.ts; that file is a layer above this one, so
 * the rule is restated here): into a neighbouring column on the level, one up
 * or one down; no taller than `MAX_STEP`; with headroom over the cell being
 * left for a step up, and over the cell being entered for a step down. Only
 * straight moves are tried: the search takes a diagonal only where both
 * straight moves are open, so it gets nowhere this does not.
 */
export function walkableFrom(world: World, start: Cell, radius: number, opt: WalkOptions): Set<number> {
  const seen = new Set<number>();
  if (Number.isNaN(standHeight(world, start.x, start.y, start.z, opt))) return seen;
  const queue: number[] = [start.x, start.y, start.z];
  seen.add(cellKey(start.x, start.y, start.z));
  while (queue.length > 0) {
    const z = queue.pop() as number;
    const y = queue.pop() as number;
    const x = queue.pop() as number;
    const h0 = standHeight(world, x, y, z, opt);
    const upClear = clear(world.get(x, y + 2, z));
    for (const [dx, dz] of SIDES) {
      const nx = x + dx;
      const nz = z + dz;
      if (Math.abs(nx - start.x) > radius || Math.abs(nz - start.z) > radius) continue;
      let ny = -1;
      let h = standHeight(world, nx, y, nz, opt);
      if (!Number.isNaN(h)) {
        if (Math.abs(h - h0) <= MAX_STEP) ny = y;
      } else {
        h = upClear ? standHeight(world, nx, y + 1, nz, opt) : NaN;
        if (!Number.isNaN(h) && h - h0 <= MAX_STEP) ny = y + 1;
        else {
          h = standHeight(world, nx, y - 1, nz, opt);
          if (!Number.isNaN(h) && h0 - h <= MAX_STEP && clear(world.get(nx, y + 1, nz))) ny = y - 1;
        }
      }
      if (ny < 0) continue;
      const key = cellKey(nx, ny, nz);
      if (seen.has(key)) continue;
      seen.add(key);
      queue.push(nx, ny, nz);
    }
  }
  return seen;
}
