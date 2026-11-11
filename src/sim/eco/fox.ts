// The fox: a lone hunter that works out from its den at dusk and through the
// night. It lives on rabbits, which are as fast as it is, so it does not chase
// them: it creeps up on one that is feeding and springs from close to, and
// whether that comes off depends on whether the rabbit looked up in time. On a
// dark night with an empty belly it will slip into the village after hens.
// It goes hungry when rabbits are scarce and starves when there are none.

import { alarmGroup, eatFood, findFood, fleeFrom, runSpeed, scare, vigour, wait } from './brain';
import { H_MEADOW, H_WOOD } from './habitat';
import { RAID_REACH, STRIKE, denRest, denYoung, mealOf, scatter } from './hunting';
import { footingOk, halt, unstick, walkTo } from './motion';
import { addGroup, closeGroup, conceive, isAdult, kill, readyFemale, readyMale } from './population';
import { ACT_FEED, ACT_SLEEP, FOOD_BERRY, FOX, RABBIT, bit } from './species';
import type { Eco } from './state';
import {
  type Animal, DIED_PREDATOR, type Group, MODE_STILL, MODE_WALK, ST_CHASE, ST_COURT, ST_EAT, ST_FEED, ST_FLEE, ST_HIDE, ST_HUNT,
  ST_IDLE, ST_REST, ST_SEEK, ST_STALK, ST_WANDER, WHY_DAY, WHY_FED, WHY_HUNGRY, WHY_PERSON, WHY_PREDATOR, WHY_RAIN,
  WHY_STARVING, WHY_TIRED,
} from './types';

/** Hunger above which a fox goes looking for a meal. */
const HUNT_ABOVE = 0.35;
/** The chance that a spring kills a fit, full-grown rabbit. */
const FOX_KILLS = 0.6;
/** A fox that creeps to within this distance of a rabbit unnoticed has it at its mercy. */
const POUNCE = 3.2;
/**
 * A fox leaves alone a warren with fewer rabbits than this: the last few keep
 * to the mouth of the burrow and are not worth a night's stalking. This is the
 * rabbits' refuge when they are scarce, and what lets them come back.
 */
const WORTH_STALKING = 3;
/** How far off a fox notices a rabbit. */
const FOX_SENSE = 22;

export function thinkFox(e: Eco, a: Animal): void {
  const sp = a.sp;
  const now = e.now;
  a.nextThink = e.tick + sp.think + (a.id & 3);

  // A fox is bolder in the dark, and boldest when it has made up its mind to raid.
  const nerve = a.bold ? 0.3 : e.night ? 0.55 : 1;
  if (e.personNear(a.x, a.y, a.z, sp.flight * nerve)) {
    a.bold = false;
    a.quarry = null;
    fleeFrom(e, a, e.px, e.pz, WHY_PERSON);
    return;
  }
  if (a.state === ST_FLEE) {
    if (a.mode === MODE_WALK && now < a.until) {
      wait(e, a, 0.5);
      return;
    }
    halt(a);
    a.state = ST_IDLE;
    a.nextHunt = now + 20;
  }
  if (a.mother && a.mother.alive) {
    denYoung(e, a);
    return;
  }
  if (a.mode === MODE_STILL && !footingOk(e, a)) unstick(e, a);

  if (a.state === ST_FEED) {
    if (now < a.until) {
      if (a.mode === MODE_STILL) a.anim = 'eat';
      wait(e, a, Math.min(3, a.until - now));
      return;
    }
    a.hunger = Math.max(0, a.hunger - a.meal);
    a.meal = 0;
    a.bold = false;
    a.state = ST_IDLE;
    a.anim = 'idle';
  }
  if (a.state === ST_EAT) {
    if (now < a.until) {
      wait(e, a, a.until - now);
      return;
    }
    eatFood(e, a);
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

  const act = e.act[FOX] as number;
  if (a.hunger > HUNT_ABOVE && (act === ACT_FEED || a.hunger > 0.75) && now >= a.nextHunt) {
    huntAlone(e, a);
    return;
  }
  a.prey = null;
  a.quarry = null;
  a.bold = false;
  if (act === ACT_SLEEP || e.raining) {
    denRest(e, a, act === ACT_SLEEP, act === ACT_SLEEP ? WHY_DAY : WHY_RAIN);
    return;
  }
  // Awake and fed: potter about the den.
  if (a.mode === MODE_WALK) {
    wait(e, a, 4);
    return;
  }
  if (now >= a.until) {
    a.why = a.hunger > HUNT_ABOVE ? WHY_TIRED : WHY_FED;
    if (e.rng.chance(0.4)) {
      scatter(e, a.group.hx, a.group.hz, 24);
      a.state = ST_WANDER;
      walkTo(e, a, e.spot.x, e.spot.z, sp.walk, 1);
      a.until = now + 5;
    } else {
      a.state = ST_REST;
      a.anim = 'idle';
      a.until = now + e.rng.range(6, 14);
    }
  }
  wait(e, a, a.mode === MODE_WALK ? 4 : Math.max(1, Math.min(6, a.until - now)));
}

function huntAlone(e: Eco, a: Animal): void {
  const sp = a.sp;
  const now = e.now;
  a.why = a.hunger > 0.85 ? WHY_STARVING : WHY_HUNGRY;

  const prey = a.prey;
  if (prey && (!prey.alive || prey.state === ST_HIDE)) {
    // Gone to ground. There are others.
    a.prey = null;
    halt(a);
    a.state = ST_REST;
    a.anim = 'idle';
    a.nextHunt = now + e.rng.range(4, 10);
    wait(e, a, 2);
    return;
  }
  if (prey) {
    const dx = prey.x - a.x;
    const dz = prey.z - a.z;
    const d2 = dx * dx + dz * dz;
    const seen = prey.state === ST_FLEE || prey.alarmUntil > now;
    if (d2 < STRIKE * STRIKE || (!seen && d2 < POUNCE * POUNCE)) {
      // Within a spring of a rabbit that has not seen it, or on the heels of one that has.
      pounce(e, a, prey);
      return;
    }
    if (a.state === ST_CHASE || seen) {
      // A rabbit that saw it coming is as fast as the fox: a short dash in case it blunders, no more.
      if (a.state !== ST_CHASE) {
        a.state = ST_CHASE;
        a.chaseUntil = now + 4;
      } else if (now > a.chaseUntil || d2 > 900 || a.energy < 0.1) {
        a.prey = null;
        halt(a);
        a.state = ST_REST;
        a.anim = 'idle';
        a.why = WHY_TIRED;
        a.nextHunt = now + e.rng.range(5, 12);
        wait(e, a, 3);
        return;
      }
      walkTo(e, a, prey.x, prey.z, runSpeed(e, a), 0.5);
      scare(e, a, true);
      wait(e, a, 0.3);
      return;
    }
    if (d2 < 34 * 34) {
      a.state = ST_STALK;
      walkTo(e, a, prey.x, prey.z, sp.walk * 0.8, 0.5);
      scare(e, a, false);
      wait(e, a, 0.6);
      return;
    }
    a.prey = null;
  }

  if (a.quarry) {
    raidStep(e, a);
    return;
  }
  const q = rabbitInReach(e, a);
  if (q) {
    a.prey = q;
    a.state = ST_STALK;
    wait(e, a, 0.2);
    return;
  }
  // Hens, once the village is dark. Not every night: a fox that has just been there lies low.
  const farm = e.ctx.livestock;
  if (farm && e.night && a.hunger > 0.5 && now >= a.nextRaid) {
    const v = farm.findLivestock(a.x, a.z, RAID_REACH);
    if (v && v.kind === 'chicken' && v.anim !== 'dead') {
      a.quarry = v;
      a.bold = true;
      a.chaseUntil = now + 120;
      a.state = ST_HUNT;
      walkTo(e, a, v.x, v.z, sp.walk * 1.6, 1);
      wait(e, a, 1);
      return;
    }
    a.nextRaid = now + 240;
  }
  // Berries, when there are any, take the edge off.
  if (a.state === ST_SEEK && a.hasFood) {
    if (a.mode === MODE_WALK) {
      wait(e, a, 1.5);
      return;
    }
    if (a.arrived) {
      nibble(e, a);
      return;
    }
    a.hasFood = false;
  } else if ((e.season === 1 || e.season === 2) && a.mode === MODE_STILL && e.rng.chance(0.5) && findFood(e, a, FOOD_BERRY)) {
    a.state = ST_SEEK;
    a.hasFood = true;
    if (walkTo(e, a, a.foodX + 0.5, a.foodZ + 0.5, sp.walk, 0.9)) {
      wait(e, a, 1.5);
      return;
    }
    if (a.arrived) {
      nibble(e, a);
      return;
    }
    a.hasFood = false;
  }
  // Nothing in sight: work round the warrens.
  if (a.state !== ST_HUNT || a.mode !== MODE_WALK) {
    a.state = ST_HUNT;
    huntingGround(e, a);
    walkTo(e, a, e.spot.x, e.spot.z, sp.walk * 1.6, 2);
  }
  wait(e, a, 1);
}

/** The nearest rabbit a fox can see that is above ground and belongs to a warren worth its while. */
function rabbitInReach(e: Eco, a: Animal): Animal | null {
  const n = e.hash.collect(a.x, a.z, FOX_SENSE, bit(RABBIT), e.found);
  let best: Animal | null = null;
  let bestD = Infinity;
  for (let i = 0; i < n; i++) {
    const p = e.found[i] as Animal;
    if (p.state === ST_HIDE || p.group.members.length < WORTH_STALKING) continue;
    const d = (p.x - a.x) * (p.x - a.x) + (p.z - a.z) * (p.z - a.z);
    if (d < bestD) {
      bestD = d;
      best = p;
    }
  }
  return best;
}

function nibble(e: Eco, a: Animal): void {
  a.state = ST_EAT;
  a.anim = 'eat';
  a.until = e.now + 3;
  wait(e, a, 3);
}

/** Choose where a lone fox goes to look for rabbits: near a warren with rabbits in it, nearer ones more often. */
function huntingGround(e: Eco, a: Animal): void {
  let best: Group | null = null;
  let bestW = 0;
  for (const g of e.groups) {
    if (g.gone || g.sp.index !== RABBIT || g.members.length < WORTH_STALKING) continue;
    const dx = g.hx - a.x;
    const dz = g.hz - a.z;
    const d = Math.sqrt(dx * dx + dz * dz);
    if (d > 180 || e.habitat.crossesWater(a.x, a.z, g.hx, g.hz)) continue;
    const w = (g.members.length * e.rng.float()) / (30 + d);
    if (w > bestW) {
      bestW = w;
      best = g;
    }
  }
  if (best) scatter(e, best.hx, best.hz, 12);
  else scatter(e, a.group.hx, a.group.hz, 50);
}

/** The spring that ends a stalk: it takes the rabbit, or it does not and the whole warren knows. */
function pounce(e: Eco, a: Animal, prey: Animal): void {
  const now = e.now;
  a.prey = null;
  // The young, the old and the starving are easier to take.
  if (e.rng.chance(Math.min(0.95, FOX_KILLS * (2 - vigour(e, prey))))) {
    a.meal = mealOf(a, prey);
    kill(e, prey, DIED_PREDATOR, a.sp.eatTime + 2);
    e.kills[a.sp.index] = (e.kills[a.sp.index] as number) + 1;
    a.state = ST_FEED;
    a.until = now + a.sp.eatTime;
    // Onto it in a bound, and eat where it lies.
    if (!walkTo(e, a, prey.x, prey.z, runSpeed(e, a), 0.9)) a.anim = 'eat';
    wait(e, a, 0.5);
    return;
  }
  alarmGroup(e, prey.group, a.x, a.z, WHY_PREDATOR);
  halt(a);
  a.state = ST_REST;
  a.anim = 'idle';
  a.why = WHY_TIRED;
  a.nextHunt = now + e.rng.range(8, 20);
  wait(e, a, 2);
}

/** One step of a raid on the village's hens. */
function raidStep(e: Eco, a: Animal): void {
  const v = a.quarry;
  const farm = e.ctx.livestock;
  const now = e.now;
  if (!v || !farm || v.anim === 'dead' || now > a.chaseUntil || !e.night) {
    a.quarry = null;
    a.bold = false;
    a.nextRaid = now + 600;
    return;
  }
  const dx = v.x - a.x;
  const dz = v.z - a.z;
  if (dx * dx + dz * dz < STRIKE * STRIKE) {
    farm.killLivestock(v.id);
    e.ctx.actions.effect('feathers', v.x, v.y, v.z);
    e.raids[a.sp.index] = (e.raids[a.sp.index] as number) + 1;
    a.quarry = null;
    halt(a);
    a.state = ST_FEED;
    a.anim = 'eat';
    a.meal = a.sp.bite;
    a.until = now + a.sp.eatTime;
    a.nextRaid = now + 1000;
    wait(e, a, 3);
    return;
  }
  a.state = ST_HUNT;
  if (a.mode !== MODE_WALK || a.arrived) walkTo(e, a, v.x, v.z, a.sp.walk * 1.6, 1);
  if (a.failed) {
    // Shut in behind a fence or a door tonight.
    a.quarry = null;
    a.bold = false;
    a.nextRaid = now + 600;
  }
  wait(e, a, 1);
}

/** The den's group logic: a vixen finds a mate, and grown cubs leave to dig dens of their own. */
export function updateDen(e: Eco, g: Group): void {
  const sp = g.sp;
  const k = sp.index;
  g.nextUpdate = e.tick + 60 + (g.id % 16);
  if (g.members.length === 0) {
    closeGroup(e, g);
    return;
  }
  const f = readyFemale(e, g);
  if (f) {
    const n = e.hash.collect(f.x, f.z, 180, bit(k), e.found);
    for (let i = 0; i < n; i++) {
      const m = e.found[i] as Animal;
      if (!readyMale(e, m)) continue;
      conceive(e, f, m);
      walkTo(e, m, f.x + 0.8, f.z, sp.walk * 1.6, 1.2);
      wait(e, f, 1);
      wait(e, m, 1);
      break;
    }
  }
  // The first member holds the den. A grown animal sharing it moves out when there is room in the country.
  for (let i = 1; i < g.members.length; i++) {
    const m = g.members[i] as Animal;
    if (m.mother || !isAdult(m, e.now) || (e.groupCount[k] as number) >= (e.maxGroups[k] as number)) continue;
    const h = e.habitat;
    const spot = e.spot;
    if (!h.pickNear(H_WOOD, g.hx, g.hz, 40, 140, e.rng, spot) && !h.pickNear(H_MEADOW, g.hx, g.hz, 40, 140, e.rng, spot)) continue;
    if (h.inAvoid(spot.x, spot.z) || h.crossesWater(g.hx, g.hz, spot.x, spot.z)) continue;
    const ng = addGroup(e, sp);
    ng.hx = ng.ax = ng.bx = spot.x;
    ng.hz = ng.az = ng.bz = spot.z;
    g.members.splice(i, 1);
    m.group = ng;
    ng.members.push(m);
    break;
  }
}
