// Scaffolding for the fluid tests: a fluid wired to a world the way the
// facade wires it, stone basins to pour into, and measures of the water that
// is there. Not used by the game.

import { B, WATER_LEVEL, WATER_SOURCE } from '../world/blocks';
import type { World } from '../world/world';
import { Fluid, type FluidOptions } from './fluid';
import type { PhysicsEvent } from './types';

/** The height of the ground in the flat worlds these tests are set in. */
export const GROUND = 31;

export function setup(world: World, opts: FluidOptions = {}): { fluid: Fluid; events: PhysicsEvent[] } {
  const events: PhysicsEvent[] = [];
  const fluid = new Fluid(world, (e) => events.push(e), opts);
  // What the facade does: the fluid is told of every edit by anyone else.
  world.changed.on((c) => {
    if (!fluid.busy) fluid.edited(c.x, c.y, c.z, c.old, c.state);
  });
  return { fluid, events };
}

/** Finite water in the whole world, in sixteenths. */
export function totalUnits(world: World): number {
  let total = 0;
  for (let y = 0; y < world.sy; y++) {
    for (let z = 0; z < world.sz; z++) {
      for (let x = 0; x < world.sx; x++) {
        const s = world.get(x, y, z);
        if (!WATER_SOURCE[s]) total += WATER_LEVEL[s] as number;
      }
    }
  }
  return total;
}

/** Finite water in one layer of the whole world, in sixteenths. */
export function layerUnits(world: World, y: number): number {
  let total = 0;
  for (let z = 0; z < world.sz; z++) {
    for (let x = 0; x < world.sx; x++) {
      const s = world.get(x, y, z);
      if (!WATER_SOURCE[s]) total += WATER_LEVEL[s] as number;
    }
  }
  return total;
}

export function fill(world: World, x0: number, y0: number, z0: number, x1: number, y1: number, z1: number, state: number): void {
  for (let y = y0; y <= y1; y++) for (let z = z0; z <= z1; z++) for (let x = x0; x <= x1; x++) world.set(x, y, z, state);
}

/** `fill` without telling anyone: the world as it was found, not an edit. */
export function fillRaw(world: World, x0: number, y0: number, z0: number, x1: number, y1: number, z1: number, state: number): void {
  for (let y = y0; y <= y1; y++) for (let z = z0; z <= z1; z++) for (let x = x0; x <= x1; x++) world.setRaw(x, y, z, state);
}

/** A stone box open at the top whose interior is x0..x1, z0..z1 and `depth` cells deep, standing on the ground. */
export function basin(world: World, x0: number, z0: number, x1: number, z1: number, depth: number): void {
  for (let y = GROUND + 1; y <= GROUND + depth; y++) {
    for (let z = z0 - 1; z <= z1 + 1; z++) {
      for (let x = x0 - 1; x <= x1 + 1; x++) {
        const wall = x < x0 || x > x1 || z < z0 || z > z1;
        if (wall) world.set(x, y, z, B.stone);
      }
    }
  }
}

/** Tick until nothing is active, or for `maxTicks`; returns the ticks run. */
export function settle(fluid: Fluid, maxTicks: number, each?: () => void): number {
  let n = 0;
  while (fluid.activeCount > 0 && n < maxTicks) {
    fluid.tick();
    each?.();
    n++;
  }
  return n;
}

export function columnUnits(world: World, x: number, z: number, y0: number, y1: number): number {
  let u = 0;
  for (let y = y0; y <= y1; y++) u += WATER_LEVEL[world.get(x, y, z)] as number;
  return u;
}
