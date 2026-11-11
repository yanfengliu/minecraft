// A whole simulated year (28 days) of the fixture village, observed hourly:
// the fields go through their calendar, the flock makes good its losses in
// spring, and the village gets through the winter fed and solvent.

import { beforeAll, describe, expect, it } from 'vitest';
import { B, cropStage } from '../../world/blocks';
import { DAYS_PER_YEAR } from '../clock';
import { G } from './goods';
import { type Headless, TICKS_PER_DAY, createHeadlessVillage } from './headless';

/** Set VILLAGE_SEED to run another village's year; the invariants should hold for any seed. */
const SEED = Number((globalThis as { process?: { env: Record<string, string | undefined> } }).process?.env.VILLAGE_SEED ?? 4242);
const HOUR = TICKS_PER_DAY / 24;

/** What happened to one field over the year, counted from block changes alone. */
interface FieldLog {
  cells: number;
  /** Crop blocks placed at stage 0, crop blocks that moved up a stage, and ripe crop blocks removed. */
  sown: number;
  grew: number;
  reaped: number;
  /** Most cells seen under crop at once, and most seen ripe at once. */
  mostCrop: number;
  mostRipe: number;
}

const obs = {
  fields: [] as FieldLog[],
  coin: [] as number[],
  initialCoin: 0,
  hungryRun: new Map<number, number>(),
  hungryNow: new Map<number, number>(),
  stagesAtWinter: -1,
  stagesAtYearEnd: -1,
  stagesBySeason: [0, 0, 0, 0],
  wetShareInRain: 0,
  dryShareInSun: 0,
  sheepAfterCull: 0,
  sheepEndOfSpring: 0,
  viewsBefore: 0,
  viewsAfterKill: 0,
  killedStillFound: false,
  firewoodBurned: [0, 0, 0, 0],
  breadInWinter: 0,
  minStock: 0,
};

let h: Headless;

function observe(): void {
  const { sim, world, weather, clock } = h;
  const core = sim.core;
  core.fields.forEach((fs, i) => {
    const log = obs.fields[i]!;
    let crops = 0;
    let ripe = 0;
    let wet = 0;
    const f = fs.f;
    for (let z = f.z0; z <= f.z1; z++) {
      for (let x = f.x0; x <= f.x1; x++) {
        const stage = cropStage(world.get(x, f.y + 1, z));
        if (stage >= 0) crops++;
        if (stage === 3) ripe++;
        if (world.get(x, f.y, z) === B.farmland + 1) wet++;
      }
    }
    log.mostCrop = Math.max(log.mostCrop, crops);
    log.mostRipe = Math.max(log.mostRipe, ripe);
    if (weather.precipitation > 0.3 && !weather.snowing) obs.wetShareInRain = Math.max(obs.wetShareInRain, wet / log.cells);
    if (weather.wetness < 0.05 && weather.precipitation < 0.01) obs.dryShareInSun = Math.max(obs.dryShareInSun, 1 - wet / log.cells);
  });
  const ledger = sim.ledger();
  obs.coin.push(ledger.coin - ledger.playerNet);
  for (const r of core.residents) {
    const hunger = 1 - sim.inspect(r.id)!.bars[0]!.value;
    const run = hunger >= 0.85 ? (obs.hungryNow.get(r.id) ?? 0) + 1 : 0;
    obs.hungryNow.set(r.id, run);
    obs.hungryRun.set(r.id, Math.max(obs.hungryRun.get(r.id) ?? 0, run));
  }
  for (const b of core.businesses) for (const n of b.stock) obs.minStock = Math.min(obs.minStock, n);
  for (const home of core.households) for (const n of home.larder) obs.minStock = Math.min(obs.minStock, n);
  // Just before midnight the day's counts are complete.
  if (clock.hour >= 23) {
    obs.firewoodBurned[clock.seasonIndex]! += sim.economy.consumed[G.firewood]!;
    if (clock.seasonIndex === 3) obs.breadInWinter += sim.economy.produced[G.bread]!;
  }
}

beforeAll(() => {
  h = createHeadlessVillage(SEED);
  const { sim, clock } = h;
  const core = sim.core;
  obs.initialCoin = sim.ledger().coin;
  obs.fields = core.fields.map((fs) => ({ cells: fs.w * fs.d, sown: 0, grew: 0, reaped: 0, mostCrop: 0, mostRipe: 0 }));
  h.world.changed.on((c) => {
    const before = cropStage(c.old);
    const after = cropStage(c.state);
    if (before < 0 && after < 0) return;
    const i = core.fields.findIndex((fs) => c.x >= fs.f.x0 && c.x <= fs.f.x1 && c.z >= fs.f.z0 && c.z <= fs.f.z1 && c.y === fs.f.y + 1);
    const log = obs.fields[i];
    if (!log) return;
    if (before < 0 && after === 0) log.sown++;
    else if (before >= 0 && after === before + 1) log.grew++;
    else if (before === 3 && c.state === B.air) log.reaped++;
  });
  let stagesBefore = 0;
  for (let hour = 1; hour <= DAYS_PER_YEAR * 24; hour++) {
    const season = clock.seasonIndex;
    h.step(HOUR);
    obs.stagesBySeason[season]! += sim.stats.cropStages - stagesBefore;
    stagesBefore = sim.stats.cropStages;
    observe();
    if (hour === 30) {
      // A fox in the night: three sheep gone on the second day of spring.
      const sheep = core.animals.filter((a) => a.view.kind === 'sheep').slice(0, 3);
      obs.viewsBefore = sim.views.length;
      for (const a of sheep) sim.livestock.killLivestock(a.id);
      obs.viewsAfterKill = sim.views.length;
      obs.killedStillFound = sheep.some((a) => sim.views.some((v) => v.id === a.id) || sim.inspect(a.id) !== null);
      obs.sheepAfterCull = core.animals.filter((a) => a.view.kind === 'sheep').length;
    }
    if (hour === 7 * 24) obs.sheepEndOfSpring = core.animals.filter((a) => a.view.kind === 'sheep').length;
    if (hour === 21 * 24 + 6) obs.stagesAtWinter = sim.stats.cropStages;
  }
  obs.stagesAtYearEnd = sim.stats.cropStages;
}, 120_000);

describe('a year in the fixture village', () => {
  it('sows every field and harvests it', () => {
    const s = h.sim.stats;
    const cells = obs.fields.reduce((n, f) => n + f.cells, 0);
    console.log(`fields: ${cells} cells; tilled ${s.cellsTilled}, sown ${s.cellsSown}, harvested ${s.cellsHarvested}, watered ${s.cellsWatered}; growth stages by season ${obs.stagesBySeason.join('/')}`);
    console.log(obs.fields.map((f, i) => `field ${i} (${h.plan.fields[i]!.crop}, ${f.cells} cells): sown ${f.sown}, stages grown ${f.grew}, reaped ${f.reaped}, most under crop ${f.mostCrop}, most ripe at once ${f.mostRipe}`).join('\n'));
    obs.fields.forEach((f, i) => {
      // Every cell of every field was sown, came up through all three stages, and was cut at least once.
      expect(f.sown, `field ${i} sown`).toBeGreaterThanOrEqual(f.cells);
      expect(f.mostCrop, `field ${i} under crop`).toBeGreaterThan(f.cells * 0.9);
      expect(f.grew, `field ${i} grew`).toBeGreaterThanOrEqual(f.cells * 3);
      expect(f.reaped, `field ${i} reaped`).toBeGreaterThanOrEqual(f.cells);
      expect(f.mostRipe, `field ${i} ripe`).toBeGreaterThan(0);
    });
    // The simulation's own counts agree with what the blocks did.
    expect(s.cellsSown).toBe(obs.fields.reduce((n, f) => n + f.sown, 0));
    expect(s.cellsHarvested).toBe(obs.fields.reduce((n, f) => n + f.reaped, 0));
    expect(s.cropStages).toBe(obs.fields.reduce((n, f) => n + f.grew, 0));
    expect(s.cellsTilled).toBeGreaterThanOrEqual(cells);
    expect(s.cellsSown).toBeGreaterThanOrEqual(cells * 2);
    expect(s.cellsHarvested).toBeGreaterThanOrEqual(cells * 1.5);
    // What was harvested went into the economy.
    const econ = h.sim.economy;
    expect(econ.villageStock(G.wheat) + econ.villageStock(G.flour) + econ.villageStock(G.bread)).toBeGreaterThan(100);
  });

  it('grows crops in the warm seasons and not at all in winter', () => {
    expect(obs.stagesBySeason[0]).toBeGreaterThan(0);
    expect(obs.stagesBySeason[1]).toBeGreaterThan(obs.stagesBySeason[0]!);
    expect(obs.stagesBySeason[3]).toBe(0);
    expect(obs.stagesAtWinter).toBeGreaterThan(0);
    expect(obs.stagesAtYearEnd).toBe(obs.stagesAtWinter);
  });

  it('wets the soil when it rains and lets it dry in the sun', () => {
    expect(obs.wetShareInRain).toBeGreaterThan(0.9);
    expect(obs.dryShareInSun).toBeGreaterThan(0.5);
  });

  it('loses farm animals to predators and breeds back in spring', () => {
    expect(obs.viewsAfterKill).toBe(obs.viewsBefore - 3);
    expect(obs.killedStillFound).toBe(false);
    console.log(`flock: ${obs.sheepAfterCull} sheep after the fox, ${obs.sheepEndOfSpring} by the end of spring; born ${h.sim.stats.livestockBorn}, lost ${h.sim.stats.livestockLost}`);
    expect(obs.sheepEndOfSpring).toBeGreaterThan(obs.sheepAfterCull);
    expect(h.sim.stats.livestockLost).toBeGreaterThanOrEqual(3);
  });

  it('gets through the winter fed, warm and solvent', () => {
    const worst = Math.max(...obs.hungryRun.values());
    // Hourly samples: nobody critically hungry for more than three hours running.
    expect(worst).toBeLessThanOrEqual(3);
    expect(obs.breadInWinter).toBeGreaterThan(100);
    // More firewood goes on the hearths in winter than in summer.
    expect(obs.firewoodBurned[3]).toBeGreaterThan(obs.firewoodBurned[1]!);
    for (const coin of obs.coin) expect(coin).toBe(obs.initialCoin);
    expect(obs.minStock).toBe(0);
    expect(h.sim.stats.teleports).toBe(0);
    const ledger = h.sim.ledger();
    console.log(`year end: coin ${ledger.coin} (purses ${ledger.purses}, tills ${ledger.tills}, treasury ${ledger.treasury}); firewood burned by season ${obs.firewoodBurned.join('/')}; meals ${h.sim.stats.meals}, alms ${h.sim.stats.almsMeals}, foraged ${h.sim.stats.foraged}; teleports ${h.sim.stats.teleports}, failed routes ${h.sim.stats.pathFails}`);
  });
});
