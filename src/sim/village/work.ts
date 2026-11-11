// Work that happens at a building: making goods at a work spot from a recipe,
// carrying finished goods to the businesses that use them, putting down what
// was gathered outdoors, and minding the counter in between. Driven entirely by
// the tables in goods.ts.

import { act, cue, face, go } from './agent';
import type { Core } from './core';
import { type Economy, RESALE_MARGIN } from './economy';
import { CARRY, G, ITEM_ID, LABEL, NG } from './goods';
import { type Business, PACK_DELIVERY, PACK_JOB, PACK_NONE, type Recipe, type Resident, type Site, type SpotState } from './model';

/** A shelf this many times over target is full: production stops and the trade rests. */
export const FULL = 1.6;

export function spotOf(site: Site, kind: string): SpotState | null {
  for (const s of site.spots) if (s.spot.kind === kind) return s;
  return null;
}

/** People without tools at home work more slowly. */
export function toolFactor(r: Resident): number {
  return (r.home.larder[G.tools] as number) === 0 && r.home.toolWear >= 1 ? 1.3 : 1;
}

function canRun(b: Business, rec: Recipe): boolean {
  for (const [g, n] of rec.input) if ((b.stock[g] as number) < n) return false;
  for (const [g] of rec.output) if ((b.stock[g] as number) >= (b.target[g] as number) * FULL) return false;
  return true;
}

function runRecipe(core: Core, econ: Economy, b: Business, rec: Recipe): void {
  for (const [g, n] of rec.input) if ((b.stock[g] as number) < n) return;
  for (const [g, n] of rec.input) {
    b.stock[g] = (b.stock[g] as number) - n;
    econ.used(g, n);
  }
  for (const [g, n] of rec.output) {
    b.stock[g] = (b.stock[g] as number) + n;
    econ.made(g, n);
    if (g === G.bread) core.stats.breadBaked += n;
  }
}

/**
 * A day's work at a workshop: deliver what is ready, make what is wanted, and
 * otherwise mind the shop. Returns after issuing one instruction.
 */
export function workshop(core: Core, econ: Economy, r: Resident): void {
  const b = r.job as Business;
  const site = b.site;
  if (haul(core, econ, r)) return;
  const now = core.env.now;
  for (const rec of b.spec.recipes) {
    if (!canRun(b, rec)) continue;
    const seconds = rec.seconds * toolFactor(r);
    r.activity = `${rec.verb} at ${site.b.name}`;
    const spot = spotOf(site, rec.spot) ?? site.spots[0];
    if (!spot) {
      // A workplace the plan gave no work spot: the work is done all the same, wherever there is floor.
      if (!go(core, r, core.claim(r, site.floor) ?? site.drop)) return;
      act(core, r, 'work', seconds, rec.held, () => runRecipe(core, econ, b, rec));
      return;
    }
    // One pair of hands at a millstone or an oven at a time.
    if (spot.user !== r.id && spot.until > now) continue;
    spot.user = r.id;
    spot.until = now + 30;
    if (!go(core, r, spot.spot.stand)) return;
    spot.until = now + seconds;
    if (spot.spot.block) face(r, spot.spot.block);
    if (rec.fire && spot.spot.block) {
      spot.fireUntil = now + seconds + 1.5;
      if (!spot.lit) {
        core.setLit(spot.spot.block, true);
        spot.lit = true;
      }
      site.hearthUntil = Math.max(site.hearthUntil, now + seconds + 5);
    }
    act(core, r, 'work', seconds, rec.held, () => runRecipe(core, econ, b, rec));
    if (rec.fx !== '' && spot.spot.block) cue(core, r, rec.fx, 1.4, spot.spot.block);
    return;
  }
  tend(core, r);
}

/** Stand at the counter (or the main work spot) ready to serve, tidying now and then. */
function tend(core: Core, r: Resident): void {
  const b = r.job as Business;
  const site = b.site;
  const spot = spotOf(site, 'counter') ?? site.spots[0] ?? null;
  const now = core.env.now;
  const free = spot && (spot.user === r.id || spot.until <= now);
  const cell = free && spot ? spot.spot.stand : core.claim(r, site.floor) ?? site.b.entry;
  r.activity = `Minding ${site.b.name}`;
  if (!go(core, r, cell)) return;
  const seconds = 8 + core.rng.float() * 8;
  if (free && spot) {
    spot.user = r.id;
    spot.until = now + seconds;
    if (spot.spot.block) face(r, spot.spot.block);
    // Only whoever stands at the counter itself is there to sell.
    r.selling = b.spec.sells.length > 0;
  }
  act(core, r, core.rng.chance(0.25) ? 'work' : 'idle', seconds);
}

/** The delivery most worth making for a business right now, or null. */
function bestDelivery(core: Core, b: Business): { good: number; qty: number; to: Business } | null {
  for (const [good, kinds] of b.spec.deliver) {
    const g = G[good];
    const surplus = (b.stock[g] as number) - (b.spec.keep[good] ?? 0);
    if (surplus <= 0) continue;
    const price = b.price[g] as number;
    for (const kind of kinds) {
      for (const c of core.businesses) {
        if (c === b || c.site.b.kind !== kind) continue;
        const target = c.target[g] as number;
        const need = Math.ceil(target) - (c.stock[g] as number) - (c.incoming[g] as number);
        if (need <= 0) continue;
        // A reseller takes goods only where its own price leaves a margin; a maker needs its materials whatever they cost.
        if (c.spec.recipes.length === 0 && price > (c.price[g] as number) * RESALE_MARGIN) continue;
        // Not worth a walk to top up a shelf that is still mostly full.
        if ((c.stock[g] as number) > 0 && need < Math.ceil(target * 0.3)) continue;
        const qty = Math.min(surplus, need, CARRY, Math.floor(c.coin / price));
        // Go when the load covers the want, or is a decent share of the shelf; not for every single item.
        if (qty >= 1 && qty >= Math.min(need, Math.max(3, Math.ceil(target * 0.3)))) return { good: g, qty, to: c };
      }
    }
  }
  return null;
}

/** True when some customer is waiting on goods this business has ready. */
export function hasDelivery(core: Core, b: Business): boolean {
  return b.hauler === 0 && !core.env.bad && bestDelivery(core, b) !== null;
}

/**
 * Carry finished goods to a customer business. Returns true when the resident
 * is on a delivery (an instruction was issued), false when there is none to make.
 */
export function haul(core: Core, econ: Economy, r: Resident): boolean {
  const b = r.job as Business;
  if (!r.haul) {
    // Nobody sets out with a load in the rain; one already on the road is carried through.
    if (b.hauler !== 0 || r.packCount > 0 || core.env.bad) return false;
    const plan = bestDelivery(core, b);
    if (!plan) return false;
    r.haul = { ...plan, loaded: false };
    b.hauler = r.id;
    plan.to.incoming[plan.good] = (plan.to.incoming[plan.good] as number) + plan.qty;
  }
  const h = r.haul;
  if (h.loaded) {
    deliver(core, econ, r);
    return true;
  }
  r.activity = `Loading ${LABEL[h.good]} for ${h.to.site.b.name}`;
  if (!go(core, r, b.site.drop)) return true;
  act(core, r, 'work', 3, ITEM_ID[h.good] as number, () => {
    const g = h.good;
    const n = Math.min(h.qty, b.stock[g] as number);
    h.to.incoming[g] = (h.to.incoming[g] as number) - (h.qty - n);
    if (n <= 0) {
      r.haul = null;
      b.hauler = 0;
      return;
    }
    b.stock[g] = (b.stock[g] as number) - n;
    r.pack[g] = (r.pack[g] as number) + n;
    r.packCount += n;
    r.packKind = PACK_DELIVERY;
    h.qty = n;
    h.loaded = true;
  });
  return true;
}

/** Finish a delivery in hand: walk to the customer, hand over, take payment at the posted price. */
export function deliver(core: Core, econ: Economy, r: Resident): void {
  const h = r.haul;
  const b = r.job;
  if (!h || !b) {
    // A load with no delivery behind it is just the business's goods: take them back.
    r.packKind = r.packCount > 0 ? PACK_JOB : PACK_NONE;
    return;
  }
  const to = h.to;
  const g = h.good;
  r.activity = `Delivering ${LABEL[g]} to ${to.site.b.name}`;
  if (!go(core, r, to.site.drop)) return;
  act(core, r, 'work', 3, ITEM_ID[g] as number, () => {
    // The goods are the seller's until paid for; what the customer cannot take or afford goes back on the seller's shelf.
    b.stock[g] = (b.stock[g] as number) + h.qty;
    const room = Math.max(0, Math.ceil((to.target[g] as number) * FULL) - (to.stock[g] as number));
    const sold = econ.sell(b, g, Math.min(h.qty, room), to);
    to.stock[g] = (to.stock[g] as number) + sold;
    if (sold > 0) to.paid[g] = b.price[g] as number;
    to.incoming[g] = (to.incoming[g] as number) - h.qty;
    r.pack[g] = (r.pack[g] as number) - h.qty;
    r.packCount -= h.qty;
    r.packKind = PACK_NONE;
    r.haul = null;
    b.hauler = 0;
    if (sold > 0) core.stats.deliveries++;
  });
}

/** Put down at the workplace what was gathered, caught or harvested. */
export function unloadAtJob(core: Core, r: Resident): void {
  const b = r.job;
  if (!b) {
    dropPack(r);
    return;
  }
  r.activity = `Bringing the day's take to ${b.site.b.name}`;
  if (!go(core, r, b.site.drop)) return;
  let held = -1;
  for (let g = 0; g < NG; g++) if ((r.pack[g] as number) > 0) held = ITEM_ID[g] as number;
  act(core, r, 'work', 2, held, () => {
    for (let g = 0; g < NG; g++) {
      b.stock[g] = (b.stock[g] as number) + (r.pack[g] as number);
      r.pack[g] = 0;
    }
    r.packCount = 0;
    r.packKind = PACK_NONE;
  });
}

function dropPack(r: Resident): void {
  r.pack.fill(0);
  r.packCount = 0;
  r.packKind = PACK_NONE;
}

/** Add gathered goods to what a worker is carrying for their business. */
export function gather(econ: Economy, r: Resident, g: number, n: number, kind: number): void {
  if (n <= 0) return;
  r.pack[g] = (r.pack[g] as number) + n;
  r.packCount += n;
  r.packKind = kind;
  econ.made(g, n);
}
