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

/** Coin the village holds, less what the player has put in: constant if no coin is made or lost. */
const closed = (v: ReturnType<typeof createHeadlessVillage>): number => {
  const l = v.sim.ledger();
  return l.coin - l.playerNet;
};

describe('trading with the village', () => {
  it('moves goods and coin both ways and loses none', () => {
    const { trade, inv, village } = market(200);
    const bread = item('bread').id;
    const before = closed(village);
    const stock = village.sim.ledger().goods.find((g) => g.good === 'bread')!.stock;
    const price = village.sim.quoteBuy('bread', 3);
    expect(price).not.toBeNull();

    expect(trade.buy('bread', 3)).toBe(true);
    expect(inv.count(bread)).toBe(3);
    expect(inv.coins).toBe(200 - (price as number));
    expect(village.sim.ledger().goods.find((g) => g.good === 'bread')!.stock).toBe(stock - 3);
    expect(closed(village)).toBe(before);

    // Selling straight back fetches less than was paid: the village buys below its own asking price.
    const offer = village.sim.quoteSell('bread', 3);
    expect(offer).not.toBeNull();
    expect(offer as number).toBeLessThan(price as number);
    expect(trade.sell('bread', 3)).toBe(true);
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

  it('hands over what does not fit in the pack instead of losing it', () => {
    const { trade, inv, dropped } = market(500);
    const stone = item('stone').id;
    // Fill every slot but leave room for one more loaf in a stack.
    for (let i = 0; i < SLOTS; i++) inv.slots[i] = { item: stone, count: 99 };
    inv.slots[0] = { item: item('bread').id, count: 98 };
    expect(trade.buy('bread', 3)).toBe(true);
    expect(inv.count(item('bread').id)).toBe(99);
    expect(dropped).toEqual([[item('bread').id, 2]]);
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
