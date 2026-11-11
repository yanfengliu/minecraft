import { describe, expect, it } from 'vitest';
import { Rng } from '../core/rng';
import { B, WATER_LEVEL, WATER_SOURCE, waterState } from '../world/blocks';
import { World, createFlatWorld } from '../world/world';
import { Fluid, RIVER_SPEED, type FluidOptions } from './fluid';
import type { PhysicsEvent } from './types';

const GROUND = 31;

function setup(world: World, opts: FluidOptions = {}): { fluid: Fluid; events: PhysicsEvent[] } {
  const events: PhysicsEvent[] = [];
  const fluid = new Fluid(world, (e) => events.push(e), opts);
  // What the facade does: edits by anyone else wake the fluid.
  world.changed.on((c) => {
    if (!fluid.busy) fluid.wake(c.x, c.y, c.z);
  });
  return { fluid, events };
}

/** Finite water in the whole world, in sixteenths. */
function totalUnits(world: World): number {
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

function fill(world: World, x0: number, y0: number, z0: number, x1: number, y1: number, z1: number, state: number): void {
  for (let y = y0; y <= y1; y++) for (let z = z0; z <= z1; z++) for (let x = x0; x <= x1; x++) world.set(x, y, z, state);
}

/** A stone box open at the top whose interior is x0..x1, z0..z1 and `depth` cells deep, standing on the ground. */
function basin(world: World, x0: number, z0: number, x1: number, z1: number, depth: number): void {
  for (let y = GROUND + 1; y <= GROUND + depth; y++) {
    for (let z = z0 - 1; z <= z1 + 1; z++) {
      for (let x = x0 - 1; x <= x1 + 1; x++) {
        const wall = x < x0 || x > x1 || z < z0 || z > z1;
        if (wall) world.set(x, y, z, B.stone);
      }
    }
  }
}

function settle(fluid: Fluid, maxTicks: number, each?: () => void): number {
  let n = 0;
  while (fluid.activeCount > 0 && n < maxTicks) {
    fluid.tick();
    each?.();
    n++;
  }
  return n;
}

function columnUnits(world: World, x: number, z: number, y0: number, y1: number): number {
  let u = 0;
  for (let y = y0; y <= y1; y++) u += WATER_LEVEL[world.get(x, y, z)] as number;
  return u;
}

describe('fluid', () => {
  it('holds exactly what is poured into a closed basin and comes to rest', () => {
    const world = createFlatWorld(64, 64, GROUND);
    const { fluid } = setup(world);
    basin(world, 20, 20, 27, 27, 4);
    // A block of water hung in the air above the middle: 4 x 4 x 3 full cells.
    fill(world, 22, GROUND + 6, 22, 25, GROUND + 8, 25, waterState(16));
    const poured = 4 * 4 * 3 * 16;
    expect(totalUnits(world)).toBe(poured);
    let worst = 0;
    const ticks = settle(fluid, 2000, () => {
      worst = Math.max(worst, Math.abs(totalUnits(world) - poured));
    });
    expect(worst).toBe(0);
    expect(fluid.activeCount).toBe(0);
    expect(ticks).toBeLessThan(2000);
    expect(fluid.created + fluid.absorbed + fluid.evaporated + fluid.lost).toBe(0);
    // 768 units over 64 cells is 12 each: the pool is level to within one unit and nothing escaped.
    let lo = 99;
    let hi = 0;
    for (let z = 20; z <= 27; z++) {
      for (let x = 20; x <= 27; x++) {
        const u = columnUnits(world, x, z, GROUND + 1, GROUND + 10);
        lo = Math.min(lo, u);
        hi = Math.max(hi, u);
      }
    }
    expect(hi - lo).toBeLessThanOrEqual(1);
    expect(lo).toBeGreaterThanOrEqual(11);
    console.log(`fluid basin: ${poured} units settled in ${ticks} ticks, levels ${lo}..${hi}`);
    // A settled pool costs nothing: further ticks examine no cells.
    fluid.tick();
    expect(fluid.processed).toBe(0);
  });

  it('runs downhill and pools at the bottom', () => {
    const world = createFlatWorld(64, 64, GROUND);
    const { fluid } = setup(world);
    // A stepped channel three wide falling toward +x: the floor drops one block every two cells.
    for (let x = 10; x <= 40; x++) {
      const floor = GROUND + Math.max(0, 8 - Math.floor((x - 10) / 2));
      for (let z = 29; z <= 33; z++) {
        const wall = z === 29 || z === 33;
        for (let y = GROUND + 1; y <= GROUND + 12; y++) {
          if (wall ? y <= floor + 3 : y <= floor) world.set(x, y, z, B.stone);
        }
      }
    }
    // End walls close the channel, so the low end is a basin.
    for (let z = 29; z <= 33; z++) for (let y = GROUND + 1; y <= GROUND + 12; y++) world.set(9, y, z, B.stone);
    for (let z = 29; z <= 33; z++) for (let y = GROUND + 1; y <= GROUND + 4; y++) world.set(41, y, z, B.stone);
    fill(world, 10, GROUND + 9, 30, 11, GROUND + 12, 32, waterState(16));
    const poured = 2 * 4 * 3 * 16;
    let ticks = settle(fluid, 3000);
    // The run leaves a film a sixteenth deep on each step; give it time to dry.
    for (let i = 0; i < 200; i++) fluid.tick();
    ticks += 200 + settle(fluid, 3000);
    expect(fluid.activeCount).toBe(0);
    expect(totalUnits(world)).toBe(poured - fluid.evaporated);
    // Everything that is left lies on the flat bottom reach (the floor is level from x = 26 on).
    let high = 0;
    let low = 0;
    for (let x = 10; x <= 40; x++) {
      for (let z = 30; z <= 32; z++) {
        const u = columnUnits(world, x, z, GROUND + 1, GROUND + 12);
        if (x < 26) high += u;
        else low += u;
      }
    }
    expect(high).toBe(0);
    expect(low).toBeGreaterThan(poured * 0.9);
    console.log(`fluid slope: ${low}/${poured} units reached the bottom in ${ticks} ticks, ${fluid.evaporated} evaporated on the way`);
  });

  it('evens out two basins when the wall between them is breached', () => {
    const world = createFlatWorld(64, 64, GROUND);
    const { fluid } = setup(world);
    // Two 5 x 5 basins sharing the wall at x = 25, both four deep.
    basin(world, 20, 20, 24, 24, 4);
    basin(world, 26, 20, 30, 24, 4);
    fill(world, 20, GROUND + 1, 20, 24, GROUND + 3, 24, waterState(16));
    const poured = 5 * 5 * 3 * 16;
    settle(fluid, 200);
    expect(fluid.activeCount).toBe(0);
    expect(columnUnits(world, 28, 22, GROUND + 1, GROUND + 4)).toBe(0);
    // Knock a hole through the bottom of the shared wall.
    world.set(25, GROUND + 1, 22, B.air);
    const ticks = settle(fluid, 5000);
    expect(fluid.activeCount).toBe(0);
    expect(totalUnits(world)).toBe(poured);
    let left = 0;
    let right = 0;
    let lo = 999;
    let hi = 0;
    for (let z = 20; z <= 24; z++) {
      for (let i = 0; i < 5; i++) {
        const a = columnUnits(world, 20 + i, z, GROUND + 1, GROUND + 4);
        const b = columnUnits(world, 26 + i, z, GROUND + 1, GROUND + 4);
        left += a;
        right += b;
        lo = Math.min(lo, a, b);
        hi = Math.max(hi, a, b);
      }
    }
    // 1200 units over 51 cells is about 23.5 a column: both sides meet there, within a sixteenth or two of a block.
    expect(Math.abs(left / 25 - right / 25)).toBeLessThanOrEqual(1.5);
    expect(hi - lo).toBeLessThanOrEqual(3);
    expect(left / 25).toBeGreaterThan(21);
    expect(right / 25).toBeGreaterThan(21);
    console.log(`fluid breach: left mean ${(left / 25).toFixed(2)}, right mean ${(right / 25).toFixed(2)}, columns ${lo}..${hi}, ${ticks} ticks`);
  });

  it('refills a cell dug beside a source and heals a hole inside a lake', () => {
    const world = createFlatWorld(64, 64, GROUND);
    const { fluid } = setup(world);
    // A lake two deep set into the ground, surface level with the grass.
    for (let y = GROUND - 1; y <= GROUND; y++) for (let z = 20; z <= 27; z++) for (let x = 20; x <= 27; x++) world.setRaw(x, y, z, B.water_source);
    // Dig the bank.
    world.set(28, GROUND, 23, B.air);
    settle(fluid, 100);
    expect(world.get(28, GROUND, 23)).toBe(waterState(16));
    expect(fluid.activeCount).toBe(0);
    expect(fluid.created).toBe(16);
    // Drop a block into the lake and take it out again.
    world.set(23, GROUND, 23, B.stone);
    settle(fluid, 100);
    world.set(23, GROUND, 23, B.air);
    settle(fluid, 100);
    expect(world.get(23, GROUND, 23)).toBe(B.water_source);
    expect(fluid.activeCount).toBe(0);
    // The lake itself was never touched, and every unit is accounted for.
    expect(world.get(22, GROUND, 23)).toBe(B.water_source);
    expect(totalUnits(world)).toBe(fluid.created - fluid.absorbed);
    // Water falling onto a source is swallowed: nine units arrive from outside and nine are absorbed.
    const before = fluid.absorbed;
    world.set(24, GROUND + 3, 24, waterState(9));
    settle(fluid, 100);
    expect(fluid.absorbed - before).toBe(9);
    expect(totalUnits(world)).toBe(16);
    expect(world.get(24, GROUND + 1, 24)).toBe(B.air);
  });

  it('dries up a lone thin film but leaves a puddle alone', () => {
    const world = createFlatWorld(64, 64, GROUND);
    const { fluid } = setup(world, { evaporateTicks: 30 });
    world.set(10, GROUND + 1, 10, waterState(1));
    // A deeper puddle in a one-cell pit cannot spread and is not a film.
    world.set(40, GROUND, 40, B.air);
    world.set(40, GROUND, 40, waterState(5));
    for (let i = 0; i < 60; i++) fluid.tick();
    expect(world.get(10, GROUND + 1, 10)).toBe(B.air);
    expect(world.get(40, GROUND, 40)).toBe(waterState(5));
    expect(fluid.evaporated).toBe(1);
    expect(fluid.activeCount).toBe(0);
  });

  it('washes plants out of the way and reports the current', () => {
    const world = createFlatWorld(64, 64, GROUND);
    const { fluid, events } = setup(world);
    world.set(12, GROUND + 1, 12, B.tall_grass);
    world.set(12, GROUND + 4, 12, waterState(16));
    for (let i = 0; i < 6; i++) fluid.tick();
    expect(events.some((e) => e.type === 'burst' && e.state === B.tall_grass)).toBe(true);
    expect(WATER_LEVEL[world.get(12, GROUND + 1, 12)]).toBeGreaterThan(0);

    const out = { x: 0, z: 0 };
    // River variant 0 runs toward +x, variant 2 toward -z.
    world.setRaw(30, GROUND, 30, B.river);
    world.setRaw(31, GROUND, 30, B.river + 2);
    world.setRaw(32, GROUND, 30, B.water_source);
    fluid.flowInto(30, GROUND, 30, out);
    expect(out.x).toBeCloseTo(RIVER_SPEED);
    expect(out.z).toBeCloseTo(0);
    fluid.flowInto(31, GROUND, 30, out);
    expect(out.x).toBeCloseTo(0);
    expect(out.z).toBeCloseTo(-RIVER_SPEED);
    fluid.flowInto(32, GROUND, 30, out);
    expect(Math.hypot(out.x, out.z)).toBe(0);
    // Finite water runs from deep toward shallow.
    world.setRaw(40, GROUND + 1, 20, waterState(12));
    world.setRaw(39, GROUND + 1, 20, waterState(16));
    world.setRaw(41, GROUND + 1, 20, waterState(6));
    world.setRaw(40, GROUND + 1, 19, B.stone);
    world.setRaw(40, GROUND + 1, 21, B.stone);
    fluid.flowInto(40, GROUND + 1, 20, out);
    expect(out.x).toBeGreaterThan(1);
    expect(out.z).toBe(0);
  });

  it('ticks ten thousand active cells in under 3 ms', () => {
    const samples: { cells: number; ms: number }[] = [];
    const run = (measure: boolean): void => {
      const world = createFlatWorld(128, 128, GROUND);
      const { fluid } = setup(world);
      // A ragged sheet of water over open ground, in the bottom layer of a
      // section so that every cell also reads across a section face: nearly
      // every water cell moves water every tick, which is the expensive case.
      for (let z = 30; z < 98; z++) {
        for (let x = 30; x < 98; x++) world.set(x, GROUND + 1, z, waterState(2 + ((x * 7 + z * 13) % 15)));
      }
      for (let i = 0; i < 3; i++) {
        const cells = fluid.activeCount;
        const t0 = performance.now();
        fluid.tick();
        const ms = performance.now() - t0;
        if (measure) samples.push({ cells, ms });
      }
    };
    // The first runs only warm the JIT.
    for (let i = 0; i < 4; i++) run(false);
    for (let i = 0; i < 8; i++) run(true);
    for (const s of samples) expect(s.cells).toBeGreaterThanOrEqual(10000);
    const times = samples.map((s) => s.ms).sort((a, b) => a - b);
    const median = times[times.length >> 1] as number;
    const cells = samples.map((s) => s.cells);
    console.log(`fluid perf: ${samples.length} ticks of ${Math.min(...cells)}..${Math.max(...cells)} active cells took ${(times[0] as number).toFixed(2)} ms best, ${median.toFixed(2)} ms median, ${(times[times.length - 1] as number).toFixed(2)} ms worst`);
    expect(median).toBeLessThan(3);
  });

  it('gives the same water for the same edits', () => {
    const sig = (): string => {
      const world = createFlatWorld(64, 64, GROUND);
      const { fluid } = setup(world, { seed: 7 });
      basin(world, 20, 20, 30, 30, 3);
      world.set(25, GROUND + 1, 25, B.stone);
      fill(world, 21, GROUND + 5, 21, 23, GROUND + 7, 23, waterState(16));
      const parts: number[] = [];
      for (let i = 0; i < 300; i++) {
        if (i === 40) world.set(31, GROUND + 1, 25, B.air);
        fluid.tick();
        if (i % 50 === 49) for (let z = 18; z <= 40; z++) for (let x = 18; x <= 40; x++) parts.push(columnUnits(world, x, z, GROUND + 1, GROUND + 8));
      }
      return parts.join(',');
    };
    expect(sig()).toBe(sig());
  });

  it('settles any walled-in mess of rubble and water, conserving every unit (soak)', () => {
    let ticksTotal = 0;
    for (let seed = 1; seed <= 12; seed++) {
      const rng = new Rng(seed);
      const world = createFlatWorld(64, 64, GROUND);
      const { fluid } = setup(world, { seed });
      // A walled yard with random rubble, pits and ledges in it.
      basin(world, 16, 16, 39, 39, 8);
      for (let i = 0; i < 160; i++) {
        const x = 16 + rng.int(24);
        const z = 16 + rng.int(24);
        const h = rng.int(5);
        for (let y = GROUND + 1; y <= GROUND + h; y++) world.setRaw(x, y, z, B.stone);
        if (rng.chance(0.15)) world.setRaw(x, GROUND, z, B.air);
        if (rng.chance(0.1)) world.setRaw(x, GROUND + h + 2, z, B.oak_planks);
      }
      // Water thrown in at random heights, in lumps and in sheets.
      let poured = 0;
      const pour = (x: number, y: number, z: number, level: number): void => {
        if (world.get(x, y, z) !== B.air) return;
        world.set(x, y, z, waterState(level));
        poured += level;
      };
      for (let i = 0; i < 40; i++) {
        const x = 17 + rng.int(22);
        const z = 17 + rng.int(22);
        const y = GROUND + 6 + rng.int(4);
        const size = 1 + rng.int(3);
        for (let dz = 0; dz < size; dz++) for (let dx = 0; dx < size; dx++) pour(x + dx, y, z + dz, 1 + rng.int(16));
      }
      let worst = 0;
      const ticks = settle(fluid, 6000, () => {
        // Checked now and then; the full scan is the slow part of this test.
        if (fluid.ticks % 40 === 0) worst = Math.max(worst, Math.abs(totalUnits(world) - (poured - fluid.evaporated)));
      });
      ticksTotal += ticks;
      expect(fluid.activeCount).toBe(0);
      expect(worst).toBe(0);
      expect(totalUnits(world)).toBe(poured - fluid.evaporated);
      expect(fluid.created + fluid.absorbed + fluid.lost).toBe(0);
      // At rest: no water hangs over a cell it could fall into, and no cell stands two units above an open neighbour.
      let hanging = 0;
      let steps = 0;
      for (let y = GROUND; y <= GROUND + 10; y++) {
        for (let z = 16; z <= 39; z++) {
          for (let x = 16; x <= 39; x++) {
            const level = WATER_LEVEL[world.get(x, y, z)] as number;
            if (level === 0) continue;
            const under = world.get(x, y - 1, z);
            if (under === B.air || ((WATER_LEVEL[under] as number) > 0 && (WATER_LEVEL[under] as number) < 16)) hanging++;
            for (const [dx, dz] of [[1, 0], [0, 1], [-1, 0], [0, -1]] as const) {
              const n = world.get(x + dx, y, z + dz);
              const open = n === B.air || (WATER_LEVEL[n] as number) > 0;
              if (open && level - (WATER_LEVEL[n] as number) >= 2) steps++;
            }
          }
        }
      }
      expect(hanging).toBe(0);
      expect(steps).toBe(0);
    }
    console.log(`fluid soak: 12 random yards settled in ${ticksTotal} ticks in all, every unit accounted for`);
  });
});
