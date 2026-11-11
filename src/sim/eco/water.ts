// Life on and in the water. Ducks paddle about their pond or reach of river,
// dabbling as they go (their flights are flock business, in birds.ts). Fish
// swim in schools inside a water body, and how many are drawn follows that
// body's stock: a number that regrows logistically toward what the water can
// carry, and that fishing (and gulls) draw down.

import { WATER_SOURCE } from '../../world/blocks';
import { forage, wait } from './brain';
import type { WaterBody } from './habitat';
import { halt, paddleTo, swimTo } from './motion';
import { addAnimal, addGroup, closeGroup, kill } from './population';
import { FISH, SPECIES, type Species } from './species';
import type { Eco } from './state';
import {
  type Animal, DIED_HUNTER, DIED_PREDATOR, FM_PERCH, FM_ROOST, type Group, MODE_FLY, MODE_PADDLE, MODE_STILL, MODE_SWIM,
  ST_DABBLE, ST_FLEE, ST_FOLLOW, ST_REST, ST_SLEEP, ST_SWIM, WHY_FED, WHY_HABIT, WHY_HUNGRY, WHY_MOTHER, WHY_NIGHT, WHY_PERSON,
} from './types';

/** Fish per square block a body of sea, and of fresh water, carries when left alone, and the limits on a body's total. */
const SEA_DENSITY = 0.03;
const FRESH_DENSITY = 0.05;
const CAPACITY_MIN = 6;
const SEA_CAPACITY_MAX = 90;
const FRESH_CAPACITY_MAX = 40;
/** Growth rate of a stock per day, by season. */
const STOCK_GROWTH = [0.5, 0.45, 0.3, 0.12];
/** A trickle of fish from deeper water, as a share of capacity per day, so an emptied ground can recover. */
const STOCK_TRICKLE = 0.03;
/** Most fish drawn in one body, and in the whole world. */
const SLOTS_MAX = 20;
const FISH_MAX = 96;
/** How far from the water a line reaches. */
const FISHING_REACH = 10;
const SCHOOL_SIZE = 8;
/** Headings a startled fish tries in turn, relative to straight away from what startled it. */
const DART = [0, 1, -1, 2, -2, 0];
/** Ticks a fish goes without a thought when nothing happens to it. */
const FISH_IDLE = 150;

// -----------------------------------------------------------------------------
// Ducks on the water
// -----------------------------------------------------------------------------

export function thinkDuck(e: Eco, a: Animal, g: Group): void {
  const sp = a.sp;
  const now = e.now;
  const body = g.body;
  if (!body) return;

  // Someone on the bank: keep the width of the pond from them. (Closer still and the raft takes off.)
  if (e.personNear(a.x, a.y, a.z, sp.flight)) {
    if (a.state !== ST_FLEE || a.mode !== MODE_PADDLE) {
      let bx = a.x;
      let bz = a.z;
      let best = 0;
      for (let t = 0; t < 5; t++) {
        e.habitat.pointIn(body, e.rng, e.spot);
        const d = (e.spot.x - e.px) * (e.spot.x - e.px) + (e.spot.z - e.pz) * (e.spot.z - e.pz);
        if (d > best) {
          best = d;
          bx = e.spot.x;
          bz = e.spot.z;
        }
      }
      a.state = ST_FLEE;
      a.why = WHY_PERSON;
      a.until = now + 4;
      paddleTo(a, bx, bz, sp.run);
    }
    wait(e, a, 0.8);
    return;
  }
  if (a.state === ST_FLEE) {
    if (a.mode === MODE_PADDLE && now < a.until) {
      wait(e, a, 0.8);
      return;
    }
    a.state = ST_SWIM;
  }

  const m = a.mother;
  if (m && m.alive && m.mode !== MODE_FLY) {
    // Ducklings string along behind their mother.
    const dx = m.x - a.x;
    const dz = m.z - a.z;
    const d2 = dx * dx + dz * dz;
    a.why = WHY_MOTHER;
    if (d2 > 4) {
      a.state = ST_FOLLOW;
      paddleTo(a, m.x - Math.sin(m.yaw) * 0.9, m.z - Math.cos(m.yaw) * 0.9, d2 > 36 ? sp.run : sp.walk * 1.4);
      wait(e, a, 0.8);
      return;
    }
    if (a.mode !== MODE_STILL) halt(a);
    a.state = m.state === ST_SLEEP ? ST_SLEEP : ST_FOLLOW;
    a.anim = m.state === ST_SLEEP ? 'sleep' : 'swim';
    wait(e, a, 1.5);
    return;
  }

  if (g.mode === FM_ROOST || g.mode === FM_PERCH) {
    if (a.mode !== MODE_STILL) halt(a);
    const asleep = g.mode === FM_ROOST;
    a.state = asleep ? ST_SLEEP : ST_REST;
    a.anim = asleep ? 'sleep' : 'swim';
    a.why = asleep ? WHY_NIGHT : WHY_FED;
    wait(e, a, asleep ? 12 : 8);
    return;
  }
  // Feeding: paddle a little way, up-end for a while, paddle on. (Arriving wakes it.)
  if (a.mode === MODE_PADDLE) {
    wait(e, a, 4);
    return;
  }
  if (a.state === ST_SWIM && (a.arrived || a.failed)) {
    const seconds = e.rng.range(5, 10);
    a.state = ST_DABBLE;
    a.anim = 'eat';
    a.why = a.hunger > 0.5 ? WHY_HUNGRY : WHY_HABIT;
    a.until = now + seconds;
    a.arrived = false;
    forage(e, a, seconds);
    wait(e, a, seconds);
    return;
  }
  if (a.state === ST_DABBLE && now < a.until) {
    wait(e, a, a.until - now);
    return;
  }
  // Somewhere new on the water: a short paddle, keeping with the rest of the raft.
  let tx = a.x;
  let tz = a.z;
  let best = Infinity;
  for (let t = 0; t < 5; t++) {
    e.habitat.pointIn(body, e.rng, e.spot);
    const far = (e.spot.x - g.ax) * (e.spot.x - g.ax) + (e.spot.z - g.az) * (e.spot.z - g.az) > 196;
    const d = (e.spot.x - a.x) * (e.spot.x - a.x) + (e.spot.z - a.z) * (e.spot.z - a.z) + (far ? 400 : 0);
    if (d < 2 || d >= best) continue;
    best = d;
    tx = e.spot.x;
    tz = e.spot.z;
  }
  a.state = ST_SWIM;
  a.why = WHY_HABIT;
  paddleTo(a, tx, tz, sp.walk);
  if (a.arrived) a.mode = MODE_STILL;
  wait(e, a, a.arrived ? 2 : 4);
}

// -----------------------------------------------------------------------------
// Fish
// -----------------------------------------------------------------------------

/** Give every water body its carrying capacity and a full stock, and share out the fish that may be drawn. */
export function stockWaters(e: Eco, wanted: number | undefined): void {
  const bodies = e.habitat.bodies;
  let slots = 0;
  for (const b of bodies) {
    b.capacity = b.sea
      ? Math.min(SEA_CAPACITY_MAX, Math.max(CAPACITY_MIN, b.area * SEA_DENSITY))
      : Math.min(FRESH_CAPACITY_MAX, Math.max(CAPACITY_MIN, b.area * FRESH_DENSITY));
    b.stock = b.capacity;
    b.slots = Math.min(SLOTS_MAX, Math.max(3, Math.round(b.area / 40)));
    slots += b.slots;
  }
  // The whole world may only draw so many fish: a long coast shows fewer per stretch, not more in all.
  const budget = wanted === undefined ? FISH_MAX : wanted;
  if (slots > budget) {
    const k = budget / slots;
    for (const b of bodies) b.slots = budget === 0 ? 0 : Math.max(1, Math.floor(b.slots * k));
  }
}

/** Once an hour: stocks grow toward what their water carries, and the fish drawn are brought into line with them. */
export function tendWaters(e: Eco): void {
  const growth = (STOCK_GROWTH[e.season] as number) / 24;
  for (const b of e.habitat.bodies) {
    if (b.capacity <= 0) continue;
    b.stock += growth * b.stock * (1 - b.stock / b.capacity) + (STOCK_TRICKLE / 24) * b.capacity;
    if (b.stock > b.capacity) b.stock = b.capacity;
    const want = Math.round((b.slots * b.stock) / b.capacity);
    // A few at a time, so a recovering stock fills in over hours rather than appearing at once.
    for (let add = Math.min(2, want - b.shown); add > 0; add--) addFish(e, b, e.rng.range(0, 3));
    // Fewer than are drawn: the gulls have had them.
    if (b.shown > want) cull(e, b, b.shown - want, DIED_PREDATOR, b.cx, b.cz);
  }
}

/** Put one more fish in a body, in a school with room, or a new school. */
export function addFish(e: Eco, body: WaterBody, ageDays: number): Animal | null {
  const sp = SPECIES[FISH] as Species;
  let school: Group | null = null;
  for (const g of e.groups) {
    if (!g.gone && g.body === body && g.sp === sp && g.members.length < SCHOOL_SIZE) {
      school = g;
      break;
    }
  }
  const spot = e.spot;
  if (!school) {
    school = addGroup(e, sp);
    school.body = body;
    e.habitat.pointIn(body, e.rng, spot);
    school.ax = school.mx = spot.x;
    school.az = school.mz = spot.z;
    school.my = spot.y + 0.4;
  }
  // Beside its schoolmates if it has any, so a new fish does not appear in the middle of nowhere.
  const mate = school.members[0];
  let x = school.ax;
  let y = school.my;
  let z = school.az;
  if (mate) {
    x = mate.x;
    y = mate.y;
    z = mate.z;
  }
  if (!WATER_SOURCE[e.world.get(Math.floor(x), Math.floor(y), Math.floor(z))]) return null;
  const a = addAnimal(e, sp, school, ageDays, e.rng.chance(0.5));
  a.x = x;
  a.y = y;
  a.z = z;
  a.cx = Math.floor(x);
  a.cy = Math.floor(y);
  a.cz = Math.floor(z);
  a.anim = 'swim';
  a.state = ST_SWIM;
  e.hash.insert(a);
  body.shown++;
  e.births[FISH] = (e.births[FISH] as number) + 1;
  return a;
}

/** Take `n` drawn fish out of a body, those nearest (x, z) first. */
function cull(e: Eco, body: WaterBody, n: number, cause: number, x: number, z: number): void {
  for (let i = 0; i < n; i++) {
    let best: Animal | null = null;
    let bestD = Infinity;
    for (const g of e.groups) {
      if (g.gone || g.body !== body || g.sp.index !== FISH) continue;
      for (const m of g.members) {
        const d = (m.x - x) * (m.x - x) + (m.z - z) * (m.z - z);
        if (d < bestD) {
          bestD = d;
          best = m;
        }
      }
    }
    if (!best) return;
    // Landed, or gone: no body is left in the water.
    kill(e, best, cause, 0);
  }
}

export function updateSchool(e: Eco, g: Group): void {
  const now = e.now;
  g.nextUpdate = e.tick + 30 + (g.id % 16);
  const n = g.members.length;
  const body = g.body;
  if (n === 0 || !body) {
    closeGroup(e, g);
    return;
  }
  let mx = 0;
  let mz = 0;
  for (const m of g.members) {
    mx += m.x;
    mz += m.z;
  }
  g.mx = mx / n;
  g.mz = mz / n;
  const dx = g.ax - g.mx;
  const dz = g.az - g.mz;
  if (now < g.until && dx * dx + dz * dz > 4) return;
  const wasAt = g.ax;
  // Somewhere new, by choice not far off: a school noses about its water rather than crossing it.
  const spot = e.spot;
  let bx = g.ax;
  let by = g.my;
  let bz = g.az;
  let best = Infinity;
  for (let t = 0; t < 4; t++) {
    e.habitat.pointIn(body, e.rng, spot);
    let d = Math.abs(Math.hypot(spot.x - g.mx, spot.z - g.mz) - 12);
    // Not back under whoever just frightened it.
    if (now < g.alarmUntil && (spot.x - g.alarmX) * (spot.x - g.alarmX) + (spot.z - g.alarmZ) * (spot.z - g.alarmZ) < 100) d += 100;
    if (d >= best) continue;
    best = d;
    bx = spot.x;
    by = spot.y;
    bz = spot.z;
  }
  // `by` is the top water cell there: swim under the surface, deeper where there is depth.
  const w = e.world;
  let depth = 1;
  while (depth < 3 && WATER_SOURCE[w.get(Math.floor(bx), by - depth, Math.floor(bz))]) depth++;
  g.ax = bx;
  g.az = bz;
  g.my = by + 0.65 - e.rng.float() * (depth - 0.5);
  g.until = now + e.rng.range(12, 30);
  // A frightened school goes at once; otherwise each fish finishes what it was doing first.
  if (now < g.alarmUntil && g.ax !== wasAt) for (const m of g.members) if (m.nextThink > e.tick + 12) m.nextThink = e.tick + 12;
}

export function thinkFish(e: Eco, a: Animal): void {
  const sp = a.sp;
  const g = a.group;
  // A fish thinks when it gets where it was going, when it meets the bank, and when someone looms over the
  // water. This is only the fallback.
  a.nextThink = e.tick + FISH_IDLE + (a.id & 15);
  if (e.personNear(a.x, a.y, a.z, sp.flight)) {
    // Dart away from the shadow: straight away if there is water that way, else to one side or the other.
    const away = Math.atan2(a.x - e.px, a.z - e.pz);
    const w = e.world;
    a.state = ST_FLEE;
    a.why = WHY_PERSON;
    // The school takes the hint and moves off, or the fish would swim straight back to where it was.
    if (g.alarmUntil < e.now) {
      g.alarmUntil = e.now + 20;
      g.alarmX = e.px;
      g.alarmZ = e.pz;
      g.until = 0;
      g.nextUpdate = e.tick + 1;
    }
    for (let k = 0; k < DART.length; k++) {
      const ang = away + (DART[k] as number);
      const tx = a.x + Math.sin(ang) * 4;
      const tz = a.z + Math.cos(ang) * 4;
      // Open water all the way, and not off the edge of the world (beyond which the sea reads as water too).
      const clear = e.habitat.inWorld(tx, tz, 2) && WATER_SOURCE[w.get(Math.floor(tx), Math.floor(a.y), Math.floor(tz))] && WATER_SOURCE[w.get(Math.floor((a.x + tx) / 2), Math.floor(a.y), Math.floor((a.z + tz) / 2))];
      if (!clear && k < DART.length - 1) continue;
      swimTo(a, tx, a.y, tz, sp.run);
      break;
    }
    wait(e, a, 1.2);
    return;
  }
  if (a.mode === MODE_SWIM && a.state !== ST_FLEE) return;
  a.state = ST_SWIM;
  a.why = WHY_HABIT;
  a.anim = 'swim';
  if (a.failed && g.body) {
    // The bank is in the way of the school's line: take a short leg somewhere else in the water first.
    const spot = e.spot;
    for (let t = 0; t < 4; t++) {
      e.habitat.pointIn(g.body, e.rng, spot);
      if ((spot.x - a.x) * (spot.x - a.x) + (spot.z - a.z) * (spot.z - a.z) < 64) break;
    }
    swimTo(a, spot.x, Math.min(a.y, spot.y + 0.6), spot.z, sp.walk);
    return;
  }
  // Each fish keeps its own place in the school, which shifts a little a couple of times a minute so none hangs dead still.
  const turn = a.id * 2.4 + (e.tick >> 8) * 0.7;
  const ox = Math.sin(turn) * (0.5 + (a.id % 4) * 0.4);
  const oz = Math.cos(turn) * (0.5 + (a.id % 4) * 0.4);
  const slow = e.night ? 0.6 : 1;
  swimTo(a, g.ax + ox, g.my - (a.id % 3) * 0.12, g.az + oz, sp.walk * slow * (0.8 + (a.id % 5) * 0.1));
  if (a.arrived) {
    // On station: hang there until the station next shifts.
    a.mode = MODE_STILL;
    a.nextThink = e.tick + 258 - (e.tick & 255) + (a.id & 15);
  }
}

// -----------------------------------------------------------------------------
// Fishing
// -----------------------------------------------------------------------------

/** How good the fishing is near a spot, 0 (fished out, or no water) .. 1 (teeming). */
export function fishAbundance(e: Eco, x: number, z: number): number {
  const b = e.habitat.bodyNear(x, z, FISHING_REACH);
  if (!b || b.capacity <= 0) return 0;
  const a = b.stock / b.capacity;
  return a < 0 ? 0 : a > 1 ? 1 : a;
}

/** Try to land one fish near a spot. The better the fishing, the likelier a bite; a catch comes off the stock. */
export function catchFish(e: Eco, x: number, z: number): boolean {
  const b = e.habitat.bodyNear(x, z, FISHING_REACH);
  if (!b || b.stock < 1) return false;
  const abundance = b.stock / b.capacity;
  if (!e.rng.chance(Math.min(0.95, Math.max(0.03, abundance * 1.1)))) return false;
  b.stock -= 1;
  const want = Math.round((b.slots * b.stock) / b.capacity);
  if (b.shown > want) cull(e, b, 1, DIED_HUNTER, x, z);
  return true;
}

