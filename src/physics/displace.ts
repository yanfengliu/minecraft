// Where finite water goes when something is put into the cell it was in: a
// block the player sets down, a seed sown, a trunk grown. It belongs to the
// body it stood in, so that is where it is put back.
//
// At once, where water would go of itself: into the cell below, and sideways
// into water with room or into the open (a puddle is squeezed aside). What is
// left is given to the body. The full water joined to the block is searched
// for water with room: the highest of it first, so that the search climbs to
// the surface from any depth, and at each height the nearest first. All of it
// is searched before anything else is settled for. A body with no room in it
// rises instead, at the lowest open cell found against it. Only water with no
// body and no open cell at all is lost, and it is counted.
//
// The search has no limit of distance. Three versions that had one each lost
// water that had somewhere to go: beside and straight above the block only; a
// fixed number of cells spread evenly, which gave up at the bottom of a deep
// pool; and a larger number taken highest first, which gave up in a wide pool
// under a roof with one way out. What bounds the work instead is time. Between
// one fluid tick and the next the searches pass through so many full cells and
// no more, however many blocks are set down, which is the whole of any
// ordinary pond; each tick then carries on with as many again. One search runs
// at a time and the rest wait their turn, so the memory taken is one body's
// worth. Water waiting to be placed is in `pending`: it is not in the world
// and it is not lost.
//
// A search that runs over several ticks is told of every change anyone else
// makes to a cell it has looked at, because room may have opened behind it.
// After such a change it does not settle for what it found. It looks again, a
// few times over, before it lets the body rise; and it never calls water lost
// on the word of a search the world changed under.

import { REPLACEABLE, WATER_LEVEL, WATER_SOURCE } from '../world/blocks';
import type { World } from '../world/world';
import { CellSet } from './cellset';
import { DX, DZ } from './leveling';

/** Put up to `units` of finite water into a cell and return what fitted. A source swallows all of it; a cell that cannot hold water takes none. */
export type PutWater = (x: number, y: number, z: number, units: number) => number;

/** Full cells the searches may pass through between one fluid tick and the next, in the calls that displace water: more than any pond holds. */
export const DISPLACE_AT_ONCE = 4096;
/** Full cells the searches pass through on each fluid tick. */
export const DISPLACE_PER_TICK = 4096;
/** Times running a search starts again, because what it had looked at was changed, before it lets the body rise at the open cell it found. */
const RESTARTS = 2;

interface Parcel {
  x: number;
  y: number;
  z: number;
  units: number;
  /** 0..3: which side is looked at first, so that the same side is not always favoured. */
  turn: number;
}

interface Job extends Parcel {
  restarts: number;
}

export class Displacement {
  /** Units given up: displaced, with no body to take them and no open cell at all. */
  lost = 0;
  /** Full cells every search so far has passed through: the work done. */
  passed = 0;

  private job: Job | null = null;
  private readonly waiting: Parcel[] = [];
  /** Cells the search under way has looked at. */
  private readonly seen: CellSet;
  /** Full cells still to be passed through, by height and at each height in the order they were found; `heads` is how far each has been read. */
  private readonly levels: number[][] = [];
  private readonly heads: number[] = [];
  private highest = -1;
  private queued = 0;
  /** The lowest open cell found against the body, and its height; -1 when none has been. */
  private spill = -1;
  private spillY = 0;
  /** True once anyone else has changed a cell the search under way had looked at. */
  private stale = false;
  /** True while this object is placing water. Its own writes only add water: they never make room. */
  private placing = false;
  /** Full cells the calls that displace water may still pass through before the next tick. */
  private atOnce = DISPLACE_AT_ONCE;

  /** `put` places water in a cell. */
  constructor(private readonly world: World, private readonly put: PutWater) {
    this.seen = new CellSet(world);
  }

  /** Units displaced and not yet placed. */
  get pending(): number {
    let units = this.job ? this.job.units : 0;
    for (const p of this.waiting) units += p.units;
    return units;
  }

  /** True while there is water still to be placed. */
  get busy(): boolean {
    return this.job !== null || this.waiting.length > 0;
  }

  /** Somebody wrote to this cell, water or anything else. A search under way has to know if it was a cell it had looked at. */
  changed(x: number, y: number, z: number): void {
    if (this.job !== null && !this.placing && !this.stale && this.seen.has(x, y, z)) this.stale = true;
  }

  /** `units` of water have lost their cell at (x, y, z) to something written there. */
  displace(x: number, y: number, z: number, units: number, turn: number): void {
    const w = this.world;
    units -= this.place(x, y - 1, z, units);
    // Sideways: water with room first, then the open.
    for (let pass = 0; pass < 2 && units > 0; pass++) {
      for (let k = 0; k < 4 && units > 0; k++) {
        const i = (turn + k) & 3;
        const nx = x + (DX[i] as number);
        const nz = z + (DZ[i] as number);
        if (!w.inBounds(nx, y, nz)) continue;
        const wet = (WATER_LEVEL[w.get(nx, y, nz)] as number) > 0;
        if (wet === (pass === 0)) units -= this.place(nx, y, nz, units);
      }
    }
    if (units <= 0) return;
    this.waiting.push({ x, y, z, units, turn });
    if (this.job === null && this.atOnce > 0) this.atOnce = this.run(this.atOnce);
  }

  /** Once each fluid tick: carry on with the search under way and with those waiting behind it. */
  advance(): void {
    this.run(DISPLACE_PER_TICK);
    this.atOnce = DISPLACE_AT_ONCE;
  }

  // -------------------------------------------------------------------------

  /** Pass through up to `budget` full cells, starting the next search as each one ends. Returns what is left of the budget. */
  private run(budget: number): number {
    const w = this.world;
    const layer = w.sx * w.sz;
    while (budget > 0) {
      if (!this.job) {
        const next = this.waiting.shift();
        if (!next) break;
        this.begin(next, 0);
      }
      const job = this.job as Job;
      while (budget > 0 && job.units > 0 && this.queued > 0) {
        let q = this.levels[this.highest];
        while (q === undefined || (this.heads[this.highest] as number) >= q.length) q = this.levels[--this.highest];
        const head = this.heads[this.highest] as number;
        this.heads[this.highest] = head + 1;
        const k = q[head] as number;
        this.queued--;
        budget--;
        this.passed++;
        const cy = Math.floor(k / layer);
        const cz = Math.floor((k - cy * layer) / w.sx);
        const cx = k - cy * layer - cz * w.sx;
        // It may have changed since it was queued: room in it now, or no longer water at all.
        const s = w.get(cx, cy, cz);
        const level = WATER_LEVEL[s] as number;
        if (WATER_SOURCE[s] || (level > 0 && level < 16)) {
          job.units -= this.place(cx, cy, cz, job.units);
          if (job.units <= 0) break;
        } else if (level !== 16) {
          continue;
        }
        this.around(job, cx, cy, cz, false);
      }
      // Out of budget with more to look at: carry on at the next tick.
      if (job.units > 0 && this.queued > 0) break;
      // Water put back in the line is not looked for again in the same call.
      if (!this.finish(job)) break;
    }
    return budget;
  }

  private place(x: number, y: number, z: number, units: number): number {
    this.placing = true;
    const fitted = this.put(x, y, z, units);
    this.placing = false;
    return fitted;
  }

  private begin(p: Parcel, restarts: number): void {
    this.seen.clear();
    for (let i = 0; i < this.levels.length; i++) {
      const q = this.levels[i];
      if (q === undefined) continue;
      q.length = 0;
      this.heads[i] = 0;
    }
    this.highest = -1;
    this.queued = 0;
    this.spill = -1;
    this.spillY = this.world.sy;
    this.stale = false;
    const job: Job = { x: p.x, y: p.y, z: p.z, units: p.units, turn: p.turn, restarts };
    this.job = job;
    this.seen.add(p.x, p.y, p.z);
    this.around(job, p.x, p.y, p.z, true);
  }

  /**
   * Look at the six cells round one: give water to those with room, queue
   * those that are full, and note open air as somewhere the body could rise.
   * Round the block itself (`origin`) open air is not noted: it is not against
   * the body, and is the last resort.
   */
  private around(job: Job, cx: number, cy: number, cz: number, origin: boolean): void {
    const w = this.world;
    const layer = w.sx * w.sz;
    for (let d = 0; d < 6 && job.units > 0; d++) {
      let nx = cx;
      let ny = cy;
      let nz = cz;
      if (d === 0) ny--;
      else if (d === 5) ny++;
      else {
        const i = (job.turn + d - 1) & 3;
        nx += DX[i] as number;
        nz += DZ[i] as number;
      }
      if (!w.inBounds(nx, ny, nz) || this.seen.has(nx, ny, nz)) continue;
      this.seen.add(nx, ny, nz);
      const nk = ny * layer + nz * w.sx + nx;
      const s = w.get(nx, ny, nz);
      const level = WATER_LEVEL[s] as number;
      if (WATER_SOURCE[s] || (level > 0 && level < 16)) {
        job.units -= this.place(nx, ny, nz, job.units);
        if (job.units <= 0) return;
      } else if (level === 0) {
        if (!origin && REPLACEABLE[s] && ny < this.spillY) {
          this.spillY = ny;
          this.spill = nk;
        }
        continue;
      }
      // Full, now or already: to be passed through.
      let q = this.levels[ny];
      if (q === undefined) {
        q = [];
        this.levels[ny] = q;
        this.heads[ny] = 0;
      }
      q.push(nk);
      this.queued++;
      if (ny > this.highest) this.highest = ny;
    }
  }

  /**
   * The search is over. Place what is left where the body can rise, or
   * failing a body round the block, or count it lost. Returns false when the
   * water goes back in the line instead, to be looked for again.
   */
  private finish(job: Job): boolean {
    const w = this.world;
    this.job = null;
    if (job.units <= 0) return true;
    if (this.stale && job.restarts < RESTARTS) {
      // What it looked at was changed under it, and there may be room now where there was none.
      this.begin(job, job.restarts + 1);
      return true;
    }
    if (this.spill >= 0) {
      const layer = w.sx * w.sz;
      const cy = Math.floor(this.spill / layer);
      const cz = Math.floor((this.spill - cy * layer) / w.sx);
      job.units -= this.place(this.spill - cy * layer - cz * w.sx, cy, cz, job.units);
    }
    if (job.units > 0) {
      // No body, or none with anywhere to rise: back where it was if that is open again, else onto what was put there.
      job.units -= this.place(job.x, job.y, job.z, job.units);
      if (job.units > 0) job.units -= this.place(job.x, job.y + 1, job.z, job.units);
    }
    if (job.units <= 0) return true;
    if (!this.stale) {
      // Everything was looked at, nothing changed meanwhile, and there is nowhere.
      this.lost += job.units;
      return true;
    }
    this.waiting.push({ x: job.x, y: job.y, z: job.z, units: job.units, turn: job.turn });
    return false;
  }
}
