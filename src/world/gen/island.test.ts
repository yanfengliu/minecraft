import { describe, expect, it } from 'vitest';
import { B, IS_LOG, WATER_SOURCE } from '../blocks';
import { LightEngine } from '../light';
import { isStandable } from '../walk';
import { generateIsland } from './island';
import { DEFAULT_ISLAND } from './terrain';
import { lakeHoles, waterFaults } from './testkit';

const SMALL = { seed: 7, sx: 192, sy: 128, sz: 192, seaLevel: 40 };

function digest(world: ReturnType<typeof generateIsland>['world']): number {
  let h = 2166136261;
  for (let i = 0; i < world.sectionCount; i++) {
    const s = world.blocks[i];
    h = Math.imul(h ^ (world.uniform[i] as number), 16777619);
    if (!s) continue;
    for (let k = 0; k < s.length; k += 7) h = Math.imul(h ^ (s[k] as number), 16777619);
  }
  return h >>> 0;
}

describe('island generation', () => {
  const island = generateIsland(SMALL);
  const { world, info } = island;

  it('makes an island: sea at every edge, land in the middle, somewhere to stand', () => {
    for (let i = 0; i < SMALL.sx; i += 8) {
      expect(WATER_SOURCE[world.get(i, SMALL.seaLevel - 1, 0)]).toBe(1);
      expect(WATER_SOURCE[world.get(0, SMALL.seaLevel - 1, i)]).toBe(1);
      expect(WATER_SOURCE[world.get(i, SMALL.seaLevel - 1, SMALL.sz - 1)]).toBe(1);
      expect(WATER_SOURCE[world.get(SMALL.sx - 1, SMALL.seaLevel - 1, i)]).toBe(1);
    }
    expect(world.groundY(96, 96)).toBeGreaterThan(SMALL.seaLevel);
    expect(isStandable(world, Math.floor(info.spawn.x), info.spawn.y, Math.floor(info.spawn.z))).toBe(true);
  });

  it('has a lake above the sea, a river that runs down from it, and trees', () => {
    expect(info.lake.level).toBeGreaterThan(SMALL.seaLevel);
    expect(world.get(info.lake.x, info.lake.level, info.lake.z)).toBe(B.water_source);
    expect(info.river.length).toBeGreaterThan(20);
    for (let i = 1; i < info.river.length; i++) {
      expect(info.river[i]!.level).toBeLessThanOrEqual(info.river[i - 1]!.level);
    }
    expect(info.river[info.river.length - 1]!.level).toBe(SMALL.seaLevel - 1);
    let rivers = 0;
    let logs = 0;
    for (let z = 0; z < SMALL.sz; z++) {
      for (let x = 0; x < SMALL.sx; x++) {
        for (let y = SMALL.seaLevel - 2; y < 110; y++) {
          const s = world.get(x, y, z);
          if (s >= B.river && s < B.river + 8) rivers++;
          if (IS_LOG[s]) logs++;
        }
      }
    }
    expect(rivers).toBeGreaterThan(50);
    expect(logs).toBeGreaterThan(200);
  });

  it('never leaves water resting on nothing or standing beside open air', () => {
    // Beside as well as beneath: looking only at the cell below each one, this test passed a river
    // that had cut a trench through the lake, between walls of standing water.
    expect(waterFaults(world)).toEqual({ hanging: 0, stillOpen: 0, overBank: 0, first: [] });
  });

  it('keeps the lake whole: the river leaves at its level and comes down to the sea along its course', () => {
    const { lake, river } = info;
    expect(lakeHoles(world, lake)).toBe(0);
    const crossing = river.filter((p) => Math.hypot(p.x - lake.x, p.z - lake.z) <= lake.radius * 0.75);
    expect(crossing.length).toBeGreaterThan(0);
    for (const p of crossing) expect(p.level).toBe(lake.level);
    // A third of the way down it is still a river in the hills. It used to reach the level of the sea
    // within eight blocks of its start and run the rest of the way in a gorge.
    expect(river[Math.floor(river.length / 3)]!.level).toBeGreaterThan(SMALL.seaLevel + 4);
  });

  it('ships with light already computed, matching a fresh computation', () => {
    const fresh = world.clone();
    new LightEngine(fresh).computeAll();
    let mismatches = 0;
    for (let z = 0; z < SMALL.sz; z += 3) {
      for (let x = 0; x < SMALL.sx; x += 3) {
        for (let y = 30; y < 110; y += 2) if (world.getLight(x, y, z) !== fresh.getLight(x, y, z)) mismatches++;
      }
    }
    expect(mismatches).toBe(0);
    const g = world.groundY(96, 96);
    expect(world.skyLight(96, g + 20, 96)).toBe(15);
  });

  it('is deterministic for a seed and different for another', () => {
    expect(digest(generateIsland(SMALL).world)).toBe(digest(world));
    expect(digest(generateIsland({ ...SMALL, seed: 8 }).world)).not.toBe(digest(world));
  });

  // Other seeds and sizes; the second is the island the browser gate loads.
  it.each([[3, 192], [DEFAULT_ISLAND.seed, 256], [11, 224]])('holds its water on seed %i at %i blocks across', (seed, size) => {
    const other = generateIsland({ ...SMALL, seed, sx: size, sz: size });
    expect(waterFaults(other.world)).toEqual({ hanging: 0, stillOpen: 0, overBank: 0, first: [] });
    expect(lakeHoles(other.world, other.info.lake)).toBe(0);
    expect(other.info.river[Math.floor(other.info.river.length / 3)]!.level).toBeGreaterThan(SMALL.seaLevel + 4);
  });

  // Opt-in (FULL_ISLAND=1): the full island takes seconds, which is the loading screen's budget, not a unit test's.
  const env = (globalThis as { process?: { env: Record<string, string | undefined> } }).process?.env ?? {};
  it.runIf(env.FULL_ISLAND === '1')('generates the full-size island within the loading budget', () => {
    const t0 = performance.now();
    const full = generateIsland(DEFAULT_ISLAND, undefined, () => performance.now());
    const ms = performance.now() - t0;
    const allocated = full.world.blocks.filter((s) => s !== null).length;
    const lit = full.world.light.filter((s) => s !== null).length;
    console.log(`full island: ${ms.toFixed(0)} ms ${JSON.stringify(full.timings)} block sections ${allocated}, light sections ${lit}, of ${full.world.sectionCount}`);
    expect(ms).toBeLessThan(15000);
  });
});
