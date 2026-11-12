import { describe, expect, it } from 'vitest';
import { B, WATER_LEVEL, waterState } from '../world/blocks';
import { type World, createFlatWorld } from '../world/world';
import { DISPLACE_AT_ONCE, DISPLACE_PER_TICK } from './displace';
import type { Fluid } from './fluid';
import { GROUND, basin, columnUnits, fill, fillRaw, layerUnits, settle, setup, totalUnits } from './testkit';

// Water that loses its cell to something put there. Every unit of it goes
// somewhere it could have gone, or is counted, and it stays in the body it
// stood in for as long as that body has room.

describe('displaced water', () => {
  it('finds room across a full pool, round a ledge and far up a shaft', () => {
    const world = createFlatWorld(64, 64, GROUND);
    const { fluid } = setup(world);
    // A full pool 3 x 3 and two deep, with one block of ceiling over its middle column and open sky over the rest.
    basin(world, 20, 20, 22, 22, 3);
    fill(world, 20, GROUND + 1, 20, 22, GROUND + 2, 22, waterState(16));
    world.setRaw(21, GROUND + 3, 21, B.stone);
    const pool = 18 * 16;
    settle(fluid, 50);
    expect(totalUnits(world)).toBe(pool);
    // A block set in the bottom of the middle column: every cell beside it is full, and so is the one
    // above it, which lies under the ceiling. The room is one cell over and two up.
    world.set(21, GROUND + 1, 21, B.stone);
    expect(fluid.lost).toBe(0);
    expect(totalUnits(world)).toBe(pool);
    settle(fluid, 300);
    expect(totalUnits(world)).toBe(pool);

    // A shaft of water twenty-four deep, open at the top: a block at its foot lifts the whole column.
    const top = GROUND + 24;
    expect(top + 1).toBeLessThan(world.sy);
    for (let y = GROUND + 1; y <= top + 1; y++) {
      for (const [dx, dz] of [[1, 0], [-1, 0], [0, 1], [0, -1]] as const) world.setRaw(40 + dx, y, 40 + dz, B.stone);
    }
    fill(world, 40, GROUND + 1, 40, 40, top, 40, waterState(16));
    const before = totalUnits(world);
    world.set(40, GROUND + 1, 40, B.stone);
    expect(fluid.lost).toBe(0);
    expect(totalUnits(world)).toBe(before);
    expect(WATER_LEVEL[world.get(40, top + 1, 40)]).toBe(16);
  });

  it('raises a deep pool from a block set at its bottom', () => {
    const world = createFlatWorld(64, 64, GROUND);
    const { fluid } = setup(world);
    // A full pool nine by nine and twelve deep, open above: 972 cells, and the surface eleven cells above
    // a block set in the middle of its floor. A search that spread evenly gave up long before the top.
    basin(world, 20, 20, 28, 28, 13);
    fill(world, 20, GROUND + 1, 20, 28, GROUND + 12, 28, waterState(16));
    settle(fluid, 50);
    const deep = totalUnits(world);
    expect(deep).toBe(81 * 12 * 16);
    world.set(24, GROUND + 1, 24, B.stone);
    expect(fluid.lost).toBe(0);
    expect(totalUnits(world)).toBe(deep);
    settle(fluid, 400);
    expect(totalUnits(world)).toBe(deep);
    // It went on top, inside the walls.
    let above = 0;
    for (let z = 20; z <= 28; z++) for (let x = 20; x <= 28; x++) above += WATER_LEVEL[world.get(x, GROUND + 13, z)] as number;
    expect(above).toBe(16);
  });

  it('keeps the water in a pool that has room, rather than lifting it onto the block', () => {
    const world = createFlatWorld(64, 64, GROUND);
    const { fluid } = setup(world);
    // A trough three cells long and one deep, not quite full. A block set in one end pushes its water along
    // the trough, where there is room for it. It is not lifted onto the block, from where it ran off over the rim.
    basin(world, 40, 40, 42, 40, 1);
    world.set(40, GROUND + 1, 40, waterState(11));
    world.set(41, GROUND + 1, 40, waterState(11));
    world.set(42, GROUND + 1, 40, waterState(10));
    settle(fluid, 100);
    const trough = (): number => columnUnits(world, 40, 40, GROUND + 1, GROUND + 1) + columnUnits(world, 41, 40, GROUND + 1, GROUND + 1) + columnUnits(world, 42, 40, GROUND + 1, GROUND + 1);
    expect(trough()).toBe(32);
    const all = totalUnits(world);
    const first = WATER_LEVEL[world.get(40, GROUND + 1, 40)] as number;
    world.set(40, GROUND + 1, 40, B.stone);
    settle(fluid, 200);
    expect(fluid.lost).toBe(0);
    expect(totalUnits(world)).toBe(all);
    expect(first).toBeGreaterThan(0);
    expect(trough()).toBe(32);
    expect(WATER_LEVEL[world.get(40, GROUND + 2, 40)]).toBe(0);
  });

  it('finds the one way out at the far end of a long flooded passage, over as many ticks as it takes', () => {
    const world = createFlatWorld(128, 128, GROUND);
    const { fluid } = setup(world);
    // A flooded passage one cell wide and deep under a stone roof, folded back and forth fifty times: 5,050
    // full cells in single file, and the only place the water can rise is past the last of them. Whatever
    // order a search takes them in, one that stops at four thousand cells never gets there.
    basin(world, 10, 10, 109, 109, 2);
    for (let z = 10; z <= 109; z++) {
      for (let x = 10; x <= 109; x++) {
        const row = z - 10;
        const wet = row % 2 === 0 || x === (row % 4 === 1 ? 109 : 10);
        world.setRaw(x, GROUND + 1, z, wet ? waterState(16) : B.stone);
        world.setRaw(x, GROUND + 2, z, B.stone);
      }
    }
    // The way out: the roof is open over the stub at the very end of the passage.
    world.setRaw(10, GROUND + 2, 109, B.air);
    settle(fluid, 50);
    const pool = totalUnits(world);
    expect(pool).toBe(5050 * 16);
    world.set(10, GROUND + 1, 10, B.stone);
    expect(fluid.lost).toBe(0);
    // Too far to find in the call itself: the water is neither in the world nor lost, and the books say so.
    expect(fluid.pending).toBe(16);
    expect(totalUnits(world) + fluid.pending).toBe(pool);
    expect(fluid.activeCount).toBeGreaterThan(0);
    const ticks = settle(fluid, 400);
    expect(ticks).toBeGreaterThan(0);
    expect(fluid.pending).toBe(0);
    expect(fluid.lost).toBe(0);
    expect(totalUnits(world)).toBe(pool);
    expect(WATER_LEVEL[world.get(10, GROUND + 2, 109)]).toBe(16);
  });

  it('finds the one opening in the roof over a wide, deep pool', () => {
    const world = createFlatWorld(128, 128, GROUND);
    const { fluid } = setup(world);
    // Ninety-six cells square and eight deep under a roof, 73,728 cells of full water, with one cell of the
    // roof open in the corner farthest from the block.
    basin(world, 16, 16, 111, 111, 9);
    fillRaw(world, 16, GROUND + 1, 16, 111, GROUND + 8, 111, waterState(16));
    fillRaw(world, 16, GROUND + 9, 16, 111, GROUND + 9, 111, B.stone);
    world.setRaw(111, GROUND + 9, 111, B.air);
    const pool = 96 * 96 * 8 * 16;
    world.set(16, GROUND + 1, 16, B.stone);
    expect(fluid.pending).toBe(16);
    let most = 0;
    let ticks = 0;
    for (; fluid.pending > 0 && ticks < 100; ticks++) {
      const before = fluid.searched;
      fluid.tick();
      most = Math.max(most, fluid.searched - before);
    }
    expect(fluid.pending).toBe(0);
    expect(fluid.lost).toBe(0);
    expect(WATER_LEVEL[world.get(111, GROUND + 9, 111)]).toBe(16);
    expect(totalUnits(world)).toBe(pool);
    // The whole pool was looked through, a tick's worth at a time.
    expect(fluid.searched).toBeGreaterThanOrEqual(96 * 96 * 8 - 1);
    expect(most).toBeLessThanOrEqual(DISPLACE_PER_TICK);
    console.log(`displaced water: a way out ${fluid.searched} full cells away was found in ${ticks} ticks`);
  });

  it('gives the water to room at the far side of a brim-full pool before it lets the pool overflow', () => {
    const world = createFlatWorld(64, 64, GROUND);
    const { fluid } = setup(world);
    // Twenty by twenty and one deep, full to the brim but for the far corner, where sixteen cells are each a
    // unit short: exactly the room a block's worth of water needs, 30 cells and more from where it is set.
    basin(world, 20, 20, 39, 39, 1);
    for (let z = 20; z <= 39; z++) for (let x = 20; x <= 39; x++) world.set(x, GROUND + 1, z, waterState(x >= 36 && z >= 36 ? 15 : 16));
    settle(fluid, 100);
    const inside = (): number => {
      let units = 0;
      for (let z = 20; z <= 39; z++) for (let x = 20; x <= 39; x++) units += WATER_LEVEL[world.get(x, GROUND + 1, z)] as number;
      return units;
    };
    const pool = 384 * 16 + 16 * 15;
    expect(inside()).toBe(pool);
    world.set(20, GROUND + 1, 20, B.stone);
    settle(fluid, 400);
    // All of it still in the pool: none was set on top of the water to run off over the rim.
    expect(inside()).toBe(pool);
    expect(totalUnits(world)).toBe(pool);
    expect(fluid.lost).toBe(0);
    expect(fluid.pending).toBe(0);
  });

  it('takes the nearest room first', () => {
    const world = createFlatWorld(64, 64, GROUND);
    const { fluid } = setup(world);
    // A pool forty cells square let into the ground and full to the brim, but for two cells three steps
    // from the middle that are each half full.
    fillRaw(world, 12, GROUND, 12, 51, GROUND, 51, waterState(16));
    world.setRaw(35, GROUND, 32, waterState(8));
    world.setRaw(32, GROUND, 35, waterState(8));
    const pool = totalUnits(world);
    world.set(32, GROUND, 32, B.stone);
    expect(fluid.pending + fluid.lost).toBe(0);
    expect(totalUnits(world)).toBe(pool);
    expect(WATER_LEVEL[world.get(35, GROUND, 32)]).toBe(16);
    expect(WATER_LEVEL[world.get(32, GROUND, 35)]).toBe(16);
    // Found by going outward from the block: through the two dozen cells within three steps of it, not
    // the sixteen hundred of the pool.
    expect(fluid.searched).toBeLessThan(40);
  });

  it('lets water displaced from a fall go on down, not up the fall', () => {
    const world = createFlatWorld(64, 64, GROUND);
    const { fluid } = setup(world);
    // A full column of water twenty high with a part-full cell on top, and beside it, half way up and over
    // open air, a cell holding one unit. Nothing is ticked: this is where the unit is put, not where it runs.
    const top = GROUND + 21;
    for (let y = GROUND + 2; y < top; y++) world.setRaw(31, y, 30, waterState(16));
    world.setRaw(31, top, 30, waterState(5));
    world.setRaw(30, GROUND + 10, 30, waterState(1));
    world.set(30, GROUND + 10, 30, B.stone);
    expect(WATER_LEVEL[world.get(30, GROUND + 9, 30)]).toBe(1);
    expect(WATER_LEVEL[world.get(31, top, 30)]).toBe(5);
    expect(fluid.lost + fluid.pending).toBe(0);
  });

  it('looks again when a pool gets room behind the search, rather than letting it overflow', () => {
    const world = createFlatWorld(128, 128, GROUND);
    const { fluid } = setup(world);
    // A pool seventy-two cells square let into the ground, full to the brim and level with the grass:
    // 5,184 cells, too many to look through in the call that sets a block in its corner.
    fillRaw(world, 20, GROUND, 20, 91, GROUND, 91, waterState(16));
    const pool = totalUnits(world);
    world.set(20, GROUND, 20, B.stone);
    expect(fluid.pending).toBe(16);
    // While the search is out across the pool, a hole is dug in the floor near where it began. The water
    // over the hole falls in, and the pool has exactly the room it lacked, in a part already looked at.
    world.set(23, GROUND - 1, 22, B.air);
    let over = 0;
    const tick = (): void => {
      fluid.tick();
      over = Math.max(over, layerUnits(world, GROUND + 1));
    };
    for (let i = 0; fluid.pending > 0 && i < 50; i++) tick();
    for (let i = 0; i < 40; i++) tick();
    expect(fluid.pending).toBe(0);
    expect(fluid.lost).toBe(0);
    expect(totalUnits(world)).toBe(pool);
    // None of it was ever set on top of the pool, from where it would have run off over the grass.
    expect(over).toBe(0);
  });

  it('does not call water lost while the walls round it are being changed, and does once they are still', () => {
    // The same pool under a stone roof, shut in on every side, with a block set in its corner.
    const tank = (): { world: World; fluid: Fluid } => {
      const world = createFlatWorld(128, 128, GROUND);
      const { fluid } = setup(world);
      fillRaw(world, 20, GROUND, 20, 91, GROUND, 91, waterState(16));
      fillRaw(world, 20, GROUND + 1, 20, 91, GROUND + 1, 91, B.stone);
      world.set(20, GROUND, 20, B.stone);
      expect(fluid.pending).toBe(16);
      return { world, fluid };
    };
    // Somebody rebuilding the roof over a part the search has been through, a block every tick. The tank
    // stays shut, but no search gets to the end of it without something it looked at having changed.
    const rebuild = (world: World, fluid: Fluid): void => {
      for (let i = 0; i < 14; i++) {
        world.set(24, GROUND + 1, 22, i % 2 === 0 ? B.oak_planks : B.stone);
        fluid.tick();
        expect(fluid.lost).toBe(0);
        expect(fluid.pending).toBe(16);
      }
      expect(world.get(24, GROUND + 1, 22)).toBe(B.stone);
    };

    // Left alone after that, a search runs with nothing changing under it, finds the tank shut, and says so.
    const shut = tank();
    const held = totalUnits(shut.world);
    rebuild(shut.world, shut.fluid);
    settle(shut.fluid, 20);
    expect(shut.fluid.pending).toBe(0);
    expect(shut.fluid.lost).toBe(16);
    expect(shut.fluid.activeCount).toBe(0);
    expect(totalUnits(shut.world)).toBe(held);

    // Opened instead, the water that was waiting rises where the roof was.
    const opened = tank();
    rebuild(opened.world, opened.fluid);
    opened.world.set(24, GROUND + 1, 22, B.air);
    settle(opened.fluid, 20);
    expect(opened.fluid.pending).toBe(0);
    expect(opened.fluid.lost).toBe(0);
    expect(WATER_LEVEL[opened.world.get(24, GROUND + 1, 22)]).toBe(16);
    expect(totalUnits(opened.world)).toBe(held + 16);
  });

  it('does only so much searching between one tick and the next, however many blocks are set down', () => {
    const world = createFlatWorld(128, 128, GROUND);
    const { fluid } = setup(world);
    // A brim-full pool of three thousand cells with no room anywhere in it. Each block set in it sends a
    // search through the whole pool before the pool is allowed to overflow.
    fillRaw(world, 20, GROUND, 20, 79, GROUND, 69, waterState(16));
    const pool = totalUnits(world);
    for (let i = 0; i < 10; i++) world.set(20 + i * 2, GROUND, 20, B.stone);
    // Ten blocks in one tick: one search finished and the next begun, and the rest wait.
    expect(fluid.searched).toBeLessThanOrEqual(DISPLACE_AT_ONCE);
    expect(fluid.pending).toBe(9 * 16);
    let ticks = 0;
    for (; fluid.pending > 0 && ticks < 60; ticks++) {
      const before = fluid.searched;
      fluid.tick();
      expect(fluid.searched - before).toBeLessThanOrEqual(DISPLACE_PER_TICK);
    }
    expect(fluid.pending).toBe(0);
    expect(fluid.lost).toBe(0);
    expect(totalUnits(world)).toBe(pool - fluid.evaporated);
    console.log(`displaced water: ten blocks in a full pool of 3000 cells were all placed ${ticks} ticks later, ${fluid.searched} full cells searched`);
  });

  it('moves water aside when anything is put where it stands, and loses none', () => {
    const world = createFlatWorld(64, 64, GROUND);
    const { fluid, events } = setup(world);
    const inWorld = (): number => fluid.poured + fluid.created - fluid.absorbed - fluid.evaporated - fluid.lost - fluid.pending;
    // A walled pool 6 x 6, a block and a half deep.
    basin(world, 20, 20, 25, 25, 3);
    fill(world, 20, GROUND + 1, 20, 25, GROUND + 1, 25, waterState(16));
    fill(world, 20, GROUND + 2, 20, 25, GROUND + 2, 25, waterState(8));
    const poured = 36 * 24;
    settle(fluid, 200);
    expect(fluid.poured).toBe(poured);
    expect(totalUnits(world)).toBe(poured);

    // What the player's block, a villager's seed and a growing trunk all do: write straight into a cell that holds water.
    world.set(22, GROUND + 1, 22, B.stone); // a full cell on the bottom, with water over it
    expect(totalUnits(world)).toBe(poured);
    world.set(23, GROUND + 2, 23, B.oak_log); // a half-full cell at the surface
    world.set(21, GROUND + 2, 24, B.wheat); // not solid, but nothing water can share a cell with
    world.set(24, GROUND + 2, 21, B.oak_sapling); // a plant: the water comes back and washes it out
    world.set(20, GROUND + 2, 20, B.air); // and nobody empties a cell by writing air into it
    expect(totalUnits(world)).toBe(poured);
    settle(fluid, 500);
    expect(fluid.activeCount).toBe(0);
    expect(totalUnits(world)).toBe(poured);
    expect(fluid.lost + fluid.created + fluid.absorbed).toBe(0);
    expect(world.get(22, GROUND + 1, 22)).toBe(B.stone);
    expect(world.get(23, GROUND + 2, 23)).toBe(B.oak_log);
    expect(world.get(21, GROUND + 2, 24)).toBe(B.wheat);
    expect(WATER_LEVEL[world.get(24, GROUND + 2, 21)]).toBeGreaterThan(0);
    expect(events.some((e) => e.type === 'burst' && e.state === B.oak_sapling)).toBe(true);
    // The same water in less room: the pool stands higher than the 24 units a column it did.
    let highest = 0;
    for (let z = 20; z <= 25; z++) for (let x = 20; x <= 25; x++) highest = Math.max(highest, columnUnits(world, x, z, GROUND + 1, GROUND + 3));
    expect(highest).toBeGreaterThan(24);

    // Shut in on every side there is nowhere to push it: that, and only that, is counted as lost.
    world.set(40, GROUND, 40, B.air);
    world.set(40, GROUND, 40, waterState(11));
    world.set(40, GROUND + 1, 40, B.stone);
    world.set(40, GROUND, 40, B.stone);
    expect(fluid.lost).toBe(11);
    expect(totalUnits(world)).toBe(poured);
    // Poured into a lake it is swallowed, and the books say so.
    world.setRaw(50, GROUND, 50, B.water_source);
    expect(fluid.addWater(50, GROUND, 50, 7)).toBe(7);
    expect(fluid.absorbed).toBe(7);
    expect(totalUnits(world)).toBe(inWorld());
  });
});
