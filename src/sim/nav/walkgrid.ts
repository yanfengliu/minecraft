// A memo of `standHeight` and step cost per feet cell. A search asks about the
// same cell from each of its neighbours, and the next search asks about most
// of the same cells again, so remembering the answers is most of the cost of
// pathfinding saved. The table is direct-mapped and of fixed size: a collision
// simply overwrites, and an edit to the world forgets the four feet cells whose
// answer it could change.

import { isDoor, isGate } from '../../world/blocks';
import { standHeight, walkCost, type WalkOptions } from '../../world/walk';
import type { World } from '../../world/world';
import { packCell } from './cells';

/** Extra cost of stepping through a doorway, so routes do not wander through houses for a shortcut. */
const DOOR_COST = 1.5;

export class WalkGrid {
  private readonly world: World;
  private readonly opt: WalkOptions;
  private readonly keys: Int32Array;
  private readonly heights: Float32Array;
  private readonly costs: Float32Array;
  private readonly shift: number;

  constructor(world: World, opt: WalkOptions, bits = 17) {
    this.world = world;
    this.opt = opt;
    this.keys = new Int32Array(1 << bits).fill(-1);
    this.heights = new Float32Array(1 << bits);
    this.costs = new Float32Array(1 << bits);
    this.shift = 32 - bits;
  }

  /** Table slot holding this cell's answers, filled in if it held another cell's. The cell must be inside the world. */
  private slot(x: number, y: number, z: number): number {
    const key = packCell(x, y, z);
    const s = Math.imul(key, 0x9e3779b1) >>> this.shift;
    if (this.keys[s] !== key) {
      const world = this.world;
      const h = standHeight(world, x, y, z, this.opt);
      this.keys[s] = key;
      this.heights[s] = h;
      if (h === h) {
        const here = world.get(x, y, z);
        this.costs[s] = walkCost(world, x, y, z) + (isDoor(here) || isGate(here) ? DOOR_COST : 0);
      } else {
        this.costs[s] = 0;
      }
    }
    return s;
  }

  private inside(x: number, y: number, z: number): boolean {
    const world = this.world;
    return x >= 0 && z >= 0 && y > 0 && x < world.sx && z < world.sz && y < world.sy;
  }

  /** Height of the surface stood on in this feet cell, or NaN when it cannot be stood in (or lies outside the world). */
  height(x: number, y: number, z: number): number {
    return this.inside(x, y, z) ? (this.heights[this.slot(x, y, z)] as number) : NaN;
  }

  /** Cost multiplier of a step into this cell: the surface underfoot, wading, and a doorway. Only meaningful where `height` is a number. */
  cost(x: number, y: number, z: number): number {
    return this.inside(x, y, z) ? (this.costs[this.slot(x, y, z)] as number) : 0;
  }

  /** A block changed at (x, y, z): forget every feet cell whose footing or headroom it is part of. */
  invalidate(x: number, y: number, z: number): void {
    for (let fy = y - 2; fy <= y + 1; fy++) {
      if (fy < 0) continue;
      const key = packCell(x, fy, z);
      const s = Math.imul(key, 0x9e3779b1) >>> this.shift;
      if (this.keys[s] === key) this.keys[s] = -1;
    }
  }
}
