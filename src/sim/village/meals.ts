// Meals: at one's own table when the larder has food, from the shopping basket
// on the way home, and when a household has nothing and cannot buy, a free meal
// from whoever in the village has most to spare, or failing that whatever can
// be foraged. The last two never move coin, so they cannot upset the accounts.

import { B } from '../../world/blocks';
import type { Cell } from '../api';
import { groundLevel } from '../nav';
import { act, cue, gaveUp, go, sit } from './agent';
import type { Core } from './core';
import type { Economy } from './economy';
import { shop } from './errands';
import { G, ITEM_ID } from './goods';
import { type Business, MEAL_SUPPER, PACK_HOME, PACK_NONE, type Resident } from './model';
import { HUNGER_URGENT, eatFromLarder, eatFromStock, foodIn, larderFood } from './needs';

const BREAD_ITEM = ITEM_ID[G.bread] as number;
/** Hunger taken off by a spell of foraging, by season: lean in spring, leaner in winter. */
const FORAGE = [0.3, 0.45, 0.45, 0.2];
/** Simulated seconds someone hungry with a bare larder waits before trying the shops again. */
const SHOP_AGAIN = 30;

/**
 * Have a meal. `bit` is the MEAL_* flag to set once eaten. With `packed` the
 * resident eats where they stand from what they brought from home; otherwise
 * they go home, sit down and eat, with the hearth lit.
 */
export function meal(core: Core, econ: Economy, r: Resident, bit: number, packed: boolean, label: string): void {
  const home = r.home;
  const used = (g: number, n: number): void => econ.used(g, n);
  // Shopping in hand and hungry: eat from the basket rather than walk past food.
  if (r.packKind === PACK_HOME && foodIn(r.pack) > 0 && (larderFood(home) < 0.4 || r.hunger >= HUNGER_URGENT)) {
    r.activity = 'Eating from the basket';
    act(core, r, 'eat', 8, BREAD_ITEM, () => {
      const before = r.packCount;
      eatFromStock(core, r, r.pack, used);
      let left = 0;
      for (const n of r.pack) left += n;
      r.packCount = left;
      if (left === 0 && before > 0) r.packKind = PACK_NONE;
      r.meals |= bit;
    });
    return;
  }
  if (larderFood(home) < 0.4) {
    hungryWithNothing(core, econ, r, bit);
    return;
  }
  r.activity = label;
  if (packed) {
    act(core, r, 'eat', 10, BREAD_ITEM, () => {
      eatFromLarder(core, r, used);
      r.meals |= bit;
    });
    return;
  }
  const site = home.site;
  const seat = core.claim(r, site.b.seats) ?? core.claim(r, site.floor) ?? r.bed.stand;
  if (!go(core, r, seat)) return;
  // The evening meal is the cooked one: it burns the day's firewood, and more of it in winter.
  if (bit === MEAL_SUPPER && home.fuelDay !== core.env.day) {
    home.fuelDay = core.env.day;
    const burn = Math.min(home.larder[G.firewood] as number, core.env.season === 3 ? 2 : 1);
    home.larder[G.firewood] = (home.larder[G.firewood] as number) - burn;
    if (burn > 0) econ.used(G.firewood, burn);
    if (burn > 0) site.hearthUntil = core.env.now + 45;
  }
  sit(core, r, seat, 12, BREAD_ITEM, () => {
    const item = eatFromLarder(core, r, used);
    if (item >= 0) r.view.held = item;
    r.meals |= bit;
  }, 'eat');
}

/** The business with the most food on its shelves, or null when the whole village is bare. */
function fullestShelves(core: Core): Business | null {
  let best: Business | null = null;
  let bestFood = 0.5;
  for (const b of core.businesses) {
    const food = foodIn(b.stock);
    if (food > bestFood) {
      bestFood = food;
      best = b;
    }
  }
  return best;
}

function hungryWithNothing(core: Core, econ: Economy, r: Resident, bit: number): void {
  // An adult with coin goes and buys; the routine will find them eating from the basket next. One trip, and
  // then whatever it brought: back at the same counter with the same purse nothing would have changed, so a
  // trip that ends with no food in the basket is followed by a meal given or found, not by another trip.
  const onTheWay = r.targetId > 0;
  if (!r.child && (onTheWay || (r.coin > 0 && r.shopAgainAt <= core.env.now))) {
    r.shopAgainAt = core.env.now + SHOP_AGAIN;
    if (shop(core, econ, r, 2)) return;
  }
  if (r.hunger < 0.55) {
    // Not yet pressing: go without this meal and see what the day brings.
    r.meals |= bit;
    act(core, r, 'idle', 3);
    return;
  }
  const giver = fullestShelves(core);
  if (giver) {
    r.activity = `Asking for a meal at ${giver.site.b.name}`;
    if (!go(core, r, giver.site.customer)) return;
    act(core, r, 'eat', 10, BREAD_ITEM, () => {
      if (eatFromStock(core, r, giver.stock, (g, n) => econ.used(g, n)) > 0) core.stats.almsMeals++;
      r.meals |= bit;
    });
    return;
  }
  forage(core, r, bit);
}

/**
 * Nothing to eat anywhere: go out past the last houses and find what grows in
 * the hedges and verges. Uses `r.target` for the spot. Not flagged as outdoor
 * work: hunger does not wait for the rain to stop.
 */
function forage(core: Core, r: Resident, bit: number): void {
  r.activity = 'Foraging for something to eat';
  if (r.target && gaveUp(r, r.target)) r.target = null;
  if (!r.target) {
    // Open ground a short walk from home, in whatever direction: not under a roof, not in someone's field.
    const from = r.home.site.b.entry;
    for (let tries = 0; tries < 8 && !r.target; tries++) {
      const a = core.rng.range(0, Math.PI * 2);
      const d = core.rng.range(10, 22);
      const x = Math.round(from.x + Math.sin(a) * d);
      const z = Math.round(from.z + Math.cos(a) * d);
      const y = groundLevel(core.world, x, z);
      if (y < 0 || core.siteIndexAt(x, z) >= 0) continue;
      const ground = core.world.get(x, y - 1, z);
      if (ground === B.grass || ground === B.forest_floor || ground === B.dirt) r.target = { x, y, z };
    }
    r.target ??= core.plan.center;
  }
  const spot: Cell = r.target;
  if (!go(core, r, spot, true, false)) return;
  act(core, r, 'work', 20, -1, () => {
    r.hunger = Math.max(0, r.hunger - (FORAGE[core.env.season] as number));
    r.meals |= bit;
    r.target = null;
    core.stats.foraged++;
  });
  cue(core, r, 'dust', 4, spot);
}
