// Coming into the world and leaving it: making an animal, killing one, clearing
// its body away, pairing a couple and delivering the litter. Every count the
// census reports is kept here, as the events happen.

import { lerp } from '../../core/math';
import { DAYS_PER_SEASON, DAY_SECONDS } from '../clock';
import { halt } from './motion';
import { FISH, GT_BAND, GT_WARREN, type Species, bit } from './species';
import type { Eco } from './state';
import { airFloor } from './terrain';
import { Animal, CAUSES, Group, MODE_FLY, MODE_STILL, ST_COURT, ST_DEAD, ST_FLEE, ST_HIDE, WHY_BREED } from './types';

/** Seconds a body lies where it fell when nothing is eating it. */
const CARCASS = 30;
/** Seconds between a group's chances to pair two of its members. */
const COURT_EVERY = 240;
/** How far a male will come to join a group that has none. */
const SUITOR_REACH = 130;
/** A female carries her young for between this much and this much of her species' gestation. */
const CARRY_LEAST = 0.9;
const CARRY_MOST = 1.15;
/** Seconds a birth may run late: she delivers at her next thought, and a bird not until it has landed. */
const BIRTH_SLACK = 200;

/** The season (0 spring to 3 winter) that a moment of simulated time falls in. */
function seasonAt(time: number): number {
  return Math.floor(time / (DAYS_PER_SEASON * DAY_SECONDS)) % 4;
}

export function addGroup(e: Eco, sp: Species): Group {
  const g = new Group(e.nextGroup++, sp);
  g.nextUpdate = e.tick + 1 + (g.id % 20);
  e.groups.push(g);
  e.groupCount[sp.index] = (e.groupCount[sp.index] as number) + 1;
  return g;
}

/** Make an animal of a given age in a group. The caller places it and adds it to the spatial hash. */
export function addAnimal(e: Eco, sp: Species, g: Group, ageDays: number, female: boolean): Animal {
  const a = new Animal(sp, g);
  a.id = e.nextId++;
  a.look = e.rng.u32();
  a.female = female;
  a.born = e.now - ageDays * DAY_SECONDS;
  a.lifespan = sp.lifespan * DAY_SECONDS * e.rng.range(0.85, 1.12);
  a.size = e.rng.range(0.94, 1.06);
  // Constitution, 0.6 to 1.4, read off the bits of `look` the renderer makes least use of rather than drawn afresh.
  a.grit = 0.6 + (0.8 * (a.look >>> 12)) / 0xfffff;
  a.hunger = e.rng.range(0.1, 0.4);
  a.energy = e.rng.range(0.7, 1);
  a.cruise = e.rng.range(0.7, 1.3);
  a.thought = e.now;
  // Thoughts are spread across ticks so the cost of thinking is even.
  a.nextThink = e.tick + 1 + (a.id % sp.think);
  a.yaw = e.rng.range(-Math.PI, Math.PI);
  a.yawT = a.yaw;
  grow(a, e.now);
  a.slot = e.animals.length;
  e.animals.push(a);
  e.byId.set(a.id, a);
  g.members.push(a);
  e.count[sp.index] = (e.count[sp.index] as number) + 1;
  return a;
}

/** Set an animal's drawn size from its age. */
export function grow(a: Animal, now: number): void {
  const t = (now - a.born) / (a.sp.mature * DAY_SECONDS);
  a.scale = t >= 1 ? a.size : a.size * lerp(a.sp.birthScale, 1, t < 0 ? 0 : t);
}

export function isAdult(a: Animal, now: number): boolean {
  return now - a.born >= a.sp.mature * DAY_SECONDS;
}

/** Kill an animal. Its body stays in view for `carcass` seconds, then is cleared away. */
export function kill(e: Eco, a: Animal, cause: number, carcass = CARCASS): void {
  if (!a.alive) return;
  const k = a.sp.index;
  if (a.mode === MODE_FLY) a.y = airFloor(e.world, a.cx, a.cz);
  halt(a);
  a.alive = false;
  a.hidden = false;
  a.state = ST_DEAD;
  a.anim = 'dead';
  a.mode = MODE_STILL;
  a.prey = null;
  a.landing = false;
  a.removeAt = e.now + carcass;
  a.nextThink = e.tick + Math.ceil(carcass * 10);
  e.hash.remove(a);
  e.count[k] = (e.count[k] as number) - 1;
  e.deaths[k] = (e.deaths[k] as number) + 1;
  e.deathsBy[k * CAUSES + cause] = (e.deathsBy[k * CAUSES + cause] as number) + 1;
  const g = a.group;
  const at = g.members.indexOf(a);
  if (at >= 0) g.members.splice(at, 1);
  // One fewer fish is drawn in its water.
  if (k === FISH && g.body && g.body.shown > 0) g.body.shown--;
  if (a.mother) {
    if (a.mother.alive) a.mother.young--;
    a.mother = null;
  }
}

/** Take an animal out of the drawn list. It keeps its record: a bird gone for the winter comes back as itself. */
export function withdraw(e: Eco, a: Animal): void {
  const list = e.animals;
  const i = a.slot;
  if (i < 0) return;
  const last = list.pop() as Animal;
  if (last !== a) {
    list[i] = last;
    last.slot = i;
  }
  a.slot = -1;
}

/** Clear a body away for good. */
export function bury(e: Eco, a: Animal): void {
  withdraw(e, a);
  e.byId.delete(a.id);
}

/** Drop a group that has no members left. */
export function closeGroup(e: Eco, g: Group): void {
  if (g.gone) return;
  g.gone = true;
  e.groupCount[g.sp.index] = (e.groupCount[g.sp.index] as number) - 1;
}

/** A grown, well-fed female of this group that is not carrying or nursing and may breed now, or null. */
export function readyFemale(e: Eco, g: Group): Animal | null {
  const sp = g.sp;
  const k = sp.index;
  const now = e.now;
  if (now < g.nextCourt) return null;
  // The young come in their season, so the courting runs a gestation ahead of it: it begins while the season
  // before is ending and stops when a litter could no longer be born in time.
  const carry = sp.gestation * DAY_SECONDS;
  if (!sp.breed[seasonAt(now + carry * CARRY_LEAST)] || !sp.breed[seasonAt(now + carry * CARRY_MOST + BIRTH_SLACK)]) return null;
  // One chance every few hours, and it may not take: a group's young arrive over days, not all at once.
  g.nextCourt = now + COURT_EVERY;
  if (!e.rng.chance(sp.fertility)) return null;
  if ((e.count[k] as number) + (e.awayCount[k] as number) >= (e.cap[k] as number)) return null;
  for (const a of g.members) {
    if (!a.female || a.state === ST_FLEE || a.state === ST_COURT || a.mother || !isAdult(a, now)) continue;
    if (a.dueAt === 0 && now >= a.nextBreed && a.young === 0 && a.hunger < 0.5 && a.health > 0.6) return a;
  }
  return null;
}

export function readyMale(e: Eco, a: Animal): boolean {
  return a.alive && !a.female && !a.mother && a.state !== ST_FLEE && a.state !== ST_COURT && a.hunger < 0.7 && isAdult(a, e.now);
}

/**
 * She conceives at once; the courtship that follows is for show, and a rabbit
 * down its burrow puts on none: it stays below, where nobody would see it.
 */
export function conceive(e: Eco, f: Animal, m: Animal): void {
  const sp = f.sp;
  f.dueAt = e.now + sp.gestation * DAY_SECONDS * e.rng.range(CARRY_LEAST, CARRY_MOST);
  f.nextBreed = f.dueAt + sp.rebreed * DAY_SECONDS;
  for (const a of [f, m]) {
    if (a.state === ST_HIDE) continue;
    a.state = ST_COURT;
    a.why = WHY_BREED;
    a.until = e.now + 12;
  }
}

/**
 * Find a pair ready to breed and start them courting. Returns [female, male],
 * or null. The male is one of her own group if it has one. If it has none, and
 * the species lives in herds or warrens, a male comes over from the nearest
 * group that has one and stays: left to chance, small groups drift to a single
 * sex and the species stops breeding with animals to spare.
 */
export function pairUp(e: Eco, g: Group): [Animal, Animal] | null {
  const f = readyFemale(e, g);
  if (!f) return null;
  for (const m of g.members) {
    if (!readyMale(e, m)) continue;
    conceive(e, f, m);
    return [f, m];
  }
  const type = g.sp.groupType;
  if ((type !== GT_BAND && type !== GT_WARREN) || g.members.length >= g.sp.groupMax) return null;
  const n = e.hash.collect(f.x, f.z, SUITOR_REACH, bit(g.sp.index), e.found);
  let best: Animal | null = null;
  let bestD = Infinity;
  for (let i = 0; i < n; i++) {
    const m = e.found[i] as Animal;
    if (m.group === g || !readyMale(e, m)) continue;
    const d = (m.x - f.x) * (m.x - f.x) + (m.z - f.z) * (m.z - f.z);
    if (d < bestD && !e.habitat.crossesWater(f.x, f.z, m.x, m.z)) {
      bestD = d;
      best = m;
    }
  }
  if (!best) return null;
  const old = best.group.members;
  old.splice(old.indexOf(best), 1);
  best.group = g;
  g.members.push(best);
  conceive(e, f, best);
  return [f, best];
}

/**
 * Chance that a newborn of this species is female. Even when the sexes are
 * level, and nine in ten for whichever sex the species is short of by a tenth
 * of its number or more: among four foxes or five wolves a run of sons would
 * otherwise end the line with animals to spare, and it did. Only those with
 * life left to breed are counted, so two old vixens do not hide that every cub
 * so far is a dog fox. In a large population the lean is too slight to see.
 */
function femaleOdds(e: Eco, k: number): number {
  let females = 0;
  let males = 0;
  for (const a of e.animals) {
    if (!a.alive || a.sp.index !== k || e.now - a.born > a.lifespan * 0.8) continue;
    if (a.female) females++;
    else males++;
  }
  const lean = (males - females) / Math.max(1, (males + females) * 0.1);
  return 0.5 + 0.4 * (lean < -1 ? -1 : lean > 1 ? 1 : lean);
}

/**
 * Deliver a litter beside the mother. Litters are larger when the species is
 * scarce and smaller as it nears its cap, and never take it or the group past
 * their limits. Returns the newborn, which start exactly where she is.
 */
export function birth(e: Eco, mother: Animal): Animal[] {
  const sp = mother.sp;
  const k = sp.index;
  const g = mother.group;
  mother.dueAt = 0;
  const cap = e.cap[k] as number;
  const have = (e.count[k] as number) + (e.awayCount[k] as number);
  const crowd = cap > 0 ? have / cap : 1;
  let n = Math.round(lerp(sp.litter[1], sp.litter[0], crowd) + e.rng.range(-0.5, 0.5));
  n = Math.min(Math.max(n, sp.litter[0]), sp.litter[1], cap - have, sp.groupMax - g.members.length);
  const out: Animal[] = [];
  for (let i = 0; i < n; i++) {
    const c = addAnimal(e, sp, g, 0, e.rng.chance(femaleOdds(e, k)));
    c.hunger = 0.1;
    c.mother = mother;
    c.x = mother.x;
    c.y = mother.y;
    c.z = mother.z;
    c.cx = mother.cx;
    c.cy = mother.cy;
    c.cz = mother.cz;
    c.gy = mother.gy;
    c.perchFloor = mother.perchFloor;
    if (mother.state === ST_HIDE) {
      // Born below ground, and not seen until they come up with her.
      c.state = ST_HIDE;
      c.hidden = true;
    }
    e.hash.insert(c);
    out.push(c);
  }
  mother.young += out.length;
  e.births[k] = (e.births[k] as number) + out.length;
  return out;
}
