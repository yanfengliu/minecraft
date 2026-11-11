import { beforeAll, describe, expect, it } from 'vitest';
import { DAYS_PER_SEASON, DAY_SECONDS, SIM_DT } from '../clock';
import type { CensusRow } from './index';
import { WILD_KINDS } from './species';
import { floorCellY } from './terrain';
import { builtKit } from './testbuild';
import { type Rig, censusTable, countForage, envNumber, makeRig, misplaced } from './testkit';

/** Simulated years the soak runs. One by default; `ECO_SOAK_YEARS=3 npm test` for the long look. */
const YEARS = Math.max(1, Math.round(envNumber('ECO_SOAK_YEARS', 1)));
const SEASONS = ['spring', 'summer', 'autumn', 'winter'];
const SEASON_SECONDS = DAYS_PER_SEASON * DAY_SECONDS;

// The whole ecosystem on the fixture, left to itself with nothing brought in
// from outside, looked at at the end of every season. The tests below share
// the one run.
describe(`${YEARS} simulated ${YEARS === 1 ? 'year' : 'years'} of the whole ecosystem`, () => {
  interface Mark {
    label: string;
    day: number;
    rows: CensusRow[];
    forage: number;
  }
  const marks: Mark[] = [];
  /**
   * The census at the last tick of each season. The marks are taken a few
   * hours later, at the hour of the morning the run began, which is near
   * enough for everything but saying which season a birth fell in.
   */
  const turns: CensusRow[][] = [];
  const midwinter: CensusRow[][] = [];
  const problems: string[] = [];
  const overCap: string[] = [];
  let rig: Rig;
  let start: CensusRow[] = [];
  let forageAtStart = 0;
  const of = (rows: CensusRow[], kind: string): CensusRow => rows.find((r) => r.kind === kind) as CensusRow;

  beforeAll(() => {
    rig = makeRig({ seed: 1, startDay: 0, eco: { immigration: false } });
    start = rig.eco.census();
    forageAtStart = countForage(rig.world);
    console.log(`Start: ${rig.eco.views.length} animals, ${forageAtStart} forage plants\n${censusTable(rig.eco)}`);
    let turn = SEASON_SECONDS;
    const watch = (tick: number): void => {
      if (rig.clock.time + SIM_DT >= turn) {
        turns.push(rig.eco.census());
        turn += SEASON_SECONDS;
      }
      if (tick % 241 !== 0) return;
      if (problems.length < 10) problems.push(...misplaced(rig.world, rig.eco.views));
      for (const r of rig.eco.census()) if (r.count > r.cap) overCap.push(`${r.kind} ${r.count} > ${r.cap} on day ${rig.clock.day}`);
    };
    for (let year = 1; year <= YEARS; year++) {
      for (let s = 0; s < 4; s++) {
        if (s === 3) {
          rig.days(3.5, watch);
          midwinter.push(rig.eco.census());
          rig.days(3.5, watch);
        } else rig.days(7, watch);
        const forage = countForage(rig.world);
        const p = rig.eco.plants();
        marks.push({ label: `year ${year}, end of ${SEASONS[s]}`, day: rig.clock.day, rows: rig.eco.census(), forage });
        console.log(
          `Year ${year}, end of ${SEASONS[s]} (day ${rig.clock.day}): ${rig.eco.views.length} animals; ${forage} forage plants, ` +
          `cover ${(p.cover * 100).toFixed(0)}%, ${p.ripeBushes} ripe bushes, ${p.saplings} saplings, ${rig.eco.stats().treesGrown} trees grown\n${censusTable(rig.eco)}`,
        );
      }
    }
  }, 900_000);

  it('ends with every species present, none of them brought back in from outside', () => {
    const end = (marks.at(-1) as Mark).rows;
    expect(end.map((r) => r.kind)).toEqual([...WILD_KINDS]);
    for (const r of end) {
      expect(r.count, `${r.kind} at the end`).toBeGreaterThan(0);
      expect(r.arrived, `${r.kind} arrivals`).toBe(0);
    }
    // And not by standing still: they bred, and the short-lived and the hunted lost animals. (The fox and the
    // wolf are too few for a litter every year to be certain; their breeding is looked at below.)
    for (const kind of ['deer', 'rabbit', 'boar', 'songbird', 'crow', 'gull', 'duck', 'fish']) expect(of(end, kind).births, `${kind} births`).toBeGreaterThan(0);
    for (const kind of ['deer', 'rabbit', 'boar', 'songbird', 'fish']) expect(of(end, kind).deaths, `${kind} deaths`).toBeGreaterThan(0);
  });

  it('no species is ever above its cap, or anywhere near gone', () => {
    expect(overCap).toEqual([]);
    // Stated caps for the fixture: the most there can ever be of each.
    const caps = Object.fromEntries(start.map((r) => [r.kind, r.cap]));
    expect(caps).toEqual({ deer: 30, rabbit: 101, boar: 20, fox: 6, wolf: 5, songbird: 60, crow: 14, gull: 18, duck: 17, fish: 81 });
    for (const m of marks) {
      for (const r of m.rows) {
        expect(r.count, `${r.kind}, ${m.label}`).toBeLessThanOrEqual(r.cap);
        expect(r.count + r.away, `${r.kind}, ${m.label}`).toBeGreaterThanOrEqual(2);
      }
    }
    const most = Math.max(...marks.map((m) => m.rows.reduce((n, r) => n + r.count, 0)));
    expect(most).toBeLessThan(352);
    expect(most).toBeGreaterThan(250);
  });

  it('animals are never inside a block, outside the world, or fish out of water', () => {
    expect(problems).toEqual([]);
  });

  it('the young come in their season', () => {
    // Season by season, each counted to its last tick.
    expect(turns.length).toBe(YEARS * 4);
    const [spring, summer, , winter] = turns as [CensusRow[], CensusRow[], CensusRow[], CensusRow[]];
    // Fawns, piglets, cubs and pups in spring only.
    for (const kind of ['deer', 'boar']) expect(of(spring, kind).births, `${kind} born in spring`).toBeGreaterThan(0);
    for (const kind of ['deer', 'boar', 'fox', 'wolf']) expect(of(winter, kind).births, `${kind} born after spring`).toBe(of(spring, kind).births);
    expect(of(spring, 'fox').births + of(spring, 'wolf').births).toBeGreaterThan(0);
    // Rabbits through spring and summer, and none after: the courting stops when a litter could no longer come in time.
    expect(of(spring, 'rabbit').births).toBeGreaterThan(20);
    expect(of(summer, 'rabbit').births).toBeGreaterThan(of(spring, 'rabbit').births);
    expect(of(winter, 'rabbit').births).toBe(of(summer, 'rabbit').births);
    expect(of(summer, 'songbird').births).toBeGreaterThan(5);
    expect(of(winter, 'songbird').births).toBe(of(summer, 'songbird').births);
  });

  it('songbirds are fewer in winter, and back in spring', () => {
    const [, summer, , winter] = marks as [Mark, Mark, Mark, Mark];
    const cold = of(midwinter[0] as CensusRow[], 'songbird');
    expect(cold.away).toBeGreaterThan(10);
    expect(cold.count).toBeLessThan(of(summer.rows, 'songbird').count * 0.75);
    expect(cold.count).toBeGreaterThan(5);
    // The first morning of spring finds the flocks back, less the few that did not make the passage.
    expect(of(winter.rows, 'songbird').away).toBe(0);
    expect(of(winter.rows, 'songbird').count).toBeGreaterThan(cold.count + 8);
  });

  it('hunters take prey, and age and hunger take their share', () => {
    const end = (marks.at(-1) as Mark).rows;
    expect(of(end, 'rabbit').killed).toBeGreaterThan(30);
    expect(of(end, 'deer').killed + of(end, 'boar').killed).toBeGreaterThan(3);
    expect(rig.eco.stats().kills.fox).toBe(of(end, 'rabbit').killed);
    expect(rig.eco.stats().kills.wolf).toBe(of(end, 'deer').killed + of(end, 'boar').killed);
    expect(end.reduce((n, r) => n + r.oldAge, 0)).toBeGreaterThan(20);
    // Fish are born and die with their stock; nobody fished, so none were landed.
    expect(of(end, 'fish').hunted).toBe(0);
    expect(rig.eco.stats().fishStock).toBeGreaterThan(200);
  });

  it('the plant cover swings with the seasons and is never grazed out', () => {
    const [spring, summer, , winter] = marks as [Mark, Mark, Mark, Mark];
    expect(spring.forage).toBeGreaterThan(forageAtStart * 1.2);
    expect(winter.forage).toBeLessThan(summer.forage * 0.75);
    for (const m of marks) expect(m.forage, m.label).toBeGreaterThan(1500);
    const eaten = rig.eco.stats().eaten;
    expect((eaten.deer ?? 0) + (eaten.rabbit ?? 0) + (eaten.boar ?? 0)).toBeGreaterThan(8000);
  });

  it('keeps a day-by-day history for the chart', () => {
    const history = rig.eco.history();
    const days = Math.min(112, YEARS * 28 + 1);
    for (const kind of WILD_KINDS) expect(history[kind]?.length).toBe(days);
    expect(history.deer?.[0]).toBe(of(start, 'deer').count);
    expect(Math.max(...(history.rabbit ?? []))).toBeGreaterThan(of(start, 'rabbit').count);
  });
});

describe('determinism', () => {
  /** Everything that can be seen of a run, boiled down to a string. */
  function digest(seed: number, days: number): string {
    const rig = makeRig({ seed, startDay: 0 });
    rig.days(days);
    let plants = 0;
    for (let z = 0; z < rig.world.sz; z++) {
      for (let x = 0; x < rig.world.sx; x++) plants = (Math.imul(plants, 31) + rig.world.get(x, floorCellY(rig.world, x, z), z)) >>> 0;
    }
    const animals = rig.eco.views.map((v) => [v.id, v.kind, v.look, v.x, v.y, v.z, v.yaw, v.anim, v.animTime, v.scale].join(','));
    return [plants, JSON.stringify(rig.eco.census()), JSON.stringify(rig.eco.stats()), ...animals].join('\n');
  }

  it('the same seed gives the same world, animal for animal and plant for plant', () => {
    const a = digest(7, 2.5);
    const b = digest(7, 2.5);
    expect(a.split('\n').length).toBeGreaterThan(200);
    expect(b).toBe(a);
    expect(digest(8, 2.5)).not.toBe(a);
  });
});

describe('cost', () => {
  interface Kit {
    makeRig: typeof makeRig;
  }

  interface Cost {
    /** Mean wall-clock microseconds per `tick()` over one simulated day, and the cheapest and dearest hours of it. */
    mean: number;
    best: number;
    worst: number;
    /** The same day measured in processor time: what the ticks cost however busy the machine was. NaN if it cannot be read. */
    cpu: number;
    animals: number;
  }

  /** Processor time this process has used, in microseconds, where the host can say. */
  function cpuMicros(): number {
    const proc = (globalThis as { process?: { cpuUsage?: () => { user: number; system: number } } }).process;
    const used = proc?.cpuUsage?.();
    return used ? used.user + used.system : NaN;
  }

  /**
   * One simulated day of the fixture's full population, timed tick by tick.
   * The day is run `runs` times over (it is the same day each time: the
   * simulation is deterministic) and each hour takes its best showing, which
   * sheds most of what other work on the machine adds.
   */
  function measure(kit: Kit, runs: number): Cost {
    const hours = new Array<number>(24).fill(Infinity);
    let animals = 0;
    let cpu = Infinity;
    for (let run = 0; run < runs; run++) {
      const rig = kit.makeRig({ seed: 1, startDay: 8 });
      rig.days(0.25);
      animals = 0;
      const cpu0 = cpuMicros();
      for (let hour = 0; hour < 24; hour++) {
        let ms = 0;
        for (let i = 0; i < 600; i++) {
          rig.clock.advance(SIM_DT);
          rig.weather.update(SIM_DT);
          const t0 = performance.now();
          rig.eco.tick();
          ms += performance.now() - t0;
        }
        hours[hour] = Math.min(hours[hour] as number, (ms * 1000) / 600);
        animals += rig.eco.views.length / 24;
      }
      // Processor time covers the whole loop, clock and weather included, so it overstates the tick a little.
      cpu = Math.min(cpu, (cpuMicros() - cpu0) / 14400);
    }
    return { mean: hours.reduce((a, b) => a + b, 0) / 24, best: Math.min(...hours), worst: Math.max(...hours), cpu, animals: Math.round(animals) };
  }

  it('a tick costs well under 40 microseconds with the fixture fully stocked', async () => {
    // The simulation as the game ships it is what is judged: see `testbuild.ts` for why the runner's own reading is not.
    let game: Cost | null = null;
    try {
      game = measure(await builtKit(), 2);
    } catch (err) {
      console.log(`Could not build the simulation as the game does (${String(err)}); timing it in the test runner only.`);
    }
    const runner = measure({ makeRig }, 1);
    const line = (c: Cost): string => `${c.mean.toFixed(1)} us (hourly means ${c.best.toFixed(1)} to ${c.worst.toFixed(1)}; ${Number.isNaN(c.cpu) ? 'processor time not available' : `${c.cpu.toFixed(1)} us of processor time`})`;
    console.log(
      `EcoSim.tick() with ${runner.animals} animals, mean over one simulated day (14400 ticks):\n` +
      (game ? `  as built for the game:  ${line(game)}\n` : '') +
      `  inside the test runner: ${line(runner)}`,
    );
    const judged = game ?? runner;
    expect(judged.animals).toBeGreaterThan(220);
    // Wall-clock time is the plain reading. On a machine busy with other work it overstates what the tick costs,
    // so processor time may stand in for it.
    expect(Number.isNaN(judged.cpu) ? judged.mean : Math.min(judged.mean, judged.cpu)).toBeLessThan(40);
  });
});
