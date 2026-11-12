import { describe, expect, it } from 'vitest';
import { B, BLOCKS, SHAPE, SHAPE_CUBE, WALK_COST, gateState } from './blocks';
import { isStandable, standHeight } from './walk';
import { type World, createFlatWorld } from './world';

const GROUND = 31;
const FEET = GROUND + 1;
const VILLAGER = { opensGates: true, opensDoors: true };
const ANIMAL = { opensGates: false, opensDoors: false };

/** A flat world with one block set down on the grass at (8, FEET, 8). */
function with1(state: number): World {
  const world = createFlatWorld(32, 32, GROUND, 64);
  world.setRaw(8, FEET, 8, state);
  return world;
}

describe('standHeight', () => {
  it('stands on the ground, on a low step, and in the cell over a path', () => {
    const world = createFlatWorld(32, 32, GROUND, 64);
    expect(standHeight(world, 4, FEET, 4)).toBe(FEET);
    expect(standHeight(world, 4, FEET + 1, 4)).toBeNaN();
    expect(standHeight(with1(B.oak_slab), 8, FEET, 8)).toBe(FEET + 0.5);
    expect(standHeight(with1(B.stool), 8, FEET, 8)).toBe(FEET + 0.5);
    world.setRaw(4, GROUND, 4, B.path);
    expect(standHeight(world, 4, FEET, 4)).toBe(GROUND + 15 / 16);
  });

  it('lets nobody stand on a shut gate, a fence, a lantern or a campfire', () => {
    // On top of a shut gate was a way out of every pen: one step up from the grass, one step down outside.
    for (const [name, state] of [['shut gate', gateState(0, false)], ['shut gate across', gateState(1, false)], ['fence', B.fence], ['lantern', B.lantern], ['lit lantern', B.lantern + 1], ['campfire', B.campfire], ['lit campfire', B.campfire + 1]] as const) {
      const world = with1(state);
      for (const walker of [VILLAGER, ANIMAL]) {
        expect(isStandable(world, 8, FEET + 1, 8, walker), `over a ${name}`).toBe(false);
      }
      // Nor in the fire, or in the fence. (A villager stands in a gateway; that is the next test.)
      if (name.includes('gate')) continue;
      expect(isStandable(world, 8, FEET, 8, VILLAGER), `in a ${name}`).toBe(false);
    }
  });

  it('lets a villager through a gate and stops an animal at it, shut; open, it stops nobody', () => {
    const shut = with1(gateState(0, false));
    expect(standHeight(shut, 8, FEET, 8, VILLAGER)).toBe(FEET);
    expect(standHeight(shut, 8, FEET, 8, ANIMAL)).toBeNaN();
    const open = with1(gateState(0, true));
    expect(standHeight(open, 8, FEET, 8, ANIMAL)).toBe(FEET);
  });

  it('gives a walkable top to no fitting but steps, slabs, made ground and stools', () => {
    // Anything shaped, not a plain cube, is walked on only if it is meant as footing. A fitting added
    // without a walk cost of 0 takes the default and becomes a step: that is how gates did.
    const footing = /_stairs$|_slab$|^path$|^farmland$|^stool$/;
    const strays = BLOCKS.filter((s) => SHAPE[s.id] !== SHAPE_CUBE && (WALK_COST[s.id] as number) > 0 && !footing.test(s.family)).map((s) => s.name);
    expect(strays).toEqual([]);
  });
});
