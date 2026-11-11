// Loose blocks: sand, gravel and snow. A loose block with nothing under it
// leaves the grid, falls as a plain vertical body, and goes back into the grid
// on the first cell that can hold it. One that lands on a heap steeper than
// its angle of repose slides off sideways, so heaps settle at 45 degrees
// instead of standing as towers. The grid is the truth: a falling block is
// only the animation between two grid states.

import { hash3i } from '../core/rng';
import { B, LOOSE, REPLACEABLE, SOLID, WATER_LEVEL } from '../world/blocks';
import type { World } from '../world/world';
import { GRAVITY, type BodyView, type EmitEvent } from './types';

// Local aliases keep table reads cheap under any module loader (see fluid.ts).
const IS_LOOSE = LOOSE;
const OPEN = REPLACEABLE;
const HARD = SOLID;
const LEVEL = WATER_LEVEL;
const AIR = B.air;

const DX = [1, 0, -1, 0];
const DZ = [0, 1, 0, -1];
/** Fastest a block falls through air and sinks through water, m/s. */
const MAX_FALL = 50;
const SINK_SPEED = 3;
/** How fast a block that slid off a heap closes the sideways gap to its new column, m/s. */
const SLIDE_SPEED = 5;

/** What the loose-block system needs from the rest of physics. */
export interface LooseHost {
  emit: EmitEvent;
  nextId(): number;
  addView(view: BodyView): void;
  removeView(view: BodyView): void;
  /** Called before a block replaces the water in a cell, so the water can be pushed aside. */
  displace(x: number, y: number, z: number): void;
  /** True when something that must not be buried (the player) occupies the cell. */
  blocked(x: number, y: number, z: number): boolean;
  /** Turn a block that has nowhere to land into its item drop. */
  drop(state: number, x: number, y: number, z: number): void;
}

export interface LooseOptions {
  seed?: number;
  /** Cells examined per step; a larger cascade carries on over the following steps. */
  maxChecksPerStep?: number;
  /** Blocks in flight at once; beyond this a block is put straight where it would land. */
  maxFalling?: number;
}

interface Falling {
  view: BodyView;
  state: number;
  /** Column the block is falling in. */
  cx: number;
  cz: number;
  /** Height of the block's underside. */
  y: number;
  vy: number;
  /** Sideways offset still to close after sliding off a heap, in blocks. */
  ox: number;
  oz: number;
  wet: boolean;
}

export class LooseBlocks {
  private readonly falling: Falling[] = [];
  private queue: number[] = [];
  private head = 0;
  private readonly queued = new Set<number>();
  private readonly seed: number;
  private readonly maxChecks: number;
  private readonly maxFalling: number;

  constructor(private readonly world: World, private readonly host: LooseHost, opts: LooseOptions = {}) {
    this.seed = opts.seed ?? 0;
    this.maxChecks = opts.maxChecksPerStep ?? 128;
    this.maxFalling = opts.maxFalling ?? 512;
  }

  /** Blocks in flight. */
  get fallingCount(): number {
    return this.falling.length;
  }

  /** Cells waiting to be examined. */
  get pending(): number {
    return this.queue.length - this.head;
  }

  /** True when nothing is falling and nothing is waiting to be looked at. */
  get idle(): boolean {
    return this.falling.length === 0 && this.pending === 0;
  }

  /** A block changed. Queue whatever that may have set loose; nothing moves until `step`. */
  onBlockChanged(x: number, y: number, z: number, old: number, state: number): void {
    if (IS_LOOSE[state]) this.enqueue(x, y, z);
    if (OPEN[state] && !OPEN[old]) {
      // The cell stopped holding things up, stopped being in the way, and stopped weighing on what is under it.
      this.enqueue(x, y + 1, z);
      this.enqueue(x, y - 1, z);
      for (let i = 0; i < 4; i++) {
        const nx = x + (DX[i] as number);
        const nz = z + (DZ[i] as number);
        this.enqueue(nx, y, nz);
        this.enqueue(nx, y + 1, nz);
      }
    }
  }

  /** Ask for one cell to be examined, for example after loading a world with unsupported sand. */
  enqueue(x: number, y: number, z: number): void {
    const w = this.world;
    if (!w.inBounds(x, y, z)) return;
    const key = (y * w.sz + z) * w.sx + x;
    if (this.queued.has(key)) return;
    this.queued.add(key);
    this.queue.push(key);
  }

  step(dt: number): void {
    const w = this.world;
    const end = Math.min(this.queue.length, this.head + this.maxChecks);
    while (this.head < end) {
      const key = this.queue[this.head++] as number;
      this.queued.delete(key);
      const x = key % w.sx;
      const z = Math.floor(key / w.sx) % w.sz;
      this.check(x, Math.floor(key / (w.sx * w.sz)), z);
    }
    if (this.head === this.queue.length) {
      this.queue.length = 0;
      this.head = 0;
    } else if (this.head > 1024) {
      this.queue = this.queue.slice(this.head);
      this.head = 0;
    }
    for (let i = this.falling.length - 1; i >= 0; i--) {
      if (this.advance(this.falling[i] as Falling, dt)) {
        const last = this.falling.pop() as Falling;
        if (i < this.falling.length) this.falling[i] = last;
      }
    }
  }

  // -------------------------------------------------------------------------

  private check(x: number, y: number, z: number): void {
    const w = this.world;
    const s = w.get(x, y, z);
    if (!IS_LOOSE[s] || y <= 0) return;
    const below = w.get(x, y - 1, z);
    if (OPEN[below]) {
      this.release(x, y, z, s, 0, 0);
      return;
    }
    // Only the top of a heap slides: a block with weight on it stays put, and
    // so does one lying on firm ground, however narrow the ledge.
    if (!IS_LOOSE[below] || HARD[w.get(x, y + 1, z)]) return;
    const r = hash3i(x, y, z, this.seed) & 3;
    for (let k = 0; k < 4; k++) {
      const i = (r + k) & 3;
      const nx = x + (DX[i] as number);
      const nz = z + (DZ[i] as number);
      if (!w.inBounds(nx, y, nz)) continue;
      if (OPEN[w.get(nx, y, nz)] && OPEN[w.get(nx, y - 1, nz)]) {
        this.release(x, y, z, s, DX[i] as number, DZ[i] as number);
        return;
      }
    }
  }

  /** Take a block out of the grid and let it fall, optionally stepping one column sideways first. */
  private release(x: number, y: number, z: number, state: number, dx: number, dz: number): void {
    this.world.set(x, y, z, AIR);
    const cx = x + dx;
    const cz = z + dz;
    if (this.falling.length >= this.maxFalling) {
      // Too many in the air to animate: put it straight where it would come to rest.
      let k = y - 1;
      while (k >= 0 && OPEN[this.world.get(cx, k, cz)]) k--;
      this.land(state, cx, k + 1, cz);
      return;
    }
    const view: BodyView = {
      id: this.host.nextId(), kind: 'block',
      x: x + 0.5, y: y + 0.5, z: z + 0.5, qx: 0, qy: 0, qz: 0, qw: 1,
      sleeping: false, state, item: -1, count: 0, cells: [], version: 0,
    };
    this.host.addView(view);
    this.falling.push({ view, state, cx, cz, y, vy: 0, ox: -dx, oz: -dz, wet: false });
  }

  /** Move one falling block. Returns true when it has landed and should be forgotten. */
  private advance(f: Falling, dt: number): boolean {
    const w = this.world;
    const inWater = LEVEL[w.get(f.cx, Math.floor(f.y + 0.5), f.cz)] !== 0;
    f.vy -= GRAVITY * dt;
    if (inWater) {
      if (!f.wet) {
        f.wet = true;
        this.host.emit({ type: 'splash', x: f.cx + 0.5, y: Math.floor(f.y + 0.5) + 1, z: f.cz + 0.5, strength: Math.min(10, -f.vy) });
      }
      if (f.vy < -SINK_SPEED) f.vy = -SINK_SPEED;
    } else if (f.vy < -MAX_FALL) f.vy = -MAX_FALL;
    const target = f.y + f.vy * dt;
    // Every cell the underside passes into must be free; the first that is not is what it lands on.
    for (let k = Math.ceil(f.y) - 1; k >= Math.floor(target); k--) {
      if (k >= 0 && OPEN[w.get(f.cx, k, f.cz)]) continue;
      this.host.removeView(f.view);
      this.land(f.state, f.cx, k + 1, f.cz);
      return true;
    }
    f.y = target;
    const slide = SLIDE_SPEED * dt;
    f.ox = Math.abs(f.ox) <= slide ? 0 : f.ox - Math.sign(f.ox) * slide;
    f.oz = Math.abs(f.oz) <= slide ? 0 : f.oz - Math.sign(f.oz) * slide;
    f.view.x = f.cx + 0.5 + f.ox;
    f.view.y = f.y + 0.5;
    f.view.z = f.cz + 0.5 + f.oz;
    return false;
  }

  /** Put a block back into the grid at a cell, or drop it as an item if the cell cannot take it. */
  private land(state: number, x: number, y: number, z: number): void {
    const w = this.world;
    // Falling blocks do not see each other, so another may have come to rest
    // here first: this one settles on top of it.
    for (let tries = 0; tries < 8 && IS_LOOSE[w.get(x, y, z)]; tries++) y++;
    const there = w.get(x, y, z);
    if (!w.inBounds(x, y, z) || !OPEN[there] || this.host.blocked(x, y, z)) {
      this.host.drop(state, x + 0.5, y + 0.5, z + 0.5);
      return;
    }
    if (LEVEL[there] !== 0) this.host.displace(x, y, z);
    else if (there !== AIR) this.host.emit({ type: 'burst', x: x + 0.5, y: y + 0.5, z: z + 0.5, state: there });
    w.set(x, y, z, state);
    this.host.emit({ type: 'land', x: x + 0.5, y: y + 0.5, z: z + 0.5, state });
  }
}
