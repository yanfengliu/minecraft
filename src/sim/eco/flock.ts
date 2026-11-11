// What a flock of birds does, decided for the flock as a whole: asleep at the
// roost by night, and by day a round of feeding, perching and (for gulls)
// wheeling over the coast, each in a new place it flies to together. A flock
// breeds, divides when it grows too large, and, if it is one of the songbird
// flocks that winter in the south, leaves in late autumn and returns in spring.

import { clamp } from '../../core/math';
import { takeOff, transit, wake, wheel } from './birds';
import { H_MEADOW, H_SEA, H_SHORE, H_WOOD, type Spot } from './habitat';
import { addGroup, bury, closeGroup, pairUp } from './population';
import { ACT_SLEEP, CROW, DUCK, GULL, SONGBIRD } from './species';
import type { Eco } from './state';
import { airFloor } from './terrain';
import {
  type Animal, CAUSES, DIED_AGE, DIED_HUNGER, FM_AWAY, FM_DEPART, FM_FORAGE, FM_PERCH, FM_ROOST, FM_TRANSIT, FM_WHEEL,
  type Group, MODE_FLY, WHY_SEASON,
} from './types';

/** How near the goal the flock's centre must come before it starts to land. */
const ARRIVE = 9;
/** Chance that a bird gone south does not come back. */
const PASSAGE_LOSS = 0.1;

/** Pick a spot of one habitat near the flock's home; false when there is none in reach. */
function near(e: Eco, g: Group, cls: number, r: number, out: Spot): boolean {
  return e.habitat.pickNear(cls, g.hx, g.hz, 0, r, e.rng, out) && !e.habitat.inAvoid(out.x, out.z);
}

/** Choose what a flock that is awake does next, and send it there. */
function nextActivity(e: Eco, g: Group): void {
  const k = g.sp.index;
  const spot = e.spot;
  const rng = e.rng;
  const hungry = g.hunger > 0.3 || rng.chance(0.35);
  if (k === DUCK) {
    duckActivity(e, g);
    return;
  }
  if (k === GULL) {
    // Mostly on the wing over the water; down to feed on it or to stand on the shore between.
    const r = rng.float();
    if (r < 0.5 && g.mode !== FM_WHEEL) wheel(e, g);
    else if ((hungry || r < 0.7) && near(e, g, H_SEA, 60, spot)) transit(e, g, spot.x, spot.z, FM_FORAGE);
    else if (near(e, g, H_SHORE, 60, spot)) transit(e, g, spot.x, spot.z, FM_PERCH);
    else wheel(e, g);
    return;
  }
  if (hungry) {
    if (k === SONGBIRD && (e.season === 1 || e.season === 2) && rng.chance(0.4) && e.flora.ripeNear(g.hx, g.hz, 90, spot)) {
      // A bush in berry: the flock strips it between them.
      g.kx = spot.x;
      g.ky = spot.y;
      g.kz = spot.z;
      transit(e, g, spot.x + 0.5, spot.z + 0.5, FM_FORAGE);
      g.atBush = true;
      return;
    }
    if (k === CROW && carrion(e, g, spot)) {
      transit(e, g, spot.x, spot.z, FM_FORAGE);
      return;
    }
    // Songbirds feed along the edge of their wood; crows range over the open meadow.
    if (near(e, g, H_MEADOW, k === CROW ? 110 : 55, spot) || near(e, g, H_WOOD, 45, spot)) {
      transit(e, g, spot.x, spot.z, FM_FORAGE);
      return;
    }
  }
  if (near(e, g, H_WOOD, k === CROW ? 80 : 45, spot)) transit(e, g, spot.x, spot.z, FM_PERCH);
  else transit(e, g, g.hx, g.hz, FM_PERCH);
}

/** Crows find the dead: the nearest body lying within reach of the roost. */
function carrion(e: Eco, g: Group, out: Spot): boolean {
  let best = 120 * 120;
  let found = false;
  for (const a of e.animals) {
    if (a.alive || a.sp.fly > 0) continue;
    const dx = a.x - g.hx;
    const dz = a.z - g.hz;
    const d = dx * dx + dz * dz;
    if (d >= best || e.habitat.inAvoid(a.x, a.z)) continue;
    best = d;
    out.x = a.x;
    out.z = a.z;
    found = true;
  }
  return found;
}

/** Ducks spend the day on their water, shifting about it, and now and then take a turn in the air. */
function duckActivity(e: Eco, g: Group): void {
  const h = e.habitat;
  const spot = e.spot;
  const body = g.body;
  if (!body) return;
  let ducklings = false;
  for (const m of g.members) if (m.mother) ducklings = true;
  // No pleasure flights while there are ducklings to mind.
  if (!ducklings && e.rng.chance(0.15)) {
    // A flight: to other fresh water if there is any, else out over the country and back.
    const fresh = h.bodies.filter((b) => !b.sea && b !== body && b.area >= 60);
    if (fresh.length > 0 && e.rng.chance(0.5)) {
      g.body = fresh[e.rng.int(fresh.length)] as typeof body;
      h.pointIn(g.body, e.rng, spot);
      g.hx = spot.x;
      g.hz = spot.z;
      transit(e, g, spot.x, spot.z, FM_FORAGE);
    } else {
      const ang = e.rng.range(0, Math.PI * 2);
      transit(e, g, g.hx + Math.sin(ang) * 45, g.hz + Math.cos(ang) * 45, FM_TRANSIT);
    }
    return;
  }
  // Stay down: a new part of the water, and either feed or drift.
  h.pointIn(body, e.rng, spot);
  g.ax = spot.x;
  g.az = spot.z;
  g.mode = g.hunger > 0.2 || e.rng.chance(0.6) ? FM_FORAGE : FM_PERCH;
  g.until = e.now + (g.mode === FM_FORAGE ? e.rng.range(60, 140) : e.rng.range(30, 70));
}

function duration(e: Eco, g: Group): number {
  const k = g.sp.index;
  if (g.then === FM_FORAGE) return k === DUCK ? e.rng.range(60, 140) : k === CROW ? e.rng.range(40, 90) : e.rng.range(30, 70);
  return k === CROW ? e.rng.range(30, 70) : e.rng.range(20, 50);
}

export function updateFlock(e: Eco, g: Group): void {
  const sp = g.sp;
  const k = sp.index;
  const now = e.now;
  g.nextUpdate = e.tick + 10 + (g.id & 3);
  const size = g.members.length;
  if (size === 0) {
    absent(e, g);
    return;
  }
  let flying = 0;
  let mx = 0;
  let my = 0;
  let mz = 0;
  let vx = 0;
  let vz = 0;
  let hunger = 0;
  let ax = 0;
  let az = 0;
  for (let i = 0; i < size; i++) {
    const m = g.members[i] as Animal;
    hunger += m.hunger;
    ax += m.x;
    az += m.z;
    if (m.mode !== MODE_FLY) continue;
    flying++;
    mx += m.x;
    my += m.y;
    mz += m.z;
    vx += m.vx;
    vz += m.vz;
  }
  g.hunger = hunger / size;
  g.flying = flying;
  if (flying > 0) {
    g.mx = mx / flying;
    g.my = my / flying;
    g.mz = mz / flying;
    g.mvx = vx / flying;
    g.mvz = vz / flying;
  } else {
    g.mx = ax / size;
    g.mz = az / size;
  }

  if (g.migratory && g.mode !== FM_DEPART && (e.season === 3 || (e.season === 2 && e.seasonT > 0.55))) {
    g.mode = FM_DEPART;
    g.landing = false;
    g.ax = clamp(g.mx, 12, e.world.sx - 12);
    g.az = e.world.sz + 40;
    wake(e, g);
  }
  if (g.coverDay !== e.day && (k === SONGBIRD || k === CROW)) {
    // A roost whose wood has been felled is no roost: move to the nearest wood still standing.
    g.coverDay = e.day;
    if (e.habitat.classAt(g.hx, g.hz) !== H_WOOD && e.habitat.nearest(H_WOOD, g.hx, g.hz, 160, e.spot)) {
      g.hx = e.spot.x;
      g.hz = e.spot.z;
    }
  }
  const act = e.act[k] as number;
  switch (g.mode) {
    case FM_DEPART:
      return;
    case FM_ROOST:
      if (act !== ACT_SLEEP && !e.raining) nextActivity(e, g);
      break;
    case FM_TRANSIT:
    case FM_WHEEL: {
      if (g.landing) {
        // Everyone is down, or near enough: a straggler still circling finishes its landing on its own.
        if (flying > 0 && now < g.until) break;
        g.mode = g.then;
        g.landing = false;
        g.until = now + duration(e, g);
        break;
      }
      const dx = g.mx - g.ax;
      const dz = g.mz - g.az;
      const there = g.mode === FM_WHEEL ? false : dx * dx + dz * dz < ARRIVE * ARRIVE;
      if (!there && now < g.until) break;
      if (g.mode === FM_WHEEL) {
        // Done circling: down onto the water to feed, or the shore to rest.
        const spot = e.spot;
        if ((g.hunger > 0.3 || e.rng.chance(0.5)) && near(e, g, H_SEA, 60, spot)) transit(e, g, spot.x, spot.z, FM_FORAGE);
        else if (near(e, g, H_SHORE, 60, spot)) transit(e, g, spot.x, spot.z, act === ACT_SLEEP ? FM_ROOST : FM_PERCH);
        else transit(e, g, g.hx, g.hz, FM_PERCH);
      } else if (g.then === FM_TRANSIT) {
        // The far end of a duck's circuit: turn for home.
        transit(e, g, g.hx, g.hz, FM_FORAGE);
      } else {
        g.landing = true;
        g.until = now + 12;
      }
      break;
    }
    default:
      if (now < g.until) break;
      if (g.atBush) {
        e.flora.strip(g.kx, g.ky, g.kz);
        for (const m of g.members) m.hunger = Math.max(0, m.hunger - 0.12);
        g.atBush = false;
      }
      if (act === ACT_SLEEP) {
        if (k === DUCK) {
          g.mode = FM_ROOST;
          g.until = now + 60;
        } else transit(e, g, g.hx, g.hz, FM_ROOST);
      } else if (e.raining && k !== DUCK && k !== GULL) {
        // Sit the rain out in the trees.
        if (g.mode === FM_PERCH) g.until = now + 40;
        else transit(e, g, g.hx, g.hz, FM_PERCH);
      } else nextActivity(e, g);
  }

  if (flying === 0) pairUp(e, g);
  if (size >= sp.groupMax && now >= g.nextSplit) divide(e, g);
}

/** A flock grown to its limit divides, the new one taking a roost of its own if the country has room for another. */
function divide(e: Eco, g: Group): void {
  const sp = g.sp;
  const k = sp.index;
  g.nextSplit = e.now + 120;
  if ((e.groupCount[k] as number) >= (e.maxGroups[k] as number) || g.flying > 0) return;
  const spot = e.spot;
  const cls = k === GULL ? H_SHORE : H_WOOD;
  if (k === DUCK || !e.habitat.pickNear(cls, g.hx, g.hz, 20, 120, e.rng, spot)) return;
  const ng = addGroup(e, sp);
  ng.hx = ng.ax = ng.mx = spot.x;
  ng.hz = ng.az = ng.mz = spot.z;
  ng.mode = g.mode;
  ng.until = g.until;
  ng.migratory = g.migratory;
  ng.nextSplit = e.now + 600;
  const take = Math.floor(g.members.length / 2);
  for (let i = 0; i < take; i++) {
    const m = g.members.pop() as Animal;
    if (m.mother) m.mother.young--;
    m.mother = null;
    m.group = ng;
    ng.members.push(m);
  }
}

/** A flock with nobody in it: either all gone south, to be brought back in spring, or dead. */
function absent(e: Eco, g: Group): void {
  const k = g.sp.index;
  if (g.absent.length === 0) {
    closeGroup(e, g);
    return;
  }
  g.mode = FM_AWAY;
  g.nextUpdate = e.tick + 600;
  if (e.season === 3 || (e.season === 2 && e.seasonT > 0.5)) return;
  const w = e.world;
  for (const a of g.absent) {
    e.awayCount[k] = (e.awayCount[k] as number) - 1;
    // Not all of them make it back.
    const old = e.now - a.born > a.lifespan;
    if (old || e.rng.chance(PASSAGE_LOSS)) {
      e.deaths[k] = (e.deaths[k] as number) + 1;
      const cause = old ? DIED_AGE : DIED_HUNGER;
      e.deathsBy[k * CAUSES + cause] = (e.deathsBy[k * CAUSES + cause] as number) + 1;
      a.alive = false;
      bury(e, a);
      continue;
    }
    a.slot = e.animals.length;
    e.animals.push(a);
    g.members.push(a);
    e.count[k] = (e.count[k] as number) + 1;
    a.x = clamp(g.hx + e.rng.range(-14, 14), 8, w.sx - 8);
    a.z = w.sz - 8 - e.rng.range(0, 6);
    a.cx = Math.floor(a.x);
    a.cz = Math.floor(a.z);
    a.y = airFloor(w, a.cx, a.cz) + 12 + e.rng.range(0, 6);
    a.thought = e.now;
    a.hunger = 0.35;
    a.energy = 0.6;
    e.hash.insert(a);
    takeOff(e, a);
    a.vz = -a.sp.fly;
    a.why = WHY_SEASON;
  }
  g.absent.length = 0;
  if (g.members.length === 0) {
    closeGroup(e, g);
    return;
  }
  transit(e, g, g.hx, g.hz, FM_PERCH);
  g.nextUpdate = e.tick + 10;
}
