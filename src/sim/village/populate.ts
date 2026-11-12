// Builds the village's people and institutions from the plan: a household for
// every building with beds, a resident for every bed, a business for every
// building with a trade, jobs for the adults, opening stock and coin.

import type { Bed, Cell } from '../api';
import { VILLAGER_WALK, createMover, placeMover } from '../nav';
import type { Core } from './core';
import type { Economy } from './economy';
import { G, KIND_SPEC, NG, TRADE, VALUE, cropStock } from './goods';
import { type Business, type FieldState, type Household, PACK_NONE, PHASE_IDLE, type PenState, type Resident, type Site, FLOCK_PENNED } from './model';
import { Namer } from './names';

/** About one resident in five is a child. */
const CHILD_SHARE = 0.2;
const ADULT_SPEED = 1.5;
const CHILD_SPEED = 1.35;

export function populate(core: Core, economy: Economy): void {
  const namer = new Namer(core.rng.fork('names'));
  for (const site of core.sites) {
    const spec = KIND_SPEC[site.b.kind];
    if (spec.slots > 0) core.businesses.push(newBusiness(site));
  }
  for (const b of core.businesses) core.businessById.set(b.id, b);
  const businessById = core.businessById;

  for (const f of core.plan.fields) {
    const owner = businessById.get(f.owner) ?? null;
    const w = f.x1 - f.x0 + 1;
    const d = f.z1 - f.z0 + 1;
    const state: FieldState = {
      f, owner, w, d,
      growth: new Float32Array(w * d),
      seen: new Float64Array(w * d).fill(core.clock.time),
      watered: new Float64Array(w * d),
      claim: new Int32Array(w * d),
      tilled: new Uint8Array(w * d),
    };
    core.fields.push(state);
    if (owner) {
      owner.fields.push(state);
      const [opening, target] = cropStock(w * d);
      const g = G[f.crop];
      owner.stock[g] = (owner.stock[g] as number) + opening;
      owner.target[g] = (owner.target[g] as number) + target;
    }
  }
  for (const pen of core.plan.pens) {
    const owner = businessById.get(pen.owner) ?? null;
    const area = (pen.x1 - pen.x0 + 1) * (pen.z1 - pen.z0 + 1);
    const perHead = pen.animal === 'chicken' ? 2.5 : pen.animal === 'sheep' ? 5 : 8;
    const state: PenState = { pen, owner, animals: [], capacity: Math.max(2, Math.round(area / perHead)), eggs: 0, flock: FLOCK_PENNED, driveAt: 0, tendedDay: -1 };
    core.pens.push(state);
    owner?.pens.push(state);
  }
  for (const b of core.businesses) {
    for (let g = 0; g < NG; g++) {
      b.paid[g] = VALUE[g] as number;
      const handled = (b.target[g] as number) > 0;
      b.price[g] = handled ? economy.wanted(b, g) : (VALUE[g] as number);
      // A farm sells only the crops it has fields for: a good with no target here is not this business's to sell.
      if (!handled) b.sells[g] = 0;
    }
  }

  for (const site of core.sites) {
    if (site.b.beds.length === 0) continue;
    core.households.push({
      id: site.b.id, site, name: namer.familyName(), members: [], larder: new Int32Array(NG), plate: 0, clothWear: 0, toolWear: 0,
      waterDay: -1, fuelDay: -1, shopDay: -1, errand: 0,
    });
  }
  const childBeds = chooseChildBeds(core);
  let id = 1;
  for (const home of core.households) {
    for (const bed of home.site.b.beds) {
      const child = childBeds.has(bed);
      const r = newResident(core, id++, home, bed, child, namer.givenName());
      home.members.push(r);
      core.residents.push(r);
      core.residentById.set(r.id, r);
    }
  }
  assignJobs(core);
  assignStalls(core);

  for (const home of core.households) {
    const n = home.members.length;
    const workers = home.members.filter((m) => !m.child).length;
    home.larder[G.bread] = n * 2;
    home.larder[G.turnip] = n;
    home.larder[G.cabbage] = n;
    home.larder[G.firewood] = 5;
    home.larder[G.cloth] = Math.ceil(n / 2);
    home.larder[G.tools] = workers > 0 ? 1 : 0;
  }
  core.treasury.coin = 300 + core.residents.length * 4;
}

function newBusiness(site: Site): Business {
  const spec = KIND_SPEC[site.b.kind];
  const b: Business = {
    id: site.b.id, site, spec, trade: TRADE[spec.trade], coin: spec.float > 0 ? spec.float + 60 : 0,
    stock: new Int32Array(NG), target: new Float32Array(NG), price: new Float64Array(NG), paid: new Float64Array(NG),
    sells: new Uint8Array(NG), incoming: new Int32Array(NG), workers: [], hauler: 0, stall: null, fields: [], pens: [], lastWage: 0,
    income: -1, markup: spec.markup,
  };
  for (const [good, opening, target] of spec.goods) {
    b.stock[G[good]] = opening;
    b.target[G[good]] = target;
  }
  for (const good of spec.sells) b.sells[G[good]] = 1;
  return b;
}

/**
 * Which beds are children's. Bigger homes take a child first, then two-bed
 * homes in a shuffled order, and every household keeps at least one adult.
 */
function chooseChildBeds(core: Core): Set<Bed> {
  const rng = core.rng.fork('children');
  const total = core.households.reduce((n, h) => n + h.site.b.beds.length, 0);
  let wanted = Math.round(total * CHILD_SHARE);
  const chosen = new Set<Bed>();
  const taken = new Map<Household, number>();
  const order = rng.shuffle(core.households.slice()).sort((p, q) => q.site.b.beds.length - p.site.b.beds.length);
  for (let round = 0; round < 3 && wanted > 0; round++) {
    for (const home of order) {
      if (wanted <= 0) break;
      const beds = home.site.b.beds;
      const have = taken.get(home) ?? 0;
      // A first child wherever there is a second bed; more only in homes that still keep two adults.
      if (have !== round || beds.length - have < (round === 0 ? 2 : 3)) continue;
      chosen.add(beds[beds.length - 1 - have] as Bed);
      taken.set(home, have + 1);
      wanted--;
    }
  }
  return chosen;
}

function newResident(core: Core, id: number, home: Household, bed: Bed, child: boolean, given: string): Resident {
  const rng = core.rng;
  const age = child ? rng.intRange(5, 13) : rng.intRange(18, 66);
  const look = rng.u32();
  const scale = child ? 0.52 + (age - 5) * 0.04 : 0.94 + (look % 13) * 0.01;
  const view = core.makeView(id, child ? 'child' : 'villager', look, child ? TRADE.child : TRADE.labourer, scale);
  const speed = child ? CHILD_SPEED : age > 55 ? ADULT_SPEED - 0.2 : ADULT_SPEED;
  // The gait reference shrinks with the body, so short legs step faster over the same ground.
  const mover = createMover(view, speed, ADULT_SPEED * scale, true, VILLAGER_WALK, rng.range(-0.18, 0.18), rng.range(-0.18, 0.18));
  const r: Resident = {
    id, view, mover, name: `${given} ${home.name}`, age, child, home, bed, trade: child ? TRADE.child : TRADE.labourer, job: null,
    coin: child ? 0 : rng.intRange(40, 70),
    hunger: rng.range(0.2, 0.35), energy: rng.range(0.85, 1), social: rng.range(0.5, 0.8), mood: 0.7, needsAt: core.clock.time,
    jitter: rng.range(-0.3, 0.3), rota: 0,
    asleep: false, perch: null, stool: -1,
    phase: PHASE_IDLE, wakeAt: 0, actEnd: 0, onDone: null, req: null, dest: null, goSoft: false, goCache: true, tries: 0, failKey: -1,
    pace: speed, askKey: -1, badKey: -1,
    fxKind: '', fxEvery: 0, fxNext: 0, fxX: 0, fxY: 0, fxZ: 0,
    outdoor: false, running: false, selling: false, activity: 'Getting up', inside: -1, place: -1,
    pack: new Int32Array(NG), packKind: PACK_NONE, packCount: 0, haul: null,
    day: -1, meals: 0, step: 0, target: null, targetId: 0, quietUntil: 0, bubbleUntil: 0, shopAgainAt: 0, firewoodAt: 0, restUntil: 0,
    evening: 0, mug: 0, water: 0, waterTrips: 0, field: null, plot: -1, op: 0, plotRetryAt: 0, goal: 0,
  };
  const start: Cell = bed.stand;
  placeMover(mover, core.world, core.doors, start.x, start.y, start.z);
  r.inside = core.siteIndexAt(view.x, view.z);
  return r;
}

/**
 * Give every adult a trade. Those who live at a workplace work there; the rest
 * walk to whichever workplace still needs hands, the most essential trades
 * being filled first and each place going to whoever lives nearest.
 */
function assignJobs(core: Core): void {
  const open = new Map<Business, number>();
  for (const b of core.businesses) open.set(b, b.spec.slots);
  const take = (r: Resident, b: Business): void => {
    r.job = b;
    r.trade = b.trade;
    r.view.role = b.trade;
    b.workers.push(r);
    open.set(b, (open.get(b) as number) - 1);
  };
  const adults = core.residents.filter((r) => !r.child);
  const byId = new Map(core.businesses.map((b) => [b.id, b]));
  for (const r of adults) {
    const b = byId.get(r.home.id);
    if (b && (open.get(b) as number) > 0) take(r, b);
  }
  const distance = (r: Resident, b: Business): number =>
    Math.abs(r.home.site.b.entry.x - b.site.b.entry.x) + Math.abs(r.home.site.b.entry.z - b.site.b.entry.z);
  const nearest = (b: Business): Resident | null => {
    let best: Resident | null = null;
    for (const r of adults) if (!r.job && (!best || distance(r, b) < distance(best, b))) best = r;
    return best;
  };
  const byNeed = core.businesses.slice().sort((p, q) => p.spec.staffing - q.spec.staffing || p.id - q.id);
  // One place per business per pass, so a shortage of hands is spread rather than starving the last trades entirely.
  for (let filled = true; filled; ) {
    filled = false;
    for (const b of byNeed) {
      if ((open.get(b) as number) <= 0) continue;
      const r = nearest(b);
      if (!r) break;
      take(r, b);
      filled = true;
    }
  }
  // More hands than places: the extra go to the land and the woods, where they are always useful.
  const spare = byNeed.filter((b) => b.spec.float > 0);
  let next = 0;
  for (const r of adults) {
    if (r.job || spare.length === 0) continue;
    take(r, spare[next++ % spare.length] as Business);
  }
  let rota = 0;
  for (const r of adults) if (r.trade === TRADE.guard) r.rota = rota++;
}

function assignStalls(core: Core): void {
  const sellers = core.businesses.filter((b) => b.spec.stall > 0 && b.workers.length > 0)
    .sort((p, q) => p.spec.stall - q.spec.stall || p.id - q.id);
  core.plan.stalls.forEach((stall, i) => {
    const b = sellers[i];
    if (b) b.stall = stall;
  });
}
