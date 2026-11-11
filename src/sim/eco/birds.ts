// Songbirds, crows, gulls and (in the air) ducks, one bird at a time. What a
// flock is doing is decided for it as a whole (flock.ts); here each bird acts
// on that. Perched, it roosts, rests or feeds. In the air it steers by the
// three boid rules against its flockmates, toward the flock's goal and over
// the terrain ahead; told to land, it finds a perch of its own and comes down
// on it. The orders a flock can be given (go there, scatter, wheel) are here
// too, since a startled bird gives them.

import { clamp } from '../../core/math';
import { B, IS_LEAVES, SOLID, WATER_LEVEL } from '../../world/blocks';
import { forage, wait } from './brain';
import { H_SEA, H_SHORE, H_WOOD } from './habitat';
import { FLOAT, halt, steerTo } from './motion';
import { withdraw } from './population';
import { DUCK, GULL } from './species';
import type { Eco } from './state';
import { airFloor, waterTop } from './terrain';
import {
  type Animal, FM_DEPART, FM_FORAGE, FM_PERCH, FM_ROOST, FM_TRANSIT, FM_WHEEL, type Group, MODE_FLY, ST_EAT, ST_FLY, ST_PERCH,
  ST_ROOST, WHY_FED, WHY_FLOCK, WHY_HABIT, WHY_HUNGRY, WHY_NIGHT, WHY_PERSON, WHY_RAIN, WHY_SEASON,
} from './types';
import { thinkDuck } from './water';

// Where a bird may come down.
const P_TREE = 0;
const P_GROUND = 1;
const P_SHORE = 2;
const P_WATER = 3;

/** Height each species likes to keep over what is below it, by species index. */
const ALTITUDE = [0, 0, 0, 0, 0, 5, 9, 14, 7, 0];
/** Birds closer than this (squared) push apart. */
const SEPARATION2 = 2.2 * 2.2;
/** Ticks between a flying bird's corrections of course: coarser when cruising, finer on the way down to a perch. */
const STEER_TICKS = 8;
const LAND_TICKS = 4;
/** Seconds of feeding between a bird's thoughts while it forages. */
const PECK = 4;

function landingKind(g: Group): number {
  const k = g.sp.index;
  if (k === DUCK) return P_WATER;
  if (k === GULL) return g.then === FM_FORAGE ? P_WATER : P_SHORE;
  return g.then === FM_FORAGE ? P_GROUND : P_TREE;
}

/** Look for a place to come down within `r` of (x, z). Leaves it in the bird's perch fields. */
function findPerch(e: Eco, a: Animal, x: number, z: number, r: number, where: number): boolean {
  const w = e.world;
  const g = a.group;
  if (where === P_WATER && g.body) {
    // A duck lands on its own water, near the rest of the raft.
    for (let t = 0; t < 6; t++) {
      e.habitat.pointIn(g.body, e.rng, e.spot);
      const dx = e.spot.x - x;
      const dz = e.spot.z - z;
      if (t < 5 && dx * dx + dz * dz > (r + 6) * (r + 6)) continue;
      const top = waterTop(w, Math.floor(e.spot.x), Math.floor(e.spot.z));
      if (top < 0) continue;
      a.px = e.spot.x;
      a.py = top + FLOAT;
      a.pz = e.spot.z;
      return true;
    }
    return false;
  }
  for (let t = 0; t < 12; t++) {
    const px = Math.floor(x + e.rng.range(-r, r));
    const pz = Math.floor(z + e.rng.range(-r, r));
    if (px < 3 || pz < 3 || px >= w.sx - 3 || pz >= w.sz - 3) continue;
    const h = w.height(px, pz);
    if (h < 1) continue;
    const top = w.get(px, h - 1, pz);
    const above = w.get(px, h, pz);
    let y = h;
    if (where === P_TREE) {
      if (!IS_LEAVES[top] || above !== B.air) continue;
    } else if (where === P_WATER) {
      const surface = waterTop(w, px, pz);
      if (surface < 0) continue;
      y = surface + FLOAT;
    } else {
      if (SOLID[above] || WATER_LEVEL[above]) continue;
      const beach = top === B.sand || top === B.gravel || top === B.stone;
      if (where === P_SHORE ? !beach && top !== B.grass : !beach && top !== B.grass && top !== B.forest_floor && top !== B.dirt) continue;
      if (e.habitat.inAvoid(px, pz)) continue;
    }
    a.px = px + 0.5;
    a.py = y;
    a.pz = pz + 0.5;
    return true;
  }
  return false;
}

export function takeOff(e: Eco, a: Animal): void {
  a.mode = MODE_FLY;
  a.state = ST_FLY;
  a.anim = 'fly';
  a.why = WHY_FLOCK;
  a.landing = false;
  a.landTries = 0;
  a.vx = 0;
  a.vz = 0;
  a.vy = 2.2;
  a.dvx = 0;
  a.dvy = 2.5;
  a.dvz = 0;
  a.gy = airFloor(e.world, a.cx, a.cz) + 0.3;
  a.nextThink = e.tick + 1;
}

/** Put a bird down at a point: on a perch, the ground, or the water. */
export function perchAt(e: Eco, a: Animal, x: number, y: number, z: number): void {
  halt(a);
  a.x = x;
  a.y = y;
  a.z = z;
  a.cx = Math.floor(x);
  a.cy = Math.floor(y);
  a.cz = Math.floor(z);
  a.landing = false;
  a.landTries = 0;
  a.perchFloor = airFloor(e.world, a.cx, a.cz);
  a.state = ST_PERCH;
  a.anim = WATER_LEVEL[e.world.get(a.cx, a.cy, a.cz)] ? 'swim' : 'idle';
  a.yawT = a.yaw;
  e.hash.moved(a);
}

/** A short flight to another perch close by. */
function hop(e: Eco, a: Animal, r: number): void {
  const g = a.group;
  if (!findPerch(e, a, a.x, a.z, r, landingKind(g)) && !findPerch(e, a, g.ax, g.az, 8, landingKind(g))) return;
  takeOff(e, a);
  a.landing = true;
}

// -----------------------------------------------------------------------------
// One bird
// -----------------------------------------------------------------------------

export function thinkBird(e: Eco, a: Animal): void {
  const g = a.group;
  const sp = a.sp;
  if (a.mode === MODE_FLY) {
    fly(e, a, g);
    return;
  }
  a.nextThink = e.tick + sp.think + (a.id & 7);
  // The branch it sat on may have been cut from under it.
  if (airFloor(e.world, a.cx, a.cz) !== a.perchFloor) {
    takeOff(e, a);
    return;
  }
  if (e.personNear(a.x, a.y, a.z, sp.flight)) {
    if (sp.index !== DUCK || e.personNear(a.x, a.y, a.z, sp.flight * 0.5)) {
      flush(e, g, e.px, e.pz);
      takeOff(e, a);
      a.why = WHY_PERSON;
      return;
    }
  }
  if ((g.mode === FM_TRANSIT || g.mode === FM_WHEEL || g.mode === FM_DEPART) && !g.landing) {
    takeOff(e, a);
    if (g.mode === FM_DEPART) a.why = WHY_SEASON;
    return;
  }
  if (sp.index === DUCK) {
    thinkDuck(e, a, g);
    return;
  }
  const afloat = WATER_LEVEL[e.world.get(a.cx, a.cy, a.cz)] !== 0;
  if (g.mode === FM_ROOST) {
    a.state = ST_ROOST;
    a.anim = afloat ? 'swim' : 'sleep';
    a.why = WHY_NIGHT;
    // The flock wakes its birds when it moves, and anyone coming near wakes them sooner.
    wait(e, a, 12);
  } else if (g.mode === FM_FORAGE) {
    a.state = ST_EAT;
    a.anim = afloat ? 'swim' : (a.id + (e.tick >> 5)) & 1 ? 'eat' : 'idle';
    a.why = a.hunger > 0.5 ? WHY_HUNGRY : WHY_HABIT;
    forage(e, a, PECK);
    // Birds on the ground are never still for long.
    if (e.rng.chance(0.2)) hop(e, a, 3.5);
    else wait(e, a, PECK);
  } else {
    a.state = ST_PERCH;
    a.anim = afloat ? 'swim' : 'idle';
    a.why = e.raining ? WHY_RAIN : WHY_FED;
    wait(e, a, 8);
  }
}

function fly(e: Eco, a: Animal, g: Group): void {
  a.nextThink = e.tick + STEER_TICKS;
  if (g.mode === FM_DEPART) {
    // South, high, and off the edge of the map until spring.
    if (a.z > e.world.sz - 6) {
      leave(e, a, g);
      return;
    }
    steer(e, a, g);
    return;
  }
  if (a.landing) {
    a.nextThink = e.tick + LAND_TICKS;
    const dx = a.px - a.x;
    const dz = a.pz - a.z;
    const hd = Math.sqrt(dx * dx + dz * dz);
    if ((hd < 0.7 && Math.abs(a.py - a.y) < 1) || ++a.landTries > 80) {
      perchAt(e, a, a.px, a.py, a.pz);
      a.nextThink = e.tick + 1 + (a.id & 7);
      return;
    }
    // Come in over the perch, then drop onto it.
    steerTo(a, a.px, a.py + Math.min(5, hd * 0.7), a.pz, Math.min(a.sp.fly, 1.2 + hd * 1.1));
    a.yawT = Math.atan2(a.vx, a.vz);
    a.anim = 'glide';
    return;
  }
  if (g.landing || (g.mode !== FM_TRANSIT && g.mode !== FM_WHEEL)) {
    let where = landingKind(g);
    // Nowhere of the right kind after a good look: settle for the next best thing rather than fly for ever.
    if (a.landTries > 8 && where !== P_WATER) where = where === P_GROUND ? P_TREE : P_GROUND;
    else if (a.landTries > 8 && a.sp.index === GULL) where = P_SHORE;
    if (findPerch(e, a, g.ax, g.az, 5 + Math.min(a.landTries, 10) * 2, where)) {
      a.landing = true;
      a.landTries = 0;
      return;
    }
    a.landTries++;
  }
  steer(e, a, g);
}

/** The boid rules: toward the goal, with the flock, apart from neighbours, and over the ground ahead. */
function steer(e: Eco, a: Animal, g: Group): void {
  const w = e.world;
  let fx: number;
  let fz: number;
  let lift = 0;
  const gx = g.ax - a.x;
  const gz = g.az - a.z;
  const gd = Math.sqrt(gx * gx + gz * gz) + 1e-6;
  if (g.mode === FM_WHEEL) {
    // Round the goal at a set distance: along the tangent, corrected toward the circle.
    const pull = clamp((gd - g.radius) / g.radius, -1, 1);
    fx = (gz / gd) * g.spin + (gx / gd) * pull * 1.3;
    fz = (-gx / gd) * g.spin + (gz / gd) * pull * 1.3;
  } else {
    fx = (gx / gd) * 1.5;
    fz = (gz / gd) * 1.5;
  }
  if (g.flying > 1) {
    // Cohesion: toward the middle of the flock. Alignment: the way the flock is going.
    const cx = g.mx - a.x;
    const cz = g.mz - a.z;
    const cd = Math.sqrt(cx * cx + cz * cz);
    if (cd > 2) {
      const k = Math.min(1, cd / 12) * 0.8;
      fx += (cx / cd) * k;
      fz += (cz / cd) * k;
    }
    const mv = Math.sqrt(g.mvx * g.mvx + g.mvz * g.mvz);
    if (mv > 0.5) {
      fx += (g.mvx / mv) * 0.6;
      fz += (g.mvz / mv) * 0.6;
    }
    // Separation: away from any flockmate that is too close.
    const members = g.members;
    for (let i = 0; i < members.length; i++) {
      const m = members[i] as Animal;
      if (m === a || m.mode !== MODE_FLY) continue;
      const dx = a.x - m.x;
      const dy = a.y - m.y;
      const dz = a.z - m.z;
      const d2 = dx * dx + dy * dy + dz * dz;
      if (d2 >= SEPARATION2 || d2 < 1e-4) continue;
      const k = ((SEPARATION2 - d2) / SEPARATION2 / Math.sqrt(d2)) * 1.8;
      fx += dx * k;
      fz += dz * k;
      lift += dy * k;
    }
  }
  // Turn in from the edge of the world, unless leaving it is the point.
  if (g.mode !== FM_DEPART) {
    const margin = 10;
    if (a.x < margin) fx += (margin - a.x) * 0.4;
    else if (a.x > w.sx - margin) fx -= (a.x - (w.sx - margin)) * 0.4;
    if (a.z < margin) fz += (margin - a.z) * 0.4;
    else if (a.z > w.sz - margin) fz -= (a.z - (w.sz - margin)) * 0.4;
  }
  const f = Math.sqrt(fx * fx + fz * fz) + 1e-6;
  const speed = a.sp.fly * (0.85 + 0.15 * a.cruise);
  a.dvx = (fx / f) * speed;
  a.dvz = (fz / f) * speed;

  // Hold height over the highest thing between here and two seconds ahead, so trees and hills are climbed in time.
  let floor = a.gy;
  const f1 = airFloor(w, Math.floor(a.x + a.vx * 1.2), Math.floor(a.z + a.vz * 1.2));
  const f2 = airFloor(w, Math.floor(a.x + a.vx * 2.4), Math.floor(a.z + a.vz * 2.4));
  if (f1 > floor) floor = f1;
  if (f2 > floor) floor = f2;
  const want = floor + (ALTITUDE[a.sp.index] as number) * a.cruise * (g.mode === FM_DEPART ? 2 : 1);
  a.dvy = clamp((want - a.y) * 0.9 + lift, -2.5, 3.5);
  a.yawT = Math.atan2(a.vx, a.vz);
  // Gulls ride the air; small birds flap unless they are coming down.
  a.anim = a.sp.index === GULL ? (a.dvy > 0.8 ? 'fly' : 'glide') : a.dvy < -1 ? 'glide' : 'fly';
  a.state = ST_FLY;
}

// -----------------------------------------------------------------------------
// The flock
// -----------------------------------------------------------------------------

export function wake(e: Eco, g: Group): void {
  // A few ticks apart, so a flock rises as a ripple rather than a single jump.
  for (let i = 0; i < g.members.length; i++) {
    const m = g.members[i] as Animal;
    if (m.mode !== MODE_FLY && m.nextThink > e.tick + 2 + i) m.nextThink = e.tick + 1 + i * 2;
  }
}

/** Send the flock to (x, z), to do `then` when it lands. */
export function transit(e: Eco, g: Group, x: number, z: number, then: number): void {
  const w = e.world;
  g.ax = clamp(x, 4, w.sx - 4);
  g.az = clamp(z, 4, w.sz - 4);
  g.then = then;
  g.mode = FM_TRANSIT;
  g.landing = false;
  g.atBush = false;
  g.until = e.now + 45;
  wake(e, g);
}

/** Someone came too close: the whole flock goes up and settles somewhere else. */
export function flush(e: Eco, g: Group, px: number, pz: number): void {
  if (g.mode === FM_TRANSIT || g.mode === FM_WHEEL || g.mode === FM_DEPART) return;
  const k = g.sp.index;
  if (k === GULL) {
    wheel(e, g);
    return;
  }
  if (k === DUCK) {
    // Off the water and away from the trouble, to come back round when it has had time to pass.
    const d = Math.hypot(g.mx - px, g.mz - pz) + 1e-6;
    transit(e, g, g.mx + ((g.mx - px) / d) * 40, g.mz + ((g.mz - pz) / d) * 40, FM_TRANSIT);
    return;
  }
  const then = g.mode === FM_ROOST ? FM_ROOST : FM_PERCH;
  const spot = e.spot;
  for (let t = 0; t < 6; t++) {
    if (!e.habitat.pickNear(H_WOOD, g.hx, g.hz, 0, 60, e.rng, spot)) break;
    const dx = spot.x - px;
    const dz = spot.z - pz;
    if (dx * dx + dz * dz < 20 * 20 && t < 5) continue;
    transit(e, g, spot.x, spot.z, then);
    return;
  }
  transit(e, g, g.hx, g.hz, then);
}

/** Send a flock of gulls up to circle over the water near its home. */
export function wheel(e: Eco, g: Group): void {
  const h = e.habitat;
  const spot = e.spot;
  if (!h.pickNear(H_SEA, g.hx, g.hz, 0, 60, e.rng, spot) && !h.pickNear(H_SHORE, g.hx, g.hz, 0, 60, e.rng, spot)) {
    spot.x = g.hx;
    spot.z = g.hz;
  }
  g.ax = clamp(spot.x, 16, e.world.sx - 16);
  g.az = clamp(spot.z, 16, e.world.sz - 16);
  g.mode = FM_WHEEL;
  g.landing = false;
  g.radius = e.rng.range(9, 15);
  g.spin = e.rng.chance(0.5) ? 1 : -1;
  g.until = e.now + e.rng.range(40, 90);
  wake(e, g);
}

/** One bird of a departing flock reaches the edge of the map: it is gone until spring. */
function leave(e: Eco, a: Animal, g: Group): void {
  const k = a.sp.index;
  halt(a);
  e.hash.remove(a);
  withdraw(e, a);
  g.members.splice(g.members.indexOf(a), 1);
  g.absent.push(a);
  if (a.mother) a.mother.young = Math.max(0, a.mother.young - 1);
  a.mother = null;
  a.young = 0;
  e.count[k] = (e.count[k] as number) - 1;
  e.awayCount[k] = (e.awayCount[k] as number) + 1;
}
