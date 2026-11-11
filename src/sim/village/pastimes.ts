// What people do when they are not at their trade: evenings at home, in the
// tavern or on the square, the chapel on Restday, the market on Fairday,
// children's play and lessons; and the two trades whose work is mostly other
// people, the priest and the reeve. Wherever people gather each holds a
// standing place of their own; when a place is full the latecomer goes home.

import type { Cell } from '../api';
import { packCell } from '../nav';
import { act, face, go, sit } from './agent';
import type { Core } from './core';
import type { Economy } from './economy';
import { carryHome, shop, shoppingList, worthATrip } from './errands';
import { richest } from './economy';
import { G, ITEM_ID, NG } from './goods';
import { type Business, PACK_HOME, PHASE_WALK, type Resident, type Site } from './model';
import type { Social } from './social';
import { spotOf } from './work';

export interface Parts {
  core: Core;
  econ: Economy;
  social: Social;
}

const ALE_ITEM = ITEM_ID[G.ale] as number;

/** Someone awake and standing still within a few blocks, to talk to. */
function companion(core: Core, r: Resident): Resident | null {
  for (const o of core.residents) {
    if (o === r || o.asleep || o.phase === PHASE_WALK) continue;
    const dx = o.view.x - r.view.x;
    const dz = o.view.z - r.view.z;
    if (dx * dx + dz * dz < 9) return o;
  }
  return null;
}

/**
 * For people who drift from spot to spot (browsing the market, a child at
 * play, the reeve on his rounds): the place they are making for or standing
 * at, or a newly picked one. Uses `r.target`; `moveOn` gives it up.
 */
function roam(core: Core, r: Resident, pick: () => Cell | null): Cell | null {
  const t = r.target;
  if (t && core.places.get(packCell(t.x, t.y, t.z)) === r.id) return t;
  r.target = pick();
  return r.target;
}

function moveOn(core: Core, r: Resident): void {
  core.release(r);
  r.target = null;
}

/**
 * Pass some time in company: mostly sitting or standing by, now and then
 * turning to a neighbour to talk. With `roaming` the place is given up
 * afterwards, so the next look round finds somewhere new to stand.
 */
function idleInCompany(p: Parts, r: Resident, place: Cell, seated: boolean, held = -1, roaming = false): void {
  const { core, social } = p;
  const after = roaming ? () => moveOn(core, r) : null;
  const other = core.rng.chance(0.3) ? companion(core, r) : null;
  if (other) {
    if (!r.perch) face(r, { x: Math.floor(other.view.x), y: place.y, z: Math.floor(other.view.z) });
    social.chat(r, other);
    r.social = Math.min(1, r.social + 0.06);
    other.social = Math.min(1, other.social + 0.04);
    if (seated) sit(core, r, place, 5, held, after, 'talk');
    else act(core, r, 'talk', 5, held, after);
    return;
  }
  const seconds = roaming ? 8 + core.rng.float() * 10 : 15 + core.rng.float() * 15;
  if (seated) sit(core, r, place, seconds, held, after);
  else act(core, r, 'idle', seconds, held, after);
}

export function homeEvening(p: Parts, r: Resident): void {
  const site = r.home.site;
  r.activity = `At home in ${site.b.name}`;
  const seat = p.core.claim(r, site.b.seats);
  const place = seat ?? p.core.claim(r, site.floor) ?? r.bed.stand;
  if (!go(p.core, r, place)) return;
  idleInCompany(p, r, place, seat !== null);
}

/**
 * An evening at the tavern: a seat, a mug of ale if the purse runs to it, and
 * talk. Returns false when the house is full. Uses `r.step` (sittings so far)
 * and `r.targetId` (sittings left on the mug in hand).
 */
export function tavernEvening(p: Parts, r: Resident, tavern: Business): boolean {
  const { core, econ } = p;
  const site = tavern.site;
  const seat = core.claim(r, site.b.seats);
  const place = seat ?? core.claim(r, site.floor);
  if (!place) return false;
  r.activity = `Drinking at ${site.b.name}`;
  if (!go(core, r, place)) return true;
  // A mug on sitting down, and perhaps one more later for those who can afford it. A mug lasts three sittings.
  if (r.targetId === 0 && (r.step === 0 || (r.step === 5 && r.coin > 25 && core.rng.chance(0.5)))) {
    if (econ.sell(tavern, G.ale, 1, r) > 0) {
      econ.used(G.ale, 1);
      r.social = Math.min(1, r.social + 0.08);
      r.targetId = 3;
    }
  }
  r.step++;
  const drinking = r.targetId > 0;
  if (drinking) r.targetId--;
  idleInCompany(p, r, place, seat !== null, drinking ? ALE_ITEM : -1);
  return true;
}

/** Out on the square in company. Returns false when there is no room left to stand. */
export function onTheSquare(p: Parts, r: Resident): boolean {
  const { core } = p;
  const place = core.claim(r, core.squareSpots);
  if (!place) return false;
  r.activity = 'Passing the time on the square';
  r.outdoor = true;
  if (!go(core, r, place)) return true;
  idleInCompany(p, r, place, false);
  return true;
}

/** A place in the chapel: a pew, the floor behind them, or the doorstep when the building is full. */
function chapelPlace(core: Core, r: Resident, chapel: Site): { place: Cell; seated: boolean } | null {
  const seat = core.claim(r, chapel.b.seats);
  const place = seat ?? core.claim(r, chapel.floor) ?? core.claim(r, chapel.forecourt);
  return place ? { place, seated: seat !== null } : null;
}

/** The Restday service: the priest at the altar, everyone else in the pews, standing behind, or listening at the door. */
export function chapelService(p: Parts, r: Resident, chapel: Site, leading: boolean): boolean {
  const { core, social } = p;
  if (leading) {
    const altar = spotOf(chapel, 'altar') ?? chapel.spots[0];
    const stand = altar ? altar.spot.stand : chapel.interior[chapel.interior.length - 1] ?? chapel.b.entry;
    r.activity = 'Leading the Restday service';
    if (!go(core, r, stand)) return true;
    // Turn from the altar to the people.
    face(r, chapel.b.door ?? chapel.b.entry);
    if (core.chatter.chance(0.25)) social.say(r, core.chatter.pick(['Give thanks for the harvest.', 'Peace on this house.', 'Let us be glad of the day.']), 40);
    act(core, r, 'talk', 20 + core.rng.float() * 10);
    return true;
  }
  const where = chapelPlace(core, r, chapel);
  if (!where) return false;
  r.activity = 'At the Restday service';
  if (!go(core, r, where.place)) return true;
  r.social = Math.min(1, r.social + 0.05);
  if (where.seated) sit(core, r, where.place, 30);
  else {
    face(r, chapel.b.door ?? chapel.b.entry);
    act(core, r, 'idle', 30);
  }
  return true;
}

/** Children at their letters in the chapel. */
export function lessons(p: Parts, r: Resident, chapel: Site): boolean {
  const { core } = p;
  const where = chapelPlace(core, r, chapel);
  if (!where) return false;
  r.activity = 'At lessons in the chapel';
  if (!go(core, r, where.place)) return true;
  if (where.seated) sit(core, r, where.place, 25);
  else act(core, r, 'idle', 25);
  return true;
}

/** Fairday on the square: the household's shopper buys for the week at the stalls; everyone else looks round. */
export function marketVisit(p: Parts, r: Resident): boolean {
  const { core, econ } = p;
  const home = r.home;
  r.outdoor = true;
  if (r.packKind === PACK_HOME) {
    carryHome(core, r);
    return true;
  }
  const shopper = richest(home.members) === r && home.shopDay !== core.env.day && (home.errand === 0 || home.errand === r.id);
  if (shopper || r.targetId > 0) {
    if (r.targetId > 0 || worthATrip(shoppingList(core, home, 6))) {
      if (shop(core, econ, r, 6)) return true;
    }
    home.shopDay = core.env.day;
  }
  // Browsing: a spot on the square, then another, a different one each time.
  const place = roam(core, r, () => core.claim(r, core.squareSpots, core.rng.int(1 << 16)));
  if (!place) return false;
  r.activity = 'Looking round the market';
  // A wander from one spot to the next is never walked twice, so its route is not worth remembering.
  if (!go(core, r, place, false, false)) return true;
  idleInCompany(p, r, place, false, -1, true);
  return true;
}

/** Behind a stall on Fairday morning, with something of one's own to show. */
export function stallSelling(p: Parts, r: Resident, b: Business): void {
  const { core, social } = p;
  const stall = b.stall;
  if (!stall) return;
  r.activity = `Selling at the ${b.site.b.name} stall`;
  r.outdoor = true;
  if (!go(core, r, stall.stand)) return;
  face(r, stall.customer);
  r.selling = true;
  let most = -1;
  for (let g = 0; g < NG; g++) if (b.sells[g] && (b.stock[g] as number) > 0 && (most < 0 || (b.stock[g] as number) > (b.stock[most] as number))) most = g;
  if (most >= 0 && core.chatter.chance(0.12)) social.say(r, core.chatter.pick(['Fresh today!', 'Come and look!', 'Best in the village!', 'Fair prices!']), 60);
  act(core, r, 'idle', 10 + core.rng.float() * 10, most >= 0 ? (ITEM_ID[most] as number) : -1);
}

/** Children running about: across the square, round the well, back to their own door. */
export function play(p: Parts, r: Resident): boolean {
  const { core } = p;
  // Mostly the square; now and then home to the doorstep.
  const place = roam(core, r, () => {
    const doorstep = core.rng.chance(0.25) ? core.claim(r, r.home.site.forecourt, core.rng.int(1 << 16)) : null;
    return doorstep ?? core.claim(r, core.squareSpots, core.rng.int(1 << 16));
  });
  if (!place) return false;
  r.activity = 'Playing';
  r.outdoor = true;
  r.running = true;
  if (!go(core, r, place, false, false)) return true;
  // In summer and autumn a child now and then comes home with a handful of berries from the hedges.
  if ((core.env.season === 1 || core.env.season === 2) && core.rng.chance(0.03)) {
    r.home.larder[G.berries] = (r.home.larder[G.berries] as number) + 1;
    p.econ.made(G.berries, 1);
  }
  const other = companion(core, r);
  if (other && core.rng.chance(0.4)) {
    p.social.chat(r, other);
    r.social = Math.min(1, r.social + 0.08);
    act(core, r, 'talk', 4, -1, () => moveOn(core, r));
    return true;
  }
  act(core, r, 'idle', 3 + core.rng.float() * 6, -1, () => moveOn(core, r));
  return true;
}

/** Somewhere to stand on a round of the village: outside one of these buildings, or failing that on the square. */
function callAt(core: Core, r: Resident, sites: readonly Site[]): Cell | null {
  return roam(core, r, () => {
    const outside = sites.length > 0 && core.rng.chance(0.7) ? core.claim(r, core.rng.pick(sites).forecourt, core.rng.int(1 << 16)) : null;
    return outside ?? core.claim(r, core.squareSpots, core.rng.int(1 << 16));
  });
}

/** The priest's weekday: prayers at the altar, the children's lessons, and afternoons out among the parish. */
export function priestWork(p: Parts, r: Resident, teaching: boolean): void {
  const { core, social } = p;
  const site = (r.job as Business).site;
  const env = core.env;
  if (!teaching && env.hour >= 13 && !env.bad && env.daylight > 0.3) {
    const place = callAt(core, r, core.households.map((home) => home.site));
    if (place) {
      r.outdoor = true;
      r.activity = 'Visiting the parish';
      if (!go(core, r, place)) return;
      idleInCompany(p, r, place, false, -1, true);
      return;
    }
  }
  const altar = spotOf(site, 'altar') ?? site.spots[0];
  const stand = altar ? altar.spot.stand : site.interior[0] ?? site.b.entry;
  r.activity = teaching ? 'Teaching the children their letters' : 'At prayer in the chapel';
  if (!go(core, r, stand)) return;
  if (teaching) {
    face(r, site.b.door ?? site.b.entry);
    if (core.chatter.chance(0.15)) social.say(r, core.chatter.pick(['Again, from the top.', 'A, B, C...', 'Slates up!']), 60);
    act(core, r, 'talk', 20);
  } else {
    if (altar?.spot.block) face(r, altar.spot.block);
    act(core, r, 'work', 25);
  }
}

/** The reeve's weekday: the accounts in the morning, and a round of the village's works in the afternoon. */
export function reeveWork(p: Parts, r: Resident): void {
  const { core } = p;
  const site = (r.job as Business).site;
  const env = core.env;
  if (env.hour >= 13 && !env.bad && env.daylight > 0.3) {
    const place = callAt(core, r, core.businesses.filter((b) => b.spec.float > 0).map((b) => b.site));
    if (place) {
      r.outdoor = true;
      r.activity = 'Making the rounds of the village';
      if (!go(core, r, place)) return;
      idleInCompany(p, r, place, false, -1, true);
      return;
    }
  }
  const desk = spotOf(site, 'desk') ?? site.spots[0];
  const stand = desk ? desk.spot.stand : site.interior[0] ?? site.b.entry;
  r.activity = `Keeping the accounts at ${site.b.name}`;
  if (!go(core, r, stand)) return;
  if (desk?.spot.block) face(r, desk.spot.block);
  act(core, r, 'work', 20 + core.rng.float() * 10);
}
