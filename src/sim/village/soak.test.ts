// Fourteen simulated days of the fixture village, run once and observed every
// ten in-game minutes. The assertions below are the village's invariants: they
// are judged from the entity views and the world's blocks, as the game would
// see them, not from the simulation's own bookkeeping.

import { beforeAll, describe, expect, it } from 'vitest';
import { B, IS_LOG, doorIsOpen, isDoor, isGate } from '../../world/blocks';
import { ITEMS, item } from '../../world/items';
import { ANIM_STATES, type Building, type Cell, type EntityView } from '../api';
import { DAY_SECONDS, FAIR_DAY, REST_DAY } from '../clock';
import { sunTimes } from '../sky';
import { PRICE_MAX, PRICE_MIN } from './economy';
import { NG, PROFESSIONS, TRADE, VALUE } from './goods';
import { type Headless, createHeadlessVillage } from './headless';
import type { Resident } from './model';

const DAYS = 14;
/** Set VILLAGE_SEED to soak another village; the invariants should hold for any seed. */
const SEED = Number((globalThis as { process?: { env: Record<string, string | undefined> } }).process?.env.VILLAGE_SEED ?? 20261111);
/** Ticks between observations: ten in-game minutes. */
const SAMPLE = 100;

interface Night {
  samples: number;
  inBed: Map<number, number>;
}

const obs = {
  nights: [] as Night[],
  /** Per resident: days on which they were seen at their workplace. */
  worked: new Map<number, Set<number>>(),
  /** Per resident: longest run of samples with critical hunger. */
  hungryRun: new Map<number, number>(),
  hungryNow: new Map<number, number>(),
  worstHunger: 0,
  anims: new Set<string>(),
  held: new Set<number>(),
  bubbles: 0,
  maxBubbles: 0,
  longestBubble: 0,
  coinEachHour: [] as number[],
  minStock: 0,
  priceProblems: [] as string[],
  eveningLamps: [] as number[],
  eveningHomesLit: [] as number[],
  eveningHomesWrong: [] as string[],
  lightRechecks: [] as { at: number; building: Building; day: number }[],
  noonLit: [] as number[],
  ovenLitSeen: false,
  ovenFacing: new Set<number>(),
  forgeLitSeen: false,
  effects: new Map<string, number>(),
  doorOpens: 0,
  gateOpens: 0,
  walkStill: 0,
  walkSamples: 0,
  flockOutSeen: false,
  flockNightOutside: 0,
  orphanDoors: [] as string[],
  doorChecks: 0,
  crowding: 0,
};

let h: Headless;
let initialCoin = 0;

const near = (v: EntityView, c: Cell, d: number): boolean => Math.abs(v.x - (c.x + 0.5)) <= d && Math.abs(v.z - (c.z + 0.5)) <= d;
const inRect = (v: EntityView, x0: number, z0: number, x1: number, z1: number, pad: number): boolean =>
  v.x >= x0 - pad && v.x <= x1 + 1 + pad && v.z >= z0 - pad && v.z <= z1 + 1 + pad;
const inArea = (v: EntityView, a: { x: number; z: number; radius: number }, pad: number): boolean => Math.hypot(v.x - a.x, v.z - a.z) <= a.radius + pad;

/** Is this resident where their trade is practised? Judged from position alone. */
function atWork(r: Resident): boolean {
  const { plan } = h;
  const v = r.view;
  const job = r.job;
  if (!job) return false;
  const b = job.site.b;
  if (inRect(v, b.x0, b.z0, b.x1, b.z1, 0.5)) return true;
  if (job.stall && near(v, job.stall.stand, 1)) return true;
  switch (r.trade) {
    case TRADE.farmer:
      return job.fields.some((f) => inRect(v, f.f.x0, f.f.z0, f.f.x1, f.f.z1, 1.5)) || job.pens.some((p) => near(v, p.pen.outside, 1.5));
    case TRADE.woodcutter: return inArea(v, plan.forest, 2);
    case TRADE.fisher: return plan.dock.some((c) => near(v, c, 1.5));
    case TRADE.hunter: return inArea(v, plan.hunting, 2);
    case TRADE.miner: return plan.mine !== null && plan.mine.faces.some((c) => near(v, c, 1.5));
    case TRADE.shepherd: return inArea(v, plan.pasture, 2) || job.pens.some((p) => near(v, p.pen.outside, 1.5));
    case TRADE.guard: return plan.patrol.some((c) => near(v, c, 1.5)) || plan.lamps.some((c) => near(v, c, 2.5));
    default: return false;
  }
}

/** A building's lanterns against who is in it: lit when someone indoors is awake, out when nobody is. */
function lightsOf(b: Building): { awake: boolean; on: boolean; wrong: boolean; text: string } {
  const { sim, world } = h;
  const lit = (c: Cell): boolean => {
    const s = world.get(c.x, c.y, c.z);
    return s === B.lantern + 1 || s === B.hanging_lantern + 1;
  };
  const awake = sim.core.residents.some((r) => !r.asleep && inRect(r.view, b.x0, b.z0, b.x1, b.z1, -0.01));
  const on = b.lights.every(lit);
  const off = b.lights.every((c) => !lit(c));
  return { awake, on, wrong: (awake && !on) || (!awake && !off), text: `awake ${awake}, lit ${b.lights.filter(lit).length}/${b.lights.length}` };
}

function observe(tick: number): void {
  const { sim, world, plan, clock } = h;
  const core = sim.core;
  const hour = clock.hour;
  const day = clock.day;

  // People who are standing, sitting or lying somewhere should each have their own spot.
  const still = core.residents.filter((r) => r.view.anim !== 'walk' && r.view.anim !== 'run');
  for (let i = 0; i < still.length; i++) {
    for (let j = i + 1; j < still.length; j++) {
      const a = still[i]!.view;
      const b = still[j]!.view;
      if (Math.abs(a.x - b.x) < 0.45 && Math.abs(a.z - b.z) < 0.45 && Math.abs(a.y - b.y) < 1) obs.crowding++;
    }
  }

  // Hunger, through the inspector, as a player would read it.
  for (const r of core.residents) {
    const hunger = 1 - (sim.inspect(r.id)!.bars[0]!.value as number);
    obs.worstHunger = Math.max(obs.worstHunger, hunger);
    const run = hunger >= 0.85 ? (obs.hungryNow.get(r.id) ?? 0) + 1 : 0;
    obs.hungryNow.set(r.id, run);
    obs.hungryRun.set(r.id, Math.max(obs.hungryRun.get(r.id) ?? 0, run));
    obs.anims.add(r.view.anim);
    if (r.view.held >= 0) obs.held.add(r.view.held);
    if (clock.dayOfWeek !== REST_DAY && hour >= 4 && hour < 23.9 && atWork(r)) {
      let days = obs.worked.get(r.id);
      if (!days) obs.worked.set(r.id, (days = new Set()));
      days.add(day);
    }
  }

  // Nights run from 22:00 to 05:00; a sample counts for the night that began the evening before.
  if (hour >= 22 || hour < 5) {
    const index = hour >= 22 ? day : day - 1;
    if (index >= 0) {
      const night = (obs.nights[index] ??= { samples: 0, inBed: new Map() });
      night.samples++;
      for (const r of core.residents) {
        const bed = r.bed.block;
        const v = r.view;
        const lying = v.anim === 'sleep' && Math.abs(v.x - (bed.x + 0.5)) < 0.9 && Math.abs(v.z - (bed.z + 0.5)) < 0.9 && Math.abs(v.y - bed.y - 0.56) < 0.2;
        if (lying) night.inBed.set(r.id, (night.inBed.get(r.id) ?? 0) + 1);
      }
      // The flock is penned at night.
      if (hour >= 23 || hour < 4) {
        for (const a of core.animals) {
          const p = a.pen.pen;
          if (!inRect(a.view, p.x0, p.z0, p.x1, p.z1, 0.01)) obs.flockNightOutside++;
        }
      }
    }
  }
  if (hour >= 10 && hour < 15) {
    const sheep = core.animals.filter((a) => a.view.kind === 'sheep');
    if (sheep.length > 0 && sheep.filter((a) => inArea(a.view, plan.pasture, 1)).length >= sheep.length * 0.7) obs.flockOutSeen = true;
  }

  const ways: Cell[] = [...plan.buildings.flatMap((b) => (b.door ? [b.door] : [])), ...plan.pens.map((p) => p.gate)];
  for (const c of ways) {
    const s = world.get(c.x, c.y, c.z);
    const open = isDoor(s) ? doorIsOpen(s) : ((s - B.gate) & 1) === 1;
    obs.doorChecks++;
    const attended = sim.views.some((v) => Math.abs(v.x - c.x - 0.5) < 2.2 && Math.abs(v.z - c.z - 0.5) < 2.2);
    if (open && !attended) obs.orphanDoors.push(`${c.x},${c.z} on day ${day} at ${hour.toFixed(2)}`);
  }

  const lit = (c: Cell): boolean => {
    const s = world.get(c.x, c.y, c.z);
    return s === B.lantern + 1 || s === B.hanging_lantern + 1;
  };
  const sun = sunTimes(clock);
  const sampleHours = SAMPLE / 600;
  if (hour >= sun.set + 1 && hour < sun.set + 1 + sampleHours) {
    obs.eveningLamps.push(plan.lamps.filter(lit).length);
    let homes = 0;
    for (const site of core.sites) {
      const check = lightsOf(site.b);
      if (check.awake && check.on) homes++;
      // Lanterns follow the household within a second or two; only a mismatch that lasts is a fault.
      if (check.wrong) obs.lightRechecks.push({ at: tick + 25, building: site.b, day });
    }
    obs.eveningHomesLit.push(homes);
  }
  if (hour >= 12 && hour < 12 + sampleHours) {
    obs.noonLit.push(plan.lamps.filter(lit).length + core.sites.reduce((n, s) => n + s.b.lights.filter(lit).length, 0));
  }

  for (const site of core.sites) {
    for (const spot of site.b.work) {
      if (!spot.block) continue;
      const s = world.get(spot.block.x, spot.block.y, spot.block.z);
      if (spot.kind === 'oven') {
        obs.ovenFacing.add((s - B.oven) >> 1);
        if (((s - B.oven) & 1) === 1) obs.ovenLitSeen = true;
      }
      if (spot.kind === 'forge' && s === B.forge + 1) obs.forgeLitSeen = true;
    }
  }

  if (tick % 600 === 0) {
    const ledger = sim.ledger();
    obs.coinEachHour.push(ledger.coin - ledger.playerNet);
    for (const b of core.businesses) {
      for (let g = 0; g < NG; g++) {
        obs.minStock = Math.min(obs.minStock, b.stock[g]!, b.incoming[g]!);
        if (b.target[g]! > 0) {
          const ratio = b.price[g]! / VALUE[g]!;
          if (!(ratio >= PRICE_MIN - 1e-9 && ratio <= PRICE_MAX + 1e-9)) obs.priceProblems.push(`${b.site.b.name} ${g}: ${ratio}`);
        }
      }
    }
    for (const home of core.households) for (let g = 0; g < NG; g++) obs.minStock = Math.min(obs.minStock, home.larder[g]!);
    for (const r of core.residents) for (let g = 0; g < NG; g++) obs.minStock = Math.min(obs.minStock, r.pack[g]!, r.coin);
    for (const good of ledger.goods) {
      const ratio = good.price / item(good.good).value;
      if (!(ratio >= PRICE_MIN - 0.01 && ratio <= PRICE_MAX + 0.01)) obs.priceProblems.push(`ledger ${good.good}: ${ratio}`);
      if (good.stock < 0 || good.producedToday < 0 || good.consumedToday < 0) obs.priceProblems.push(`ledger ${good.good} negative`);
    }
  }
}

beforeAll(() => {
  h = createHeadlessVillage(SEED, { onEffect: (kind) => obs.effects.set(kind, (obs.effects.get(kind) ?? 0) + 1) });
  const { sim, world } = h;
  const core = sim.core;
  initialCoin = sim.ledger().coin;
  world.changed.on((c) => {
    if (isDoor(c.state) && doorIsOpen(c.state) && !doorIsOpen(c.old)) obs.doorOpens++;
    if (isGate(c.state) && ((c.state - B.gate) & 1) === 1 && ((c.old - B.gate) & 1) === 0) obs.gateOpens++;
  });
  const bubbleSince = new Map<number, number>();
  const last = new Map<number, [number, number]>();
  const total = DAYS * (DAY_SECONDS * 10);
  for (let tick = 1; tick <= total; tick++) {
    h.step(1);
    // Every tick: bubbles, and that anyone shown walking is in fact moving.
    let showing = 0;
    for (const r of core.residents) {
      const v = r.view;
      if (v.bubble !== '') {
        showing++;
        if (!bubbleSince.has(r.id)) {
          bubbleSince.set(r.id, tick);
          obs.bubbles++;
        }
      } else if (bubbleSince.has(r.id)) {
        obs.longestBubble = Math.max(obs.longestBubble, (tick - bubbleSince.get(r.id)!) / 10);
        bubbleSince.delete(r.id);
      }
      if (tick % 7 === 0) {
        const before = last.get(r.id);
        if (before && (v.anim === 'walk' || v.anim === 'run')) {
          obs.walkSamples++;
          if (Math.hypot(v.x - before[0], v.z - before[1]) < 1e-6) obs.walkStill++;
        }
      }
      if (tick % 7 === 6) last.set(r.id, [v.x, v.z]);
    }
    obs.maxBubbles = Math.max(obs.maxBubbles, showing);
    if (tick % SAMPLE === 0) observe(tick);
    while (obs.lightRechecks.length > 0 && obs.lightRechecks[0]!.at <= tick) {
      const again = obs.lightRechecks.shift()!;
      const check = lightsOf(again.building);
      if (check.wrong) obs.eveningHomesWrong.push(`${again.building.name} day ${again.day}: ${check.text}`);
    }
  }
}, 120_000);

describe('fourteen days in the fixture village', () => {
  it('has one resident per bed, about a fifth of them children, all with stable views', () => {
    const { sim, plan } = h;
    const residents = sim.core.residents;
    const beds = plan.buildings.reduce((n, b) => n + b.beds.length, 0);
    expect(residents.length).toBe(beds);
    expect(residents.length).toBeGreaterThanOrEqual(40);
    expect(residents.length).toBeLessThanOrEqual(50);
    const children = residents.filter((r) => r.child);
    expect(children.length / residents.length).toBeGreaterThan(0.15);
    expect(children.length / residents.length).toBeLessThan(0.27);
    for (const c of children) {
      expect(c.view.kind).toBe('child');
      expect(sim.professions[c.view.role]).toBe('child');
      expect(c.view.scale).toBeLessThan(0.9);
      expect(c.home.members.some((m) => !m.child)).toBe(true);
    }
    const ids = new Set(sim.views.map((v) => v.id));
    expect(ids.size).toBe(sim.views.length);
    for (const v of sim.views) expect(v.id).toBeLessThan(100000);
    for (const r of residents) {
      expect(sim.views).toContain(r.view);
      if (!r.child) expect(sim.professions[r.view.role]).toBe(PROFESSIONS[r.trade]);
    }
    // Every trade the fixture has a building for is practised by someone.
    const trades = new Set(residents.map((r) => PROFESSIONS[r.trade]));
    for (const t of ['farmer', 'miller', 'baker', 'innkeeper', 'smith', 'carpenter', 'weaver', 'storekeeper', 'priest', 'reeve', 'fisher', 'hunter', 'woodcutter', 'miner', 'shepherd', 'guard']) {
      expect(trades.has(t as (typeof PROFESSIONS)[number]), t).toBe(true);
    }
  });

  it('never leaves anyone critically hungry for more than a few hours', () => {
    const worst = Math.max(...obs.hungryRun.values());
    // Samples are ten minutes apart: 18 samples is three hours.
    expect(worst).toBeLessThanOrEqual(18);
    expect(h.sim.stats.meals).toBeGreaterThan(DAYS * h.sim.core.residents.length * 2);
    console.log(`hunger: worst ${obs.worstHunger.toFixed(2)}, longest critical spell ${(worst / 6).toFixed(1)} h, meals ${h.sim.stats.meals}, alms ${h.sim.stats.almsMeals}, foraged ${h.sim.stats.foraged}`);
  });

  it('has every resident asleep in their own bed for most of each night', () => {
    const residents = h.sim.core.residents;
    let worst = 1;
    let who = '';
    const full = obs.nights.filter((n) => n && n.samples >= 40);
    expect(full.length).toBeGreaterThanOrEqual(DAYS - 1);
    full.forEach((night, i) => {
      for (const r of residents) {
        const share = (night.inBed.get(r.id) ?? 0) / night.samples;
        if (share < worst) {
          worst = share;
          who = `${r.name} (${PROFESSIONS[r.trade]}) night ${i}`;
        }
      }
    });
    console.log(`sleep: least time in own bed over a night ${(worst * 100).toFixed(0)}% - ${who}`);
    expect(worst, who).toBeGreaterThan(0.6);
  });

  it('sees each trade at its workplace on every working day', () => {
    const { sim } = h;
    const missing: string[] = [];
    for (const r of sim.core.residents) {
      if (!r.job) continue;
      for (let day = 0; day < DAYS; day++) {
        if (day % 7 === REST_DAY) continue;
        if (!obs.worked.get(r.id)?.has(day)) missing.push(`${r.name} (${PROFESSIONS[r.trade]}) day ${day}${day % 7 === FAIR_DAY ? ' (fair)' : ''}`);
      }
    }
    expect(missing).toEqual([]);
  });

  it('lights lanterns and street lamps in the evening and has them out by day', () => {
    const { plan, sim } = h;
    expect(obs.eveningLamps.length).toBeGreaterThanOrEqual(DAYS - 1);
    for (const n of obs.eveningLamps) expect(n).toBe(plan.lamps.length);
    for (const n of obs.eveningHomesLit) expect(n).toBeGreaterThanOrEqual(8);
    expect(obs.eveningHomesWrong).toEqual([]);
    expect(obs.noonLit.length).toBeGreaterThanOrEqual(DAYS - 1);
    for (const n of obs.noonLit) expect(n).toBe(0);
    // The watch did it on foot, not the fallback.
    expect(sim.stats.lampsLit).toBeGreaterThanOrEqual(plan.lamps.length * (DAYS - 1));
  });

  it('bakes bread and eats it', () => {
    const s = h.sim.stats;
    expect(s.breadBaked).toBeGreaterThan(DAYS * 20);
    expect(s.breadEaten).toBeGreaterThan(DAYS * 20);
    expect(obs.ovenLitSeen).toBe(true);
    // The oven keeps its facing whether lit or not.
    expect(obs.ovenFacing.size).toBe(1);
    expect(obs.forgeLitSeen).toBe(true);
    console.log(`bread: baked ${s.breadBaked}, eaten ${s.breadEaten}`);
  });

  it('walks everywhere: no teleports, hardly a failed route', () => {
    const s = h.sim.stats;
    console.log(`routes: teleports ${s.teleports}, failed ${s.pathFails}, strays ${s.strays}; nav ${JSON.stringify(h.sim.core.nav.stats)}`);
    expect(s.teleports).toBe(0);
    expect(s.pathFails).toBeLessThanOrEqual(5);
    expect(s.strays).toBeLessThanOrEqual(2);
  });

  it('conserves money to the coin, keeps stocks non-negative and prices within bounds', () => {
    expect(obs.coinEachHour.length).toBeGreaterThanOrEqual(DAYS * 24);
    for (const coin of obs.coinEachHour) expect(coin).toBe(initialCoin);
    expect(obs.minStock).toBe(0);
    expect(obs.priceProblems).toEqual([]);
    const ledger = h.sim.ledger();
    expect(ledger.coin).toBe(ledger.purses + ledger.tills + ledger.treasury);
    expect(ledger.population).toBe(h.sim.core.residents.length);
    console.log(`money: ${ledger.coin} coins (purses ${ledger.purses}, tills ${ledger.tills}, treasury ${ledger.treasury})`);
  });

  it('shows what people are doing: animations, things in hand, the odd word', () => {
    for (const a of obs.anims) expect(ANIM_STATES).toContain(a);
    for (const a of ['walk', 'work', 'eat', 'sleep', 'sit', 'talk', 'idle']) expect(obs.anims.has(a), a).toBe(true);
    for (const id of obs.held) expect(ITEMS[id]).toBeDefined();
    for (const name of ['wheat', 'bread', 'tools']) expect(obs.held.has(item(name).id), name).toBe(true);
    // Shown walking means moving.
    expect(obs.walkSamples).toBeGreaterThan(1000);
    expect(obs.walkStill / obs.walkSamples).toBeLessThan(0.01);
    // Nobody stands, sits or sleeps on top of anybody else, give or take two people brushing past at a doorway.
    console.log(`crowding: ${obs.crowding} pairs of people sharing a spot, over ${DAYS * 144} looks at ${h.sim.core.residents.length} people`);
    expect(obs.crowding).toBeLessThan(DAYS * 3);
    // People speak now and then, briefly, and not all at once.
    const perPersonDay = obs.bubbles / (DAYS * h.sim.core.residents.length);
    console.log(`bubbles: ${obs.bubbles} (${perPersonDay.toFixed(1)} per person per day), most at once ${obs.maxBubbles}, longest ${obs.longestBubble.toFixed(1)} s`);
    expect(obs.bubbles).toBeGreaterThan(DAYS * 20);
    expect(perPersonDay).toBeLessThan(40);
    expect(obs.maxBubbles).toBeLessThanOrEqual(3);
    expect(obs.longestBubble).toBeLessThanOrEqual(6);
  });

  it('works on real blocks: doors, crops, trees, cues', () => {
    const { sim, world, plan } = h;
    const s = sim.stats;
    expect(obs.doorOpens).toBeGreaterThan(DAYS * 100);
    expect(obs.gateOpens).toBeGreaterThan(DAYS);
    // Nobody leaves a door or a gate open behind them: an open one always has someone in or beside it.
    expect(obs.orphanDoors).toEqual([]);
    expect(obs.doorChecks).toBeGreaterThan(1000);
    expect(s.cellsSown).toBeGreaterThan(300);
    expect(s.cellsHarvested).toBeGreaterThan(100);
    expect(s.treesFelled).toBeGreaterThan(3);
    expect(s.saplingsPlanted).toBe(s.treesFelled);
    let saplings = 0;
    let logs = 0;
    const f = plan.forest;
    for (let z = f.z - f.radius; z <= f.z + f.radius; z++) {
      for (let x = f.x - f.radius; x <= f.x + f.radius; x++) {
        const state = world.get(x, 32, z);
        if (state === B.oak_sapling || state === B.birch_sapling || state === B.pine_sapling) saplings++;
        if (IS_LOG[state]) logs++;
      }
    }
    expect(saplings).toBe(s.saplingsPlanted);
    console.log(`blocks: doors opened ${obs.doorOpens}, gates ${obs.gateOpens}, sown ${s.cellsSown}, harvested ${s.cellsHarvested}, trees felled ${s.treesFelled}, saplings ${saplings}, trunks left ${logs}; cues ${JSON.stringify([...obs.effects])}`);
    for (const kind of ['smoke', 'sparks', 'chop', 'hammer']) expect(obs.effects.get(kind) ?? 0, kind).toBeGreaterThan(10);
  });

  it('takes the flock to pasture by day and pens it at night', () => {
    const s = h.sim.stats;
    expect(obs.flockOutSeen).toBe(true);
    expect(obs.flockNightOutside).toBe(0);
    expect(s.eggsLaid).toBeGreaterThan(DAYS * 2);
    expect(s.woolShorn).toBeGreaterThan(0);
    console.log(`livestock: ${h.sim.core.animals.length} head, eggs ${s.eggsLaid}, wool ${s.woolShorn}, born ${s.livestockBorn}`);
  });
});
