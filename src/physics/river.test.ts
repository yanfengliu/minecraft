import { describe, expect, it } from 'vitest';
import { B, REPLACEABLE, WATER_LEVEL, WATER_SOURCE } from '../world/blocks';
import { generateIsland } from '../world/gen/island';
import { World, createFlatWorld } from '../world/world';
import { Fluid } from './fluid';

// Natural water is made of sources, and a river comes down from its lake in
// steps: at each one a source stands beside open air over the next reach.
// These tests hold the fluid to the design's promise about that shape: it is
// settled, and however it is disturbed it costs nothing afterwards.

const GROUND = 31;
const DX = [1, 0, -1, 0];
const DZ = [0, 1, 0, -1];

/** A fluid wired to the world the way the facade wires it, with a count of every write anyone makes. */
function setup(world: World): { fluid: Fluid; writes: () => number } {
  const fluid = new Fluid(world, () => {});
  let n = 0;
  world.changed.on((c) => {
    n++;
    if (!fluid.busy) fluid.edited(c.x, c.y, c.z, c.old, c.state);
  });
  return { fluid, writes: () => n };
}

/** Tick until nothing is active; returns the ticks that took, or `max` if it never happened. */
function quiet(fluid: Fluid, max: number): number {
  let n = 0;
  while (fluid.activeCount > 0 && n < max) {
    fluid.tick();
    n++;
  }
  return n;
}

function census(world: World): { sources: number; finite: number } {
  let sources = 0;
  let finite = 0;
  for (let y = 0; y < world.sy; y++) {
    for (let z = 0; z < world.sz; z++) {
      for (let x = 0; x < world.sx; x++) {
        const s = world.get(x, y, z);
        if (WATER_SOURCE[s]) sources++;
        else finite += WATER_LEVEL[s] as number;
      }
    }
  }
  return { sources, finite };
}

interface Exposed {
  /** The source, and the open cell beside it. */
  x: number;
  y: number;
  z: number;
  nx: number;
  nz: number;
  /** True when the open column under that cell ends in water; false when it ends on ground. */
  intoWater: boolean;
}

/** Every place a source stands beside a cell water could enter: the steps between reaches, and any gap in a bank. */
function exposed(world: World): Exposed[] {
  const out: Exposed[] = [];
  for (let z = 1; z < world.sz - 1; z++) {
    for (let x = 1; x < world.sx - 1; x++) {
      for (let y = 1; y < world.sy - 1; y++) {
        if (!WATER_SOURCE[world.get(x, y, z)]) continue;
        for (let i = 0; i < 4; i++) {
          const nx = x + (DX[i] as number);
          const nz = z + (DZ[i] as number);
          const n = world.get(nx, y, nz);
          if (WATER_SOURCE[n] || !REPLACEABLE[n]) continue;
          let yy = y - 1;
          let under = world.get(nx, yy, nz);
          while (!WATER_SOURCE[under] && REPLACEABLE[under] && (WATER_LEVEL[under] as number) < 16) under = world.get(nx, --yy, nz);
          out.push({ x, y, z, nx, nz, intoWater: WATER_SOURCE[under] === 1 });
        }
      }
    }
  }
  return out;
}

const TOP = GROUND + 10;
const HIGH = GROUND + 9;
/** Where each reach of the channel begins, and how far its surface lies below the first. */
const REACHES = [{ x: 6, drop: 0 }, { x: 26, drop: 1 }, { x: 46, drop: 3 }, { x: 66, drop: 6 }] as const;
const END = 90;

/**
 * A river as generation cuts one, in miniature: a channel five wide running
 * toward +x through a block of stone, two deep down the middle and one at the
 * sides, its surface stepping down by one block, then two, then three. Each
 * lower reach bites a cell into the one above along the middle, as the
 * generator's overlapping discs do, so the lip of a step is not a straight line.
 */
function steppedRiver(): World {
  const world = createFlatWorld(96, 64, GROUND, 64);
  for (let y = GROUND + 1; y <= TOP; y++) for (let z = 22; z <= 42; z++) for (let x = 2; x <= 94; x++) world.setRaw(x, y, z, B.stone);
  for (let z = 30; z <= 34; z++) {
    const middle = z > 30 && z < 34;
    for (let x = REACHES[0].x; x <= END; x++) {
      let drop = 0;
      for (const r of REACHES) if (x >= r.x - (middle ? 1 : 0)) drop = r.drop;
      const level = HIGH - drop;
      for (let y = level - (middle ? 1 : 0); y <= TOP; y++) world.setRaw(x, y, z, y <= level ? B.river : B.air);
    }
  }
  world.recomputeHeightmap();
  return world;
}

describe('river steps', () => {
  it('stay at rest when woken, and heal no further than the notch at a one-block lip', () => {
    const world = steppedRiver();
    const { fluid, writes } = setup(world);
    const before = census(world);
    expect(before.finite).toBe(0);
    // Twelve places where a source looks out over a lower reach; none where it looks out over ground.
    const lips = exposed(world);
    expect(lips.length).toBeGreaterThanOrEqual(12);
    expect(lips.every((e) => e.intoWater)).toBe(true);
    // Wake every cell of the river and everything beside it.
    for (let y = GROUND; y <= TOP; y++) for (let z = 29; z <= 35; z++) for (let x = 5; x <= 91; x++) fluid.wake(x, y, z);
    const ticks = quiet(fluid, 400);
    expect(fluid.activeCount).toBe(0);
    expect(ticks).toBeLessThan(40);
    // The only thing there was to do: at the one-block step the three cells of the notch were holes in the
    // upper reach, held by two sources each, and are river again. The deeper steps were left exactly alone.
    const after = census(world);
    expect(after.finite).toBe(0);
    expect(after.sources).toBe(before.sources + 3);
    for (let z = 31; z <= 33; z++) expect(world.get(25, HIGH, z)).toBe(B.river);
    expect(fluid.created).toBe(48);
    expect(fluid.absorbed).toBe(48);
    expect(writes()).toBeLessThan(40);
    // Settled means it costs nothing: more ticks look at no cell and write nothing.
    const done = writes();
    for (let i = 0; i < 100; i++) fluid.tick();
    expect(fluid.processed).toBe(0);
    expect(writes()).toBe(done);
    console.log(`river steps: ${lips.length} lips woken, quiet after ${ticks} ticks and ${done} writes`);
  });

  it('go quiet again after a bridge, a dam built and taken away, and a dug bank', () => {
    const world = steppedRiver();
    const { fluid, writes } = setup(world);
    for (let y = GROUND; y <= TOP; y++) for (let z = 29; z <= 35; z++) for (let x = 5; x <= 91; x++) fluid.wake(x, y, z);
    quiet(fluid, 400);
    const before = census(world);
    const start = writes();
    let edits = 0;
    const set = (x: number, y: number, z: number, state: number): void => {
      if (world.set(x, y, z, state)) edits++;
    };
    for (const r of REACHES.slice(1)) {
      const level = HIGH - (REACHES[REACHES.indexOf(r) - 1] as (typeof REACHES)[number]).drop;
      // A plank bridge over the lip, one block above the upper reach.
      for (let z = 29; z <= 35; z++) set(r.x - 1, level + 1, z, B.oak_planks);
      // A dam across the upper reach a few cells back from the lip, bed to surface...
      for (let z = 30; z <= 34; z++) for (let y = level - 1; y <= level; y++) if (WATER_SOURCE[world.get(r.x - 5, y, z)]) set(r.x - 5, y, z, B.cobble);
      for (let i = 0; i < 12; i++) fluid.tick();
      // ...and taken away again, top course first.
      for (let y = level; y >= level - 1; y--) for (let z = 30; z <= 34; z++) if (world.get(r.x - 5, y, z) === B.cobble) set(r.x - 5, y, z, B.air);
      // The bank dug out beside the upper reach, at water level.
      set(r.x - 8, level, 29, B.air);
    }
    const ticks = quiet(fluid, 2000);
    expect(fluid.activeCount).toBe(0);
    expect(ticks).toBeLessThan(200);
    // The river is whole again, and the only finite water is what stands in the three dug cells.
    const after = census(world);
    expect(after.sources).toBe(before.sources);
    expect(after.finite).toBe(3 * 16);
    expect(fluid.created - fluid.absorbed).toBe(before.finite + 3 * 16);
    // What it cost is of the order of the edits themselves, not a flow that runs on.
    const cost = writes() - start - edits;
    expect(cost).toBeLessThan(400);
    const done = writes();
    for (let i = 0; i < 200; i++) fluid.tick();
    expect(fluid.processed).toBe(0);
    expect(writes()).toBe(done);
    console.log(`river steps: ${edits} edits round three steps cost ${cost} writes of water and were quiet ${ticks} ticks after the last`);
  });

  it('stand full, with nothing running, where a dam along the very lip is taken away', () => {
    const world = steppedRiver();
    const { fluid, writes } = setup(world);
    for (let y = GROUND; y <= TOP; y++) for (let z = 29; z <= 35; z++) for (let x = 5; x <= 91; x++) fluid.wake(x, y, z);
    quiet(fluid, 400);
    const before = census(world);
    // The last row of each upper reach, bed to surface, turned to stone and then dug out again from the top.
    for (const r of REACHES.slice(1)) {
      const level = HIGH - (REACHES[REACHES.indexOf(r) - 1] as (typeof REACHES)[number]).drop;
      for (let z = 30; z <= 34; z++) for (let y = level - 1; y <= level; y++) if (WATER_SOURCE[world.get(r.x - 1, y, z)]) world.set(r.x - 1, y, z, B.cobble);
      for (let i = 0; i < 12; i++) fluid.tick();
      for (let y = level; y >= level - 1; y--) for (let z = 30; z <= 34; z++) if (world.get(r.x - 1, y, z) === B.cobble) world.set(r.x - 1, y, z, B.air);
    }
    const ticks = quiet(fluid, 2000);
    expect(fluid.activeCount).toBe(0);
    expect(ticks).toBeLessThan(200);
    const done = writes();
    for (let i = 0; i < 200; i++) fluid.tick();
    expect(fluid.processed).toBe(0);
    expect(writes()).toBe(done);
    // Each lip is one source upstream of open air over the next reach, which no longer heals: the two cells
    // at the sides, on the bed, stand full of finite water, and the three in the middle, over the reach's own
    // lower layer, stay open. None of it is going anywhere.
    const after = census(world);
    expect(after.finite).toBe(3 * 2 * 16);
    expect(fluid.created - fluid.absorbed).toBe(after.finite);
    expect(after.sources).toBeLessThan(before.sources);
    for (const r of REACHES.slice(1)) {
      const level = HIGH - (REACHES[REACHES.indexOf(r) - 1] as (typeof REACHES)[number]).drop;
      expect(WATER_LEVEL[world.get(r.x - 1, level, 30)]).toBe(16);
      expect(WATER_LEVEL[world.get(r.x - 1, level, 34)]).toBe(16);
      expect(world.get(r.x - 1, level, 32)).toBe(B.air);
      // Nothing was left lying on the reach below.
      expect(world.get(r.x, level, 32)).toBe(B.air);
    }
  });

  it('pour onto a ledge built under the lip, stand full there, and stop when it is taken away', () => {
    const world = steppedRiver();
    const { fluid, writes } = setup(world);
    for (let y = GROUND; y <= TOP; y++) for (let z = 29; z <= 35; z++) for (let x = 5; x <= 91; x++) fluid.wake(x, y, z);
    quiet(fluid, 400);
    const before = census(world);
    // A stone set into the surface of each lower reach, in the first cell past the lip of the reach above.
    const ledges = REACHES.slice(1).map((r) => {
      const fall = r.drop - (REACHES[REACHES.indexOf(r) - 1] as (typeof REACHES)[number]).drop;
      let x = r.x - 2;
      while (WATER_SOURCE[world.get(x, HIGH - r.drop + fall, 32)]) x++;
      return { x, y: HIGH - r.drop, z: 32, fall };
    });
    const [one, two, three] = ledges as [(typeof ledges)[number], (typeof ledges)[number], (typeof ledges)[number]];
    world.set(one.x, one.y, one.z, B.stone);
    world.set(two.x, two.y, two.z, B.stone);
    let ticks = quiet(fluid, 2000);
    expect(fluid.activeCount).toBe(0);
    expect(ticks).toBeLessThan(200);
    // Now the lip has somewhere to pour to that is not water. Under a step of one or two blocks every cell
    // over the stone is beside a source of the upper reach: the column fills, and stands full.
    for (const l of [one, two]) for (let k = 1; k <= l.fall; k++) expect(WATER_LEVEL[world.get(l.x, l.y + k, l.z)]).toBe(16);
    expect(census(world).finite).toBe((1 + 2) * 16);
    let done = writes();
    for (let i = 0; i < 100; i++) fluid.tick();
    expect(writes()).toBe(done);

    // Under the three-block step the stone lies below the upper reach's bed: what lands on it runs off into
    // the river, and goes on running. That is a real waterfall, of the player's making, and it costs what it moves.
    world.set(three.x, three.y, three.z, B.stone);
    for (let i = 0; i < 100; i++) fluid.tick();
    expect(fluid.activeCount).toBeGreaterThan(0);
    const made = fluid.created;
    for (let i = 0; i < 30; i++) fluid.tick();
    expect(fluid.created).toBeGreaterThan(made);
    expect(fluid.activeCount).toBeLessThan(60);

    for (const l of ledges) world.set(l.x, l.y, l.z, B.air);
    ticks = quiet(fluid, 2000);
    expect(fluid.activeCount).toBe(0);
    expect(ticks).toBeLessThan(200);
    // The stones' cells are river again, the water that stood or ran on them has gone into it, and nothing pours.
    expect(census(world)).toEqual(before);
    done = writes();
    for (let i = 0; i < 100; i++) fluid.tick();
    expect(fluid.processed).toBe(0);
    expect(writes()).toBe(done);
  });

  it('close a wide hole in deep water from its corners, and let nothing run meanwhile', () => {
    const world = createFlatWorld(64, 64, GROUND);
    // A lake 14 x 14 and four deep.
    for (let y = GROUND - 3; y <= GROUND; y++) for (let z = 20; z <= 33; z++) for (let x = 20; x <= 33; x++) world.setRaw(x, y, z, B.water_source);
    const { fluid, writes } = setup(world);
    const before = census(world);
    // Something three by three and two deep is sunk into its surface, and then taken out.
    for (let y = GROUND - 1; y <= GROUND; y++) for (let z = 25; z <= 27; z++) for (let x = 25; x <= 27; x++) world.set(x, y, z, B.stone);
    quiet(fluid, 100);
    for (let y = GROUND; y >= GROUND - 1; y--) for (let z = 25; z <= 27; z++) for (let x = 25; x <= 27; x++) world.set(x, y, z, B.air);
    const start = writes();
    const ticks = quiet(fluid, 2000);
    expect(fluid.activeCount).toBe(0);
    expect(ticks).toBeLessThan(60);
    // Every cell of it is lake again, each filled once and healed: 18 cells of 16 units, made and then swallowed.
    expect(census(world)).toEqual(before);
    expect(fluid.created).toBe(18 * 16);
    expect(fluid.absorbed).toBe(18 * 16);
    // A handful of writes a cell, with no water crossing the hole to be swallowed on the far side.
    expect(writes() - start).toBeLessThan(18 * 8);
    console.log(`lake hole: 18 cells closed in ${ticks} ticks and ${writes() - start} writes`);
  });

  it('are at rest on a generated island, whatever is done beside them', () => {
    const { world } = generateIsland({ seed: 7, sx: 192, sy: 128, sz: 192, seaLevel: 40 });
    const { fluid, writes } = setup(world);
    const open = exposed(world);
    // Where the open column ends on ground, generation has left water standing beside a drop onto land. That
    // water rightly runs when woken, and the shape is generation's to put right; it is walled off here so that
    // this test is about what the fluid owes: one body of water standing over another.
    const leaks = open.filter((e) => !e.intoWater);
    for (const e of leaks) world.setRaw(e.nx, e.y, e.nz, B.stone);
    const steps = open.filter((e) => e.intoWater);
    // An edit right beside every one of them, as a bridge or a dug bank would be, and a look at both cells.
    for (const e of steps) {
      if (world.get(e.x, e.y + 1, e.z) === B.air) {
        world.set(e.x, e.y + 1, e.z, B.oak_planks);
        world.set(e.x, e.y + 1, e.z, B.air);
      }
      fluid.wake(e.x, e.y, e.z);
      fluid.wake(e.nx, e.y, e.nz);
    }
    const start = writes();
    const ticks = quiet(fluid, 600);
    expect(fluid.activeCount).toBe(0);
    expect(ticks).toBeLessThan(600);
    const settled = writes();
    for (let i = 0; i < 120; i++) fluid.tick();
    expect(fluid.processed).toBe(0);
    expect(writes()).toBe(settled);
    // Nothing is left running: whatever sources made on the way to rest is standing still or was swallowed.
    expect(fluid.created - fluid.absorbed).toBeGreaterThanOrEqual(0);
    console.log(
      `river steps: generated island has ${steps.length} places where a source stands over lower water, all quiet ${ticks} ticks and ${settled - start} writes after being disturbed; `
      + `${leaks.length} more stand beside a drop onto land and were walled off`,
    );
  });
});
