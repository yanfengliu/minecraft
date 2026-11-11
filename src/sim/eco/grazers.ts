// Deer, rabbits and boar, one animal at a time: the animals that live on
// plants. Where its group is feeding or lying up is decided for the group as
// a whole (bands.ts); here each member walks there, finds its own mouthfuls
// and eats them out of the world, runs from danger, and rests. Rabbits differ
// in having a burrow they bolt to; boar in rooting the forest floor when there
// is nothing green in reach.

import { B } from '../../world/blocks';
import { standCellNear } from '../../world/walk';
import { alarmGroup, eatFood, findFood, fleeFrom, followMother, runSpeed, wait } from './brain';
import { WALK_OPT, footingOk, halt, unstick, walkTo } from './motion';
import { BOAR, GT_WARREN } from './species';
import type { Eco } from './state';
import {
  type Animal, GM_ALARM, GM_FEED, GM_SHELTER, GM_SLEEP, type Group, MODE_STILL, MODE_WALK, ST_COURT, ST_EAT, ST_FLEE, ST_HIDE,
  ST_IDLE, ST_REST, ST_SEEK, ST_SLEEP, ST_TRAVEL, ST_WANDER, WHY_BAND, WHY_DAY, WHY_FED, WHY_HABIT, WHY_HUNGRY, WHY_NIGHT,
  WHY_PERSON, WHY_RAIN, WHY_STARVING,
} from './types';

/** How far from where the group is feeding a member will graze. */
const FEED_RANGE = 14;
/** How near the lying-up place counts as being there. */
const COVER_RANGE = 7;
/** Below this hunger an animal does not bother to eat. */
const PECKISH = 0.12;
/**
 * Seconds between thoughts for an animal that is asleep, resting or in its
 * burrow, and for one that is walking somewhere. They can be long because
 * nothing depends on them: arriving, a change of plan by the group, a hunter
 * and a person coming near each wake the animal themselves.
 */
const LONG_NAP = 10;
const ON_THE_WAY = 4;
/** How far an animal caught in the open by rain will look for a tree to stand under. */
const SHELTER_REACH = 6;

/** Where a rabbit sits in its warren: all in the home cell, a little apart. */
function seatX(a: Animal): number {
  return a.group.hx + ((a.id % 3) - 1) * 0.3;
}
function seatZ(a: Animal): number {
  return a.group.hz + ((Math.floor(a.id / 3) % 3) - 1) * 0.3;
}

function enterBurrow(e: Eco, a: Animal, seconds: number): void {
  if (a.mode !== MODE_STILL) halt(a);
  a.state = ST_HIDE;
  a.until = e.now + seconds;
  a.anim = 'idle';
  wait(e, a, Math.max(1, Math.min(seconds, LONG_NAP)));
}

/** Take fright: rabbits bolt for the warren, the rest run straight away from the danger. */
function bolt(e: Eco, a: Animal, fx: number, fz: number, why: number): void {
  if (a.sp.groupType !== GT_WARREN) {
    fleeFrom(e, a, fx, fz, why);
    return;
  }
  a.state = ST_FLEE;
  a.why = why;
  a.until = e.now + 10;
  a.hasFood = false;
  if (walkTo(e, a, seatX(a), seatZ(a), runSpeed(e, a), 0.7)) wait(e, a, 0.6);
  else if (a.arrived) enterBurrow(e, a, e.rng.range(10, 22));
  else fleeFrom(e, a, fx, fz, why);
}

export function thinkGrazer(e: Eco, a: Animal): void {
  const sp = a.sp;
  const g = a.group;
  const now = e.now;
  a.nextThink = e.tick + sp.think + (a.id & 3);

  // A burrow is safe: nothing reaches a rabbit there, and it stays until all is quiet and it is time to feed.
  if (a.state === ST_HIDE) {
    if (e.personNear(a.x, a.y, a.z, sp.flight)) a.until = Math.max(a.until, now + 8);
    if (now < a.until || a.alarmUntil > now || g.mode !== GM_FEED) {
      a.anim = g.mode === GM_SLEEP ? 'sleep' : 'idle';
      if (now >= a.until && a.alarmUntil <= now) a.why = g.mode === GM_SLEEP ? WHY_NIGHT : g.mode === GM_SHELTER ? WHY_RAIN : WHY_DAY;
      wait(e, a, now < a.until ? Math.min(a.until - now + 0.2, LONG_NAP) : LONG_NAP);
      return;
    }
    a.state = ST_IDLE;
  }

  // --- danger comes before everything ---
  if (e.personNear(a.x, a.y, a.z, sp.flight)) {
    alarmGroup(e, g, e.px, e.pz, WHY_PERSON);
    if (a.state === ST_FLEE && a.mode === MODE_WALK) {
      a.until = Math.max(a.until, now + 3);
      wait(e, a, 0.6);
    } else bolt(e, a, e.px, e.pz, WHY_PERSON);
    return;
  }
  if (a.alarmUntil > now) {
    if (a.state !== ST_FLEE || a.mode !== MODE_WALK) bolt(e, a, a.alarmX, a.alarmZ, a.alarmWhy);
    else wait(e, a, 0.5);
    return;
  }
  if (a.state === ST_FLEE) {
    if (a.mode === MODE_WALK && now < a.until) {
      wait(e, a, 0.5);
      return;
    }
    if (sp.groupType === GT_WARREN && a.arrived) {
      enterBurrow(e, a, e.rng.range(10, 22));
      return;
    }
    // Far enough: stop, look back, get its breath.
    halt(a);
    a.state = ST_IDLE;
    a.anim = 'idle';
    a.until = now + 2;
    wait(e, a, 2);
    return;
  }

  if (a.mother && followMother(e, a)) return;

  if (a.state === ST_EAT) {
    if (now < a.until) {
      wait(e, a, a.until - now);
      return;
    }
    if (a.hasFood) eatFood(e, a);
    else if (e.mast > 0 && e.rng.float() < e.mast / e.mastCap) {
      // What a boar turns up from the forest floor comes out of the woods' store of mast.
      e.mast -= 1;
      a.hunger = Math.max(0, a.hunger - sp.bite);
      e.eaten[sp.index] = (e.eaten[sp.index] as number) + 1;
    }
    a.state = ST_IDLE;
    a.anim = 'idle';
  }
  if (a.state === ST_COURT) {
    if (now < a.until) {
      wait(e, a, Math.min(2, a.until - now));
      return;
    }
    a.state = ST_IDLE;
  }

  // The ground can change under an animal that is standing still: a block placed, or dug away.
  if (a.mode === MODE_STILL && !footingOk(e, a)) unstick(e, a);

  if (g.mode === GM_FEED || a.hunger > 0.85) feed(e, a, g);
  else if (g.mode === GM_ALARM) {
    // The herd is alert but nothing has come near this one: stand and watch.
    if (a.mode === MODE_STILL) a.anim = 'idle';
    wait(e, a, 1);
  } else layUp(e, a, g);
}

function beginEating(e: Eco, a: Animal): void {
  a.state = ST_EAT;
  a.anim = 'eat';
  a.until = e.now + a.sp.eatTime;
  if (a.hasFood) a.yawT = Math.atan2(a.foodX + 0.5 - a.x, a.foodZ + 0.5 - a.z);
  wait(e, a, a.sp.eatTime);
}

/** A random point within `r` of (x, z), left in `e.spot`. */
function scatter(e: Eco, x: number, z: number, r: number): void {
  const ang = e.rng.range(0, Math.PI * 2);
  const d = r * Math.sqrt(e.rng.float());
  e.spot.x = x + Math.sin(ang) * d;
  e.spot.z = z + Math.cos(ang) * d;
}

function feed(e: Eco, a: Animal, g: Group): void {
  const sp = a.sp;
  const now = e.now;
  const range = sp.groupType === GT_WARREN ? g.range : FEED_RANGE;
  const dx = g.ax - a.x;
  const dz = g.az - a.z;
  const d2 = dx * dx + dz * dz;
  if (d2 > (range + 4) * (range + 4)) {
    // Too far from where the group is feeding: go there first.
    if (a.state !== ST_TRAVEL || a.mode !== MODE_WALK) {
      scatter(e, g.ax, g.az, range * 0.6);
      a.state = ST_TRAVEL;
      a.why = WHY_BAND;
      walkTo(e, a, e.spot.x, e.spot.z, d2 > 2500 ? sp.walk * 2.4 : sp.walk * 1.5, 1.5);
      if (a.failed) g.misses += 2;
    }
    wait(e, a, a.mode === MODE_WALK ? ON_THE_WAY : 2);
    return;
  }
  if (a.hunger > PECKISH) {
    const why = a.hunger > 0.85 ? WHY_STARVING : a.hunger > 0.5 ? WHY_HUNGRY : WHY_HABIT;
    if (a.state === ST_SEEK && a.hasFood) {
      if (a.mode === MODE_WALK) {
        wait(e, a, ON_THE_WAY);
        return;
      }
      if (a.arrived) {
        beginEating(e, a);
        return;
      }
      a.hasFood = false;
    }
    if (findFood(e, a, sp.diet)) {
      a.state = ST_SEEK;
      a.why = why;
      a.hasFood = true;
      if (walkTo(e, a, a.foodX + 0.5, a.foodZ + 0.5, sp.walk, 0.9)) {
        wait(e, a, ON_THE_WAY);
        return;
      }
      if (a.arrived) {
        beginEating(e, a);
        return;
      }
      a.hasFood = false;
    }
    g.misses++;
    if (sp.index === BOAR && a.mode === MODE_STILL && e.world.get(a.cx, a.cy - 1, a.cz) === B.forest_floor && e.rng.chance(0.6)) {
      a.why = why;
      beginEating(e, a);
      return;
    }
    // Nothing in reach: move on and look again.
    if (a.mode !== MODE_WALK || a.state !== ST_SEEK) {
      scatter(e, g.ax, g.az, range);
      a.state = ST_SEEK;
      a.why = why;
      walkTo(e, a, e.spot.x, e.spot.z, sp.walk * 1.3, 1);
    }
    return;
  }
  // Fed: stand about, with the odd stroll.
  if (a.mode === MODE_WALK) {
    wait(e, a, ON_THE_WAY);
    return;
  }
  if (now >= a.until) {
    a.why = WHY_FED;
    if (e.rng.chance(0.2)) {
      scatter(e, g.ax, g.az, range * 0.7);
      a.state = ST_WANDER;
      walkTo(e, a, e.spot.x, e.spot.z, sp.walk, 1);
      a.until = now + 4;
    } else {
      a.state = ST_IDLE;
      a.anim = 'idle';
      a.until = now + e.rng.range(6, 14);
    }
  }
  wait(e, a, a.mode === MODE_WALK ? ON_THE_WAY : Math.max(1, a.until - now));
}

/** Go to where the group lies up and rest or sleep there. */
function layUp(e: Eco, a: Animal, g: Group): void {
  const warren = a.sp.groupType === GT_WARREN;
  const why = g.mode === GM_SLEEP ? WHY_NIGHT : g.mode === GM_SHELTER ? WHY_RAIN : WHY_DAY;
  let tx: number;
  let tz: number;
  let near: number;
  if (warren) {
    tx = seatX(a);
    tz = seatZ(a);
    near = 0.8;
  } else {
    // Each member has its own place around the spot, so a herd lies in a loose group, not a heap.
    const ang = a.id * 2.4;
    const r = 1.5 + (a.id % 4);
    tx = g.bx + Math.sin(ang) * r;
    tz = g.bz + Math.cos(ang) * r;
    near = COVER_RANGE;
  }
  const dx = g.bx - a.x;
  const dz = g.bz - a.z;
  const d2 = dx * dx + dz * dz;
  // Out of the rain already, and near enough the others: stay put rather than walk back into it.
  const dry = g.mode === GM_SHELTER && !warren && a.mode === MODE_STILL && !e.world.exposed(a.cx, a.cy, a.cz);
  if (dry && d2 < (near + SHELTER_REACH + 2) * (near + SHELTER_REACH + 2)) {
    rest(e, a, g, why);
    return;
  }
  if (d2 > near * near) {
    if (a.state !== ST_TRAVEL || a.mode !== MODE_WALK) {
      a.state = ST_TRAVEL;
      a.why = why;
      walkTo(e, a, tx, tz, d2 > 2500 ? a.sp.walk * 2.4 : a.sp.walk * 1.5, warren ? 0.7 : 2);
      // A lying-up place that cannot be reached is no use: the group will choose another.
      if (a.failed && d2 > 400) g.hasCover = false;
      if (a.failed) {
        rest(e, a, g, why);
        return;
      }
    }
    wait(e, a, ON_THE_WAY);
    return;
  }
  if (warren) {
    a.why = why;
    enterBurrow(e, a, 0);
    return;
  }
  if (a.mode === MODE_WALK && a.state === ST_TRAVEL) {
    // Inside the lying-up place and still walking to its own spot.
    wait(e, a, ON_THE_WAY);
    return;
  }
  rest(e, a, g, why);
}

/**
 * Find the nearest cell within reach that a walker can stand in and that has
 * something overhead to keep the rain off. Leaves it in `e.spot`.
 */
function findShelter(e: Eco, a: Animal): boolean {
  const w = e.world;
  for (let ring = 1; ring <= SHELTER_REACH; ring++) {
    for (let dz = -ring; dz <= ring; dz++) {
      for (let dx = -ring; dx <= ring; dx++) {
        if (Math.max(Math.abs(dx), Math.abs(dz)) !== ring) continue;
        const x = a.cx + dx;
        const z = a.cz + dz;
        // One read of the heightmap rules most columns out: nothing above head height.
        if (w.height(x, z) <= a.cy + 2) continue;
        const y = standCellNear(w, x, z, a.cy, 1, WALK_OPT);
        if (y < 0 || w.exposed(x, y, z)) continue;
        e.spot.x = x + 0.5;
        e.spot.z = z + 0.5;
        return true;
      }
    }
  }
  return false;
}

function rest(e: Eco, a: Animal, g: Group, why: number): void {
  if (a.mode !== MODE_STILL) halt(a);
  // In hard rain an animal standing in the open shuffles under the nearest crown before it settles.
  if (g.mode === GM_SHELTER && e.world.exposed(a.cx, a.cy, a.cz) && findShelter(e, a)) {
    a.state = ST_TRAVEL;
    a.why = why;
    if (walkTo(e, a, e.spot.x, e.spot.z, a.sp.walk * 1.5, 0.4)) {
      wait(e, a, ON_THE_WAY);
      return;
    }
  }
  // By day they doze on and off; at night they sleep.
  const asleep = g.mode === GM_SLEEP || ((a.id + Math.floor(e.now / 90)) & 3) === 0;
  a.state = asleep ? ST_SLEEP : ST_REST;
  a.anim = asleep ? 'sleep' : 'idle';
  a.why = why;
  wait(e, a, LONG_NAP);
}
