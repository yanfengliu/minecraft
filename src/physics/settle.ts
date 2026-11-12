// What becomes of a body once it has stopped. A block or compound that has
// slept for a few seconds goes back into the grid if it lies nearly square to
// it and the cells are free; otherwise it stays as a sleeping body until the
// budget for live bodies is needed, and then the oldest are turned into item
// drops.

import { B, REPLACEABLE, SOLID, WATER_LEVEL } from '../world/blocks';
import type { Body } from './body';
import { dropBlock } from './items';
import type { RigidBodies } from './rigid';
import { nearestGridRotation, rotateState } from './shapes';

const OPEN = REPLACEABLE;
const HARD = SOLID;
const LEVEL = WATER_LEVEL;
const AIR = B.air;

const grid = new Int8Array(9);

/**
 * Try to return a sleeping block or compound to the grid. The answer is
 * 'done' when it went (the body is gone); 'never' when it cannot go as it
 * lies, which nothing changes until it moves again (turned too far from the
 * grid's axes, too far from a cell centre, into something solid, or resting on
 * other bodies with no ground under it); and 'later' when it lies right but
 * the player or another body is in one of its cells, which may not last.
 *
 * A cell is free to take a block when nothing solid is in it. Water there is
 * pushed aside, a plant is crushed, and a torch, crop or other fitting is
 * knocked off as what it drops, as under a loose block that lands on one.
 */
export function trySettle(sys: RigidBodies, b: Body): 'done' | 'later' | 'never' {
  const w = sys.world;
  const v = b.view;
  const angle = nearestGridRotation(v.qx, v.qy, v.qz, v.qw, grid);
  if (angle > sys.snapAngle) return 'never';
  // True rotation, to measure how far each block would jump.
  const { qx, qy, qz, qw } = v;
  const r = [
    1 - 2 * (qy * qy + qz * qz), 2 * (qx * qy - qz * qw), 2 * (qx * qz + qy * qw),
    2 * (qx * qy + qz * qw), 1 - 2 * (qx * qx + qz * qz), 2 * (qy * qz - qx * qw),
    2 * (qx * qz - qy * qw), 2 * (qy * qz + qx * qw), 1 - 2 * (qx * qx + qy * qy),
  ] as const;
  const ox = Math.floor(v.x);
  const oy = Math.floor(v.y);
  const oz = Math.floor(v.z);
  const targets: number[] = [];
  const taken = new Set<number>();
  const limit = sys.snapDistance * sys.snapDistance;
  let inTheWay = false;
  for (const c of b.cells) {
    const tx = ox + (grid[0] as number) * c.dx + (grid[1] as number) * c.dy + (grid[2] as number) * c.dz;
    const ty = oy + (grid[3] as number) * c.dx + (grid[4] as number) * c.dy + (grid[5] as number) * c.dz;
    const tz = oz + (grid[6] as number) * c.dx + (grid[7] as number) * c.dy + (grid[8] as number) * c.dz;
    const ax = v.x + r[0] * c.dx + r[1] * c.dy + r[2] * c.dz;
    const ay = v.y + r[3] * c.dx + r[4] * c.dy + r[5] * c.dz;
    const az = v.z + r[6] * c.dx + r[7] * c.dy + r[8] * c.dz;
    if ((tx + 0.5 - ax) ** 2 + (ty + 0.5 - ay) ** 2 + (tz + 0.5 - az) ** 2 > limit) return 'never';
    if (!w.inBounds(tx, ty, tz) || HARD[w.get(tx, ty, tz)]) return 'never';
    if (sys.pusherIn(tx, ty, tz)) inTheWay = true;
    targets.push(tx, ty, tz);
    taken.add((ty * w.sz + tz) * w.sx + tx);
  }
  // It must be standing on the grid somewhere, not only on other bodies.
  let grounded = false;
  for (let i = 0; i < targets.length && !grounded; i += 3) {
    const tx = targets[i] as number;
    const ty = (targets[i + 1] as number) - 1;
    const tz = targets[i + 2] as number;
    grounded = !taken.has((ty * w.sz + tz) * w.sx + tx) && HARD[w.get(tx, ty, tz)] === 1;
  }
  if (!grounded) return 'never';
  // The player standing in one of those cells would be walled in, and another body lying in one entombed:
  // leave things as they are for now.
  if (inTheWay) return 'later';
  for (const other of sys.bodies) {
    if (other === b || other.dead) continue;
    const o = other.view;
    if (taken.has((Math.floor(o.y) * w.sz + Math.floor(o.z)) * w.sx + Math.floor(o.x))) return 'later';
  }

  sys.remove(b);
  b.cells.forEach((c, i) => {
    const tx = targets[i * 3] as number;
    const ty = targets[i * 3 + 1] as number;
    const tz = targets[i * 3 + 2] as number;
    const there = w.get(tx, ty, tz);
    const state = rotateState(c.state, grid);
    if (state < 0) {
      // The grid has no such orientation for this block (a slab on edge): it comes loose as an item.
      if (!dropBlock(sys, c.state, tx + 0.5, ty + 0.5, tz + 0.5)) sys.host.emit({ type: 'burst', x: tx + 0.5, y: ty + 0.5, z: tz + 0.5, state: c.state });
      return;
    }
    // Water in the cell is pushed aside by the fluid, which sees the write.
    if (LEVEL[there] === 0 && there !== AIR && (OPEN[there] || !dropBlock(sys, there, tx + 0.5, ty + 0.5, tz + 0.5))) {
      sys.host.emit({ type: 'burst', x: tx + 0.5, y: ty + 0.5, z: tz + 0.5, state: there });
    }
    w.set(tx, ty, tz, state);
  });
  return 'done';
}

/** Turn a body into the item drops of its blocks, where it lies. Blocks that drop nothing burst. */
export function toItems(sys: RigidBodies, b: Body): void {
  const v = b.view;
  const { qx, qy, qz, qw } = v;
  sys.remove(b);
  for (const c of b.cells) {
    const x = v.x + (1 - 2 * (qy * qy + qz * qz)) * c.dx + 2 * (qx * qy - qz * qw) * c.dy + 2 * (qx * qz + qy * qw) * c.dz;
    const y = v.y + 2 * (qx * qy + qz * qw) * c.dx + (1 - 2 * (qx * qx + qz * qz)) * c.dy + 2 * (qy * qz - qx * qw) * c.dz;
    const z = v.z + 2 * (qx * qz - qy * qw) * c.dx + 2 * (qy * qz + qx * qw) * c.dy + (1 - 2 * (qx * qx + qy * qy)) * c.dz;
    if (!dropBlock(sys, c.state, x, y, z)) sys.host.emit({ type: 'burst', x, y, z, state: c.state });
  }
}

/**
 * Keep the number of live block and compound bodies within budget: the
 * longest-lived sleepers go first, and only if that is not enough, the
 * longest-lived of those still moving.
 */
export function enforceBudget(sys: RigidBodies): void {
  const solid = sys.bodies.filter((b) => b.kind !== 'item' && !b.dead);
  let over = solid.length - sys.maxBodies;
  if (over <= 0) return;
  solid.sort((a, b) => Number(b.view.sleeping) - Number(a.view.sleeping) || a.born - b.born);
  for (let i = 0; i < solid.length && over > 0; i++, over--) toItems(sys, solid[i] as Body);
}
