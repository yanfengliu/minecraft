// Moves an entity along a path: position toward each cell centre at the
// walker's speed, height from `standHeight` so steps and slabs are climbed
// rather than snapped, heading turned at a limited rate, and doors and gates
// opened ahead and closed behind. One call advances one `SIM_DT`.

import { angleDelta, smoothstep } from '../../core/math';
import { standHeight, type WalkOptions } from '../../world/walk';
import type { World } from '../../world/world';
import type { EntityView } from '../api';
import { SIM_DT } from '../clock';
import { type Path, packCell } from './cells';
import type { Doors } from './doors';

export const MOVE_WALKING = 0;
export const MOVE_ARRIVED = 1;
/** The next cell of the route can no longer be stood in; the caller should ask for a new route. */
export const MOVE_BLOCKED = 2;

/** Radians per simulated second a walker can turn. */
const TURN_RATE = 9;

export interface Mover {
  readonly view: EntityView;
  /** Blocks per simulated second. */
  speed: number;
  /** Blocks of ground that one second of `animTime` stands for, so the gait matches the distance covered. */
  gait: number;
  /** A personal offset inside every cell, so walkers sharing a route do not march through one another. */
  laneX: number;
  laneZ: number;
  /** Opens doors and gates ahead and closes them behind. */
  opens: boolean;
  walk: WalkOptions;
  path: Path | null;
  /** Index of the path cell being walked to. */
  node: number;
  fromH: number;
  toH: number;
  segLen: number;
  /** Doorways this walker is holding open, as keys from `Doors.acquire`, or -1. */
  doorA: number;
  doorB: number;
}

export function createMover(view: EntityView, speed: number, gait: number, opens: boolean, walk: WalkOptions, laneX = 0, laneZ = 0): Mover {
  return { view, speed, gait, laneX, laneZ, opens, walk, path: null, node: 0, fromH: view.y, toH: view.y, segLen: 1, doorA: -1, doorB: -1 };
}

/** Drop the current route and let go of any doorway. */
export function stopMover(m: Mover, doors: Doors): void {
  m.path = null;
  if (m.doorA >= 0) doors.release(m.doorA);
  if (m.doorB >= 0) doors.release(m.doorB);
  m.doorA = -1;
  m.doorB = -1;
}

/** Put a walker in a cell at once (start-up, and the fallback when no route exists). */
export function placeMover(m: Mover, world: World, doors: Doors, x: number, y: number, z: number): void {
  stopMover(m, doors);
  const h = standHeight(world, x, y, z, m.walk);
  m.view.x = x + 0.5 + m.laneX;
  m.view.z = z + 0.5 + m.laneZ;
  m.view.y = Number.isNaN(h) ? y : h;
}

/**
 * Begin following a route whose first cell is the one the walker stands in.
 * Returns MOVE_ARRIVED for a route with nowhere to go and MOVE_BLOCKED when
 * the first step is already impassable.
 */
export function startPath(m: Mover, path: Path, world: World, doors: Doors): number {
  stopMover(m, doors);
  if (path.length <= 1) return MOVE_ARRIVED;
  m.path = path;
  // Standing in a doorway: keep it open until we have stepped out of it.
  if (m.opens) m.doorA = doors.acquire(path.xs[0] as number, path.ys[0] as number, path.zs[0] as number);
  return beginSegment(m, world, doors, 1);
}

function beginSegment(m: Mover, world: World, doors: Doors, next: number): number {
  const path = m.path as Path;
  const nx = path.xs[next] as number;
  const ny = path.ys[next] as number;
  const nz = path.zs[next] as number;
  const h = standHeight(world, nx, ny, nz, m.walk);
  if (h !== h) {
    stopMover(m, doors);
    return MOVE_BLOCKED;
  }
  if (m.opens) {
    const key = doors.acquire(nx, ny, nz);
    if (key >= 0) {
      if (m.doorA < 0) m.doorA = key;
      else if (m.doorB < 0) m.doorB = key;
      else doors.release(key);
    }
  }
  const v = m.view;
  m.node = next;
  m.fromH = v.y;
  m.toH = h;
  m.segLen = Math.max(1e-3, Math.hypot(nx + 0.5 + m.laneX - v.x, nz + 0.5 + m.laneZ - v.z));
  return MOVE_WALKING;
}

/** Advance one simulation step along the route. */
export function stepMover(m: Mover, world: World, doors: Doors): number {
  const path = m.path;
  if (!path) return MOVE_ARRIVED;
  const v = m.view;
  let left = m.speed * SIM_DT;
  // A fast walker can finish one short segment and start the next within a step.
  for (let hop = 0; hop < 4; hop++) {
    const tx = (path.xs[m.node] as number) + 0.5 + m.laneX;
    const tz = (path.zs[m.node] as number) + 0.5 + m.laneZ;
    const dx = tx - v.x;
    const dz = tz - v.z;
    const d = Math.sqrt(dx * dx + dz * dz);
    if (d > 1e-4) {
      const turn = angleDelta(v.yaw, Math.atan2(dx, dz));
      const max = TURN_RATE * SIM_DT;
      v.yaw += turn > max ? max : turn < -max ? -max : turn;
      if (v.yaw > Math.PI) v.yaw -= Math.PI * 2;
      else if (v.yaw < -Math.PI) v.yaw += Math.PI * 2;
    }
    if (d > left) {
      const k = left / d;
      v.x += dx * k;
      v.z += dz * k;
      // Hold the old height until near the edge of the cell, then rise or drop quickly: a step, not a ramp.
      v.y = m.fromH + (m.toH - m.fromH) * smoothstep(0.25, 0.75, 1 - (d - left) / m.segLen);
      v.animTime += left / m.gait;
      return MOVE_WALKING;
    }
    v.x = tx;
    v.z = tz;
    v.y = m.toH;
    v.animTime += d / m.gait;
    left -= d;

    const here = packCell(path.xs[m.node] as number, path.ys[m.node] as number, path.zs[m.node] as number);
    if (m.doorA >= 0 && m.doorA !== here) {
      doors.release(m.doorA);
      m.doorA = -1;
    }
    if (m.doorB >= 0 && m.doorB !== here) {
      doors.release(m.doorB);
      m.doorB = -1;
    }
    if (m.node + 1 >= path.length) {
      stopMover(m, doors);
      return MOVE_ARRIVED;
    }
    const result = beginSegment(m, world, doors, m.node + 1);
    if (result !== MOVE_WALKING) return result;
  }
  return MOVE_WALKING;
}

/** Turn a standing entity to look at a point. */
export function faceToward(view: EntityView, x: number, z: number): void {
  const dx = x - view.x;
  const dz = z - view.z;
  if (dx * dx + dz * dz > 1e-6) view.yaw = Math.atan2(dx, dz);
}
