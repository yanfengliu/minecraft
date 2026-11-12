// Household errands: deciding what the larder needs, walking to whoever sells
// it, paying from one's own purse and carrying the goods home; and fetching
// water from the well.

import type { Cell } from '../api';
import { FAIR_DAY } from '../clock';
import { packCell } from '../nav';
import { act, go } from './agent';
import type { Core } from './core';
import type { Economy } from './economy';
import { FOOD, FOOD_GOODS, G, ITEM_ID, NG, VALUE } from './goods';
import { type Business, type Household, PACK_DELIVERY, PACK_HOME, PACK_JOB, PACK_NONE, type Resident } from './model';
import { larderFood } from './needs';

export interface ShoppingList {
  /** Meals' worth of food wanted. */
  food: number;
  firewood: number;
  cloth: number;
  tools: number;
}

/** Items one person carries home from a shopping trip. */
const BASKET = 40;
export const MARKET_OPENS = 8;
export const MARKET_CLOSES = 13;

/** Meals a household eats in a day. */
function dailyFood(home: Household): number {
  let units = 0;
  for (const m of home.members) units += m.child ? 1.4 : 2;
  return units;
}

/** What a household would buy to be stocked for `days` days. Small shortfalls are left for another day. */
export function shoppingList(core: Core, home: Household, days: number): ShoppingList {
  const daily = dailyFood(home);
  const food = daily * days - larderFood(home);
  const burn = core.env.season === 3 ? 2 : 1;
  const wood = home.larder[G.firewood] as number;
  const workers = home.members.some((m) => !m.child);
  return {
    food: food >= daily * 0.75 ? food : 0,
    firewood: wood < burn * 2 ? burn * (days + 1) - wood : 0,
    cloth: (home.larder[G.cloth] as number) === 0 && home.clothWear > 0.3 ? 1 : 0,
    tools: workers && (home.larder[G.tools] as number) === 0 && home.toolWear > 0.3 ? 1 : 0,
  };
}

export function worthATrip(list: ShoppingList): boolean {
  return list.food > 0 || list.firewood > 0 || list.cloth > 0 || list.tools > 0;
}

function marketOpen(core: Core): boolean {
  const env = core.env;
  return env.weekday === FAIR_DAY && env.hour >= MARKET_OPENS && env.hour < MARKET_CLOSES && !env.bad;
}

/** Where a customer of this business stands right now: at its market stall while the fair is on, else at its counter. */
function servingCell(core: Core, b: Business): Cell {
  return b.stall && marketOpen(core) ? b.stall.customer : b.site.customer;
}

/**
 * The seller that best covers a shopping list for this shopper: mostly a
 * matter of who has the food, nudged toward good prices, a short walk, the
 * market on Fairday, and whichever kind of food the larder is short of so that
 * diets stay mixed. Only what the shopper's purse can pay for counts: a full
 * shelf at a price out of reach is no reason to walk there, and with nothing in
 * reach anywhere there is no seller at all.
 */
function pickSeller(core: Core, econ: Economy, r: Resident, list: ShoppingList): Business | null {
  const home = r.home;
  const bread = (home.larder[G.bread] as number) * (FOOD[G.bread] as number);
  const wantsBread = bread * 2 <= larderFood(home) + 0.5;
  const fair = marketOpen(core);
  const from = home.site.b.entry;
  /** Units of a good on a business's shelf that this shopper could buy at least one of. */
  const offers = (b: Business, g: number): number => (b.sells[g] && econ.buyable(b, g, 1, r) > 0 ? (b.stock[g] as number) : 0);
  let best: Business | null = null;
  let bestScore = 0.5;
  for (const b of core.businesses) {
    let food = 0;
    let dear = 0;
    let kinds = 0;
    for (const g of FOOD_GOODS) {
      const n = offers(b, g);
      if (n <= 0) continue;
      food += n * (FOOD[g] as number);
      dear += (b.price[g] as number) / (VALUE[g] as number);
      kinds++;
    }
    let score = 0;
    if (list.food > 0 && food > 0) {
      const cheapness = Math.min(1.6, Math.max(0.6, kinds / dear));
      const hasBread = offers(b, G.bread) > 0;
      score += Math.min(list.food, food) * 3 * cheapness * (hasBread === wantsBread ? 1.5 : 1);
    }
    score += Math.min(list.firewood, offers(b, G.firewood)) * 0.6;
    if (list.cloth > 0 && offers(b, G.cloth) > 0) score += 5;
    if (list.tools > 0 && offers(b, G.tools) > 0) score += 6;
    if (score <= 0) continue;
    if (fair && b.stall) score *= 1.5;
    const to = b.site.b.entry;
    score -= (Math.abs(from.x - to.x) + Math.abs(from.z - to.z)) * 0.02;
    if (score > bestScore) {
      bestScore = score;
      best = b;
    }
  }
  return best;
}

function buy(core: Core, econ: Economy, r: Resident, seller: Business, list: ShoppingList): number {
  let room = BASKET - r.packCount;
  let bought = 0;
  const take = (g: number, qty: number): number => {
    const n = econ.sell(seller, g, Math.min(qty, room), r);
    if (n > 0) {
      r.pack[g] = (r.pack[g] as number) + n;
      r.packCount += n;
      room -= n;
      bought += n;
    }
    return n;
  };
  const perMeal = (g: number): number => (seller.price[g] as number) / (FOOD[g] as number);
  const foods = FOOD_GOODS.filter((g) => seller.sells[g] && (seller.stock[g] as number) > 0).sort((p, q) => perMeal(p) - perMeal(q) || p - q);
  // A mixed basket: mostly the cheapest food, but some of the next two as well unless they cost far more for the same meal.
  const cheapest = foods.length > 0 ? perMeal(foods[0] as number) : 0;
  const mix = foods.filter((g) => perMeal(g) <= cheapest * 2.5).slice(0, 3);
  const shares = mix.length >= 3 ? [0.5, 0.3, 0.2] : mix.length === 2 ? [0.6, 0.4] : [1];
  let want = list.food;
  mix.forEach((g, i) => {
    const per = FOOD[g] as number;
    want -= take(g, Math.ceil((list.food * (shares[i] as number)) / per)) * per;
  });
  // Whatever the mix could not supply is made up from anything on the shelf.
  for (const g of foods) {
    if (want <= 0.25 || room <= 0) break;
    const per = FOOD[g] as number;
    want -= take(g, Math.ceil(want / per)) * per;
  }
  if (list.firewood > 0 && seller.sells[G.firewood]) take(G.firewood, list.firewood);
  if (list.cloth > 0 && seller.sells[G.cloth]) take(G.cloth, list.cloth);
  if (list.tools > 0 && seller.sells[G.tools]) take(G.tools, list.tools);
  if (bought > 0) {
    r.packKind = PACK_HOME;
    core.stats.purchases++;
  }
  return bought;
}

/**
 * Run a shopping errand: pick a seller, walk to it, buy, and leave the rest to
 * `carryHome`. Returns false when there is nothing worth going for, so the
 * caller can do something else. Uses `r.targetId` for the seller chosen.
 */
export function shop(core: Core, econ: Economy, r: Resident, days: number): boolean {
  const home = r.home;
  // Hands full of the workplace's goods: those are put down first, or they would end up in the larder.
  if (r.packKind === PACK_JOB || r.packKind === PACK_DELIVERY) return false;
  let seller = r.targetId > 0 ? core.businessById.get(r.targetId) ?? null : null;
  if (!seller) {
    const list = shoppingList(core, home, days);
    if (!worthATrip(list) || r.coin <= 0) return false;
    seller = pickSeller(core, econ, r, list);
    if (!seller) return false;
    r.targetId = seller.id;
    home.errand = r.id;
  }
  r.activity = `Shopping at ${seller.site.b.name}`;
  const chosen = seller;
  const cell = servingCell(core, chosen);
  const key = packCell(cell.x, cell.y, cell.z);
  const holder = core.places.get(key);
  const close = Math.abs(r.view.x - cell.x - 0.5) < 5 && Math.abs(r.view.z - cell.z - 0.5) < 5;
  if (close && holder !== undefined && holder !== r.id) {
    // One customer at a time: the next waits a few steps off, in the shop, on its doorstep or, for a stall, on the square.
    const site = chosen.site;
    const wait = cell === site.customer ? core.claim(r, site.floor) ?? core.claim(r, site.forecourt) : core.claim(r, core.squareSpots);
    if (wait && !go(core, r, wait)) return true;
    act(core, r, 'idle', 3);
    return true;
  }
  if (!go(core, r, cell)) return true;
  if (!core.hold(r, key)) {
    act(core, r, 'idle', 2);
    return true;
  }
  act(core, r, 'talk', 4, -1, () => {
    buy(core, econ, r, chosen, shoppingList(core, home, days));
    r.targetId = 0;
    home.errand = 0;
    home.shopDay = core.env.day;
    core.release(r);
  });
  return true;
}

/** Give up a shopping errand under way (bedtime, a storm). */
export function dropErrand(r: Resident): void {
  if (r.home.errand === r.id) r.home.errand = 0;
  r.targetId = 0;
}

/** Take shopping home and put it in the larder. */
export function carryHome(core: Core, r: Resident): void {
  const home = r.home;
  r.activity = 'Carrying the shopping home';
  if (!go(core, r, home.site.drop)) return;
  let held = -1;
  for (let g = 0; g < NG; g++) if ((r.pack[g] as number) > 0) held = ITEM_ID[g] as number;
  act(core, r, 'work', 2, held, () => {
    for (let g = 0; g < NG; g++) {
      home.larder[g] = (home.larder[g] as number) + (r.pack[g] as number);
      r.pack[g] = 0;
    }
    r.packCount = 0;
    r.packKind = PACK_NONE;
  });
}

/** Draw the household's water at the well. */
export function fetchWater(core: Core, r: Resident): void {
  r.activity = 'Fetching water from the well';
  r.outdoor = true;
  const spot = core.claim(r, core.wellSpots);
  if (!spot) {
    // Every place at the well is taken: wait for a turn.
    act(core, r, 'idle', 3);
    return;
  }
  if (!go(core, r, spot)) return;
  act(core, r, 'work', 6, -1, () => {
    r.home.waterDay = core.env.day;
    core.release(r);
  });
}
