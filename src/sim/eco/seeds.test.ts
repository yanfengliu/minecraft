import { beforeAll, describe, expect, it } from 'vitest';
import type { CensusRow } from './index';
import { WILD_KINDS } from './species';
import { type Kit, builtKit } from './testbuild';
import * as inRunner from './testkit';

// The soak follows one seed closely. This looks at others, each a landscape
// of its own with its own weather and its own luck, for what must hold on all
// of them: nothing dies out, nothing passes its cap, nothing ends up inside a
// block. Left alone it gives four other seeds a spring and a summer, which is
// what the default run can afford; `ECO_SOAK_YEARS=3 npm test` gives each of
// seeds 1 to 5 its three years, the long look that the tuning is judged by.
const YEARS = Math.max(1, Math.round(inRunner.envNumber('ECO_SOAK_YEARS', 1)));
const FULL = YEARS > 1;
const SEEDS = FULL ? [1, 2, 3, 4, 5] : [2, 3, 4, 5];
const SEASONS = FULL ? YEARS * 4 : 2;
const NAMES = ['spring', 'summer', 'autumn', 'winter'];

interface Run {
  seed: number;
  start: CensusRow[];
  /** The census at the end of each season. */
  ends: CensusRow[][];
  overCap: string[];
  misplaced: string[];
  kills: Record<string, number>;
}

describe(`${SEEDS.length} seeds, ${FULL ? `${YEARS} years` : 'a spring and a summer'} each`, () => {
  const runs: Run[] = [];
  const of = (rows: CensusRow[], kind: string): CensusRow => rows.find((r) => r.kind === kind) as CensusRow;
  const last = (run: Run): CensusRow[] => run.ends.at(-1) as CensusRow[];

  beforeAll(async () => {
    // As the game ships it, which runs a simulated year in half the time; the runner's own copy if that cannot be built.
    let kit: Kit = inRunner;
    try {
      kit = await builtKit();
    } catch (err) {
      console.log(`Could not build the simulation as the game does (${String(err)}); running it in the test runner.`);
    }
    for (const seed of SEEDS) {
      const rig = kit.makeRig({ seed, startDay: 0, eco: { immigration: false } });
      const run: Run = { seed, start: rig.eco.census(), ends: [], overCap: [], misplaced: [], kills: {} };
      const watch = (tick: number): void => {
        if (tick % 1200 !== 0) return;
        if (run.misplaced.length < 5) run.misplaced.push(...kit.misplaced(rig.world, rig.eco.views));
        for (const r of rig.eco.census()) if (r.count > r.cap) run.overCap.push(`${r.kind} ${r.count} > ${r.cap} on day ${rig.clock.day}`);
      };
      const lines: string[] = [];
      for (let s = 0; s < SEASONS; s++) {
        rig.days(7, watch);
        run.ends.push(rig.eco.census());
        if (s % 4 === 3 || s === SEASONS - 1) lines.push(`  year ${Math.floor(s / 4) + 1}, end of ${NAMES[s % 4]}: ${kit.censusLine(rig.eco)}`);
      }
      run.kills = rig.eco.stats().kills;
      console.log(`Seed ${seed}, immigration off\n${lines.join('\n')}\n${kit.censusTable(rig.eco)}`);
      runs.push(run);
    }
  }, 1_800_000);

  it('ends with every species present on every seed, none of them brought back in from outside', () => {
    expect(runs.map((r) => r.seed)).toEqual(SEEDS);
    for (const run of runs) {
      expect(last(run).map((r) => r.kind)).toEqual([...WILD_KINDS]);
      for (const r of last(run)) {
        expect(r.count + r.away, `${r.kind} at the end, seed ${run.seed}`).toBeGreaterThan(0);
        expect(r.arrived, `${r.kind} arrivals, seed ${run.seed}`).toBe(0);
      }
    }
  });

  it('no species is ever above its cap', () => {
    for (const run of runs) {
      expect(run.overCap, `seed ${run.seed}`).toEqual([]);
      for (const rows of run.ends) for (const r of rows) expect(r.count, `${r.kind}, seed ${run.seed}`).toBeLessThanOrEqual(r.cap);
      // Every landscape carries the whole cast, in numbers of the same order as the soak's.
      const total = run.start.reduce((n, r) => n + r.count, 0);
      expect(total, `animals at the start, seed ${run.seed}`).toBeGreaterThan(200);
      expect(total, `animals at the start, seed ${run.seed}`).toBeLessThan(300);
    }
  });

  it('animals are never inside a block, outside the world, or fish out of water', () => {
    for (const run of runs) expect(run.misplaced, `seed ${run.seed}`).toEqual([]);
  });

  it('on every seed they breed, the hunters hunt, and no species is down to its last animal in its first year', () => {
    for (const run of runs) {
      const end = last(run);
      const firstYear = run.ends.slice(0, 4);
      for (const rows of firstYear) for (const r of rows) expect(r.count + r.away, `${r.kind}, seed ${run.seed}`).toBeGreaterThanOrEqual(2);
      for (const kind of ['deer', 'rabbit', 'boar', 'songbird', 'duck']) expect(of(end, kind).births, `${kind} births, seed ${run.seed}`).toBeGreaterThan(0);
      expect(of(end, 'rabbit').births, `rabbit births, seed ${run.seed}`).toBeGreaterThan(30);
      expect(of(end, 'rabbit').killed, `rabbits taken, seed ${run.seed}`).toBeGreaterThan(10);
      expect(run.kills.fox, `fox kills, seed ${run.seed}`).toBe(of(end, 'rabbit').killed);
      expect(run.kills.wolf, `wolf kills, seed ${run.seed}`).toBe(of(end, 'deer').killed + of(end, 'boar').killed);
    }
  });
});
