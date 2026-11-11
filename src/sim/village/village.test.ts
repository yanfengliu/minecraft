// The facade as the game uses it: inspector, ledger, trade for the player,
// talk, the livestock and wildlife services, weather, a clock that jumps, and
// determinism. Short runs; the long ones are in soak.test.ts and year.test.ts.

import { describe, expect, it } from 'vitest';
import { B } from '../../world/blocks';
import { ECONOMY_GOODS } from '../../world/items';
import { ANIM_STATES, type EntityView, type WildlifeApi, validateVillagePlan } from '../api';
import { DAY_SECONDS, FAIR_DAY } from '../clock';
import { G, PROFESSIONS, TRADE } from './goods';
import { type Headless, TICKS_PER_DAY, createHeadlessVillage } from './headless';
import type { Livestock } from './livestock';
import { FLOCK_PENNED } from './model';

const HOUR = TICKS_PER_DAY / 24;

/**
 * Everything that should be identical between two runs from one seed. With
 * `wording` false, what people happen to be saying is left out: that is the one
 * thing allowed to differ when the player has spoken to someone.
 */
function fingerprint(h: Headless, wording = true): number[] {
  const out: number[] = [];
  const { sim, world, plan } = h;
  for (const v of sim.views) {
    out.push(v.id, v.x, v.y, v.z, v.yaw, v.animTime, v.held, v.scale, ANIM_STATES.indexOf(v.anim));
    if (wording) out.push(v.bubble.length);
  }
  for (const r of sim.core.residents) out.push(r.coin, r.hunger, r.energy, r.social, r.mood, r.packCount, r.goal);
  for (const b of sim.core.businesses) out.push(b.coin, b.markup, ...b.stock, ...b.price);
  for (const home of sim.core.households) out.push(...home.larder, home.plate);
  out.push(sim.core.treasury.coin);
  for (const [name, value] of Object.entries(sim.stats)) if (wording || name !== 'greetings') out.push(value);
  let blocks = 0;
  for (const f of plan.fields) for (let z = f.z0; z <= f.z1; z++) for (let x = f.x0; x <= f.x1; x++) blocks = (blocks * 31 + world.get(x, f.y, z) * 7 + world.get(x, f.y + 1, z)) >>> 0;
  for (const b of plan.buildings) for (const c of b.lights) blocks = (blocks * 31 + world.get(c.x, c.y, c.z)) >>> 0;
  out.push(blocks);
  return out;
}

describe('village facade', () => {
  it('builds from a valid plan and runs with no player, no wildlife and no people service', () => {
    const h = createHeadlessVillage(3);
    expect(validateVillagePlan(h.world, h.plan)).toEqual([]);
    expect(h.ctx.player).toBeNull();
    expect(h.ctx.wildlife).toBeUndefined();
    expect(h.ctx.people).toBeUndefined();
    expect(h.sim.professions).toEqual(PROFESSIONS);
    expect(h.sim.professions).toContain('child');
    h.step(HOUR * 3);
    expect(h.sim.views.length).toBeGreaterThan(50);
    for (const v of h.sim.views) {
      expect(Number.isFinite(v.x) && Number.isFinite(v.y) && Number.isFinite(v.z) && Number.isFinite(v.yaw)).toBe(true);
      expect(v.y).toBeGreaterThan(31);
      expect(v.y).toBeLessThan(40);
    }
    h.sim.dispose();
  });

  it('describes villagers and animals for the inspector', () => {
    const h = createHeadlessVillage(3);
    h.step(HOUR * 4);
    const { sim } = h;
    const baker = sim.core.residents.find((r) => r.trade === TRADE.baker)!;
    const info = sim.inspect(baker.id)!;
    expect(info.title).toBe(baker.name);
    expect(info.subtitle.toLowerCase()).toContain('baker');
    expect(info.lines.length).toBeGreaterThanOrEqual(5);
    expect(info.lines.some((l) => l.startsWith('Purse: '))).toBe(true);
    expect(info.lines.some((l) => l.startsWith('Home: '))).toBe(true);
    expect(info.lines.some((l) => l.startsWith('Works at: The Bakehouse'))).toBe(true);
    expect(info.bars.map((b) => b.label)).toEqual(['Fed', 'Energy', 'Social', 'Mood']);
    for (const bar of info.bars) {
      expect(bar.value).toBeGreaterThanOrEqual(0);
      expect(bar.value).toBeLessThanOrEqual(1);
    }
    const child = sim.core.residents.find((r) => r.child)!;
    expect(sim.inspect(child.id)!.subtitle).toContain('Child');
    const sheep = sim.views.find((v) => v.kind === 'sheep')!;
    const animal = sim.inspect(sheep.id)!;
    expect(animal.title).toBe('Sheep');
    expect(animal.lines.length).toBeGreaterThan(1);
    expect(sim.inspect(999_999)).toBeNull();
    expect(sim.talk(baker.id).length).toBeGreaterThan(3);
    expect(sim.talk(child.id).length).toBeGreaterThan(3);
    expect(sim.talk(999_999)).toBe('');
  });

  it('gives the ledger as plain data covering every economy good', () => {
    const h = createHeadlessVillage(3);
    h.step(HOUR * 30);
    const ledger = h.sim.ledger();
    expect(ledger.goods.map((g) => g.good)).toEqual([...ECONOMY_GOODS]);
    for (const g of ledger.goods) {
      expect(g.price).toBeGreaterThan(0);
      expect(g.stock).toBeGreaterThanOrEqual(0);
      expect(g.history.length).toBeGreaterThanOrEqual(2);
      expect(g.history[g.history.length - 1]).toBe(g.price);
    }
    expect(ledger.goods.find((g) => g.good === 'bread')!.stock).toBeGreaterThan(20);
    expect(ledger.population).toBe(h.sim.core.residents.length);
    expect(ledger.coin).toBe(ledger.purses + ledger.tills + ledger.treasury);
    expect(ledger.day).toBe(1);
    expect(JSON.parse(JSON.stringify(ledger))).toEqual(ledger);
  });

  it('trades with the player at posted prices and accounts for every coin', () => {
    const h = createHeadlessVillage(3);
    h.step(HOUR * 4);
    const { sim } = h;
    const econ = sim.economy;
    const before = sim.ledger();
    const stockBefore = econ.villageStock(G.bread);

    const quote = sim.quoteBuy('bread', 3)!;
    expect(Number.isInteger(quote)).toBe(true);
    expect(quote).toBeGreaterThan(0);
    const bought = sim.buy('bread', 3);
    expect(bought).toEqual({ ok: true, coins: quote });
    expect(econ.villageStock(G.bread)).toBe(stockBefore - 3);
    let ledger = sim.ledger();
    expect(ledger.coin).toBe(before.coin + quote);
    expect(ledger.playerNet).toBe(quote);

    // A big order costs more per loaf than a small one, and leaves bread dearer.
    const small = sim.quoteBuy('bread', 2)!;
    const large = sim.quoteBuy('bread', 20)!;
    expect(large / 20).toBeGreaterThan((small / 2) * 0.999);
    expect(sim.buy('bread', 20).ok).toBe(true);
    expect(sim.quoteBuy('bread', 2)!).toBeGreaterThanOrEqual(small);

    const wheatBefore = econ.villageStock(G.wheat);
    const offer = sim.quoteSell('wheat', 5)!;
    expect(Number.isInteger(offer)).toBe(true);
    expect(offer).toBeGreaterThanOrEqual(0);
    expect(sim.sell('wheat', 5)).toEqual({ ok: true, coins: offer });
    expect(econ.villageStock(G.wheat)).toBe(wheatBefore + 5);
    // Selling back is never a way to make money out of nothing.
    expect(sim.quoteSell('bread', 3)!).toBeLessThan(sim.quoteBuy('bread', 3)!);

    ledger = sim.ledger();
    expect(ledger.coin - ledger.playerNet).toBe(before.coin);

    for (const [good, qty] of [['bread', 0], ['bread', -2], ['bread', 1.5], ['bread', 100000], ['dragon', 1]] as const) {
      expect(sim.quoteBuy(good, qty), `${good} x ${qty}`).toBeNull();
      expect(sim.buy(good, qty)).toEqual({ ok: false, coins: 0 });
    }
    expect(sim.quoteSell('dragon', 1)).toBeNull();
    expect(sim.sell('wheat', 0)).toEqual({ ok: false, coins: 0 });
    // Nobody will take a mountain of stone, and nobody can pay for one.
    expect(sim.quoteSell('stone', 5000)).toBeNull();
    const after = sim.ledger();
    expect(after.coin - after.playerNet).toBe(before.coin);

    // The village goes on trading with itself and the books still balance.
    h.step(HOUR * 20);
    const later = sim.ledger();
    expect(later.coin - later.playerNet).toBe(before.coin);
  });

  it('lets the player trade with a seller at the counter or a stall, and not with someone asleep', () => {
    const h = createHeadlessVillage(3);
    const { sim, clock } = h;
    const core = sim.core;
    let atCounter = false;
    for (let i = 0; i < 40 && !atCounter; i++) {
      h.step(HOUR / 4);
      for (const r of core.residents) {
        if (!sim.canTrade(r.id)) continue;
        atCounter = true;
        expect(r.job).not.toBeNull();
        const b = r.job!.site.b;
        // Selling means standing at the business's own counter or work spot.
        expect(b.work.some((w) => w.stand.x === Math.floor(r.view.x) && w.stand.z === Math.floor(r.view.z))).toBe(true);
      }
    }
    expect(atCounter).toBe(true);
    h.runTo(1, 2);
    expect(core.residents.filter((r) => sim.canTrade(r.id))).toEqual([]);
    expect(sim.canTrade(999_999)).toBe(false);
    expect(clock.day).toBe(1);

    // Fairday in a village started that morning, under a clear sky: the stalls are manned and the square is busy.
    const fair = createHeadlessVillage(3, { startDay: FAIR_DAY });
    fair.weather.force('clear');
    fair.runTo(FAIR_DAY, 11);
    expect(fair.clock.isFairDay).toBe(true);
    const people = fair.sim.core.residents;
    const sellers = people.filter((r) => fair.sim.canTrade(r.id) && r.job?.stall && Math.floor(r.view.x) === r.job.stall.stand.x && Math.floor(r.view.z) === r.job.stall.stand.z);
    expect(sellers.length).toBeGreaterThanOrEqual(4);
    const onSquare = people.filter((r) => Math.abs(r.view.x - 64) < 9 && Math.abs(r.view.z - 64) < 9);
    expect(onSquare.length).toBeGreaterThan(20);
    // Fairday shopping is done at the stalls.
    fair.runTo(FAIR_DAY, 13);
    expect(fair.sim.stats.purchases).toBeGreaterThan(5);
  });

  it('serves predators through the livestock api', () => {
    const h = createHeadlessVillage(3);
    h.step(HOUR);
    const { sim, plan } = h;
    const pen = plan.pens.find((p) => p.animal === 'chicken')!;
    const hen = sim.livestock.findLivestock(pen.x0 + 2, pen.z0 + 1, 6)!;
    expect(hen.kind).toBe('chicken');
    expect(sim.livestock.findLivestock(2, 2, 3)).toBeNull();
    // Asked for one kind only, it looks past nearer animals of another kind. Called on the class, because the contract
    // this was written against had no fourth argument yet.
    const herd = sim.livestock as Livestock;
    expect(herd.findLivestock(pen.x0 + 2, pen.z0 + 1, 200, ['sheep'])?.kind).toBe('sheep');
    expect(herd.findLivestock(pen.x0 + 2, pen.z0 + 1, 200, ['chicken'])?.id).toBe(hen.id);
    expect(herd.findLivestock(pen.x0 + 2, pen.z0 + 1, 200, [])).toBeNull();
    const count = sim.views.length;
    sim.livestock.killLivestock(hen.id);
    expect(sim.views.length).toBe(count - 1);
    expect(sim.views.includes(hen)).toBe(false);
    expect(sim.livestock.findLivestock(pen.x0 + 2, pen.z0 + 1, 6)?.id).not.toBe(hen.id);
    sim.livestock.killLivestock(hen.id);
    expect(sim.views.length).toBe(count - 1);
    h.step(HOUR * 2);
  });

  it('fishes and hunts through the wildlife api when there is one', () => {
    let casts = 0;
    let caught = 0;
    let killed = 0;
    let nextId = 100_000;
    let deer: EntityView | null = null;
    const wildlife: WildlifeApi = {
      findAnimal(x, z, radius, kinds) {
        if (!kinds.includes('deer')) return null;
        deer ??= { id: nextId++, kind: 'deer', look: 0, role: 0, x: 104.5, y: 32, z: 100.5, yaw: 0, anim: 'idle', animTime: 0, scale: 1, held: -1, bubble: '' };
        return Math.hypot(deer.x - x, deer.z - z) <= radius ? deer : null;
      },
      harvest(id) {
        if (!deer || deer.id !== id) return null;
        deer = null;
        killed++;
        return { meat: 3, hide: 1 };
      },
      fishAbundance: () => 0.8,
      catchFish() {
        casts++;
        if (casts % 2 === 0) return false;
        caught++;
        return true;
      },
    };
    const h = createHeadlessVillage(3, { wildlife });
    // A fair day, whatever the seed's weather would have been: nobody fishes or hunts in the rain.
    h.weather.force('clear');
    const { sim } = h;
    const hunter = sim.core.businesses.find((b) => b.site.b.kind === 'hunter')!;
    const meat = hunter.stock[G.meat]!;
    h.runTo(0, 18.5);
    expect(casts).toBeGreaterThan(4);
    expect(sim.stats.fishCaught).toBe(caught);
    expect(killed).toBeGreaterThan(0);
    expect(sim.stats.animalsHunted).toBe(killed);
    const carried = sim.core.residents.filter((r) => r.job === hunter).reduce((n, r) => n + r.pack[G.meat]!, 0);
    expect(hunter.stock[G.meat]! + carried + sim.economy.villageStock(G.meat)).toBeGreaterThan(meat);
    expect(sim.economy.produced[G.meat]).toBe(killed * 3);
  });

  it('falls back to plain luck for fishing and hunting without wildlife', () => {
    const h = createHeadlessVillage(5);
    h.weather.force('clear');
    h.runTo(1, 17);
    expect(h.sim.stats.fishCaught).toBeGreaterThan(3);
    expect(h.sim.stats.animalsHunted).toBeGreaterThan(0);
  });

  it('stops outdoor work when it rains and takes shelter, then goes back out', () => {
    // A summer weekday, warm enough that what falls is rain and not snow.
    const h = createHeadlessVillage(3, { startDay: 8 });
    const { sim, world, weather, plan } = h;
    const core = sim.core;
    weather.force('clear');
    // Mid-morning: sowing, felling, fishing and the flock at grass.
    h.runTo(8, 9.5);
    const outdoorTrades = new Set<number>([TRADE.farmer, TRADE.woodcutter, TRADE.fisher, TRADE.hunter, TRADE.shepherd]);
    const outdoor = core.residents.filter((r) => outdoorTrades.has(r.trade));
    const exposed = (): string[] => outdoor.filter((r) => world.exposed(Math.floor(r.view.x), Math.floor(r.view.y + 0.07) + 1, Math.floor(r.view.z)))
      .map((r) => `${r.name} (${PROFESSIONS[r.trade]}): ${r.activity} at ${r.view.x.toFixed(1)},${r.view.z.toFixed(1)}`);
    expect(exposed().length).toBeGreaterThan(outdoor.length * 0.6);
    const sheepPen = core.pens.find((p) => p.pen.animal === 'sheep')!;
    expect(sheepPen.flock).not.toBe(FLOCK_PENNED);

    // A downpour, at once.
    weather.force('storm');
    weather.cloudCover = 1;
    weather.precipitation = 0.9;
    h.step(HOUR * 1.25);
    expect(weather.isRaining).toBe(true);
    expect(exposed()).toEqual([]);
    expect(sheepPen.flock).toBe(FLOCK_PENNED);
    for (const a of sheepPen.animals) {
      expect(a.view.x).toBeGreaterThanOrEqual(sheepPen.pen.x0);
      expect(a.view.x).toBeLessThanOrEqual(sheepPen.pen.x1 + 1);
    }
    // The watch keeps its post whatever the weather; everyone else is under a roof, bar the odd one crossing the street.
    const outside = core.residents.filter((r) => r.trade !== TRADE.guard && world.exposed(Math.floor(r.view.x), Math.floor(r.view.y + 0.07) + 1, Math.floor(r.view.z)))
      .map((r) => `${r.name} (${PROFESSIONS[r.trade]}): ${r.activity} at ${r.view.x.toFixed(1)},${r.view.z.toFixed(1)}`);
    expect(outside.length, outside.join('; ')).toBeLessThanOrEqual(3);
    let wet = 0;
    let cells = 0;
    for (const f of plan.fields) {
      for (let z = f.z0; z <= f.z1; z++) for (let x = f.x0; x <= f.x1; x++, cells++) if (world.get(x, f.y, z) === B.farmland + 1) wet++;
    }
    expect(wet).toBe(cells);

    // It clears, and within the hour or two people and sheep are out again.
    weather.force('clear');
    weather.cloudCover = 0;
    weather.precipitation = 0;
    let mostOut = 0;
    let flockOut = false;
    for (let i = 0; i < 12; i++) {
      h.step(HOUR / 6);
      mostOut = Math.max(mostOut, exposed().length);
      if (sheepPen.flock !== FLOCK_PENNED) flockOut = true;
    }
    expect(mostOut).toBeGreaterThan(outdoor.length * 0.4);
    expect(flockOut).toBe(true);
  });

  it('survives the clock being set forward, and backward', () => {
    const h = createHeadlessVillage(3);
    const { sim, clock } = h;
    h.step(HOUR * 5);
    const coin = sim.ledger().coin;
    clock.time += 3 * DAY_SECONDS + 7 * 60;
    h.step(HOUR * 2);
    clock.time -= 5 * DAY_SECONDS;
    h.step(HOUR * 2);
    expect(sim.ledger().coin).toBe(coin);
    // Everyone is still doing something sensible: by the small hours they are in bed.
    h.runTo(clock.day + 1, 2);
    const asleep = sim.core.residents.filter((r) => r.view.anim === 'sleep').length;
    expect(asleep).toBeGreaterThan(sim.core.residents.length * 0.85);
    expect(sim.stats.teleports).toBe(0);
  });

  it('reproduces the same village from the same seed', () => {
    const a = createHeadlessVillage(77);
    const b = createHeadlessVillage(77);
    const c = createHeadlessVillage(78);
    for (const h of [a, b, c]) h.step(TICKS_PER_DAY * 1.5);
    const fa = fingerprint(a);
    expect(fa.length).toBeGreaterThan(1500);
    expect(fingerprint(b)).toEqual(fa);
    expect(fingerprint(c)).not.toEqual(fa);
    // Asking a villager to talk draws on the wording stream only: the village's future is unchanged.
    for (const r of a.sim.core.residents) a.sim.talk(r.id);
    a.sim.inspect(a.sim.core.residents[0]!.id);
    a.sim.ledger();
    a.step(HOUR * 6);
    b.step(HOUR * 6);
    expect(fingerprint(a, false)).toEqual(fingerprint(b, false));
  });
});
