// Errands that do not go to plan: a purse too light for anything on the
// shelves, a larder found bare by someone who has only just come in from
// another job, and a shopping errand that comes to nothing in the middle of an
// evening at the tavern. Each is staged in the fixture village and then left to
// run, and judged by what the people do.

import { describe, expect, it } from 'vitest';
import { packCell } from '../nav';
import { interrupt } from './agent';
import { richest } from './economy';
import { FOOD_GOODS, G, ITEM_ID, TRADE } from './goods';
import { createHeadlessVillage } from './headless';
import { type Household, MEAL_SUPPER, type Resident } from './model';
import { HUNGER_URGENT, foodIn, larderFood } from './needs';

function bare(home: Household): void {
  for (const g of FOOD_GOODS) home.larder[g] = 0;
  home.plate = 0;
}

describe('errands that do not go to plan', () => {
  it('feeds an adult whose purse covers nothing on any shelf, and leaves the counters to those who can pay', () => {
    const h = createHeadlessVillage(3);
    const { sim } = h;
    const core = sim.core;
    const econ = sim.economy;
    h.runTo(0, 9);
    const houses = core.households.filter((home) => home.site.b.kind === 'house' && home.members.filter((m) => !m.child).length >= 2);
    const poorHome = houses[0] as Household;
    const payingHome = houses[1] as Household;
    const poor = poorHome.members.filter((m) => !m.child);
    const paying = payingHome.members.filter((m) => !m.child);
    // Two households with nothing to eat and adults who cannot wait: one with a coin apiece, one with full purses.
    for (const home of [poorHome, payingHome]) bare(home);
    for (const p of poor) econ.pay(p, core.treasury, p.coin - 1);
    for (const q of paying) expect(q.coin).toBeGreaterThan(30);
    for (const r of [...poor, ...paying]) {
      r.hunger = 0.8;
      interrupt(core, r);
    }
    // One coin buys nothing to eat anywhere in the village.
    let shelves = 0;
    for (const b of core.businesses) {
      for (const g of FOOD_GOODS) {
        if (!b.sells[g] || b.stock[g]! <= 0) continue;
        shelves++;
        expect(econ.cost(b.price[g]!, 1)).toBeGreaterThan(1);
      }
    }
    expect(shelves).toBeGreaterThan(5);

    const counters = core.businesses.map((b) => packCell(b.site.customer.x, b.site.customer.y, b.site.customer.z));
    const heldBy = new Map<number, { id: number; ticks: number }>();
    let longestHold = 0;
    let fruitless = 0;
    const atCounter = new Map<number, boolean>();
    const alms = sim.stats.almsMeals + sim.stats.foraged;
    const purchases = sim.stats.purchases;
    for (let tick = 0; tick < 1800; tick++) {
      h.step(1);
      for (const key of counters) {
        const holder = core.places.get(key);
        const was = heldBy.get(key);
        if (holder === undefined) heldBy.delete(key);
        else if (was && was.id === holder) longestHold = Math.max(longestHold, ++was.ticks);
        else heldBy.set(key, { id: holder, ticks: 1 });
      }
      for (const p of poor) {
        const talking = p.view.anim === 'talk' && p.activity.startsWith('Shopping at');
        if (talking && !atCounter.get(p.id)) fruitless++;
        atCounter.set(p.id, talking);
      }
    }
    // Nobody stood at a counter to buy what they could not pay for, and no counter was kept from the next customer:
    // a purchase is a few seconds' talk.
    expect(fruitless).toBe(0);
    expect(longestHold / 10).toBeLessThan(30);
    // The poor were given a meal, or found one, and the money they had is still theirs.
    expect(sim.stats.almsMeals + sim.stats.foraged - alms).toBeGreaterThanOrEqual(poor.length);
    for (const p of poor) {
      expect(p.hunger, p.name).toBeLessThan(HUNGER_URGENT);
      expect(p.coin).toBe(1);
    }
    // Those who could pay bought, and ate.
    expect(sim.stats.purchases - purchases).toBeGreaterThanOrEqual(1);
    expect(larderFood(payingHome) + paying.reduce((n, q) => n + foodIn(q.pack), 0)).toBeGreaterThan(0);
    for (const q of paying) expect(q.hunger, q.name).toBeLessThan(HUNGER_URGENT);
  });

  it('lets a farmer just in from gathering firewood go and buy food when the larder is bare', () => {
    // A winter Moonday: nothing to do in the fields, so the farmers see to the yard and bring in firewood, a load
    // at a time with a rest of two hours between. The woodpiles are kept low, so that goes on all day.
    const h = createHeadlessVillage(3, { startDay: 21 });
    h.weather.force('clear');
    const { sim, clock } = h;
    const core = sim.core;
    const farmers = core.residents.filter((r) => r.trade === TRADE.farmer);
    expect(farmers.length).toBeGreaterThan(3);
    const step = (until: number, each: (f: Resident) => void): void => {
      while (clock.hour < until) {
        for (const f of farmers) f.home.larder[G.firewood] = Math.min(f.home.larder[G.firewood]!, 2);
        h.step(1);
        for (const f of farmers) each(f);
      }
    };
    step(10.75, () => {});
    // From a quarter to eleven every farmer's larder is bare, and every farmer has money.
    const purse = new Map<number, number>();
    for (const f of farmers) {
      bare(f.home);
      if (f.coin < 30) sim.economy.pay(core.treasury, f, 30 - f.coin);
      purse.set(f.id, f.coin);
    }
    // Whoever brings a load in between then and one o'clock is resting from that job when the midday meal comes
    // round. (A load is in when the gathering stops; the weather is fine all day, so nothing else stops it.)
    const loadIn = new Map<number, number>();
    const gathering = new Map<number, boolean>();
    const shopped = new Set<number>();
    step(13.75, (f) => {
      const now = f.activity === 'Gathering firewood' && f.view.anim === 'work';
      if (gathering.get(f.id) && !now && clock.hour < 13) loadIn.set(f.id, clock.hour);
      gathering.set(f.id, now);
      if (loadIn.has(f.id) && f.activity.startsWith('Shopping at')) shopped.add(f.id);
    });
    const rested = farmers.filter((f) => loadIn.has(f.id));
    expect(rested.length).toBeGreaterThanOrEqual(3);
    // Resting from one job is no reason to go without the other: each of them set off for the shops. (From the
    // far farms the walk and the queue can outlast the meal hour, so not every one has bought by the end of it;
    // those who have, paid, and there is food in the house or on its way there.)
    for (const f of rested) expect(shopped.has(f.id), `${f.name}, load in at ${loadIn.get(f.id)!.toFixed(2)}`).toBe(true);
    const bought = rested.filter((f) => f.coin < purse.get(f.id)!);
    expect(bought.length).toBeGreaterThan(0);
    for (const f of bought) expect(larderFood(f.home) + foodIn(f.pack), f.name).toBeGreaterThan(0);
  });

  it('leaves a drinker at the tavern with the one mug when a shopping errand comes to nothing', () => {
    const h = createHeadlessVillage(3);
    const { sim, clock } = h;
    const core = sim.core;
    const econ = sim.economy;
    const tavern = core.businesses.find((b) => b.site.b.kind === 'tavern')!;
    const door = tavern.site.b.entry;
    const ale = ITEM_ID[G.ale]!;
    h.runTo(0, 18.75);
    // Whoever is nearest the tavern with supper eaten and the evening free is sent there, with a larder that wants
    // for nothing and a purse that runs to one mug and no more.
    const free = core.residents.filter((r) => !r.child && r.job !== null && r.job.spec.float > 0 && r.trade !== TRADE.innkeeper && r.trade !== TRADE.baker
      && (r.meals & MEAL_SUPPER) !== 0 && r.home.site !== tavern.site && r.packCount === 0 && !r.asleep);
    const far = (r: Resident): number => Math.abs(r.view.x - door.x) + Math.abs(r.view.z - door.z);
    const a = free.sort((p, q) => far(p) - far(q) || p.id - q.id)[0]!;
    expect(a).toBeDefined();
    const home = a.home;
    home.larder[G.bread] = 60;
    home.larder[G.firewood] = 10;
    home.larder[G.cloth] = 2;
    home.larder[G.tools] = 1;
    for (const m of home.members) if (!m.child && m.coin > 5) econ.pay(m, core.treasury, m.coin - 5);
    econ.pay(core.treasury, a, 15);
    expect(richest(home.members)).toBe(a);
    home.waterDay = clock.day;
    home.shopDay = clock.day;
    a.evening = 1;
    interrupt(core, a);
    while (clock.hour < 19.8 && a.view.held !== ale) h.step(1);
    expect(a.view.held).toBe(ale);
    expect(a.activity).toBe(`Drinking at ${tavern.site.b.name}`);
    const afterTheMug = a.coin;
    expect(afterTheMug).toBeLessThan(20);
    expect(afterTheMug).toBeGreaterThan(5);

    // Now the household finds it wants a tool, and there is not one to be had in the village: an errand for the
    // one with the fullest purse, and nowhere to go on it.
    home.larder[G.tools] = 0;
    home.toolWear = 0.6;
    for (const b of core.businesses) b.stock[G.tools] = 0;
    home.shopDay = -1;
    expect(clock.hour).toBeLessThan(19.9);
    interrupt(core, a);
    const b = tavern.site.b;
    const seen = new Set<string>();
    let outside = 0;
    // Watched for an hour and a quarter: long enough for three sittings, and over before anyone is ready for bed.
    while (clock.hour < 20.3) {
      h.step(1);
      seen.add(a.activity);
      if (a.view.x < b.x0 || a.view.x > b.x1 + 1 || a.view.z < b.z0 || a.view.z > b.z1 + 1) outside++;
    }
    // The errand was looked at and dropped (the household's shopping is marked done for the day), and the
    // evening went on where it was: no walk to some counter, and no second mug paid for.
    expect(home.shopDay).toBe(clock.day);
    expect([...seen].filter((s) => s.startsWith('Shopping'))).toEqual([]);
    expect([...seen]).toContain(`Drinking at ${b.name}`);
    expect(outside).toBe(0);
    expect(a.coin).toBe(afterTheMug);
  });
});
