// What every animal's mind has in common, whatever its species: needs that
// build between thoughts, noticing danger, running from it, finding a mouthful
// and eating it, and a youngster keeping to its mother. The guild files build
// their daily habits out of these.

import { B, SOLID } from '../../world/blocks';
import { DAY_SECONDS } from '../clock';
import { halt, walkTo } from './motion';
import { birth, grow, kill } from './population';
import { BOAR, CROW, DEER, DUCK, GT_BAND, GT_WARREN, GULL, RABBIT, SONGBIRD, bit } from './species';
import type { Eco } from './state';
import { FOOD } from './terrain';
import {
  type Animal, DIED_AGE, DIED_HUNGER, type Group, MODE_FLY, MODE_STILL, MODE_WALK, ST_FLEE, ST_FOLLOW, ST_HIDE, ST_REST,
  ST_ROOST, ST_SLEEP, WHY_MOTHER, WHY_PREDATOR,
} from './types';

/**
 * Days of going without, once starving, before an animal of average
 * constitution dies of it. Constitutions differ, so a hungry herd thins over
 * some days, the survivors finding more as it does, rather than dying as one.
 */
const STARVE_DAYS = 3;
/** Days of eating well to mend from the brink. */
const MEND_DAYS = 4;
/**
 * Hunger a bush of berries takes off, relative to a mouthful of grass, and at
 * most: never more than about a third of what the animal needs in a day, so
 * that berries take the edge off a fox's hunger without keeping it alive.
 */
const BERRY_WORTH = 2.5;
const BERRY_MOST = 0.15;
const BERRY_SHARE = 0.35;
/**
 * Chance, each time it is put to the test, that an animal notices a hunter
 * creeping up within its wariness. Many eyes: in a big group each animal
 * leaves the watching to the others and is easily surprised; one of the last
 * few in a group must keep its own watch, and rarely is. This is what makes a
 * thinned warren hard to hunt, and so lets it recover.
 */
const NOTICE_MANY = 0.2;
const NOTICE_FEW = 0.75;
const MANY = 10;
const FEW = 2;

function notices(e: Eco, p: Animal): boolean {
  const n = p.group.members.length;
  const t = n >= MANY ? 1 : n <= FEW ? 0 : (n - FEW) / (MANY - FEW);
  return e.rng.chance(NOTICE_FEW + (NOTICE_MANY - NOTICE_FEW) * t);
}
/** Species that are somebody's prey and so watch for hunters. */
export const PREY = bit(DEER) | bit(RABBIT) | bit(BOAR);

/** Offsets of the 5 x 5 block around a cell, nearest first, as (dx, dz) pairs. */
const RING: number[] = [];
for (let r = 0; r <= 2; r++) {
  for (let dz = -2; dz <= 2; dz++) {
    for (let dx = -2; dx <= 2; dx++) {
      if (Math.max(Math.abs(dx), Math.abs(dz)) === r) RING.push(dx, dz);
    }
  }
}

/** Schedule the next thought `seconds` from now. */
export function wait(e: Eco, a: Animal, seconds: number): void {
  a.nextThink = e.tick + Math.max(1, Math.round(seconds * 10));
}

/**
 * Bring hunger, energy, health, growth and age up to date since the last
 * thought, wean the grown, and deliver the due. Returns false if the animal
 * died of it.
 */
export function needs(e: Eco, a: Animal): boolean {
  const now = e.now;
  const dt = now - a.thought;
  a.thought = now;
  if (dt <= 0) return true;
  const sp = a.sp;
  const asleep = a.state === ST_SLEEP || a.state === ST_ROOST || a.state === ST_HIDE;

  a.hunger += ((sp.hungerPerDay * dt) / DAY_SECONDS) * (asleep ? 0.6 : 1);
  if (a.mother) suckle(a, a.mother, dt);
  if (a.hunger >= 1) {
    a.hunger = 1;
    a.health -= dt / (STARVE_DAYS * DAY_SECONDS * a.grit);
    if (a.health <= 0) {
      kill(e, a, DIED_HUNGER);
      return false;
    }
  } else if (a.health < 1 && a.hunger < 0.6) {
    a.health = Math.min(1, a.health + dt / (MEND_DAYS * DAY_SECONDS));
  }

  if (a.mode === MODE_WALK && a.speed > sp.walk * 1.7) a.energy -= dt / sp.stamina;
  else if (a.mode !== MODE_STILL) a.energy -= dt / 2400;
  else a.energy += dt / (asleep || a.state === ST_REST ? 240 : 700);
  a.energy = a.energy < 0 ? 0 : a.energy > 1 ? 1 : a.energy;

  const age = now - a.born;
  if (age > a.lifespan) {
    kill(e, a, DIED_AGE);
    return false;
  }
  if (age < sp.mature * DAY_SECONDS) grow(a, now);
  else a.scale = a.size;
  if (a.mother && (age > sp.wean * DAY_SECONDS || !a.mother.alive)) {
    if (a.mother.alive) a.mother.young--;
    a.mother = null;
  }
  // Not on the wing: the young start where their mother is.
  if (a.dueAt !== 0 && now >= a.dueAt && a.mode !== MODE_FLY) birth(e, a);
  return true;
}

/** A youngster near its mother is fed by her, at a cost to her. */
function suckle(a: Animal, m: Animal, dt: number): void {
  const dx = a.x - m.x;
  const dz = a.z - m.z;
  if (dx * dx + dz * dz > 64 || m.hunger > 0.9) return;
  const milk = Math.min(a.hunger, ((a.sp.hungerPerDay * dt) / DAY_SECONDS) * 3);
  a.hunger -= milk;
  m.hunger = Math.min(1, m.hunger + milk * 0.5);
}

/** How fast an animal can go relative to a fit adult: the young, the old, the starving and the spent are slower. */
export function vigour(e: Eco, a: Animal): number {
  let v = a.scale < a.size ? 0.7 + 0.3 * (a.scale / a.size) : 1;
  if (e.now - a.born > a.lifespan * 0.85) v *= 0.85;
  if (a.hunger > 0.8) v *= 0.85;
  if (a.energy < 0.15) v *= 0.6;
  return v;
}

export function runSpeed(e: Eco, a: Animal): number {
  return a.sp.run * vigour(e, a);
}

/** Tell an animal that there is danger at (x, z): a hunter, or a person. It reacts at once. */
export function alarm(e: Eco, a: Animal, x: number, z: number, why: number): void {
  a.alarmUntil = e.now + 4;
  a.alarmX = x;
  a.alarmZ = z;
  a.alarmWhy = why;
  if (a.nextThink > e.tick + 1) a.nextThink = e.tick + 1;
}

/** One of a herd has seen danger: the whole herd knows, and will feed somewhere else afterwards. */
export function alarmGroup(e: Eco, g: Group, x: number, z: number, why: number): void {
  if (g.alarmUntil > e.now + 3) return;
  g.alarmUntil = e.now + 5;
  g.alarmX = x;
  g.alarmZ = z;
  g.hasFeed = false;
  for (const m of g.members) {
    const dx = m.x - x;
    const dz = m.z - z;
    if (dx * dx + dz * dz < 40 * 40) alarm(e, m, x, z, why);
  }
}

/**
 * A hunter gives itself away to the prey around it. At a run it is plain to
 * every animal within that animal's wariness, and a herd that sees it takes
 * fright together. Creeping, it is only noticed from close to, and then only
 * by chance and by the animal that happens to look up: that chance, taken a
 * few times on the way in, is what decides whether a stalk comes off.
 */
export function scare(e: Eco, hunter: Animal, running: boolean): void {
  const n = e.hash.collect(hunter.x, hunter.z, 24, PREY, e.found);
  for (let i = 0; i < n; i++) {
    const p = e.found[i] as Animal;
    if (p.state === ST_HIDE || p.alarmUntil > e.now + 2) continue;
    const wary = p.sp.wary[running ? 1 : 0];
    const dx = p.x - hunter.x;
    const dz = p.z - hunter.z;
    if (dx * dx + dz * dz > wary * wary) continue;
    if (!running) {
      if (notices(e, p)) alarm(e, p, hunter.x, hunter.z, WHY_PREDATOR);
      continue;
    }
    alarm(e, p, hunter.x, hunter.z, WHY_PREDATOR);
    const type = p.sp.groupType;
    if (type === GT_BAND || type === GT_WARREN) alarmGroup(e, p.group, hunter.x, hunter.z, WHY_PREDATOR);
  }
}

/** Run from (fx, fz). */
export function fleeFrom(e: Eco, a: Animal, fx: number, fz: number, why: number): void {
  const ang = Math.atan2(a.x - fx, a.z - fz) + e.rng.range(-0.5, 0.5);
  const dist = a.sp.flight * 1.5 + 10;
  const speed = runSpeed(e, a);
  a.state = ST_FLEE;
  a.why = why;
  a.until = e.now + 3.5;
  a.prey = null;
  a.hasFood = false;
  // If the way straight off is shut, break to one side rather than stand and be caught.
  if (!walkTo(e, a, a.x + Math.sin(ang) * dist, a.z + Math.cos(ang) * dist, speed) && a.failed) {
    const turn = (a.id & 1 ? 1.5 : -1.5) + e.rng.range(-0.3, 0.3);
    walkTo(e, a, a.x + Math.sin(ang + turn) * dist, a.z + Math.cos(ang + turn) * dist, speed);
  }
  wait(e, a, 0.6);
}

/**
 * Look for something to eat: first the cells within two blocks, nearest first,
 * then a few glances farther off across open ground. Leaves the cell in the
 * animal's `food` fields.
 */
export function findFood(e: Eco, a: Animal, diet: number): boolean {
  const w = e.world;
  const cy = a.cy;
  // Mirror the search at random so a herd does not all eat toward the same corner.
  const flip = e.rng.u32();
  const fx = flip & 1 ? 1 : -1;
  const fz = flip & 2 ? 1 : -1;
  for (let i = 0; i < RING.length; i += 2) {
    const x = a.cx + (RING[i] as number) * fx;
    const z = a.cz + (RING[i + 1] as number) * fz;
    let y = cy;
    let s = w.get(x, y, z);
    if (!(FOOD[s] & diet)) {
      // One block up a rise, or one down a dip.
      if (SOLID[s]) y = cy + 1;
      else if (s === B.air) y = cy - 1;
      else continue;
      s = w.get(x, y, z);
      if (!(FOOD[s] & diet)) continue;
    }
    a.foodX = x;
    a.foodY = y;
    a.foodZ = z;
    return true;
  }
  for (let i = 0; i < 6; i++) {
    const x = a.cx + ((flip >>> (4 + i * 4)) & 15) - 8;
    const z = a.cz + e.rng.intRange(-8, 8);
    const y = w.height(x, z);
    if (y - cy > 3 || cy - y > 3 || !(FOOD[w.get(x, y, z)] & diet)) continue;
    a.foodX = x;
    a.foodY = y;
    a.foodZ = z;
    return true;
  }
  return false;
}

/**
 * Finish the mouthful at the animal's food cell, if it is still there: the
 * plant is eaten out of the world, and a bush is stripped of its berries.
 */
export function eatFood(e: Eco, a: Animal): boolean {
  const w = e.world;
  const s = w.get(a.foodX, a.foodY, a.foodZ);
  a.hasFood = false;
  if (!(FOOD[s] & a.sp.diet)) return false;
  let worth = a.sp.bite;
  if (s === B.berry_bush + 1) {
    e.flora.strip(a.foodX, a.foodY, a.foodZ);
    worth = Math.min(worth * BERRY_WORTH, BERRY_MOST, a.sp.hungerPerDay * BERRY_SHARE);
  } else {
    w.set(a.foodX, a.foodY, a.foodZ, B.air);
  }
  a.hunger = Math.max(0, a.hunger - worth);
  e.eaten[a.sp.index] = (e.eaten[a.sp.index] as number) + 1;
  return true;
}

/**
 * A youngster on the ground keeps close to its mother, runs when she runs and
 * sleeps when she sleeps. Returns false when it has no mother to follow.
 */
export function followMother(e: Eco, a: Animal): boolean {
  const m = a.mother;
  if (!m || !m.alive) return false;
  const dx = m.x - a.x;
  const dz = m.z - a.z;
  const d2 = dx * dx + dz * dz;
  if (m.state === ST_FLEE && m.hasGoal) {
    a.state = ST_FLEE;
    a.why = WHY_MOTHER;
    walkTo(e, a, m.gx, m.gz, runSpeed(e, a), 1.5);
    wait(e, a, 0.8);
    return true;
  }
  if (d2 > 9) {
    a.state = ST_FOLLOW;
    a.why = WHY_MOTHER;
    const off = ((a.id % 5) - 2) * 0.4;
    walkTo(e, a, m.x + off, m.z - off, d2 > 100 ? runSpeed(e, a) * 0.8 : a.sp.walk * 1.5, 1.4);
    wait(e, a, 1.5);
    return true;
  }
  if (a.mode !== MODE_STILL) halt(a);
  const asleep = m.state === ST_SLEEP || m.state === ST_HIDE;
  a.state = asleep ? ST_SLEEP : ST_FOLLOW;
  a.why = WHY_MOTHER;
  a.anim = asleep ? 'sleep' : 'idle';
  wait(e, a, asleep ? 6 : 2.5);
  return true;
}

/** Share of the day a bird must spend feeding to hold its weight when food is plentiful. */
const FEED_SHARE = 0.2;
/** How much there is for each kind of bird to find, by season: winter is lean. */
const SUPPLY: Record<number, readonly number[]> = {
  [SONGBIRD]: [1.2, 1.3, 1.1, 0.8],
  [CROW]: [1.1, 1.1, 1.1, 0.9],
  [GULL]: [1, 1, 1, 0.9],
  [DUCK]: [1.2, 1.2, 1, 0.85],
};
/** Fish a gull takes from the sea for each unit of hunger it sates. */
const GULL_CATCH = 1.2;

/**
 * A bird feeds for `seconds`: seeds and insects for the land birds, whatever
 * the water offers for ducks. What it finds is not a block in the world, so it
 * is simply worth more or less with the season.
 */
export function forage(e: Eco, a: Animal, seconds: number): void {
  const sp = a.sp;
  const supply = (SUPPLY[sp.index] as readonly number[])[e.season] as number;
  let got = (sp.hungerPerDay / (DAY_SECONDS * FEED_SHARE)) * seconds * supply;
  if (sp.index === GULL) {
    // Gulls feed from the sea: a fished-out coast feeds few, and what they take comes off the stock.
    const body = e.habitat.bodyNear(a.x, a.z, 12);
    got = Math.min(a.hunger, got * (body ? body.stock / Math.max(1, body.capacity) : 0.3));
    if (body) body.stock = Math.max(0, body.stock - got * GULL_CATCH);
  }
  a.hunger = Math.max(0, a.hunger - got);
}
