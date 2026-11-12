import { describe, expect, it } from 'vitest';
import { FAIR_DAY } from '../sim/clock';
import { createHeadlessVillage } from '../sim/village/headless';
import { item } from '../world/items';
import { Inventory, SLOTS } from './inventory';
import { Trade } from './trade';

// One village for the whole file, brought to fair day late in the morning: running four days of
// village life once is enough. The tests run in order, and the last one moves the clock on.
let shared: ReturnType<typeof createHeadlessVillage> | null = null;

/** The village with someone serving, and a player with an empty pack and this many coins. */
function market(coins: number): { trade: Trade; inv: Inventory; dropped: [number, number][]; village: ReturnType<typeof createHeadlessVillage> } {
  if (!shared) {
    shared = createHeadlessVillage(5, { startHour: 6.5, startDay: 0 });
    shared.runTo(FAIR_DAY, 11);
  }
  const village = shared;
  const inv = new Inventory();
  inv.coins = coins;
  const dropped: [number, number][] = [];
  const trade = new Trade(village.sim, inv, (id, n) => dropped.push([id, n]));
  const seller = village.sim.people.find((p) => village.sim.canTrade(p.id));
  if (!seller) throw new Error('nobody is serving on fair day at eleven');
  trade.begin(seller.id);
  return { trade, inv, dropped, village };
}

/**
 * Something to eat that the shelves hold at least three of right now. Which it is depends on the hour: at
 * eleven on fair day the bread may be down to a loaf or two on the stalls while the larders are full, and
 * these tests are about buying and selling, not about bread.
 */
function onTheShelves(village: ReturnType<typeof createHeadlessVillage>): string {
  const good = ['bread', 'turnip', 'cabbage', 'fish', 'egg', 'ale', 'flour', 'wheat'].find((g) => village.sim.quoteBuy(g, 3) !== null);
  if (!good) throw new Error('the village has three of nothing to sell on fair day');
  return good;
}

/** Coin the village holds, less what the player has put in: constant if no coin is made or lost. */
const closed = (v: ReturnType<typeof createHeadlessVillage>): number => {
  const l = v.sim.ledger();
  return l.coin - l.playerNet;
};

describe('trading with the village', () => {
  it('moves goods and coin both ways and loses none', () => {
    const { trade, inv, village } = market(200);
    const good = onTheShelves(village);
    const bread = item(good).id;
    const before = closed(village);
    const stock = village.sim.ledger().goods.find((g) => g.good === good)!.stock;
    const price = village.sim.quoteBuy(good, 3);
    expect(price).not.toBeNull();

    expect(trade.buy(good, 3)).toBe(true);
    expect(inv.count(bread)).toBe(3);
    expect(inv.coins).toBe(200 - (price as number));
    expect(village.sim.ledger().goods.find((g) => g.good === good)!.stock).toBe(stock - 3);
    expect(closed(village)).toBe(before);

    // Selling straight back fetches less than was paid: the village buys below its own asking price.
    const offer = village.sim.quoteSell(good, 3);
    expect(offer).not.toBeNull();
    expect(offer as number).toBeLessThan(price as number);
    expect(trade.sell(good, 3)).toBe(true);
    expect(inv.count(bread)).toBe(0);
    expect(inv.coins).toBe(200 - (price as number) + (offer as number));
    expect(closed(village)).toBe(before);
  });

  it('refuses what the player cannot pay for or does not have, and changes nothing', () => {
    const { trade, inv, village } = market(1);
    const before = closed(village);
    const ledger = JSON.stringify(village.sim.ledger());
    expect(trade.buy('tools', 1)).toBe(false);
    expect(trade.note).toMatch(/coins/);
    expect(trade.sell('wool', 2)).toBe(false);
    expect(trade.buy('bread', 100000)).toBe(false);
    expect(trade.buy('bread', 0)).toBe(false);
    expect(inv.coins).toBe(1);
    expect(inv.slots.every((s) => s === null)).toBe(true);
    expect(closed(village)).toBe(before);
    expect(JSON.stringify(village.sim.ledger())).toBe(ledger);
  });

  it('gives nothing for a lot not worth a coin, says so, and takes a handful of the same good', () => {
    const { trade, inv, village } = market(0);
    // The cheapest good the village will buy at all: one of it is worth less than a coin, a handful is not.
    const cheap = ['stone', 'firewood', 'oak_log', 'wheat'].find((g) => village.sim.quoteSell(g, 1) === null && village.sim.quoteSell(g, 20) !== null);
    expect(cheap, 'a good too cheap to sell singly').toBeDefined();
    const id = item(cheap as string).id;
    inv.add(id, 20);
    const before = closed(village);
    expect(trade.sell(cheap as string, 1)).toBe(false);
    expect(trade.note).toMatch(/worth less than a coin/);
    expect(inv.count(id)).toBe(20);
    expect(inv.coins).toBe(0);
    const offer = village.sim.quoteSell(cheap as string, 20) as number;
    expect(offer).toBeGreaterThanOrEqual(1);
    expect(trade.sell(cheap as string, 20)).toBe(true);
    expect(inv.count(id)).toBe(0);
    expect(inv.coins).toBe(offer);
    expect(closed(village)).toBe(before);
  });

  it('hands over what does not fit in the pack instead of losing it', () => {
    const { trade, inv, dropped, village } = market(500);
    const good = onTheShelves(village);
    const stone = item('stone').id;
    // Fill every slot but leave room for one more of it in a stack.
    for (let i = 0; i < SLOTS; i++) inv.slots[i] = { item: stone, count: 99 };
    inv.slots[0] = { item: item(good).id, count: 98 };
    expect(trade.buy(good, 3)).toBe(true);
    expect(inv.count(item(good).id)).toBe(99);
    expect(dropped).toEqual([[item(good).id, 2]]);
  });

  it('stops when the seller leaves the counter', () => {
    const { trade, inv, village } = market(200);
    village.runTo(FAIR_DAY + 1, 2);
    expect(trade.open).toBe(false);
    expect(trade.buy('bread', 1)).toBe(false);
    expect(inv.coins).toBe(200);
    trade.end();
    expect(trade.partner).toBe(-1);
  });
});
