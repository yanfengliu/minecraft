// The resident runtime: the handful of things a person can be told to do (go
// somewhere, do something for a while, sit, lie down) and the per-tick step
// that carries them out. A task issues exactly one instruction and returns; when
// it completes the routine is asked again, so behaviour is re-decided from the
// state of the world rather than scripted ahead, and an interruption (rain, a
// changed road, a missed hour) needs no special handling.

import { B, FACING_STEP, isBed } from '../../world/blocks';
import { isStandable, standHeight } from '../../world/walk';
import type { AnimState, Cell } from '../api';
import {
  MOVE_ARRIVED, MOVE_WALKING, PATH_FOUND, PATH_PENDING, VILLAGER_WALK, cellX, cellY, cellZ, nearestStandable, packCell, placeMover,
  startPath, stepMover, stopMover,
} from '../nav';
import type { Core } from './core';
import { ITEM_ID, NG } from './goods';
import { PHASE_ACT, PHASE_IDLE, PHASE_SEEK, PHASE_WALK, type Resident, type Site } from './model';

/** Route requests that may fail for one destination before the resident is simply put there. */
const MAX_TRIES = 3;
/** How much faster people move when caught in the rain. */
const HURRY = 1.5;
/** Within this many blocks of an outdoor spot, walk straight to it rather than by its anchor point. */
const ANCHOR_SKIP = 10;

/** Feet cell y for a surface height: tops of paths and farmland sit a sixteenth below the cell. */
export const feetY = (y: number): number => Math.floor(y + 0.07);

/** The item shown in a resident's hands while walking: whatever they are carrying. */
function carried(r: Resident): number {
  if (r.packCount <= 0) return -1;
  for (let g = 0; g < NG; g++) if ((r.pack[g] as number) > 0) return ITEM_ID[g] as number;
  return -1;
}

/**
 * Send a resident to a cell. Returns true when they are already standing
 * there, so a task reads `if (!go(...)) return;` and carries on once arrived.
 * A `soft` destination is given up when no route exists (the task that asked
 * finds out through `gaveUp`); any other is forced after repeated failures.
 */
export function go(core: Core, r: Resident, to: Cell, soft = false, cache = true): boolean {
  let c: Cell | null = to;
  if (!isStandable(core.world, to.x, to.y, to.z, VILLAGER_WALK)) c = core.standNear(to.x, to.y, to.z, 2);
  if (!c) {
    // Nowhere to stand at or beside the place: a soft goal is dropped, a firm one is done from here.
    core.stats.pathFails++;
    if (!soft) return true;
    r.badKey = packCell(to.x, to.y, to.z);
    act(core, r, 'idle', 1);
    return false;
  }
  if (!r.perch && core.at(r.view, c)) return true;
  rise(core, r);
  if (core.at(r.view, c)) return true;
  // A long way is walked in legs between well-known points, whose routes everyone shares.
  const hop = waypoint(core, r, c);
  if (hop) {
    c = hop;
    cache = true;
  }
  const key = packCell(c.x, c.y, c.z);
  if (r.failKey !== key) {
    r.failKey = key;
    r.tries = 0;
  }
  r.dest = c;
  r.goSoft = soft;
  r.goCache = cache;
  r.askKey = packCell(to.x, to.y, to.z);
  r.onDone = null;
  r.fxKind = '';
  seek(core, r);
  return false;
}

/**
 * Where to make for first on the way to a cell, or null to go straight there.
 * Out of a building one goes by its door, and into a building, or to standing
 * room that hangs off a named point (a spot on the square, a doorstep), by
 * that point. The legs between such points are the same for everyone, so they
 * are searched once and then come out of the route cache; only the few steps at
 * either end are particular to the walker. A building has one door with wall on
 * both sides, so the route through the door's step is the shortest anyway.
 */
function waypoint(core: Core, r: Resident, to: Cell): Cell | null {
  const v = r.view;
  const here = core.siteIndexAt(v.x, v.z);
  const there = core.siteIndexAt(to.x + 0.5, to.z + 0.5);
  if (here === there && here >= 0) return null;
  let anchor: Cell | null;
  if (here >= 0) {
    const site = core.sites[here] as Site;
    anchor = site.b.door ? site.b.entry : null;
  } else if (there >= 0) {
    const site = core.sites[there] as Site;
    anchor = site.b.door ? site.b.entry : null;
  } else {
    anchor = core.anchors.get(packCell(to.x, to.y, to.z)) ?? null;
    // Close enough that the detour by the anchor would show: go straight.
    if (Math.abs(v.x - to.x - 0.5) <= ANCHOR_SKIP && Math.abs(v.z - to.z - 0.5) <= ANCHOR_SKIP) return null;
  }
  // Someone may have built on the doorstep: make for the nearest footing instead.
  if (anchor && !isStandable(core.world, anchor.x, anchor.y, anchor.z, VILLAGER_WALK)) anchor = core.standNear(anchor.x, anchor.y, anchor.z, 2);
  return anchor && !core.at(v, anchor) ? anchor : null;
}

/**
 * True, once, when the last soft `go` to this cell found no route. A task that
 * sends a resident somewhere optional calls this before asking again, so it can
 * pick another target instead of trying the same one for ever.
 */
export function gaveUp(r: Resident, c: Cell): boolean {
  if (r.badKey < 0 || r.badKey !== packCell(c.x, c.y, c.z)) return false;
  r.badKey = -1;
  return true;
}

function seek(core: Core, r: Resident): void {
  const v = r.view;
  const c = r.dest as Cell;
  let sx = Math.floor(v.x);
  let sy = feetY(v.y);
  let sz = Math.floor(v.z);
  if (!isStandable(core.world, sx, sy, sz, VILLAGER_WALK)) {
    // Shut in a block someone placed, or knocked off the grid: step to the nearest footing first.
    const k = nearestStandable(core.world, sx, sy, sz, 2, VILLAGER_WALK);
    if (k < 0) {
      failed(core, r);
      return;
    }
    sx = cellX(k);
    sy = cellY(k);
    sz = cellZ(k);
    placeMover(r.mover, core.world, core.doors, sx, sy, sz);
  }
  r.req = core.nav.request(sx, sy, sz, c.x, c.y, c.z, r.goCache);
  r.phase = PHASE_SEEK;
  v.anim = 'idle';
  poll(core, r);
}

function poll(core: Core, r: Resident): void {
  const req = r.req;
  if (req && req.status === PATH_PENDING) return;
  r.req = null;
  const c = r.dest;
  if (!req || !c || req.status !== PATH_FOUND || !req.path) {
    failed(core, r);
    return;
  }
  const result = startPath(r.mover, req.path, core.world, core.doors);
  if (result === MOVE_WALKING) {
    const hurry = r.running || (core.env.bad && core.world.exposed(Math.floor(r.view.x), feetY(r.view.y), Math.floor(r.view.z)));
    r.mover.speed = hurry ? r.pace * HURRY : r.pace;
    r.view.anim = hurry ? 'run' : 'walk';
    r.view.held = carried(r);
    r.phase = PHASE_WALK;
    return;
  }
  if (result === MOVE_ARRIVED) {
    // Already in the cell as the grid sees it; settle exactly on it so the task's check agrees.
    placeMover(r.mover, core.world, core.doors, c.x, c.y, c.z);
    r.dest = null;
    r.phase = PHASE_IDLE;
    return;
  }
  failed(core, r);
}

function failed(core: Core, r: Resident): void {
  core.stats.pathFails++;
  r.req = null;
  const c = r.dest;
  r.dest = null;
  if (r.goSoft || !c) {
    r.badKey = r.askKey;
    act(core, r, 'idle', 1);
    return;
  }
  r.tries++;
  if (r.tries >= MAX_TRIES) {
    // The village must not seize up because one route is cut: put them there, and count it.
    core.stats.teleports++;
    placeMover(r.mover, core.world, core.doors, c.x, c.y, c.z);
    r.inside = core.siteIndexAt(r.view.x, r.view.z);
    r.tries = 0;
    r.failKey = -1;
    r.phase = PHASE_IDLE;
    return;
  }
  // Stand a moment and look about; the task will ask again.
  act(core, r, 'idle', 1 + r.tries);
}

/** Do something on the spot for a while. `done` runs when the time is up, unless the action is interrupted. */
export function act(core: Core, r: Resident, anim: AnimState, seconds: number, held = -1, done: (() => void) | null = null): void {
  if (anim !== 'sit' && anim !== 'sleep') rise(core, r);
  r.phase = PHASE_ACT;
  r.view.anim = anim;
  r.view.held = held;
  r.actEnd = core.env.now + Math.max(0.1, seconds);
  r.wakeAt = r.actEnd;
  r.onDone = done;
  r.fxKind = '';
}

/** Attach a repeating cue (a hammer blow, a puff of smoke) to the action just started. */
export function cue(core: Core, r: Resident, kind: string, every: number, c: Cell): void {
  r.fxKind = kind;
  r.fxEvery = every;
  r.fxNext = core.env.now + every * 0.5;
  r.fxX = c.x;
  r.fxY = c.y;
  r.fxZ = c.z;
  if (r.fxNext < r.wakeAt) r.wakeAt = r.fxNext;
}

/** Turn to look at a block or a cell. */
export function face(r: Resident, c: Cell): void {
  const dx = c.x + 0.5 - r.view.x;
  const dz = c.z + 0.5 - r.view.z;
  if (dx * dx + dz * dz > 0.01) r.view.yaw = Math.atan2(dx, dz);
}

/**
 * Sit down for a while. The resident must be standing in `seat`; if a stool
 * stands beside that cell they sit on it, otherwise where they are.
 */
export function sit(core: Core, r: Resident, seat: Cell, seconds: number, held = -1, done: (() => void) | null = null, anim: AnimState = 'sit'): void {
  if (!r.perch) {
    const world = core.world;
    for (const [dx, dz] of FACING_STEP) {
      if (world.get(seat.x + dx, seat.y, seat.z + dz) !== B.stool) continue;
      // A standing cell can be beside two stools, and a stool beside two standing cells: take one nobody is on.
      const stool = packCell(seat.x + dx, seat.y, seat.z + dz);
      const sitter = core.stools.get(stool);
      if (sitter !== undefined && sitter !== r.id) continue;
      core.stools.set(stool, r.id);
      r.stool = stool;
      r.perch = seat;
      r.view.x = seat.x + dx + 0.5;
      r.view.z = seat.z + dz + 0.5;
      r.view.y = seat.y + 0.5;
      // Face back into the room, the way they came.
      r.view.yaw = Math.atan2(-dx, -dz);
      break;
    }
  }
  r.phase = PHASE_ACT;
  r.view.anim = anim;
  r.view.held = held;
  r.actEnd = core.env.now + Math.max(0.1, seconds);
  r.wakeAt = r.actEnd;
  r.onDone = done;
  r.fxKind = '';
}

/** Lie down on one's own bed. The resident must be at the bed's stand. */
export function lieDown(core: Core, r: Resident): void {
  const bed = r.bed;
  const state = core.world.get(bed.block.x, bed.block.y, bed.block.z);
  r.perch = bed.stand;
  if (!isBed(state)) return;
  const step = FACING_STEP[(state - B.bed) >> 1] as readonly [number, number];
  // Feet near the foot of the bed, head toward the pillow.
  r.view.x = bed.block.x + 0.5 - step[0] * 0.3;
  r.view.z = bed.block.z + 0.5 - step[1] * 0.3;
  r.view.y = bed.block.y + 9 / 16;
  r.view.yaw = Math.atan2(step[0], step[1]);
}

/** Stand up from a stool or a bed, back where one stood before. */
export function rise(core: Core, r: Resident): void {
  const c = r.perch;
  if (!c) return;
  r.perch = null;
  if (r.stool >= 0) {
    if (core.stools.get(r.stool) === r.id) core.stools.delete(r.stool);
    r.stool = -1;
  }
  const h = standHeight(core.world, c.x, c.y, c.z, VILLAGER_WALK);
  r.view.x = c.x + 0.5 + r.mover.laneX;
  r.view.z = c.z + 0.5 + r.mover.laneZ;
  r.view.y = Number.isNaN(h) ? c.y : h;
}

/** Break off whatever the resident is doing; the routine decides afresh on the next tick. */
export function interrupt(core: Core, r: Resident): void {
  if (r.req) r.req.cancelled = true;
  r.req = null;
  r.dest = null;
  r.onDone = null;
  r.fxKind = '';
  stopMover(r.mover, core.doors);
  r.phase = PHASE_IDLE;
}

/** Advance one resident by one tick. */
export function tickResident(core: Core, r: Resident): void {
  if (r.phase === PHASE_WALK) {
    const result = stepMover(r.mover, core.world, core.doors);
    if (result === MOVE_WALKING) return;
    if (result === MOVE_ARRIVED) {
      r.phase = PHASE_IDLE;
      r.dest = null;
      r.tries = 0;
      r.failKey = -1;
      r.view.anim = 'idle';
      r.inside = core.siteIndexAt(r.view.x, r.view.z);
      core.think(r);
    } else {
      // The way ahead changed under us: plan again from here.
      seek(core, r);
    }
    return;
  }
  if (r.phase === PHASE_ACT) {
    const now = core.env.now;
    if (now < r.wakeAt) return;
    if (r.fxKind !== '' && now >= r.fxNext && now < r.actEnd) {
      core.ctx.actions.effect(r.fxKind, r.fxX + 0.5, r.fxY + 1, r.fxZ + 0.5);
      r.fxNext += r.fxEvery;
    }
    if (now < r.actEnd) {
      r.wakeAt = r.fxKind !== '' && r.fxNext < r.actEnd ? r.fxNext : r.actEnd;
      return;
    }
    const done = r.onDone;
    r.onDone = null;
    r.fxKind = '';
    r.phase = PHASE_IDLE;
    if (done) done();
    if (r.phase === PHASE_IDLE) core.think(r);
    return;
  }
  if (r.phase === PHASE_SEEK) {
    poll(core, r);
    return;
  }
  core.think(r);
}
