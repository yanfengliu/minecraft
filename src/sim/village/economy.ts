// Money and prices. Every coin lives in a wallet (a resident's purse, a
// business's till or the treasury) and moves only through `pay`, in whole
// coins, so the village's total is invariant apart from what the player brings
// in or takes out, which is counted. Each business posts an asking price per
// good that drifts toward a value set by its stock against its target.

import { clamp } from '../../core/math';
import type { GoodName } from '../../world/items';
import type { Core } from './core';
import { G, GOODS, LABEL, NG, VALUE, goodIndex } from './goods';
import type { Business, Resident } from './model';

export interface Wallet {
  coin: number;
}

/** Share of every sale that goes to the treasury. */
const MARKET_FEE = 0.05;
/** Share of a business's takings above its float that its own workers keep; the rest goes to the common purse. */
const OWN_SHARE = 0.45;
/** Coin the treasury never pays out, so it can always meet a stipend. */
const TREASURY_RESERVE = 150;
/** Share of the treasury's spare coin paid out as the evening dividend. */
const DIVIDEND = 0.9;
/** Coin a day the treasury may spend on materials for upkeep. */
const UPKEEP_BUDGET = 14;
/** Purse below which the treasury's relief tops an adult up. */
const RELIEF_LINE = 12;
/** Purse above which a fifth of the excess is levied each day, so a hoard finds its way back into circulation. */
const HOARD_LINE = 100;
const HOARD_LEVY = 0.2;
/** Bounds on a trade's price multiplier, and the most it moves in one day. */
const MARKUP_MIN = 0.7;
const MARKUP_MAX = 1.4;
const MARKUP_STEP = 0.05;
/** A reseller buys in only at this share of its own asking price or less, so there is a margin in selling on. */
export const RESALE_MARGIN = 0.92;
/** Goods that do not keep. */
const PERISHABLE = new Set([G.bread, G.fish, G.meat, G.egg, G.berries]);
/** Posted prices stay within these multiples of an item's value. */
export const PRICE_MIN = 0.4;
export const PRICE_MAX = 3;
/** What a business pays the player for goods, as a share of its own asking price. */
const BUY_BACK = 0.7;
const HISTORY_DAYS = 14;

export interface LedgerGood {
  good: GoodName;
  label: string;
  /** Lowest asking price among businesses that have it, in coins. */
  price: number;
  /** Units held by businesses and households together. */
  stock: number;
  producedToday: number;
  consumedToday: number;
  /** Closing price of each recent day, oldest first, ending with the current price. */
  history: number[];
}

export interface LedgerView {
  day: number;
  goods: LedgerGood[];
  treasury: number;
  population: number;
  /** Coin in purses, tills and the treasury together. */
  coin: number;
  /** Coin the player has paid in, less coin paid out to the player. `coin - playerNet` never changes. */
  playerNet: number;
  purses: number;
  tills: number;
  /** At the last evening pay: coin paid in wages and stipends, and the dividend each adult had from the common purse. */
  payroll: number;
  dividend: number;
}

export class Economy {
  readonly produced = new Int32Array(NG);
  readonly consumed = new Int32Array(NG);
  playerPaidIn = 0;
  playerPaidOut = 0;
  /** Coin handed out in wages and stipends at the last pay time, and the dividend each adult then had. */
  lastPayroll = 0;
  lastDividend = 0;
  /** Units of goods spoiled or thrown out since the start. */
  spoiled = 0;
  private readonly history: number[][] = GOODS.map(() => []);
  private readonly core: Core;

  constructor(core: Core) {
    this.core = core;
  }

  // --- money -----------------------------------------------------------------

  /** Move whole coins between wallets. The only place a balance changes. */
  pay(from: Wallet, to: Wallet, amount: number): void {
    if (amount <= 0) return;
    if (!Number.isInteger(amount) || from.coin < amount) throw new Error(`bad payment of ${amount} from a wallet holding ${from.coin}`);
    from.coin -= amount;
    to.coin += amount;
  }

  /** Coins for `qty` units at a posted price: whole coins, and never free. */
  cost(price: number, qty: number): number {
    return qty <= 0 ? 0 : Math.max(1, Math.round(price * qty));
  }

  totalCoin(): number {
    let sum = this.core.treasury.coin;
    for (const r of this.core.residents) sum += r.coin;
    for (const b of this.core.businesses) sum += b.coin;
    return sum;
  }

  // --- prices ----------------------------------------------------------------

  /** Where a business's price for a good is heading, given a stock level. */
  wanted(b: Business, g: number, stock: number = b.stock[g] as number): number {
    const target = b.target[g] as number;
    const value = VALUE[g] as number;
    if (target <= 0) return value;
    let price = value * b.markup * Math.pow(2, (target - stock) / target);
    // Never below what its materials cost, plus a margin: a maker passes dear inputs on rather than working at a loss.
    const floor = this.unitCost(b, g);
    if (floor > 0) price = Math.max(price, floor);
    return clamp(price, value * PRICE_MIN, value * PRICE_MAX);
  }

  private unitCost(b: Business, g: number): number {
    // By the cheapest way the business has of making it (cloth from hides when wool is dear).
    let best = Infinity;
    for (const rec of b.spec.recipes) {
      const out = rec.output.find((o) => o[0] === g);
      if (!out) continue;
      let cost = 0;
      for (const [input, n] of rec.input) cost += (b.paid[input] as number) * n;
      best = Math.min(best, (cost / out[1]) * 1.15);
    }
    return best < Infinity ? best : 0;
  }

  /** Ease every posted price a step toward where it is heading. Called once a simulated hour. */
  updatePrices(): void {
    for (const b of this.core.businesses) {
      for (let g = 0; g < NG; g++) {
        if ((b.target[g] as number) <= 0) continue;
        const price = b.price[g] as number;
        b.price[g] = price + (this.wanted(b, g) - price) * 0.2;
      }
    }
  }

  /** The village's going price for a good: the cheapest seller with stock, or failing that the cheapest posted. */
  marketPrice(g: number): number {
    let best = Infinity;
    let posted = Infinity;
    for (const b of this.core.businesses) {
      if (!b.sells[g]) continue;
      const price = b.price[g] as number;
      if (price < posted) posted = price;
      if ((b.stock[g] as number) > 0 && price < best) best = price;
    }
    return best < Infinity ? best : posted < Infinity ? posted : (VALUE[g] as number);
  }

  /** The seller of a good with stock and the lowest price, or null. */
  cheapestSeller(g: number): Business | null {
    let best: Business | null = null;
    for (const b of this.core.businesses) {
      if (!b.sells[g] || (b.stock[g] as number) <= 0) continue;
      if (!best || (b.price[g] as number) < (best.price[g] as number)) best = b;
    }
    return best;
  }

  // --- trade between villagers -----------------------------------------------

  /**
   * Sell up to `qty` units of a good from a business to a buyer at the posted
   * price, as many as the stock and the buyer's coin allow. The fee goes to the
   * treasury. Returns the units sold; the caller puts them where they belong.
   */
  sell(seller: Business, g: number, qty: number, buyer: Wallet): number {
    const price = seller.price[g] as number;
    let n = Math.min(qty, seller.stock[g] as number, Math.floor((buyer.coin + 0.5) / price));
    while (n > 0 && this.cost(price, n) > buyer.coin) n--;
    if (n <= 0) return 0;
    const total = this.cost(price, n);
    const fee = Math.floor(total * MARKET_FEE);
    this.pay(buyer, seller, total - fee);
    this.pay(buyer, this.core.treasury, fee);
    seller.stock[g] = (seller.stock[g] as number) - n;
    return n;
  }

  /** Note goods made (harvested, baked, caught) or used up (eaten, burned, worked into something else). */
  made(g: number, n: number): void {
    this.produced[g] = (this.produced[g] as number) + n;
  }

  used(g: number, n: number): void {
    this.consumed[g] = (this.consumed[g] as number) + n;
  }

  // --- wages, the common purse, stipends, relief ------------------------------

  /**
   * Evening pay. Each business keeps its float and divides the rest: a share to
   * its own workers, the larger part to the treasury as the village's common
   * purse. The treasury then pays those it keeps (watch, priest, reeve), buys a
   * little stone and timber for upkeep, tops up the poorest purses and shares
   * out what is left equally among the adults. A trade with little custom
   * (three miners for a smith who wants six lumps of ore a day) still eats, and
   * the baker, who sells to everyone, still does best.
   */
  payDay(): void {
    const core = this.core;
    const treasury = core.treasury;
    let paid = 0;
    let earners = 0;
    let incomes = 0;
    for (const b of core.businesses) {
      b.lastWage = 0;
      if (b.workers.length === 0 || b.spec.float <= 0) continue;
      const pool = Math.max(0, b.coin - b.spec.float);
      const share = Math.floor((pool * OWN_SHARE) / b.workers.length);
      for (const w of b.workers) this.pay(b, w, share);
      this.pay(b, treasury, pool - share * b.workers.length);
      b.lastWage = share;
      // Takings come in bursts (a harvest, the fair), so trades are compared on a running average.
      b.income = b.income < 0 ? share : b.income * 0.7 + share * 0.3;
      incomes += b.income * b.workers.length;
      paid += share * b.workers.length;
      earners += b.workers.length;
    }
    const average = earners > 0 ? Math.floor(paid / earners) : 0;
    this.adjustMarkups(earners > 0 ? incomes / earners : 0);

    const adults = core.residents.filter((r) => !r.child);
    const kept = adults.filter((r) => !r.job || r.job.spec.float <= 0);
    if (kept.length > 0) {
      const budget = Math.max(0, treasury.coin - TREASURY_RESERVE);
      const stipend = Math.min(Math.floor(budget / kept.length), Math.max(average, 6));
      for (const r of kept) {
        this.pay(treasury, r, stipend);
        if (r.job) r.job.lastWage = stipend;
      }
      paid += stipend * kept.length;
    }
    this.publicWorks();

    // Relief: the poorest first, each up to the line, while there is coin above the reserve.
    let spare = Math.max(0, treasury.coin - TREASURY_RESERVE);
    for (const r of adults.slice().sort((p, q) => p.coin - q.coin || p.id - q.id)) {
      if (spare <= 0 || r.coin >= RELIEF_LINE) break;
      const gift = Math.min(spare, RELIEF_LINE - r.coin);
      this.pay(treasury, r, gift);
      spare -= gift;
    }
    // The dividend: the rest of the common purse, shared equally.
    const each = adults.length > 0 ? Math.floor((spare * DIVIDEND) / adults.length) : 0;
    for (const r of adults) this.pay(treasury, r, each);
    this.lastDividend = each;
    // The hoard levy: a purse grown fat gives back part of what it holds above the line.
    for (const r of adults) {
      if (r.coin > HOARD_LINE) this.pay(r, treasury, Math.floor((r.coin - HOARD_LINE) * HOARD_LEVY));
    }
    this.lastPayroll = paid;
  }

  /**
   * Let each trade's prices lean a little toward what would bring it the
   * village's average earnings: one doing better than most asks slightly less,
   * one doing worse slightly more (unless its shelves are full, when a higher
   * price would only sell less). The band is narrow; stock still does most of
   * the work of moving a price.
   */
  private adjustMarkups(average: number): void {
    if (average <= 0) return;
    for (const b of this.core.businesses) {
      if (b.workers.length === 0 || b.spec.float <= 0 || b.income < 0) continue;
      const ratio = (b.income + 1) / (average + 1);
      let step = clamp(Math.pow(ratio, -0.3), 1 - MARKUP_STEP, 1 + MARKUP_STEP);
      let stock = 0;
      let target = 0;
      for (let g = 0; g < NG; g++) {
        if (!b.sells[g] || (b.target[g] as number) <= 0) continue;
        stock += b.stock[g] as number;
        target += b.target[g] as number;
      }
      if (step > 1 && target > 0 && stock >= target) step = 1;
      b.markup = clamp(b.markup * step, MARKUP_MIN, MARKUP_MAX);
    }
  }

  /** A few coins a day on stone, timber and firewood for the village's upkeep: roads, the well, the chapel roof. */
  private publicWorks(): void {
    const treasury = this.core.treasury;
    let budget = Math.min(UPKEEP_BUDGET, treasury.coin - TREASURY_RESERVE);
    for (const g of [G.stone, G.oak_planks, G.firewood, G.stone]) {
      if (budget <= 0) break;
      const seller = this.cheapestSeller(g);
      if (!seller) continue;
      const price = seller.price[g] as number;
      let n = Math.min(3, seller.stock[g] as number);
      while (n > 0 && this.cost(price, n) > budget) n--;
      if (n <= 0) continue;
      const before = treasury.coin;
      const sold = this.sell(seller, g, n, treasury);
      if (sold > 0) this.used(g, sold);
      budget -= before - treasury.coin;
    }
  }

  /**
   * Food that has sat too long goes off: a shelf piled far past its target
   * loses part of the excess each day. Things that keep (hides nobody wants,
   * fleeces beyond what the loom can take) are only thrown out when the pile is
   * many times what the business would ever sell, so no stock grows for ever.
   */
  spoil(): void {
    for (const b of this.core.businesses) {
      for (let g = 0; g < NG; g++) {
        const target = b.target[g] as number;
        if (target <= 0) continue;
        const limit = PERISHABLE.has(g) ? target * 2.5 : target * 8 + 20;
        const stock = b.stock[g] as number;
        if (stock <= limit) continue;
        const lost = Math.ceil((stock - limit) * 0.3);
        b.stock[g] = stock - lost;
        this.spoiled += lost;
      }
    }
  }

  // --- the player ---------------------------------------------------------------

  /**
   * How a purchase of `qty` units would be filled: cheapest sellers first, each
   * chunk priced where the seller's price will stand once the goods are gone,
   * so buying a lot costs more per unit than buying a little.
   */
  private fill(g: number, qty: number): { seller: Business; n: number; coins: number }[] | null {
    const sellers = this.core.businesses.filter((b) => b.sells[g] && (b.stock[g] as number) > 0)
      .sort((p, q) => (p.price[g] as number) - (q.price[g] as number) || p.id - q.id);
    const parts: { seller: Business; n: number; coins: number }[] = [];
    let left = qty;
    for (const seller of sellers) {
      if (left <= 0) break;
      const stock = seller.stock[g] as number;
      const n = Math.min(left, stock);
      const unit = Math.max(seller.price[g] as number, this.wanted(seller, g, stock - n / 2));
      parts.push({ seller, n, coins: Math.max(1, Math.ceil(unit * n - 1e-9)) });
      left -= n;
    }
    return left > 0 ? null : parts;
  }

  quoteBuy(good: string, qty: number): number | null {
    const g = goodIndex(good);
    if (g < 0 || !Number.isInteger(qty) || qty <= 0) return null;
    const parts = this.fill(g, qty);
    return parts ? parts.reduce((sum, p) => sum + p.coins, 0) : null;
  }

  buy(good: string, qty: number): { ok: boolean; coins: number } {
    const g = goodIndex(good);
    const parts = g < 0 || !Number.isInteger(qty) || qty <= 0 ? null : this.fill(g, qty);
    if (!parts) return { ok: false, coins: 0 };
    let coins = 0;
    for (const p of parts) {
      const fee = Math.floor(p.coins * MARKET_FEE);
      // The player's coin arrives from outside the village; it is the one place a balance grows without another shrinking.
      p.seller.coin += p.coins - fee;
      this.core.treasury.coin += fee;
      p.seller.stock[g] = (p.seller.stock[g] as number) - p.n;
      coins += p.coins;
    }
    this.playerPaidIn += coins;
    return { ok: true, coins };
  }

  /** The business that would pay most for `qty` units from the player and can afford them, with its offer. */
  private bid(g: number, qty: number): { buyer: Business; coins: number; unit: number } | null {
    let best: { buyer: Business; coins: number; unit: number } | null = null;
    for (const b of this.core.businesses) {
      const target = b.target[g] as number;
      if (target <= 0) continue;
      const stock = b.stock[g] as number;
      // Nobody takes in more than a few times what they would ever want on the shelf.
      if (stock + qty > target * 3 + 10) continue;
      const unit = BUY_BACK * Math.min(b.price[g] as number, this.wanted(b, g, stock + qty / 2));
      const coins = Math.floor(unit * qty);
      if (coins > b.coin) continue;
      if (!best || coins > best.coins) best = { buyer: b, coins, unit };
    }
    return best;
  }

  quoteSell(good: string, qty: number): number | null {
    const g = goodIndex(good);
    if (g < 0 || !Number.isInteger(qty) || qty <= 0) return null;
    return this.bid(g, qty)?.coins ?? null;
  }

  sellFromPlayer(good: string, qty: number): { ok: boolean; coins: number } {
    const g = goodIndex(good);
    const offer = g < 0 || !Number.isInteger(qty) || qty <= 0 ? null : this.bid(g, qty);
    if (!offer) return { ok: false, coins: 0 };
    offer.buyer.coin -= offer.coins;
    offer.buyer.stock[g] = (offer.buyer.stock[g] as number) + qty;
    if (offer.unit > 0) offer.buyer.paid[g] = offer.unit;
    this.playerPaidOut += offer.coins;
    return { ok: true, coins: offer.coins };
  }

  // --- the ledger -----------------------------------------------------------------

  /** Close the day: remember each good's price and start the produced and consumed counts again. */
  closeDay(): void {
    for (let g = 0; g < NG; g++) {
      const h = this.history[g] as number[];
      h.push(round2(this.marketPrice(g)));
      if (h.length > HISTORY_DAYS) h.shift();
    }
    this.produced.fill(0);
    this.consumed.fill(0);
  }

  /** Units of a good in every shop, store and larder. */
  villageStock(g: number): number {
    let n = 0;
    for (const b of this.core.businesses) n += b.stock[g] as number;
    for (const h of this.core.households) n += h.larder[g] as number;
    return n;
  }

  ledger(): LedgerView {
    const core = this.core;
    let purses = 0;
    let tills = 0;
    for (const r of core.residents) purses += r.coin;
    for (const b of core.businesses) tills += b.coin;
    return {
      day: core.clock.day,
      goods: GOODS.map((good, g) => {
        const price = round2(this.marketPrice(g));
        return {
          good,
          label: LABEL[g] as string,
          price,
          stock: this.villageStock(g),
          producedToday: this.produced[g] as number,
          consumedToday: this.consumed[g] as number,
          history: [...(this.history[g] as number[]), price],
        };
      }),
      treasury: core.treasury.coin,
      population: core.residents.length,
      coin: purses + tills + core.treasury.coin,
      playerNet: this.playerPaidIn - this.playerPaidOut,
      purses,
      tills,
      payroll: this.lastPayroll,
      dividend: this.lastDividend,
    };
  }
}

const round2 = (v: number): number => Math.round(v * 100) / 100;

/** The adult of a household best placed to pay for the shopping: the fullest purse. */
export function richest(members: readonly Resident[]): Resident | null {
  let best: Resident | null = null;
  for (const m of members) if (!m.child && (!best || m.coin > best.coin)) best = m;
  return best;
}
