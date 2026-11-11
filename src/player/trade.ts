// The player's side of a trade with the village. The village moves its own
// stock and coin (`VillageSim.buy` and `sell`); this moves the player's, and
// refuses a deal the player cannot complete, so goods and coin are never
// created or lost between the two.

import type { VillageSim } from '../sim/village';
import { ECONOMY_GOODS, item } from '../world/items';
import type { Inventory } from './inventory';

export interface Offer {
  good: string;
  label: string;
  item: number;
  /** Coins for one unit bought from the village, or null if it has none to sell. */
  buy: number | null;
  /** Coins the village pays for one unit, or null if nobody wants it. */
  sell: number | null;
  /** How many the player is carrying. */
  have: number;
}

export class Trade {
  /** The villager the player is dealing with, or -1. */
  partner = -1;
  /** What happened last, for the trade window to show. */
  note = '';

  private readonly village: VillageSim;
  private readonly inv: Inventory;
  /** Called with what the player bought but could not carry, so it can be put on the ground. */
  private readonly overflow: (item: number, count: number) => void;

  constructor(village: VillageSim, inv: Inventory, overflow: (item: number, count: number) => void) {
    this.village = village;
    this.inv = inv;
    this.overflow = overflow;
  }

  /** True while the partner is still at their counter or stall. */
  get open(): boolean {
    return this.partner >= 0 && this.village.canTrade(this.partner);
  }

  begin(villager: number): void {
    this.partner = villager;
    this.note = '';
  }

  end(): void {
    this.partner = -1;
  }

  /** Every good, with today's price each way for a single unit. */
  offers(): Offer[] {
    return ECONOMY_GOODS.map((good) => {
      const def = item(good);
      return { good, label: def.label, item: def.id, buy: this.village.quoteBuy(good, 1), sell: this.village.quoteSell(good, 1), have: this.inv.count(def.id) };
    });
  }

  /** Buy `qty` of a good at the village's price for that many. Returns whether the deal went through; `note` says why not. */
  buy(good: string, qty: number): boolean {
    if (!this.open) return this.fail('The seller has left the counter.');
    const cost = this.village.quoteBuy(good, qty);
    if (cost === null) return this.fail('There is not that much to be had.');
    if (cost > this.inv.coins) return this.fail(`That comes to ${cost} coins, and you have ${this.inv.coins}.`);
    const deal = this.village.buy(good, qty);
    if (!deal.ok) return this.fail('There is not that much to be had.');
    this.inv.coins -= deal.coins;
    const def = item(good);
    const left = this.inv.add(def.id, qty);
    if (left > 0) this.overflow(def.id, left);
    this.note = `Bought ${qty} ${def.label.toLowerCase()} for ${deal.coins} coins.`;
    return true;
  }

  /** Sell `qty` of a good from the pack. */
  sell(good: string, qty: number): boolean {
    if (!this.open) return this.fail('The seller has left the counter.');
    const def = item(good);
    if (this.inv.count(def.id) < qty) return this.fail(`You are not carrying ${qty}.`);
    const pay = this.village.quoteSell(good, qty);
    if (pay === null) return this.fail('Nobody here will take that many.');
    const deal = this.village.sell(good, qty);
    if (!deal.ok) return this.fail('Nobody here will take that many.');
    this.inv.remove(def.id, qty);
    this.inv.coins += deal.coins;
    this.inv.version++;
    this.note = `Sold ${qty} ${def.label.toLowerCase()} for ${deal.coins} coins.`;
    return true;
  }

  private fail(why: string): boolean {
    this.note = why;
    return false;
  }
}
