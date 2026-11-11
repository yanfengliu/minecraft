// Herds of deer, warrens of rabbits and sounders of boar, as groups. A group
// decides by the hour, the weather and how hungry its members are whether it
// is feeding, lying up, asleep or sheltering, and where: deer range over the
// meadow and lie up in the nearest wood, boar keep to their home wood and its
// edge, and rabbits never leave their warren but graze farther from it as the
// grass nearby is eaten down. Groups pair their members off in season, divide
// when they grow too large and merge when they shrink too small.

import { standHeight } from '../../world/walk';
import { wait } from './brain';
import { H_MEADOW, H_WOOD, STRIDE } from './habitat';
import { WALK_OPT, halt, walkTo } from './motion';
import { addGroup, closeGroup, pairUp } from './population';
import { ACT_FEED, ACT_REST, BOAR, GT_WARREN } from './species';
import type { Eco } from './state';
import { FOOD } from './terrain';
import { type Animal, GM_ALARM, GM_FEED, GM_REST, GM_SHELTER, GM_SLEEP, type Group, ST_COURT } from './types';

/** A warren's rabbits graze this near home while the grass lasts, and this far when it does not. */
const RANGE_MIN = 10;
const RANGE_MAX = 34;
/** Mean hunger at which a group feeds whatever the hour. */
const GROUP_HUNGRY = 0.62;
/** Warrens are founded at least this far apart. */
const WARREN_SPACING = 26;
/** Mouthfuls of mast the forest floor carries per square block of woodland. */
const MAST_DENSITY = 0.05;
/** Growth rate per day of that store, by season: it falls in autumn. */
const MAST_GROWTH = [0.5, 0.6, 1.2, 0.2];

/** How much mast the woodland now standing can carry. Fell the woods and the boar go hungry. */
export function mastCapacity(e: Eco): number {
  return Math.max(1, (e.habitat.total[H_WOOD] as number) * STRIDE * STRIDE * MAST_DENSITY);
}

/**
 * Once an hour: the woods' store of mast, which the boar root through, grows
 * back toward what the woods can carry. It is a number, not blocks: acorns and
 * roots are too small to be voxels.
 */
export function tendMast(e: Eco): void {
  e.mastCap = mastCapacity(e);
  e.mast += ((MAST_GROWTH[e.season] as number) / 24) * e.mast * (1 - e.mast / e.mastCap) + 0.002 * e.mastCap;
  if (e.mast > e.mastCap) e.mast = e.mastCap;
}

export function updateBand(e: Eco, g: Group): void {
  const sp = g.sp;
  const now = e.now;
  const n = g.members.length;
  g.nextUpdate = e.tick + 40 + (g.id % 16);
  if (n === 0) {
    closeGroup(e, g);
    return;
  }
  let mx = 0;
  let mz = 0;
  let hunger = 0;
  for (const m of g.members) {
    mx += m.x;
    mz += m.z;
    hunger += m.hunger;
  }
  g.mx = mx / n;
  g.mz = mz / n;
  g.hunger = hunger / n;

  const act = e.act[sp.index] as number;
  let mode: number;
  if (now < g.alarmUntil) mode = GM_ALARM;
  else if (e.raining && g.hunger < 0.7) mode = GM_SHELTER;
  else if (act === ACT_FEED || g.hunger > GROUP_HUNGRY) mode = GM_FEED;
  else mode = act === ACT_REST ? GM_REST : GM_SLEEP;
  if (mode !== g.mode) {
    g.mode = mode;
    // Wake the members to the change, a few ticks apart so they do not move as one.
    for (const m of g.members) if (m.nextThink > e.tick + 12) m.nextThink = e.tick + 1 + (m.id % 12);
  }

  if (sp.groupType === GT_WARREN) {
    // The warren is where rabbits feed from and where they rest; only how far they range changes.
    if (g.misses > n * 2) {
      g.range = Math.min(RANGE_MAX, g.range + 4);
      g.misses = 0;
    }
    if (g.rangeDay !== e.day) {
      g.rangeDay = e.day;
      g.range = Math.max(RANGE_MIN, g.range - 8);
    }
  } else {
    if (mode === GM_FEED && (!g.hasFeed || g.misses > n * 3 || now > g.feedUntil)) pickFeed(e, g);
    if ((mode === GM_REST || mode === GM_SLEEP || mode === GM_SHELTER) && (!g.hasCover || g.coverDay !== e.day)) pickCover(e, g);
  }

  const pair = pairUp(e, g);
  if (pair) {
    // He comes over to her and she waits for him; either one that is down the burrow stays as it is.
    const [f, m] = pair;
    if (f.state === ST_COURT) {
      halt(f);
      f.anim = 'idle';
      wait(e, f, 1);
    }
    if (m.state === ST_COURT) {
      walkTo(e, m, f.x + 0.8, f.z, sp.walk * 1.5, 1.2);
      wait(e, m, 1);
    }
  }
  if (now >= g.nextSplit) {
    if (n >= sp.groupMax) split(e, g);
    else if (n < sp.groupMin) merge(e, g);
  }
}

/** A rough measure of how much there is to eat around a spot: glances at a dozen cells of ground there. */
function forageNear(e: Eco, x: number, z: number, diet: number): number {
  const w = e.world;
  let n = 0;
  for (let i = 0; i < 12; i++) {
    const px = Math.floor(x + e.rng.range(-7, 7));
    const pz = Math.floor(z + e.rng.range(-7, 7));
    if ((FOOD[w.get(px, w.height(px, pz), pz)] as number) & diet) n++;
  }
  return n;
}

/**
 * Choose where a herd or sounder feeds next: of a few reachable places, the
 * one with the most to eat. A herd that picked blindly would starve on a bare
 * patch with forage standing a minute's walk away.
 */
function pickFeed(e: Eco, g: Group): void {
  const h = e.habitat;
  const spot = e.spot;
  const sp = g.sp;
  const boar = sp.index === BOAR;
  // While the forest floor has mast in it, boar mostly root in their home wood.
  const rooting = boar && e.mast > e.mastCap * 0.2 && e.rng.chance(0.6);
  let best = -1;
  for (let t = 0; t < 7; t++) {
    // Boar keep to their home wood and its edge; deer range over the meadow, farther if they must.
    const ok = boar
      ? rooting ? h.pickNear(H_WOOD, g.hx, g.hz, 0, 30, e.rng, spot) : h.pickNear(H_MEADOW, g.hx, g.hz, 8, 55, e.rng, spot)
      : h.pickNear(H_MEADOW, g.mx, g.mz, 8, t < 4 ? 60 : 110, e.rng, spot);
    if (!ok || h.inAvoid(spot.x, spot.z) || h.crossesWater(g.mx, g.mz, spot.x, spot.z)) continue;
    if (e.personNear(spot.x, spot.y, spot.z, 24)) continue;
    const score = rooting ? 0 : forageNear(e, spot.x, spot.z, sp.diet);
    if (score <= best) continue;
    best = score;
    g.ax = spot.x;
    g.az = spot.z;
    if (rooting) break;
  }
  g.hasFeed = true;
  g.feedUntil = e.now + e.rng.range(100, 220);
  g.misses = 0;
}

function pickCover(e: Eco, g: Group): void {
  const h = e.habitat;
  const spot = e.spot;
  const boar = g.sp.index === BOAR;
  // With no wood in reach the group lies up where it is, in the open.
  g.bx = g.mx;
  g.bz = g.mz;
  if (h.nearest(H_WOOD, boar ? g.hx : g.mx, boar ? g.hz : g.mz, 110, spot) && !h.crossesWater(g.mx, g.mz, spot.x, spot.z)) {
    g.bx = spot.x;
    g.bz = spot.z;
    // A little way in from the edge, and somewhere different each day.
    if (h.pickNear(H_WOOD, g.bx, g.bz, 0, 16, e.rng, spot) && !h.crossesWater(g.mx, g.mz, spot.x, spot.z) && !h.inAvoid(spot.x, spot.z)) {
      g.bx = spot.x;
      g.bz = spot.z;
    }
  }
  g.hasCover = true;
  g.coverDay = e.day;
}

/** True when a walker could stand at this spot from the habitat map. */
function standable(e: Eco, x: number, y: number, z: number): boolean {
  const s = standHeight(e.world, Math.floor(x), y, Math.floor(z), WALK_OPT);
  return s === s;
}

/** A full group divides: some of its members leave to live elsewhere, if there is room for another group. */
function split(e: Eco, g: Group): void {
  const sp = g.sp;
  const k = sp.index;
  g.nextSplit = e.now + 60;
  if ((e.groupCount[k] as number) >= (e.maxGroups[k] as number)) return;
  const free = g.members.filter((m) => !m.mother && m.young === 0 && m.dueAt === 0);
  const take = Math.min(free.length, Math.floor(g.members.length / 2));
  if (take < sp.groupMin) return;
  const h = e.habitat;
  const spot = e.spot;
  const warren = sp.groupType === GT_WARREN;
  let found = false;
  for (let t = 0; t < 8 && !found; t++) {
    // From where the group lives: its warren or home wood, or for deer, who have neither, where the herd is now.
    const deer = !warren && k !== BOAR;
    if (!h.pickNear(k === BOAR ? H_WOOD : H_MEADOW, deer ? g.mx : g.hx, deer ? g.mz : g.hz, 30, 110, e.rng, spot)) continue;
    if (h.inAvoid(spot.x, spot.z) || h.crossesWater(g.mx, g.mz, spot.x, spot.z) || !standable(e, spot.x, spot.y, spot.z)) continue;
    found = true;
    if (!warren) break;
    for (const other of e.groups) {
      if (other.gone || other.sp !== sp) continue;
      const dx = other.hx - spot.x;
      const dz = other.hz - spot.z;
      if (dx * dx + dz * dz < WARREN_SPACING * WARREN_SPACING) found = false;
    }
  }
  if (!found) return;
  const ng = addGroup(e, sp);
  ng.hx = ng.ax = ng.bx = ng.mx = spot.x;
  ng.hz = ng.az = ng.bz = ng.mz = spot.z;
  ng.hasFeed = true;
  ng.feedUntil = e.now + 240;
  ng.mode = g.mode;
  ng.nextSplit = e.now + 600;
  for (let i = 0; i < take; i++) {
    const m = free[i] as Animal;
    g.members.splice(g.members.indexOf(m), 1);
    m.group = ng;
    ng.members.push(m);
  }
}

/** A group too small to last joins the nearest other of its kind that has room. */
function merge(e: Eco, g: Group): void {
  const sp = g.sp;
  g.nextSplit = e.now + 120;
  let best: Group | null = null;
  let bestD = 200 * 200;
  for (const other of e.groups) {
    if (other === g || other.gone || other.sp !== sp || other.members.length + g.members.length > sp.groupMax) continue;
    if (other.members.length === 0) continue;
    const dx = other.mx - g.mx;
    const dz = other.mz - g.mz;
    const d = dx * dx + dz * dz;
    if (d < bestD && !e.habitat.crossesWater(g.mx, g.mz, other.mx, other.mz)) {
      bestD = d;
      best = other;
    }
  }
  if (!best) return;
  for (const m of g.members) {
    m.group = best;
    best.members.push(m);
  }
  g.members.length = 0;
  closeGroup(e, g);
}
