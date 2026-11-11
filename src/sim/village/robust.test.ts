// The village away from the happy path: the world edited under it, plans with
// almost nothing in them, the player walking up to a counter, and the rules the
// accounts keep. Short runs; the long ones are in soak.test.ts and year.test.ts.

import { describe, expect, it } from 'vitest';
import { angleDelta } from '../../core/math';
import { Rng } from '../../core/rng';
import { B } from '../../world/blocks';
import { createFlatWorld } from '../../world/world';
import { type BuildingKind, type SimContext, type VillagePlan, createBasicActions, validateVillagePlan } from '../api';
import { Clock, SIM_DT } from '../clock';
import { Weather } from '../weather';
import { Economy } from './economy';
import { FEET, GROUND, placeBuilding } from './fixture-build';
import { G } from './goods';
import { type Headless, TICKS_PER_DAY, createHeadlessVillage } from './headless';
import { VillageSim } from './index';
import { PHASE_WALK } from './model';

const HOUR = TICKS_PER_DAY / 24;

describe('village when the world is edited under it', () => {
  it('walks round a wall that appears in the road ahead', () => {
    const h = createHeadlessVillage(3);
    const { sim, world } = h;
    h.runTo(0, 7);
    // Someone on a long walk whose way, five steps on, is open ground well clear of any building: a wall there blocks
    // nobody's door, only the road.
    const open = (x: number, z: number): boolean => {
      for (let dz = -2; dz <= 2; dz++) for (let dx = -2; dx <= 2; dx++) if (sim.core.siteIndexAt(x + dx, z + dz) >= 0) return false;
      return true;
    };
    let walker = null as (typeof sim.core.residents)[number] | null;
    for (let i = 0; i < 4000 && !walker; i++) {
      h.step(1);
      walker = sim.core.residents.find((r) => {
        const p = r.mover.path;
        return r.phase === PHASE_WALK && p !== null && p.length - r.mover.node > 14 && open(p.xs[r.mover.node + 5]!, p.zs[r.mover.node + 5]!);
      }) ?? null;
    }
    expect(walker).not.toBeNull();
    const r = walker!;
    const path = r.mover.path!;
    const at = r.mover.node + 5;
    const bx = path.xs[at]!;
    const by = path.ys[at]!;
    const bz = path.zs[at]!;
    const goal = { x: path.xs[path.length - 1]!, z: path.zs[path.length - 1]! };
    world.set(bx, by, bz, B.stone);
    world.set(bx, by + 1, bz, B.stone);
    let entered = false;
    let arrived = false;
    for (let i = 0; i < 3000 && !arrived; i++) {
      h.step(1);
      if (Math.floor(r.view.x) === bx && Math.floor(r.view.z) === bz) entered = true;
      arrived = Math.floor(r.view.x) === goal.x && Math.floor(r.view.z) === goal.z;
    }
    expect(entered).toBe(false);
    expect(arrived).toBe(true);
    expect(sim.stats.teleports).toBe(0);
  });

  it('works from the nearest footing when a block is dropped on a work spot, without being carried there', () => {
    const h = createHeadlessVillage(3);
    const { sim, world } = h;
    h.runTo(0, 12);
    const mill = sim.core.businesses.find((b) => b.site.b.kind === 'mill')!;
    const stand = mill.site.b.work[0]!.stand;
    world.set(stand.x, stand.y, stand.z, B.crate);
    let milled = 0;
    for (let hour = 0; hour < 30; hour++) {
      h.step(HOUR);
      milled += sim.economy.produced[G.flour]!;
      for (const w of mill.workers) expect(Math.floor(w.view.x) === stand.x && Math.floor(w.view.z) === stand.z).toBe(false);
    }
    // The miller grinds on from beside the crate.
    expect(milled).toBeGreaterThan(0);
    expect(sim.stats.teleports).toBe(0);
  });

  it('never seizes up when a house is walled shut: the household is put where it needs to be, and counted', () => {
    const h = createHeadlessVillage(3);
    const { sim, world } = h;
    h.runTo(0, 12);
    const home = sim.core.households.find((hh) => hh.site.b.kind === 'house')!;
    const door = home.site.b.door!;
    // Brick up the doorway at midday, with the working members of the household out.
    expect(home.members.some((m) => m.inside !== sim.core.sites.indexOf(home.site))).toBe(true);
    world.set(door.x, door.y, door.z, B.stone);
    world.set(door.x, door.y + 1, door.z, B.stone);
    h.runTo(1, 2);
    // They could not walk in, so they were placed, and the count says so; the rest of the village never noticed.
    expect(sim.stats.teleports).toBeGreaterThan(0);
    expect(sim.stats.teleports).toBeLessThan(40);
    for (const m of home.members) expect(m.view.anim, m.name).toBe('sleep');
    const others = sim.core.residents.filter((x) => x.home !== home);
    expect(others.filter((x) => x.view.anim === 'sleep').length).toBeGreaterThan(others.length * 0.9);
    // Next day they are out again, at work or about the village.
    h.runTo(1, 10);
    expect(home.members.some((m) => m.inside !== sim.core.sites.indexOf(home.site))).toBe(true);
    expect(sim.ledger().coin).toBe(sim.ledger().purses + sim.ledger().tills + sim.ledger().treasury);
  });
});

describe('village on plans the fixture does not cover', () => {
  /** A hamlet on bare ground: the buildings named, a well, and nothing else the plan could have. */
  function hamlet(kinds: [BuildingKind, string][]): { h: Headless; step: (ticks: number) => void } {
    const world = createFlatWorld(64, 64, GROUND, 64);
    world.trackDirty = false;
    const cottage = ['#w###w#', '#B.B.B#', '#b.b.b#', '#.....#', '#cL.sT#', 'H....s#', '###D###'];
    const style = { wall: B.plaster, corner: B.beam, roof: B.thatch, floor: B.oak_planks };
    const buildings = kinds.map(([kind, name], i) => placeBuilding(world, i + 1, kind, name, cottage, 12 + i * 10, 20, style));
    world.recomputeHeightmap();
    world.trackDirty = true;
    const here = { x: 30, z: 40, radius: 6 };
    const plan: VillagePlan = {
      name: 'Hamlet', center: { x: 30, y: FEET, z: 32 }, buildings, fields: [], pens: [], stalls: [], well: { x: 28, y: FEET, z: 32 },
      gathering: [], dock: [], mine: null, forest: here, pasture: here, hunting: here, lamps: [], patrol: [],
    };
    expect(validateVillagePlan(world, plan)).toEqual([]);
    const clock = new Clock(6.5, 0);
    const rng = new Rng(5);
    const weather = new Weather(rng.fork('weather'), clock);
    const ctx: SimContext = { world, clock, weather, rng, actions: createBasicActions(world), player: null };
    const sim = new VillageSim(ctx, plan);
    const step = (ticks: number): void => {
      for (let i = 0; i < ticks; i++) {
        clock.advance(SIM_DT);
        weather.update(SIM_DT);
        sim.tick();
      }
    };
    return { h: { world, plan, clock, weather, ctx, sim, step, runTo: () => {} }, step };
  }

  it('runs a lone house with no workplaces, fields, pens, stalls, lamps or patrol', () => {
    const { h, step } = hamlet([['house', 'Lone Cottage']]);
    const { sim } = h;
    expect(sim.core.residents.length).toBe(3);
    expect(sim.core.businesses.length).toBe(0);
    expect(sim.views.length).toBe(3);
    // Nobody to buy from and nothing to sell: they live on the larder, then on what they can forage.
    let worst = 0;
    for (let hour = 0; hour < 24 * 6; hour++) {
      step(HOUR);
      for (const r of sim.core.residents) worst = Math.max(worst, 1 - sim.inspect(r.id)!.bars[0]!.value);
    }
    expect(worst).toBeLessThan(0.95);
    expect(sim.stats.foraged).toBeGreaterThan(0);
    expect(sim.stats.teleports).toBe(0);
    expect(sim.ledger().coin).toBe(sim.ledger().purses + sim.ledger().treasury);
    expect(sim.quoteBuy('bread', 1)).toBeNull();
    expect(sim.quoteSell('bread', 1)).toBeNull();
    // 03:00 on the seventh night: all asleep at home.
    step(HOUR * 20.5);
    for (const r of sim.core.residents) expect(r.view.anim).toBe('sleep');
  });

  it('runs a bakery and a guardhouse with nothing to supply them', () => {
    const { h, step } = hamlet([['bakery', 'Bakehouse'], ['guardhouse', 'Watch house'], ['house', 'Cottage']]);
    const { sim } = h;
    const coin = sim.ledger().coin;
    step(HOUR * 24 * 4);
    // The baker bakes what flour there was, and the books still balance when it runs out.
    expect(sim.stats.breadBaked).toBeGreaterThan(0);
    expect(sim.ledger().coin).toBe(coin);
    expect(sim.stats.teleports).toBe(0);
    for (const b of sim.core.businesses) for (const n of b.stock) expect(n).toBeGreaterThanOrEqual(0);
  });
});

describe('village and the player', () => {
  it('greets the player and turns a seller to face them', () => {
    const h = createHeadlessVillage(3);
    const { sim, ctx } = h;
    h.runTo(0, 9);
    const seller = sim.core.residents.find((r) => sim.canTrade(r.id))!;
    expect(seller).toBeDefined();
    const player = { x: seller.view.x + 1.5, y: seller.view.y, z: seller.view.z + 0.5 };
    ctx.player = player;
    let spoke = false;
    for (let i = 0; i < 200 && !spoke; i++) {
      h.step(1);
      spoke = seller.view.bubble !== '';
    }
    expect(spoke).toBe(true);
    if (sim.canTrade(seller.id)) expect(Math.abs(angleDelta(seller.view.yaw, Math.atan2(player.x - seller.view.x, player.z - seller.view.z)))).toBeLessThan(0.3);
    expect(sim.people.length).toBe(sim.core.residents.length);
    for (const v of sim.people) expect(v.kind === 'villager' || v.kind === 'child').toBe(true);
    ctx.player = null;
    h.step(HOUR);
  });
});

describe('village accounts', () => {
  it('moves only whole coins and never overdraws', () => {
    const h = createHeadlessVillage(3);
    const econ: Economy = h.sim.economy;
    const a = { coin: 10 };
    const b = { coin: 0 };
    econ.pay(a, b, 4);
    expect([a.coin, b.coin]).toEqual([6, 4]);
    econ.pay(a, b, 0);
    expect(() => econ.pay(a, b, 7)).toThrow();
    expect(() => econ.pay(a, b, 1.5)).toThrow();
    expect([a.coin, b.coin]).toEqual([6, 4]);
    expect(econ.cost(0.4, 1)).toBe(1);
    expect(econ.cost(0.4, 10)).toBe(4);
    expect(econ.cost(6, 0)).toBe(0);
  });

  it('posts prices that rise as stock falls and fall as it piles up', () => {
    const h = createHeadlessVillage(3);
    const econ = h.sim.economy;
    const bakery = h.sim.core.businesses.find((b) => b.site.b.kind === 'bakery')!;
    const target = bakery.target[G.bread]!;
    const empty = econ.wanted(bakery, G.bread, 0);
    const level = econ.wanted(bakery, G.bread, target);
    const full = econ.wanted(bakery, G.bread, target * 2);
    expect(empty).toBeGreaterThan(level);
    expect(level).toBeGreaterThan(full);
    // The posted price follows over the hours rather than jumping.
    bakery.stock[G.bread] = 0;
    const before = bakery.price[G.bread]!;
    econ.updatePrices();
    const after = bakery.price[G.bread]!;
    expect(after).toBeGreaterThan(before);
    expect(after).toBeLessThan(empty);
  });

  it('is a class the game can construct directly', () => {
    const h = createHeadlessVillage(9);
    const second = new VillageSim(h.ctx, h.plan);
    expect(second.views.length).toBe(h.sim.views.length);
    second.dispose();
    h.sim.dispose();
  });
});
