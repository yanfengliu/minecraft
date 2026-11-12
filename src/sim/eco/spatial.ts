// A uniform grid over the world holding every living animal, for "who is near
// here" questions: a fox looking for rabbits, a doe noticing a wolf, the hunter
// asking for game. Cells are intrusive doubly linked lists threaded through the
// animals themselves, so moving between cells is a few pointer writes and a
// query allocates nothing.

import type { Animal } from './types';

/** Blocks along the side of a hash cell. */
export const HASH_CELL = 16;
const SHIFT = 4;

export class SpatialHash {
  private readonly nx: number;
  private readonly nz: number;
  private readonly heads: (Animal | null)[];

  constructor(sx: number, sz: number) {
    this.nx = Math.ceil(sx / HASH_CELL);
    this.nz = Math.ceil(sz / HASH_CELL);
    this.heads = new Array<Animal | null>(this.nx * this.nz).fill(null);
  }

  private cellOf(x: number, z: number): number {
    let i = x >> SHIFT;
    let j = z >> SHIFT;
    if (i < 0) i = 0;
    else if (i >= this.nx) i = this.nx - 1;
    if (j < 0) j = 0;
    else if (j >= this.nz) j = this.nz - 1;
    return j * this.nx + i;
  }

  insert(a: Animal): void {
    this.link(a, this.cellOf(a.x, a.z));
  }

  private link(a: Animal, c: number): void {
    const head = this.heads[c] as Animal | null;
    a.hcell = c;
    a.hprev = null;
    a.hnext = head;
    if (head) head.hprev = a;
    this.heads[c] = a;
  }

  remove(a: Animal): void {
    if (a.hcell < 0) return;
    if (a.hprev) a.hprev.hnext = a.hnext;
    else this.heads[a.hcell] = a.hnext;
    if (a.hnext) a.hnext.hprev = a.hprev;
    a.hcell = -1;
    a.hprev = null;
    a.hnext = null;
  }

  /**
   * Call when an animal has entered another column, with its `cx` and `cz`
   * already set to it; relinks it only if it changed cell. It is filed by that
   * column, not by `x` and `z`: the movers call this as they cross, before they
   * write the new position, and filed by the old one an animal that stopped
   * just over a cell's edge stayed in the wrong cell, unseen by a search whose
   * box did not reach back into it.
   */
  moved(a: Animal): void {
    if (a.hcell < 0) return;
    const c = this.cellOf(a.cx, a.cz);
    if (c === a.hcell) return;
    this.remove(a);
    this.link(a, c);
  }

  /**
   * The nearest animal (by ground distance) within `radius` whose species bit
   * is in `mask`, other than `skip`. Animals whose state equals `notState` are
   * passed over; pass -1 to take any.
   */
  nearest(x: number, z: number, radius: number, mask: number, skip: Animal | null, notState: number): Animal | null {
    const i0 = Math.max(0, (x - radius) >> SHIFT);
    const i1 = Math.min(this.nx - 1, (x + radius) >> SHIFT);
    const j0 = Math.max(0, (z - radius) >> SHIFT);
    const j1 = Math.min(this.nz - 1, (z + radius) >> SHIFT);
    let best: Animal | null = null;
    let bestD = radius * radius;
    for (let j = j0; j <= j1; j++) {
      for (let i = i0; i <= i1; i++) {
        for (let a = this.heads[j * this.nx + i] as Animal | null; a; a = a.hnext) {
          if (!((1 << a.sp.index) & mask) || a === skip || a.state === notState) continue;
          const dx = a.x - x;
          const dz = a.z - z;
          const d = dx * dx + dz * dz;
          if (d < bestD) {
            bestD = d;
            best = a;
          }
        }
      }
    }
    return best;
  }

  /** Put every animal within `radius` whose species bit is in `mask` into `out`; returns how many. */
  collect(x: number, z: number, radius: number, mask: number, out: Animal[]): number {
    const i0 = Math.max(0, (x - radius) >> SHIFT);
    const i1 = Math.min(this.nx - 1, (x + radius) >> SHIFT);
    const j0 = Math.max(0, (z - radius) >> SHIFT);
    const j1 = Math.min(this.nz - 1, (z + radius) >> SHIFT);
    const r2 = radius * radius;
    let n = 0;
    for (let j = j0; j <= j1; j++) {
      for (let i = i0; i <= i1; i++) {
        for (let a = this.heads[j * this.nx + i] as Animal | null; a; a = a.hnext) {
          if (!((1 << a.sp.index) & mask)) continue;
          const dx = a.x - x;
          const dz = a.z - z;
          if (dx * dx + dz * dz < r2) out[n++] = a;
        }
      }
    }
    return n;
  }
}
