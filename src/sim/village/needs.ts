// Hunger, energy, company and mood, and eating. Needs are brought up to date
// whenever a resident is next looked at rather than every tick: they change
// over hours, and most residents spend most ticks in the middle of something.

import { clamp, saturate } from '../../core/math';
import type { Core } from './core';
import { FOOD, FOOD_GOODS, G, ITEM_ID } from './goods';
import type { Household, Resident } from './model';

/** Hunger at which a resident drops everything to eat, and at which the soak test calls it critical. */
export const HUNGER_URGENT = 0.72;
export const HUNGER_CRITICAL = 0.85;
/** Hunger below which a meal is not worth sitting down to. */
export const HUNGER_PECKISH = 0.12;

// Rates per simulated second (one in-game minute). A day awake and asleep adds about 0.83 hunger, which two meals' worth of food removes.
const HUNGER_AWAKE = 0.04 / 60;
const HUNGER_ASLEEP = 0.022 / 60;
const ENERGY_AWAKE = 0.058 / 60;
const ENERGY_ASLEEP = 0.14 / 60;
const SOCIAL_FADE = 0.03 / 60;
/** Hunger one meal's worth of food removes: more for a child, who needs less. */
const restore = (r: Resident): number => (r.child ? 0.6 : 0.42);
/** Largest gap brought up to date in one go; a clock set forward by days should not starve the village on the spot. */
const MAX_CATCH_UP = 6 * 60;

export interface Needs {
  hunger: number;
  energy: number;
  social: number;
  mood: number;
}

/** Where a resident's needs stand `dt` seconds after they were last brought up to date. Writes into `out`. */
function advance(core: Core, r: Resident, dt: number, out: Needs): void {
  let hunger = r.hunger;
  let energy = r.energy;
  let social = r.social;
  if (r.asleep) {
    hunger = saturate(hunger + HUNGER_ASLEEP * dt);
    energy = saturate(energy + ENERGY_ASLEEP * dt);
  } else {
    hunger = saturate(hunger + HUNGER_AWAKE * dt);
    energy = saturate(energy - ENERGY_AWAKE * dt);
    social = saturate(social - SOCIAL_FADE * dt);
  }
  const home = r.home;
  const cold = core.env.season === 3 && (home.larder[G.firewood] as number) === 0 ? 0.12 : 0;
  const ragged = home.clothWear >= 1 ? 0.05 : 0;
  const want = clamp(0.45 * (1 - hunger) + 0.3 * energy + 0.25 * social - cold - ragged, 0, 1);
  out.hunger = hunger;
  out.energy = energy;
  out.social = social;
  // Mood follows the needs with a lag of a few hours.
  out.mood = r.mood + (want - r.mood) * Math.min(1, dt / 200);
}

export function updateNeeds(core: Core, r: Resident): void {
  const now = core.env.now;
  const dt = Math.min(now - r.needsAt, MAX_CATCH_UP);
  r.needsAt = now;
  if (dt > 0) advance(core, r, dt, r);
}

/**
 * A resident's needs as of now, without bringing the stored ones up to date.
 * The inspector reads through this, so that looking at someone can never
 * change them.
 */
export function peekNeeds(core: Core, r: Resident): Needs {
  const out: Needs = { hunger: r.hunger, energy: r.energy, social: r.social, mood: r.mood };
  const dt = Math.min(core.clock.time - r.needsAt, MAX_CATCH_UP);
  if (dt > 0) advance(core, r, dt, out);
  return out;
}

/** Meals' worth of food in a household's larder, counting what is already cut. */
export function larderFood(home: Household): number {
  let units = home.plate;
  for (const g of FOOD_GOODS) units += (home.larder[g] as number) * (FOOD[g] as number);
  return units;
}

/** How much a resident would eat now, in meals' worth. */
function appetite(r: Resident): number {
  return Math.min(1.4, r.hunger / restore(r));
}

/**
 * Eat from the household larder until satisfied or it is bare. Whole items are
 * opened one at a time, whichever the larder holds most of, and what is not
 * eaten stays on the plate for the next person. Returns the item id eaten most
 * recently (for the hands), or -1 if there was nothing.
 */
export function eatFromLarder(core: Core, r: Resident, used: (g: number, n: number) => void): number {
  const home = r.home;
  const want = appetite(r);
  let shown = -1;
  while (home.plate < want) {
    let best = -1;
    let bestUnits = 0;
    for (const g of FOOD_GOODS) {
      const units = (home.larder[g] as number) * (FOOD[g] as number);
      if (units > bestUnits) {
        bestUnits = units;
        best = g;
      }
    }
    if (best < 0) break;
    home.larder[best] = (home.larder[best] as number) - 1;
    home.plate += FOOD[best] as number;
    used(best, 1);
    if (best === G.bread) core.stats.breadEaten++;
    shown = ITEM_ID[best] as number;
  }
  const ate = Math.min(want, home.plate);
  if (ate <= 0) return -1;
  home.plate -= ate;
  r.hunger = Math.max(0, r.hunger - ate * restore(r));
  core.stats.meals++;
  return shown;
}

/** Eat straight from a stock (a shop's shelves, one's own shopping). Returns meals' worth eaten. */
export function eatFromStock(core: Core, r: Resident, stock: Int32Array, used: (g: number, n: number) => void): number {
  const want = appetite(r);
  let ate = 0;
  while (ate < want) {
    let best = -1;
    let bestUnits = 0;
    for (const g of FOOD_GOODS) {
      const units = (stock[g] as number) * (FOOD[g] as number);
      if (units > bestUnits) {
        bestUnits = units;
        best = g;
      }
    }
    if (best < 0) break;
    stock[best] = (stock[best] as number) - 1;
    ate += FOOD[best] as number;
    used(best, 1);
    if (best === G.bread) core.stats.breadEaten++;
  }
  if (ate <= 0) return 0;
  r.hunger = Math.max(0, r.hunger - ate * restore(r));
  core.stats.meals++;
  return ate;
}

/** Meals' worth of food on a set of shelves. */
export function foodIn(stock: Int32Array): number {
  let units = 0;
  for (const g of FOOD_GOODS) units += (stock[g] as number) * (FOOD[g] as number);
  return units;
}
