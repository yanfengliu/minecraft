// Moving the animals. Every animal that is going somewhere is carried forward
// every tick, so this is the hot loop and each mover does as little as it can:
// advance along a heading, and only when it crosses into another column ask the
// world whether it may. Walkers follow the ground through `standHeight`, step
// at most one block, and feel their way round what blocks them; fliers ease
// toward a velocity their flock logic chose and stay above the terrain;
// swimmers stay in water. Where to go is decided elsewhere, a second or two at
// a time.

import { TAU } from '../../core/math';
import { SOLID, WATER_SOURCE } from '../../world/blocks';
import { type WalkOptions, standHeight } from '../../world/walk';
import { SIM_DT } from '../clock';
import type { Eco } from './state';
import { airFloor, surfaceNear } from './terrain';
import { type Animal, MODE_FLY, MODE_PADDLE, MODE_STILL, MODE_SWIM, MODE_WALK } from './types';

// Module-local copies of what the per-tick loop reads for every animal. A local constant costs nothing under any
// bundler or test runner; an imported binding is only as cheap as the tool that linked it chose to make it.
const DT = SIM_DT;
const STILL = MODE_STILL;
const WALK = MODE_WALK;
const FLY = MODE_FLY;
const SWIM = MODE_SWIM;
const PI = Math.PI;
/** Wild animals are stopped by gates and doors. */
export const WALK_OPT: WalkOptions = { opensGates: false, opensDoors: false };
/** Blocks walked on a sidestep before looking at the goal again. */
const HOP = 2.2;
/** Blocked this many times on the way to one goal, a walker gives it up. */
const STUCK_MAX = 9;
/** Blocks per second a walker drops when it steps down. */
const FALL = 7;
/** Radians a walker or swimmer turns per tick; fliers bank more slowly. */
const TURN = 0.5;
const TURN_AIR = 0.28;
/** Share of the gap to its wanted velocity a flier closes each tick. */
const EASE = 0.16;
/** Height of a paddling bird's feet above the bottom of the top water cell. */
export const FLOAT = 0.82;
/** Headings tried in turn when the straight way is shut, in eighths of a turn toward the chosen side. */
const SWEEP = [1, 2, 3, -1, -2, -3, 4];

let enterGy = 0;

/**
 * Can this walker step into column (ix, iz) from feet level `y`? Returns the
 * feet cell it would stand in, or -1, and leaves the surface height in `enterGy`.
 */
function canEnter(e: Eco, a: Animal, ix: number, iz: number, y: number): number {
  const w = e.world;
  if (ix < 1 || iz < 1 || ix >= w.sx - 1 || iz >= w.sz - 1) return -1;
  if (!a.bold && e.avoid.length > 0 && barred(e, a.x, a.z, ix + 0.5, iz + 0.5)) return -1;
  // NaN is the only value unequal to itself: `g === g` is the cheap test for "can stand".
  let g = standHeight(w, ix, y, iz, WALK_OPT);
  if (g === g) {
    enterGy = g;
    return y;
  }
  g = standHeight(w, ix, y + 1, iz, WALK_OPT);
  if (g === g) {
    enterGy = g;
    return y + 1;
  }
  g = standHeight(w, ix, y - 1, iz, WALK_OPT);
  if (g === g) {
    enterGy = g;
    return y - 1;
  }
  return -1;
}

/** An avoided area bars a step that enters it or goes deeper into it; a step outward is always allowed. */
function barred(e: Eco, x0: number, z0: number, x1: number, z1: number): boolean {
  for (const area of e.avoid) {
    const r2 = area.radius * area.radius;
    const d1 = (x1 - area.x) * (x1 - area.x) + (z1 - area.z) * (z1 - area.z);
    if (d1 >= r2) continue;
    const d0 = (x0 - area.x) * (x0 - area.x) + (z0 - area.z) * (z0 - area.z);
    if (d0 >= r2 || d1 < d0) return true;
  }
  return false;
}

/** Is the first column this heading crosses into open, and the one after it? */
function rayFree(e: Eco, a: Animal, hx: number, hz: number): boolean {
  const fx = a.x - a.cx;
  const fz = a.z - a.cz;
  const tx = hx > 1e-6 ? (1 - fx) / hx : hx < -1e-6 ? -fx / hx : Infinity;
  const tz = hz > 1e-6 ? (1 - fz) / hz : hz < -1e-6 ? -fz / hz : Infinity;
  let ix = a.cx;
  let iz = a.cz;
  if (tx < tz) ix += hx > 0 ? 1 : -1;
  else iz += hz > 0 ? 1 : -1;
  const y = canEnter(e, a, ix, iz, a.cy);
  if (y < 0) return false;
  // A second look, so a heading that only clips the corner of a free cell before a wall is not chosen.
  const jx = Math.floor(a.x + hx * 1.6);
  const jz = Math.floor(a.z + hz * 1.6);
  if ((jx === ix && jz === iz) || (jx === a.cx && jz === a.cz)) return true;
  return canEnter(e, a, jx, jz, y) >= 0;
}

function turn(a: Animal, rate: number): void {
  let d = a.yawT - a.yaw;
  if (d > PI) d -= TAU;
  else if (d < -PI) d += TAU;
  if (d > rate) a.yaw += rate;
  else if (d < -rate) a.yaw -= rate;
  else a.yaw = a.yawT;
  if (a.yaw > PI) a.yaw -= TAU;
  else if (a.yaw < -PI) a.yaw += TAU;
}

/** Stop where it is. The caller sets the animation that goes with what it does next. */
export function halt(a: Animal): void {
  a.mode = MODE_STILL;
  a.speed = 0;
  a.vx = 0;
  a.vy = 0;
  a.vz = 0;
  a.hasGoal = false;
  if (a.anim === 'walk' || a.anim === 'run') a.anim = 'idle';
}

/**
 * Point a walker at its goal, or round whatever is in the way. Returns false
 * when every way is shut. Being within reach of the goal counts as arriving.
 */
function aim(e: Eco, a: Animal): boolean {
  const dx = a.gx - a.x;
  const dz = a.gz - a.z;
  const d = Math.sqrt(dx * dx + dz * dz);
  if (d < a.reach) {
    halt(a);
    a.arrived = true;
    a.nextThink = e.tick;
    return true;
  }
  const base = Math.atan2(dx, dz);
  let hx = dx / d;
  let hz = dz / d;
  let heading = base;
  let leg = d;
  if (!rayFree(e, a, hx, hz)) {
    // Keep going the same way round an obstacle once a side is chosen, or a walker dithers in front of it.
    const side = a.side !== 0 ? a.side : (a.id + e.tick) & 1 ? 1 : -1;
    let ok = false;
    for (let k = 0; k < SWEEP.length; k++) {
      const eighths = SWEEP[k] as number;
      heading = base + side * eighths * 0.7854;
      hx = Math.sin(heading);
      hz = Math.cos(heading);
      if (rayFree(e, a, hx, hz)) {
        ok = true;
        a.side = eighths > 0 ? side : -side;
        break;
      }
    }
    if (!ok) return false;
    // A sidestep, longer at a run so that an animal skirting a shore at speed is not re-planning every other tick.
    leg = Math.min(d, Math.max(HOP, a.speed * 0.5));
    if (heading > PI) heading -= TAU;
    else if (heading < -PI) heading += TAU;
  }
  a.vx = hx * a.speed;
  a.vz = hz * a.speed;
  a.yawT = heading;
  a.leg = leg;
  a.mode = MODE_WALK;
  return true;
}

function giveUp(e: Eco, a: Animal): void {
  halt(a);
  a.failed = true;
  a.nextThink = e.tick;
}

/**
 * Set a walker off toward a point at a speed. Returns false when it does not
 * set off: either it is already there (`arrived`) or every way is shut
 * (`failed`). Once under way, reaching the goal or giving it up wakes its brain.
 */
export function walkTo(e: Eco, a: Animal, gx: number, gz: number, speed: number, reach = 0.6): boolean {
  const w = e.world;
  a.gx = gx < 1.5 ? 1.5 : gx > w.sx - 1.5 ? w.sx - 1.5 : gx;
  a.gz = gz < 1.5 ? 1.5 : gz > w.sz - 1.5 ? w.sz - 1.5 : gz;
  a.reach = reach;
  a.hasGoal = true;
  a.arrived = false;
  a.failed = false;
  a.side = 0;
  a.stuck = 0;
  a.speed = speed;
  const running = speed > a.sp.walk * 1.7;
  a.gaitK = 1 / (running ? a.sp.run : a.sp.walk);
  a.anim = running ? 'run' : 'walk';
  const thinkAt = a.nextThink;
  if (!aim(e, a)) {
    halt(a);
    a.failed = true;
    return false;
  }
  if (a.arrived) {
    // The caller is the brain: it needs no waking, and must not be woken every tick.
    a.nextThink = thinkAt;
    return false;
  }
  return true;
}

export function moveWalker(e: Eco, a: Animal): void {
  const nx = a.x + a.vx * DT;
  const nz = a.z + a.vz * DT;
  const ix = Math.floor(nx);
  const iz = Math.floor(nz);
  if (ix !== a.cx || iz !== a.cz) {
    const y = canEnter(e, a, ix, iz, a.cy);
    if (y < 0) {
      if (++a.stuck > STUCK_MAX || !aim(e, a)) giveUp(e, a);
      return;
    }
    a.cx = ix;
    a.cz = iz;
    a.cy = y;
    a.gy = enterGy;
    // Up a step at once, so the body is never inside the riser; down one it drops over a few ticks.
    if (a.gy > a.y) a.y = a.gy;
    e.hash.moved(a);
  }
  a.x = nx;
  a.z = nz;
  if (a.y > a.gy) {
    a.y -= FALL * DT;
    if (a.y < a.gy) a.y = a.gy;
  }
  const step = a.speed * DT;
  a.animTime += step * a.gaitK;
  if (a.yaw !== a.yawT) turn(a, TURN);
  a.leg -= step;
  if (a.leg <= 0) {
    if (a.stuck > 0) a.stuck--;
    if (!aim(e, a)) giveUp(e, a);
  }
}

/** Set a flier's wanted velocity toward a point in the air. */
export function steerTo(a: Animal, x: number, y: number, z: number, speed: number): void {
  const dx = x - a.x;
  const dy = y - a.y;
  const dz = z - a.z;
  const d = Math.sqrt(dx * dx + dy * dy + dz * dz) + 1e-6;
  a.dvx = (dx / d) * speed;
  a.dvy = (dy / d) * speed;
  a.dvz = (dz / d) * speed;
}

export function moveFlier(e: Eco, a: Animal): void {
  a.vx += (a.dvx - a.vx) * EASE;
  a.vy += (a.dvy - a.vy) * EASE;
  a.vz += (a.dvz - a.vz) * EASE;
  let nx = a.x + a.vx * DT;
  let ny = a.y + a.vy * DT;
  let nz = a.z + a.vz * DT;
  const ix = Math.floor(nx);
  const iz = Math.floor(nz);
  if (ix !== a.cx || iz !== a.cz) {
    const w = e.world;
    if (ix < 2 || iz < 2 || ix >= w.sx - 2 || iz >= w.sz - 2) {
      // The edge of the world: turn back.
      if (ix < 2 || ix >= w.sx - 2) {
        a.vx = -a.vx;
        a.dvx = -a.dvx;
        nx = a.x;
      }
      if (iz < 2 || iz >= w.sz - 2) {
        a.vz = -a.vz;
        a.dvz = -a.dvz;
        nz = a.z;
      }
    } else {
      a.cx = ix;
      a.cz = iz;
      a.gy = airFloor(w, ix, iz) + 0.3;
      e.hash.moved(a);
    }
  }
  if (ny < a.gy) {
    ny = a.gy;
    if (a.vy < 0) a.vy = 0;
  }
  a.x = nx;
  a.y = ny;
  a.z = nz;
  a.animTime += DT;
  if (a.yaw !== a.yawT) turn(a, TURN_AIR);
}

/** Set a swimmer off toward a point under water. Arriving, or meeting the bank, wakes its brain. */
export function swimTo(a: Animal, x: number, y: number, z: number, speed: number): void {
  const dx = x - a.x;
  const dy = y - a.y;
  const dz = z - a.z;
  const d = Math.sqrt(dx * dx + dy * dy + dz * dz);
  a.arrived = false;
  a.failed = false;
  if (d < 0.05) {
    a.arrived = true;
    return;
  }
  a.vx = (dx / d) * speed;
  a.vy = (dy / d) * speed;
  a.vz = (dz / d) * speed;
  a.speed = speed;
  a.leg = d;
  a.gaitK = 1 / a.sp.walk;
  a.yawT = Math.atan2(dx, dz);
  a.mode = MODE_SWIM;
}

export function moveSwimmer(e: Eco, a: Animal): void {
  const nx = a.x + a.vx * DT;
  const ny = a.y + a.vy * DT;
  const nz = a.z + a.vz * DT;
  const ix = Math.floor(nx);
  const iy = Math.floor(ny);
  const iz = Math.floor(nz);
  if (ix !== a.cx || iz !== a.cz || iy !== a.cy) {
    const w = e.world;
    if (ix < 1 || iz < 1 || ix >= w.sx - 1 || iz >= w.sz - 1 || !WATER_SOURCE[w.get(ix, iy, iz)]) {
      halt(a);
      a.failed = true;
      a.nextThink = e.tick;
      return;
    }
    a.cx = ix;
    a.cy = iy;
    a.cz = iz;
    e.hash.moved(a);
  }
  a.x = nx;
  a.y = ny;
  a.z = nz;
  const step = a.speed * DT;
  a.animTime += step * a.gaitK;
  if (a.yaw !== a.yawT) turn(a, TURN);
  a.leg -= step;
  if (a.leg <= 0) {
    halt(a);
    a.arrived = true;
    a.nextThink = e.tick;
  }
}

/** Set a bird on the water off across its surface. */
export function paddleTo(a: Animal, x: number, z: number, speed: number): void {
  const dx = x - a.x;
  const dz = z - a.z;
  const d = Math.sqrt(dx * dx + dz * dz);
  a.arrived = false;
  a.failed = false;
  if (d < 0.05) {
    a.arrived = true;
    return;
  }
  a.vx = (dx / d) * speed;
  a.vz = (dz / d) * speed;
  a.vy = 0;
  a.speed = speed;
  a.leg = d;
  a.gaitK = 1 / a.sp.walk;
  a.yawT = Math.atan2(dx, dz);
  a.mode = MODE_PADDLE;
  a.anim = 'swim';
}

export function movePaddler(e: Eco, a: Animal): void {
  const nx = a.x + a.vx * DT;
  const nz = a.z + a.vz * DT;
  const ix = Math.floor(nx);
  const iz = Math.floor(nz);
  if (ix !== a.cx || iz !== a.cz) {
    const w = e.world;
    const y = ix < 1 || iz < 1 || ix >= w.sx - 1 || iz >= w.sz - 1 ? -1 : surfaceNear(w, ix, iz, a.cy);
    if (y < 0) {
      halt(a);
      a.failed = true;
      a.nextThink = e.tick;
      return;
    }
    a.cx = ix;
    a.cy = y;
    a.cz = iz;
    a.y = y + FLOAT;
    e.hash.moved(a);
  }
  a.x = nx;
  a.z = nz;
  const step = a.speed * DT;
  a.animTime += step * a.gaitK;
  if (a.yaw !== a.yawT) turn(a, TURN);
  a.leg -= step;
  if (a.leg <= 0) {
    halt(a);
    a.arrived = true;
    a.nextThink = e.tick;
  }
}

/**
 * One tick for every animal: let those whose time has come think, then carry
 * each one forward. This is the hot loop of the whole simulation; an animal
 * standing still costs two comparisons and an addition.
 */
export function advance(e: Eco, think: (e: Eco, a: Animal) => void): void {
  const animals = e.animals;
  const tick = e.tick;
  // The list may grow (births) or shrink (a bird leaving for the winter) while it is walked.
  for (let i = 0; i < animals.length; i++) {
    const a = animals[i] as Animal;
    if (tick >= a.nextThink) think(e, a);
    const mode = a.mode;
    if (mode === STILL) {
      a.animTime += DT;
      if (a.yaw !== a.yawT) turn(a, TURN);
    } else if (mode === WALK) moveWalker(e, a);
    else if (mode === FLY) moveFlier(e, a);
    else if (mode === SWIM) moveSwimmer(e, a);
    else movePaddler(e, a);
  }
}

/** Stand a walker at a point whose feet cell and surface height are known. */
export function placeWalker(e: Eco, a: Animal, x: number, cy: number, z: number, gy: number): void {
  a.x = x;
  a.z = z;
  a.y = gy;
  a.gy = gy;
  a.cx = Math.floor(x);
  a.cy = cy;
  a.cz = Math.floor(z);
  a.mode = MODE_STILL;
  a.speed = 0;
  a.vx = 0;
  a.vz = 0;
  a.hasGoal = false;
  e.hash.moved(a);
}

/**
 * Put a walker on its feet in the column it is in, or the nearest column it
 * can stand in, after the ground under it changed. Returns false if there is
 * nowhere within reach.
 */
export function unstick(e: Eco, a: Animal): boolean {
  const w = e.world;
  for (let ring = 0; ring <= 3; ring++) {
    for (let dz = -ring; dz <= ring; dz++) {
      for (let dx = -ring; dx <= ring; dx++) {
        if (Math.max(Math.abs(dx), Math.abs(dz)) !== ring) continue;
        const x = a.cx + dx;
        const z = a.cz + dz;
        if (x < 1 || z < 1 || x >= w.sx - 1 || z >= w.sz - 1) continue;
        // Nearest level first: the same, then one down, one up, two down, and so on.
        for (let k = 0; k <= 8; k++) {
          const y = a.cy + (k & 1 ? -((k + 1) >> 1) : k >> 1);
          const g = standHeight(w, x, y, z, WALK_OPT);
          if (g !== g) continue;
          placeWalker(e, a, x + 0.5, y, z + 0.5, g);
          return true;
        }
      }
    }
  }
  return false;
}

/** True when a walker's cell can still be stood in; refreshes the height of the surface under it. */
export function footingOk(e: Eco, a: Animal): boolean {
  const g = standHeight(e.world, a.cx, a.cy, a.cz, WALK_OPT);
  if (g !== g) return false;
  a.gy = g;
  return true;
}

/** True when the cell holding the middle of an animal's body is free of solid blocks. */
export function bodyClear(e: Eco, a: Animal): boolean {
  return !SOLID[e.world.get(Math.floor(a.x), Math.floor(a.y + 0.4), Math.floor(a.z))];
}
