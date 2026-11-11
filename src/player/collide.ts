// Moving a box through the block world: clip the motion against block collision
// boxes one axis at a time, with a step-up so half-blocks and stairs are walked
// over, not jumped. Headless.

import type { World } from '../world/world';

export interface MoveResult {
  x: number;
  y: number;
  z: number;
  hitX: boolean;
  hitY: boolean;
  hitZ: boolean;
  onGround: boolean;
  /** How far the body was lifted by a step-up this move, in blocks. */
  stepped: number;
}

const EPS = 1e-6;
const boxes: number[] = [];

function gather(world: World, x0: number, y0: number, z0: number, x1: number, y1: number, z1: number): void {
  boxes.length = 0;
  // Fences stand a block and a half tall, so the row below can reach into this range.
  for (let cy = Math.floor(y0) - 1; cy <= Math.floor(y1); cy++) {
    for (let cz = Math.floor(z0); cz <= Math.floor(z1); cz++) {
      for (let cx = Math.floor(x0); cx <= Math.floor(x1); cx++) world.collisionBoxes(cx, cy, cz, boxes);
    }
  }
}

/** Largest part of the move `d` along one axis that does not enter any gathered box. */
function clip(axis: number, d: number, x0: number, y0: number, z0: number, x1: number, y1: number, z1: number): number {
  if (d === 0) return 0;
  const lo = [x0, y0, z0];
  const hi = [x1, y1, z1];
  const a = (axis + 1) % 3;
  const b = (axis + 2) % 3;
  for (let i = 0; i < boxes.length; i += 6) {
    // Only boxes the body overlaps on the other two axes can stop it.
    if ((hi[a] as number) <= (boxes[i + a] as number) + EPS || (lo[a] as number) >= (boxes[i + 3 + a] as number) - EPS) continue;
    if ((hi[b] as number) <= (boxes[i + b] as number) + EPS || (lo[b] as number) >= (boxes[i + 3 + b] as number) - EPS) continue;
    if (d > 0 && (hi[axis] as number) <= (boxes[i + axis] as number) + EPS) d = Math.min(d, (boxes[i + axis] as number) - (hi[axis] as number));
    else if (d < 0 && (lo[axis] as number) >= (boxes[i + 3 + axis] as number) - EPS) d = Math.max(d, (boxes[i + 3 + axis] as number) - (lo[axis] as number));
  }
  return d;
}

/**
 * Move a box whose feet centre is (x, y, z), half-width `hw` and height `h`, by
 * (dx, dy, dz). With `step` > 0 and the body grounded, a blocked horizontal
 * move is retried from `step` higher, which is how stairs and slabs are climbed.
 */
export function moveBox(
  world: World, x: number, y: number, z: number, hw: number, h: number,
  dx: number, dy: number, dz: number, step: number, grounded: boolean,
): MoveResult {
  gather(world, x - hw + Math.min(dx, 0) - 0.01, y + Math.min(dy, 0) - 0.01, z - hw + Math.min(dz, 0) - 0.01,
    x + hw + Math.max(dx, 0) + 0.01, y + h + Math.max(dy, 0) + step + 0.01, z + hw + Math.max(dz, 0) + 0.01);

  const sweep = (sx: number, sy: number, sz: number, mx: number, my: number, mz: number): [number, number, number, number, number, number] => {
    const cy = clip(1, my, sx - hw, sy, sz - hw, sx + hw, sy + h, sz + hw);
    sy += cy;
    const cx = clip(0, mx, sx - hw, sy, sz - hw, sx + hw, sy + h, sz + hw);
    sx += cx;
    const cz = clip(2, mz, sx - hw, sy, sz - hw, sx + hw, sy + h, sz + hw);
    sz += cz;
    return [sx, sy, sz, cx, cy, cz];
  };

  const [nx, ny, nz, cx, cy, cz] = sweep(x, y, z, dx, dy, dz);
  const landed = dy < 0 && cy !== dy;
  if (step > 0 && (grounded || landed) && (cx !== dx || cz !== dz)) {
    // Lift (as far as the ceiling allows), move across, settle back down; keep it only if it got further.
    const up = clip(1, step, x - hw, y, z - hw, x + hw, y + h, z + hw);
    const [tx, ty, tz, tcx, , tcz] = sweep(x, y + up, z, dx, 0, dz);
    const down = clip(1, -up, tx - hw, ty, tz - hw, tx + hw, ty + h, tz + hw);
    if (tcx * tcx + tcz * tcz > cx * cx + cz * cz + 1e-9) {
      const fy = ty + down;
      const rests = down !== -up;
      return { x: tx, y: fy, z: tz, hitX: tcx !== dx, hitY: rests, hitZ: tcz !== dz, onGround: rests || landed, stepped: Math.max(0, fy - y) };
    }
  }
  return { x: nx, y: ny, z: nz, hitX: cx !== dx, hitY: cy !== dy, hitZ: cz !== dz, onGround: landed, stepped: 0 };
}

/** True when a box at this position overlaps no block collision box. */
export function boxIsFree(world: World, x: number, y: number, z: number, hw: number, h: number): boolean {
  gather(world, x - hw, y, z - hw, x + hw, y + h, z + hw);
  for (let i = 0; i < boxes.length; i += 6) {
    if (x + hw > (boxes[i] as number) + EPS && x - hw < (boxes[i + 3] as number) - EPS &&
        y + h > (boxes[i + 1] as number) + EPS && y < (boxes[i + 4] as number) - EPS &&
        z + hw > (boxes[i + 2] as number) + EPS && z - hw < (boxes[i + 5] as number) - EPS) return false;
  }
  return true;
}
