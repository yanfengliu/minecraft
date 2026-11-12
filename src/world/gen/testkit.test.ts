import { describe, expect, it } from 'vitest';
import { B } from '../blocks';
import { type World, createFlatWorld } from '../world';
import { cellKey, walkableFrom, waterFaults } from './testkit';

const GROUND = 31;
const FEET = GROUND + 1;
const OPT = { opensGates: true };

/**
 * A walled corridor along x at z = 10, from x = 9 to x = 15, with the floor a
 * block higher from x = 12 on: the only way between the two ends is the step.
 */
function corridor(): World {
  const world = createFlatWorld(32, 32, GROUND, 64);
  for (let x = 8; x <= 16; x++) {
    for (let z = 9; z <= 11; z++) {
      if (z === 10 && x > 8 && x < 16) continue;
      for (let y = FEET; y <= FEET + 5; y++) world.setRaw(x, y, z, B.stone);
    }
  }
  for (let x = 12; x <= 15; x++) world.setRaw(x, FEET, 10, B.stone);
  return world;
}

describe('the checks the generation tests share', () => {
  const low = { x: 9, y: FEET, z: 10 };
  const high = { x: 15, y: FEET + 1, z: 10 };

  it('walks up and down a step that has headroom', () => {
    const world = corridor();
    expect(walkableFrom(world, low, 20, OPT).has(cellKey(high.x, high.y, high.z))).toBe(true);
    expect(walkableFrom(world, high, 20, OPT).has(cellKey(low.x, low.y, low.z))).toBe(true);
  });

  it('refuses the step where the path search does: no room overhead to rise into, or to come down through', () => {
    // A beam two cells above the foot of the step. Standing under it is fine; rising from under it is not,
    // and neither is stepping down to under it. A flood that asks only whether each cell can be stood in
    // calls this corridor open, and the residents sent along it are stuck.
    const world = corridor();
    world.setRaw(11, FEET + 2, 10, B.stone);
    const up = walkableFrom(world, low, 20, OPT);
    expect(up.has(cellKey(11, FEET, 10))).toBe(true);
    expect(up.has(cellKey(12, FEET + 1, 10))).toBe(false);
    const down = walkableFrom(world, high, 20, OPT);
    expect(down.has(cellKey(12, FEET + 1, 10))).toBe(true);
    expect(down.has(cellKey(11, FEET, 10))).toBe(false);
  });

  it('finds water with nothing under it, still water beside air, and a river above its bank', () => {
    const world = createFlatWorld(32, 32, GROUND, 64);
    expect(waterFaults(world)).toEqual({ hanging: 0, stillOpen: 0, overBank: 0, first: [] });
    // A pond one block deep, sound; then a river step, which is allowed to show its side over the lower reach.
    for (let x = 4; x <= 6; x++) world.setRaw(x, GROUND, 4, B.water_source);
    for (let x = 10; x <= 12; x++) world.setRaw(x, GROUND, 4, B.river);
    for (let x = 13; x <= 15; x++) {
      world.setRaw(x, GROUND, 4, B.air);
      world.setRaw(x, GROUND - 1, 4, B.river);
    }
    expect(waterFaults(world)).toEqual({ hanging: 0, stillOpen: 0, overBank: 0, first: [] });
    // The pond's bank dug away, the river's bank dug away, and the ground taken from under the pond.
    world.setRaw(7, GROUND, 4, B.air);
    world.setRaw(11, GROUND, 5, B.air);
    world.setRaw(5, GROUND - 1, 4, B.air);
    const faults = waterFaults(world);
    expect([faults.hanging, faults.stillOpen, faults.overBank]).toEqual([1, 1, 1]);
    expect(faults.first).toEqual(['water over nothing at 5,31,4', 'still water beside open air at 6,31,4', 'river above its bank at 11,31,4']);
  });
});
