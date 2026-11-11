// Stocking the world. How many of each species the country can carry is read
// off the habitat map (so much meadow makes so many warrens), each group is
// given a home in the right kind of place, and its members are set down around
// it. The same code brings a few animals back from beyond the map when a
// species has died out, if the simulation was asked to allow that.

import { clamp } from '../../core/math';
import { standCellNear, standHeight } from '../../world/walk';
import { mastCapacity } from './bands';
import { takeOff } from './birds';
import { H_HIGH, H_MEADOW, H_SEA, H_SHORE, H_WOOD, STRIDE, type Spot, type WaterBody } from './habitat';
import { WALK_OPT, placeWalker } from './motion';
import { addAnimal, addGroup } from './population';
import {
  BOAR, CROW, DEER, DUCK, FISH, FOX, GT_FLOCK, GT_SCHOOL, GULL, KIND_COUNT, RABBIT, SONGBIRD, SPECIES, type Species, WILD_KINDS,
  WOLF, type WildKind,
} from './species';
import type { Eco } from './state';
import { airFloor } from './terrain';
import { type Animal, FM_PERCH, type Group } from './types';
import { addFish, stockWaters } from './water';

export type Populations = Partial<Record<WildKind, number>>;

/** Animals in a newly made group of each species, by species index. */
const GROUP_SIZE = [5, 8, 3.4, 1, 5, 8, 8, 12, 6, 8];
/** Groups of one species make their homes at least this far apart, by species index. */
const APART = [45, 28, 30, 45, 60, 30, 40, 40, 0, 0];
/** Fewer than this many of a species cannot keep it going. */
const VIABLE = 2;
/** Days a species stays below that before others of its kind wander in. */
const ARRIVAL_DAYS = 3;

/** How many of each species this country would carry to begin with, from the extent of each habitat. */
function carrying(e: Eco): number[] {
  const h = e.habitat;
  const hectares = (c: number): number => ((h.total[c] as number) * STRIDE * STRIDE) / 10000;
  const meadow = hectares(H_MEADOW);
  const wood = hectares(H_WOOD);
  const high = hectares(H_HIGH);
  const sea = hectares(H_SEA);
  const out = new Array<number>(KIND_COUNT).fill(0);
  if (meadow > 0.2) out[DEER] = clamp(Math.round((meadow + wood) / 1.5), 1, 5) * 5;
  if (meadow > 0.1) out[RABBIT] = clamp(Math.round(meadow / 0.55), 1, 10) * 8;
  if (wood > 0.1) out[BOAR] = Math.round(clamp(Math.round(wood / 0.17), 1, 4) * 3.4);
  if (meadow + wood > 0.5) out[FOX] = clamp(Math.round((meadow + wood) / 1.1), 2, 6);
  if (meadow + wood + high > 2) out[WOLF] = 4;
  if (wood > 0.1) out[SONGBIRD] = clamp(Math.round(wood / 0.1), 1, 6) * 8;
  if (wood > 0.1 && meadow > 0.3) out[CROW] = clamp(Math.round((meadow + wood) / 5), 1, 2) * 8;
  if (sea > 0.2 && hectares(H_SHORE) > 0.02) out[GULL] = clamp(Math.round(sea / 0.8), 1, 2) * 12;
  let ducks = 0;
  for (const b of ponds(e)) ducks += clamp(Math.round(b.area / 45), 3, 9);
  out[DUCK] = ducks;
  return out;
}

/** The fresh waters big enough for ducks, largest first, three at most. */
function ponds(e: Eco): WaterBody[] {
  return e.habitat.bodies.filter((b) => !b.sea && b.area >= 60).sort((a, b) => b.area - a.area || a.id - b.id).slice(0, 3);
}

/** Stock the world: called once, when the simulation is made. */
export function seed(e: Eco, wanted: Populations): void {
  const natural = carrying(e);
  const h = e.habitat;
  e.mastCap = mastCapacity(e);
  e.mast = e.mastCap * 0.8;
  stockWaters(e, wanted.fish);

  for (let k = 0; k < KIND_COUNT; k++) {
    const sp = SPECIES[k] as Species;
    if (k === FISH) continue;
    const asked = wanted[WILD_KINDS[k] as WildKind];
    const n = asked === undefined ? (natural[k] as number) : Math.max(0, Math.round(asked));
    const made = settle(e, sp, n);
    e.cap[k] = made > 0 ? Math.max(sp.capMin, Math.ceil(made * sp.capFactor)) : 0;
    e.maxGroups[k] = Math.max(e.groupCount[k] as number, Math.ceil((e.cap[k] as number) / (GROUP_SIZE[k] as number)));
  }

  let slots = 0;
  for (const b of h.bodies) {
    for (let i = 0; i < b.slots; i++) addFish(e, b, e.rng.range(0, 30));
    slots += b.slots;
  }
  // The fish the world starts with were not born in it.
  e.births[FISH] = 0;
  e.cap[FISH] = slots;
  e.maxGroups[FISH] = e.groupCount[FISH] as number;
}

/** Make `n` animals of a species in as many groups as that takes. Returns how many were made. */
function settle(e: Eco, sp: Species, n: number): number {
  const k = sp.index;
  let made = 0;
  if (k === DUCK) {
    // Ducks go where the fresh water is, shared between the ponds by their size.
    const waters = ponds(e);
    let area = 0;
    for (const b of waters) area += b.area;
    let left = n;
    for (let i = 0; i < waters.length && left > 0; i++) {
      const b = waters[i] as WaterBody;
      const share = i === waters.length - 1 ? left : Math.min(left, Math.max(1, Math.round((n * b.area) / area)));
      made += newGroup(e, sp, Math.min(share, sp.groupMax), b);
      left -= share;
    }
    return made;
  }
  const size = GROUP_SIZE[k] as number;
  const groups = n <= 0 ? 0 : Math.max(1, Math.round(n / size));
  for (let i = 0; i < groups; i++) {
    // Spread the animals over the groups as evenly as whole numbers allow.
    const share = Math.floor((n * (i + 1)) / groups) - Math.floor((n * i) / groups);
    if (share > 0) made += newGroup(e, sp, Math.min(share, sp.groupMax), null);
  }
  return made;
}

/** The habitat a species makes its home in, with fallbacks for country that lacks it. */
function homeClasses(k: number): number[] {
  switch (k) {
    case DEER: return [H_MEADOW, H_WOOD];
    case RABBIT: return [H_MEADOW];
    case BOAR: return [H_WOOD, H_MEADOW];
    case FOX: return [H_WOOD, H_MEADOW];
    case WOLF: return [H_HIGH, H_WOOD, H_MEADOW];
    case GULL: return [H_SHORE, H_SEA];
    default: return [H_WOOD, H_MEADOW];
  }
}

function standY(e: Eco, x: number, z: number, y: number): number {
  return standCellNear(e.world, Math.floor(x), Math.floor(z), y, 3, WALK_OPT);
}

/**
 * Choose a home for a new group: a spot of the right habitat, outside avoided
 * areas, where a walker can stand, as far as may be from others of its kind.
 * Wolves want the remotest spot there is.
 */
function homeSite(e: Eco, sp: Species, out: Spot): boolean {
  const h = e.habitat;
  const k = sp.index;
  const walker = sp.fly === 0;
  const spot = e.spot;
  const apart = APART[k] as number;
  let best = -1;
  for (const cls of homeClasses(k)) {
    for (let t = 0; t < 30; t++) {
      if (!h.pick(cls, e.rng, spot) || h.inAvoid(spot.x, spot.z) || !h.inWorld(spot.x, spot.z, 6)) continue;
      let y = spot.y;
      if (walker) {
        y = standY(e, spot.x, spot.z, spot.y);
        if (y < 0) continue;
      }
      // Score: distance to the nearest home of the same species, capped so that beyond "far enough" all are equal.
      let near = 1e9;
      for (const g of e.groups) {
        if (g.gone || g.sp !== sp) continue;
        near = Math.min(near, Math.hypot(g.hx - spot.x, g.hz - spot.z));
      }
      let score = Math.min(near, apart);
      if (k === WOLF) {
        // Remote: far from where people are, and failing that far from the middle of the map.
        let people = 1e9;
        for (const area of h.avoid) people = Math.min(people, Math.hypot(area.x - spot.x, area.z - spot.z) - area.radius);
        score += h.avoid.length > 0 ? Math.min(people, 400) : Math.hypot(spot.x - e.world.sx / 2, spot.z - e.world.sz / 2);
      }
      if (score <= best) continue;
      best = score;
      out.x = spot.x;
      out.y = y;
      out.z = spot.z;
      if (k !== WOLF && near >= apart) return true;
    }
    if (best >= 0) return true;
  }
  return false;
}

/** Stand a walker somewhere within `r` of a point; at the point itself if nowhere else will do. */
function setDown(e: Eco, a: Animal, x: number, y: number, z: number, r: number): void {
  const w = e.world;
  for (let t = 0; t < 10; t++) {
    const px = Math.floor(x + e.rng.range(-r, r));
    const pz = Math.floor(z + e.rng.range(-r, r));
    if (px < 2 || pz < 2 || px >= w.sx - 2 || pz >= w.sz - 2 || e.habitat.inAvoid(px, pz)) continue;
    const cy = standCellNear(w, px, pz, y, 2, WALK_OPT);
    if (cy < 0) continue;
    placeWalker(e, a, px + 0.5, cy, pz + 0.5, standHeight(w, px, cy, pz, WALK_OPT));
    e.hash.insert(a);
    return;
  }
  const cx = Math.floor(x);
  const cz = Math.floor(z);
  placeWalker(e, a, cx + 0.5, y, cz + 0.5, standHeight(w, cx, y, cz, WALK_OPT));
  e.hash.insert(a);
}

/** Put a bird in the air over a point; it will come down where its flock is. */
function launch(e: Eco, a: Animal, x: number, z: number): void {
  const w = e.world;
  a.x = clamp(x + e.rng.range(-3, 3), 4, w.sx - 4);
  a.z = clamp(z + e.rng.range(-3, 3), 4, w.sz - 4);
  a.cx = Math.floor(a.x);
  a.cz = Math.floor(a.z);
  a.y = airFloor(w, a.cx, a.cz) + 3 + e.rng.range(0, 4);
  e.hash.insert(a);
  takeOff(e, a);
}

/** Make one group of `n` animals with a home of its own. Returns how many were made (0 if there is nowhere for it). */
function newGroup(e: Eco, sp: Species, n: number, body: WaterBody | null): number {
  const k = sp.index;
  const home: Spot = { x: 0, y: 0, z: 0 };
  if (body) e.habitat.pointIn(body, e.rng, home);
  else if (!homeSite(e, sp, home)) return 0;
  const g = addGroup(e, sp);
  g.hx = g.ax = g.bx = g.mx = home.x;
  g.hz = g.az = g.bz = g.mz = home.z;
  g.body = body;
  // Every other flock of songbirds is one that winters in the south.
  if (k === SONGBIRD) g.migratory = (e.groupCount[k] as number) % 2 === 0;
  if (sp.groupType === GT_FLOCK) {
    g.mode = FM_PERCH;
    g.until = e.now + 20;
  }
  populate(e, g, n, home.y);
  return n;
}

/** Add `n` grown animals to a group, around its home. */
function populate(e: Eco, g: Group, n: number, y: number): void {
  const sp = g.sp;
  for (let i = 0; i < n; i++) {
    // Alternate the sexes across the whole species, so every group holds both and lone foxes come in pairs.
    const female = ((e.count[sp.index] as number) & 1) === 1;
    // In their prime: a world that began with the old would lose them all in its first year.
    const a = addAnimal(e, sp, g, e.rng.range(sp.mature, sp.lifespan * 0.6), female);
    if (sp.fly > 0) launch(e, a, g.hx, g.hz);
    else setDown(e, a, g.hx, y, g.hz, sp.index === RABBIT ? 5 : 6);
  }
}

/**
 * Once a day: a species that has all but died out is given another start by a
 * few of its kind arriving from beyond the map. Fish need no such help; their
 * stock has its own trickle.
 */
export function arrivals(e: Eco, lowDays: Int32Array): void {
  for (let k = 0; k < KIND_COUNT; k++) {
    const sp = SPECIES[k] as Species;
    if (sp.groupType === GT_SCHOOL || (e.cap[k] as number) === 0) continue;
    if ((e.count[k] as number) + (e.awayCount[k] as number) >= VIABLE) {
      lowDays[k] = 0;
      continue;
    }
    lowDays[k] = (lowDays[k] as number) + 1;
    if ((lowDays[k] as number) < ARRIVAL_DAYS) continue;
    lowDays[k] = 0;
    let n = 0;
    // Join the survivors where the species lives in one group; otherwise found new ones.
    let host: Group | null = null;
    for (const g of e.groups) if (!g.gone && g.sp === sp && g.members.length > 0 && k !== FOX) host = g;
    if (host && sp.fly === 0) {
      const y = standY(e, host.hx, host.hz, Math.floor((host.members[0] as Animal).y));
      if (y >= 0) {
        populate(e, host, sp.arrive, y);
        n = sp.arrive;
      }
    }
    if (n === 0) {
      if (k === DUCK) for (const b of ponds(e).slice(0, 1)) n += newGroup(e, sp, sp.arrive, b);
      else if (k === FOX) for (let i = 0; i < sp.arrive; i++) n += newGroup(e, sp, 1, null);
      else n = newGroup(e, sp, sp.arrive, null);
    }
    e.arrivals[k] = (e.arrivals[k] as number) + n;
  }
}

