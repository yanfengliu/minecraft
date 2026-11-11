// The habitat map: what kind of country each part of the world is, found by
// sampling it. Every second column is classified (sea, fresh water, shore,
// meadow, woodland, highland) and the samples are tallied into 16-block cells,
// so "the nearest woodland" or "a random spot of meadow near here" is a few
// array reads. Water samples are grouped into bodies, each of which carries a
// fish stock. One coarse cell is re-surveyed every few ticks, so the map
// follows woods that are felled or regrow without ever scanning the world.

import { TAU } from '../../core/math';
import type { Rng } from '../../core/rng';
import { B, WATER_SOURCE } from '../../world/blocks';
import type { World } from '../../world/world';
import type { Area } from '../api';
import { SOFT, isCanopy } from './terrain';

export const H_OTHER = 0;
export const H_SEA = 1;
export const H_FRESH = 2;
export const H_SHORE = 3;
export const H_MEADOW = 4;
export const H_WOOD = 5;
export const H_HIGH = 6;
export const H_COUNT = 7;
// Provisional classes used only while surveying.
const T_WATER = 7;
const T_BARE = 8;

/** Blocks between samples. Two keeps a three-wide river connected. */
export const STRIDE = 2;
/** Blocks along the side of a coarse cell. */
export const COARSE = 16;
const PER = COARSE / STRIDE;
/** A class counts as present in a coarse cell from this many of its 64 samples. */
const PRESENT = 6;
/** Largest water body, in samples: beyond this the sea is cut into separate fishing grounds. */
const BODY_MAX = 768;
const BODY_MIN = 4;

export interface Spot {
  x: number;
  y: number;
  z: number;
}

/** A lake, a reach of river or a stretch of sea, with the fish that live in it. */
export class WaterBody {
  /** Sample indices of this body's water, for picking points in it. */
  cells: Int32Array = new Int32Array(0);
  /** Surface area in square blocks. */
  area = 0;
  cx = 0;
  cz = 0;
  /** Fish the body holds when left alone, and how many it holds now. */
  capacity = 0;
  stock = 0;
  /** Fish drawn when the stock is full, and how many are drawn now. */
  slots = 0;
  shown = 0;

  constructor(readonly id: number, readonly sea: boolean) {}
}

export class Habitat {
  /** Samples and coarse cells along x and z. */
  readonly hx: number;
  readonly hz: number;
  readonly gx: number;
  readonly gz: number;
  /** Class of each sample, and the y that goes with it: the feet cell on land, the top water cell on water. */
  readonly cls: Uint8Array;
  readonly top: Uint8Array;
  /** Samples of each class in the whole world. */
  readonly total = new Int32Array(H_COUNT);
  readonly bodies: WaterBody[] = [];
  /** Body index of each water sample, or -1. */
  readonly bodyOf: Int16Array;
  /** Ground at or above this height is highland. */
  highY = Infinity;

  private readonly counts: Uint16Array;
  private readonly lists: number[][] = [];
  private cursor = 0;

  constructor(readonly world: World, readonly avoid: readonly Area[]) {
    this.hx = world.sx / STRIDE;
    this.hz = world.sz / STRIDE;
    this.gx = world.sx / COARSE;
    this.gz = world.sz / COARSE;
    const n = this.hx * this.hz;
    this.cls = new Uint8Array(n);
    this.top = new Uint8Array(n);
    this.bodyOf = new Int16Array(n).fill(-1);
    this.counts = new Uint16Array(this.gx * this.gz * H_COUNT);
    for (let c = 0; c < H_COUNT; c++) this.lists.push([]);
    this.survey();
  }

  // ---------------------------------------------------------------------------
  // Survey
  // ---------------------------------------------------------------------------

  /** Classify one column. Returns the class (possibly provisional) and leaves the matching y in `this.y`. */
  private y = 0;
  private classify(x: number, z: number): number {
    const w = this.world;
    const h = w.height(x, z);
    this.y = h;
    if (h < 1) return H_OTHER;
    let ground = w.get(x, h - 1, z);
    if (isCanopy(ground)) {
      let y = h - 2;
      while (y > 0 && SOFT[w.get(x, y, z)]) y--;
      this.y = y + 1;
      ground = w.get(x, y, z);
      // A crown over water, a roof or a road is not woodland an animal can use.
      return ground === B.forest_floor || ground === B.grass || ground === B.dirt ? H_WOOD : H_OTHER;
    }
    const above = w.get(x, h, z);
    if (WATER_SOURCE[above]) {
      let y = h;
      while (y + 1 < w.sy && WATER_SOURCE[w.get(x, y + 1, z)]) y++;
      this.y = y;
      return above >= B.river && above < B.river + 8 ? H_FRESH : T_WATER;
    }
    if (ground === B.grass) return H_MEADOW;
    if (ground === B.sand || ground === B.gravel) return h - 1 <= w.seaLevel + 2 ? H_SHORE : T_BARE;
    if (ground === B.stone || ground === B.granite || ground === B.dirt || ground === B.snow || ground === B.clay) return T_BARE;
    return H_OTHER;
  }

  private survey(): void {
    const { hx, hz, cls, top, world } = this;
    let lo = Infinity;
    let hi = -Infinity;
    for (let j = 0; j < hz; j++) {
      for (let i = 0; i < hx; i++) {
        const c = this.classify(i * STRIDE, j * STRIDE);
        const si = j * hx + i;
        cls[si] = c;
        top[si] = this.y;
        if (c !== T_WATER && c !== H_FRESH && c !== H_OTHER) {
          if (this.y < lo) lo = this.y;
          if (this.y > hi) hi = this.y;
        }
      }
    }
    // Highland is the upper part of the land's own relief; flat country has none.
    this.highY = hi - lo >= 8 ? lo + Math.round((hi - lo) * 0.55) : Infinity;

    // The sea is the still water below sea level that reaches the edge of the world.
    const queue = new Int32Array(hx * hz);
    let tail = 0;
    const flood = (si: number): void => {
      if (cls[si] === T_WATER && (top[si] as number) < world.seaLevel) {
        cls[si] = H_SEA;
        queue[tail++] = si;
      }
    };
    for (let i = 0; i < hx; i++) {
      flood(i);
      flood((hz - 1) * hx + i);
    }
    for (let j = 0; j < hz; j++) {
      flood(j * hx);
      flood(j * hx + hx - 1);
    }
    for (let head = 0; head < tail; head++) {
      const si = queue[head] as number;
      const i = si % hx;
      if (i > 0) flood(si - 1);
      if (i < hx - 1) flood(si + 1);
      if (si >= hx) flood(si - hx);
      if (si < hx * (hz - 1)) flood(si + hx);
    }
    for (let si = 0; si < cls.length; si++) {
      const c = this.settle(cls[si] as number, top[si] as number, H_FRESH);
      cls[si] = c;
      this.bump(si, c, 1);
    }
    for (let coarse = 0; coarse < this.gx * this.gz; coarse++) {
      for (let c = 1; c < H_COUNT; c++) {
        if ((this.counts[coarse * H_COUNT + c] as number) >= PRESENT) (this.lists[c] as number[]).push(coarse);
      }
    }
    this.buildBodies(queue);
  }

  /** Turn a provisional class into a final one. */
  private settle(c: number, y: number, water: number): number {
    if (c === T_WATER) return water;
    if (c === T_BARE) return y - 1 >= this.highY ? H_HIGH : H_OTHER;
    if (c === H_MEADOW && y - 1 >= this.highY) return H_HIGH;
    return c;
  }

  private coarseOf(si: number): number {
    const i = si % this.hx;
    const j = (si - i) / this.hx;
    return Math.floor(j / PER) * this.gx + Math.floor(i / PER);
  }

  private bump(si: number, c: number, by: number): void {
    this.counts[this.coarseOf(si) * H_COUNT + c] = (this.counts[this.coarseOf(si) * H_COUNT + c] as number) + by;
    this.total[c] = (this.total[c] as number) + by;
  }

  /** Bring the per-class lists of coarse cells up to date for one cell. */
  private relist(coarse: number): void {
    for (let c = 1; c < H_COUNT; c++) {
      const list = this.lists[c] as number[];
      const present = (this.counts[coarse * H_COUNT + c] as number) >= PRESENT;
      const at = list.indexOf(coarse);
      if (present && at < 0) list.push(coarse);
      else if (!present && at >= 0) list.splice(at, 1);
    }
  }

  /** Re-survey the next coarse cell, so the map follows a world that changes. */
  refreshNext(): void {
    const coarse = this.cursor;
    this.cursor = (this.cursor + 1) % (this.gx * this.gz);
    const ci = coarse % this.gx;
    const cj = (coarse - ci) / this.gx;
    for (let j = cj * PER; j < (cj + 1) * PER; j++) {
      for (let i = ci * PER; i < (ci + 1) * PER; i++) {
        const si = j * this.hx + i;
        const old = this.cls[si] as number;
        // Water keeps the kind it had: the sea does not become a lake by being looked at again.
        const c = this.settle(this.classify(i * STRIDE, j * STRIDE), this.y, old === H_SEA ? H_SEA : H_FRESH);
        this.top[si] = this.y;
        if (c === old) continue;
        this.cls[si] = c;
        this.bump(si, old, -1);
        this.bump(si, c, 1);
      }
    }
    this.relist(coarse);
  }

  private buildBodies(queue: Int32Array): void {
    const { hx, hz, cls, bodyOf } = this;
    const NONE = -2;
    for (let start = 0; start < cls.length; start++) {
      const kind = cls[start] as number;
      if ((kind !== H_SEA && kind !== H_FRESH) || bodyOf[start] !== -1) continue;
      const id = this.bodies.length;
      let tail = 0;
      queue[tail++] = start;
      bodyOf[start] = id;
      for (let head = 0; head < tail && tail < BODY_MAX; head++) {
        const si = queue[head] as number;
        const i = si % hx;
        const j = (si - i) / hx;
        for (let dj = -1; dj <= 1; dj++) {
          for (let di = -1; di <= 1; di++) {
            const ni = i + di;
            const nj = j + dj;
            if (ni < 0 || nj < 0 || ni >= hx || nj >= hz || tail >= BODY_MAX) continue;
            const ns = nj * hx + ni;
            if (cls[ns] !== kind || bodyOf[ns] !== -1) continue;
            bodyOf[ns] = id;
            queue[tail++] = ns;
          }
        }
      }
      if (tail < BODY_MIN) {
        for (let k = 0; k < tail; k++) bodyOf[queue[k] as number] = NONE;
        continue;
      }
      const body = new WaterBody(id, kind === H_SEA);
      body.cells = queue.slice(0, tail);
      body.area = tail * STRIDE * STRIDE;
      let sx = 0;
      let sz = 0;
      for (let k = 0; k < tail; k++) {
        const si = queue[k] as number;
        sx += si % hx;
        sz += Math.floor(si / hx);
      }
      body.cx = (sx / tail) * STRIDE;
      body.cz = (sz / tail) * STRIDE;
      this.bodies.push(body);
    }
    for (let si = 0; si < bodyOf.length; si++) if (bodyOf[si] === NONE) bodyOf[si] = -1;
  }

  // ---------------------------------------------------------------------------
  // Queries
  // ---------------------------------------------------------------------------

  private sample(x: number, z: number): number {
    return Math.floor(z / STRIDE) * this.hx + Math.floor(x / STRIDE);
  }

  inWorld(x: number, z: number, margin = 2): boolean {
    return x >= margin && z >= margin && x < this.world.sx - margin && z < this.world.sz - margin;
  }

  /** Habitat class at a position (H_OTHER outside the world). */
  classAt(x: number, z: number): number {
    return this.inWorld(x, z, 0) ? (this.cls[this.sample(x, z)] as number) : H_OTHER;
  }

  /** Fraction of the coarse cell around a position that is of this class. */
  share(c: number, x: number, z: number): number {
    if (!this.inWorld(x, z, 0)) return 0;
    const coarse = Math.floor(z / COARSE) * this.gx + Math.floor(x / COARSE);
    return (this.counts[coarse * H_COUNT + c] as number) / (PER * PER);
  }

  inAvoid(x: number, z: number): boolean {
    for (const a of this.avoid) {
      const dx = x - a.x;
      const dz = z - a.z;
      if (dx * dx + dz * dz < a.radius * a.radius) return true;
    }
    return false;
  }

  private fill(si: number, out: Spot): void {
    const i = si % this.hx;
    out.x = i * STRIDE + 0.5;
    out.z = ((si - i) / this.hx) * STRIDE + 0.5;
    out.y = this.top[si] as number;
  }

  /** A random spot of this class anywhere in the world. False when there is none. */
  pick(c: number, rng: Rng, out: Spot): boolean {
    const list = this.lists[c] as number[];
    if (list.length === 0) return false;
    const coarse = list[rng.int(list.length)] as number;
    const i0 = (coarse % this.gx) * PER;
    const j0 = Math.floor(coarse / this.gx) * PER;
    for (let t = 0; t < 12; t++) {
      const si = (j0 + rng.int(PER)) * this.hx + i0 + rng.int(PER);
      if (this.cls[si] === c) {
        this.fill(si, out);
        return true;
      }
    }
    for (let j = j0; j < j0 + PER; j++) {
      for (let i = i0; i < i0 + PER; i++) {
        if (this.cls[j * this.hx + i] === c) {
          this.fill(j * this.hx + i, out);
          return true;
        }
      }
    }
    return false;
  }

  /** A random spot of this class between `rMin` and `rMax` blocks from a point. */
  pickNear(c: number, x: number, z: number, rMin: number, rMax: number, rng: Rng, out: Spot, tries = 14): boolean {
    for (let t = 0; t < tries; t++) {
      const ang = rng.float() * TAU;
      const r = rMin + (rMax - rMin) * Math.sqrt(rng.float());
      const px = x + Math.sin(ang) * r;
      const pz = z + Math.cos(ang) * r;
      if (!this.inWorld(px, pz)) continue;
      const si = this.sample(px, pz);
      if (this.cls[si] !== c) continue;
      this.fill(si, out);
      return true;
    }
    return false;
  }

  /** The spot of this class nearest to a point, within `maxR` blocks. */
  nearest(c: number, x: number, z: number, maxR: number, out: Spot): boolean {
    const ci = Math.floor(x / COARSE);
    const cj = Math.floor(z / COARSE);
    const rings = Math.ceil(maxR / COARSE);
    let best = -1;
    let bestD = Infinity;
    for (let ring = 0; ring <= rings && best < 0; ring++) {
      for (let j = cj - ring; j <= cj + ring; j++) {
        if (j < 0 || j >= this.gz) continue;
        for (let i = ci - ring; i <= ci + ring; i++) {
          if (i < 0 || i >= this.gx) continue;
          if (Math.max(Math.abs(i - ci), Math.abs(j - cj)) !== ring) continue;
          if ((this.counts[(j * this.gx + i) * H_COUNT + c] as number) === 0) continue;
          for (let sj = j * PER; sj < (j + 1) * PER; sj++) {
            for (let si = i * PER; si < (i + 1) * PER; si++) {
              if (this.cls[sj * this.hx + si] !== c) continue;
              const dx = si * STRIDE - x;
              const dz = sj * STRIDE - z;
              const d = dx * dx + dz * dz;
              if (d < bestD) {
                bestD = d;
                best = sj * this.hx + si;
              }
            }
          }
        }
      }
    }
    if (best < 0 || bestD > maxR * maxR) return false;
    this.fill(best, out);
    return true;
  }

  /** True when the straight line between two points passes over water. */
  crossesWater(x0: number, z0: number, x1: number, z1: number): boolean {
    const dx = x1 - x0;
    const dz = z1 - z0;
    const steps = Math.ceil(Math.hypot(dx, dz) / STRIDE);
    for (let k = 1; k < steps; k++) {
      const c = this.classAt(x0 + (dx * k) / steps, z0 + (dz * k) / steps);
      if (c === H_SEA || c === H_FRESH) return true;
    }
    return false;
  }

  /** The water body nearest to a point within `radius` blocks, or null. */
  bodyNear(x: number, z: number, radius: number): WaterBody | null {
    const i0 = Math.max(0, Math.floor((x - radius) / STRIDE));
    const i1 = Math.min(this.hx - 1, Math.floor((x + radius) / STRIDE));
    const j0 = Math.max(0, Math.floor((z - radius) / STRIDE));
    const j1 = Math.min(this.hz - 1, Math.floor((z + radius) / STRIDE));
    let best = -1;
    let bestD = radius * radius;
    for (let j = j0; j <= j1; j++) {
      for (let i = i0; i <= i1; i++) {
        const b = this.bodyOf[j * this.hx + i] as number;
        if (b < 0) continue;
        const dx = i * STRIDE + 0.5 - x;
        const dz = j * STRIDE + 0.5 - z;
        const d = dx * dx + dz * dz;
        if (d <= bestD) {
          bestD = d;
          best = b;
        }
      }
    }
    return best < 0 ? null : (this.bodies[best] as WaterBody);
  }

  /** A random point on the surface of a water body: `out.y` is its top water cell. */
  pointIn(body: WaterBody, rng: Rng, out: Spot): void {
    this.fill(body.cells[rng.int(body.cells.length)] as number, out);
  }
}
