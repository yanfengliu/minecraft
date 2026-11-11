// Voxel light: two flood-filled channels per cell, 0..15 each.
//
//   sky    how much open sky reaches the cell. 15 falls straight down through
//          clear cells without loss; every other step costs max(1, opacity).
//   block  light from emitters (torches, lanterns, forges), same falloff.
//
// The renderer uses sky as ambient-sky visibility (real sun shadows come from
// shadow maps) and block as warm local light. `computeAll` builds both from
// scratch; `update` repairs them after one block change, and a property test
// holds the two to exact agreement. Headless and worker-safe.

import { EMIT, LIGHT_OPACITY } from './blocks';
import type { World } from './world';

const SKY = 0;
const BLOCK = 1;

const DX = [1, -1, 0, 0, 0, 0];
const DY = [0, 0, 1, -1, 0, 0];
const DZ = [0, 0, 0, 0, 1, -1];
const DOWN = 3;

/** Growable FIFO of packed cell indices (and an optional parallel value). */
class Queue {
  data = new Int32Array(1 << 16);
  head = 0;
  tail = 0;

  push(v: number): void {
    if (this.tail === this.data.length) {
      if (this.head > this.data.length >> 1) {
        this.data.copyWithin(0, this.head, this.tail);
        this.tail -= this.head;
        this.head = 0;
      } else {
        const bigger = new Int32Array(this.data.length * 2);
        bigger.set(this.data.subarray(this.head, this.tail));
        this.tail -= this.head;
        this.head = 0;
        this.data = bigger;
      }
    }
    this.data[this.tail++] = v;
  }

  get empty(): boolean {
    return this.head === this.tail;
  }

  shift(): number {
    return this.data[this.head++] as number;
  }

  clear(): void {
    this.head = 0;
    this.tail = 0;
  }
}

export class LightEngine {
  private readonly world: World;
  private readonly addQ = new Queue();
  private readonly remQ = new Queue();
  private readonly swept: number[] = [];
  private readonly sxz: number;

  constructor(world: World) {
    this.world = world;
    this.sxz = world.sx * world.sz;
  }

  /** Subscribe to the world so every block change repairs light. Returns the unsubscribe function. */
  attach(): () => void {
    return this.world.changed.on((c) => this.update(c.x, c.y, c.z));
  }

  private pack(x: number, y: number, z: number): number {
    return y * this.sxz + z * this.world.sx + x;
  }

  private get(channel: number, x: number, y: number, z: number): number {
    const v = this.world.getLight(x, y, z);
    return channel === SKY ? v >> 4 : v & 15;
  }

  private put(channel: number, x: number, y: number, z: number, value: number): void {
    const v = this.world.getLight(x, y, z);
    this.world.setLight(x, y, z, channel === SKY ? (v & 15) | (value << 4) : (v & 0xf0) | value);
  }

  // -------------------------------------------------------------------------
  // Full computation
  // -------------------------------------------------------------------------

  computeAll(): void {
    const w = this.world;
    const { sx, sy, sz, nsx, nsy, nsz } = w;
    const wasTracking = w.trackDirty;
    w.trackDirty = false;

    // 1. Per column: the highest cell that is not perfectly clear. Everything above it sees the whole sky.
    const top = new Int16Array(sx * sz);
    for (let z = 0; z < sz; z++) {
      for (let x = 0; x < sx; x++) top[z * sx + x] = w.topWhere(x, z, LIGHT_OPACITY);
    }

    // 2. Reset every section: fully lit above the column tops, dark below.
    for (let syi = 0; syi < nsy; syi++) {
      for (let szi = 0; szi < nsz; szi++) {
        for (let sxi = 0; sxi < nsx; sxi++) {
          const si = w.sectionIndex(sxi, syi, szi);
          const y0 = syi * 32;
          let maxTop = -1;
          let minTop = sy;
          for (let lz = 0; lz < 32; lz++) {
            for (let lx = 0; lx < 32; lx++) {
              const t = top[(szi * 32 + lz) * sx + sxi * 32 + lx] as number;
              if (t > maxTop) maxTop = t;
              if (t < minTop) minTop = t;
            }
          }
          if (maxTop < y0) {
            w.light[si] = null;
            w.uniformLight[si] = 0xf0;
          } else if (minTop >= y0 + 31) {
            w.light[si] = null;
            w.uniformLight[si] = 0;
          } else {
            const l = new Uint8Array(32768);
            for (let lz = 0; lz < 32; lz++) {
              for (let lx = 0; lx < 32; lx++) {
                const t = top[(szi * 32 + lz) * sx + sxi * 32 + lx] as number;
                for (let ly = Math.max(0, t + 1 - y0); ly < 32; ly++) l[(ly << 10) | (lz << 5) | lx] = 0xf0;
              }
            }
            w.light[si] = l;
            w.uniformLight[si] = 0;
          }
        }
      }
    }

    // 3. Seed the sky flood: lit cells that border a shaded column, and the cell just above each
    //    translucent top (leaves, water) so light leaks down into it.
    this.addQ.clear();
    for (let z = 0; z < sz; z++) {
      for (let x = 0; x < sx; x++) {
        const t = top[z * sx + x] as number;
        let reach = t;
        if (x > 0) reach = Math.max(reach, top[z * sx + x - 1] as number);
        if (x < sx - 1) reach = Math.max(reach, top[z * sx + x + 1] as number);
        if (z > 0) reach = Math.max(reach, top[(z - 1) * sx + x] as number);
        if (z < sz - 1) reach = Math.max(reach, top[(z + 1) * sx + x] as number);
        const from = t + 1;
        const to = Math.min(sy - 1, Math.max(reach, t >= 0 && LIGHT_OPACITY[w.get(x, t, z)] !== 15 ? from : t));
        for (let y = from; y <= to; y++) this.addQ.push(this.pack(x, y, z));
        // A translucent block in the very top layer has no lit cell above it to leak from: the sky itself is above.
        if (t === sy - 1) this.seedCeiling(x, z);
      }
    }
    this.flood(SKY);

    // 4. Block light from every emitter.
    for (let si = 0; si < w.sectionCount; si++) {
      const s = w.blocks[si];
      const u = w.uniform[si] as number;
      if (!s && EMIT[u] === 0) continue;
      const sxi = si % nsx;
      const szi = Math.floor(si / nsx) % nsz;
      const syi = Math.floor(si / (nsx * nsz));
      for (let li = 0; li < 32768; li++) {
        const e = EMIT[s ? (s[li] as number) : u] as number;
        if (e === 0) continue;
        const x = sxi * 32 + (li & 31);
        const z = szi * 32 + ((li >> 5) & 31);
        const y = syi * 32 + (li >> 10);
        this.put(BLOCK, x, y, z, e);
        this.addQ.push(this.pack(x, y, z));
      }
    }
    this.flood(BLOCK);
    w.trackDirty = wasTracking;
  }

  // -------------------------------------------------------------------------
  // Incremental repair
  // -------------------------------------------------------------------------

  /** Repair both channels after the block at this cell changed. */
  update(x: number, y: number, z: number): void {
    const w = this.world;
    if (!w.inBounds(x, y, z)) return;
    const state = w.get(x, y, z);
    for (let channel = SKY; channel <= BLOCK; channel++) {
      this.addQ.clear();
      this.remQ.clear();
      const old = this.get(channel, x, y, z);
      if (old > 0) this.darken(channel, x, y, z, old);
      // Whatever still lights the neighbours gets a chance to flow back in.
      for (let d = 0; d < 6; d++) {
        const nx = x + DX[d]!;
        const ny = y + DY[d]!;
        const nz = z + DZ[d]!;
        if (w.inBounds(nx, ny, nz) && this.get(channel, nx, ny, nz) > 0) this.addQ.push(this.pack(nx, ny, nz));
      }
      if (channel === SKY) {
        // The top layer has no cell above to pour sky into it.
        if (y === w.sy - 1) this.seedCeiling(x, z);
      } else {
        const e = EMIT[state] as number;
        if (e > 0) {
          this.put(BLOCK, x, y, z, e);
          this.addQ.push(this.pack(x, y, z));
        }
      }
      this.flood(channel);
    }
  }

  /**
   * Give the cell in the top layer of a column the sky light it would get from an open cell above
   * it, were there one: all of it if the cell is clear, what its opacity lets through otherwise.
   */
  private seedCeiling(x: number, z: number): void {
    const y = this.world.sy - 1;
    const op = LIGHT_OPACITY[this.world.get(x, y, z)] as number;
    if (op >= 15) return;
    const light = op === 0 ? 15 : 15 - op;
    if (light <= this.get(SKY, x, y, z)) return;
    this.put(SKY, x, y, z, light);
    this.addQ.push(this.pack(x, y, z));
  }

  /** Remove light that depended on this cell, queueing surviving neighbours to re-spread. */
  private darken(channel: number, x0: number, y0: number, z0: number, startLight: number): void {
    const w = this.world;
    const sx = w.sx;
    const sxz = this.sxz;
    const rem = this.remQ;
    // Emitters swept up in the darkening: each had its own light, which has to be given back.
    const emitters = this.swept;
    emitters.length = 0;
    this.put(channel, x0, y0, z0, 0);
    rem.push(this.pack(x0, y0, z0));
    rem.push(startLight);
    while (!rem.empty) {
      const idx = rem.shift();
      const light = rem.shift();
      const y = Math.floor(idx / sxz);
      const r = idx - y * sxz;
      const z = Math.floor(r / sx);
      const x = r - z * sx;
      for (let d = 0; d < 6; d++) {
        const nx = x + DX[d]!;
        const ny = y + DY[d]!;
        const nz = z + DZ[d]!;
        if (!w.inBounds(nx, ny, nz)) continue;
        const nl = this.get(channel, nx, ny, nz);
        if (nl === 0) continue;
        const fedFromAbove = channel === SKY && d === DOWN && light === 15 && nl === 15;
        if (nl < light || fedFromAbove) {
          this.put(channel, nx, ny, nz, 0);
          rem.push(this.pack(nx, ny, nz));
          rem.push(nl);
          // A weaker lamp standing in a stronger one's light is dimmer than it and is cleared with it,
          // though what it gives is its own.
          if (channel === BLOCK && (EMIT[w.get(nx, ny, nz)] as number) > 0) emitters.push(nx, ny, nz);
        } else {
          this.addQ.push(this.pack(nx, ny, nz));
        }
      }
    }
    for (let i = 0; i < emitters.length; i += 3) {
      const ex = emitters[i] as number;
      const ey = emitters[i + 1] as number;
      const ez = emitters[i + 2] as number;
      this.put(BLOCK, ex, ey, ez, EMIT[w.get(ex, ey, ez)] as number);
      this.addQ.push(this.pack(ex, ey, ez));
    }
  }

  /** Spread light outward from every queued cell until nothing gets brighter. */
  private flood(channel: number): void {
    const w = this.world;
    const sx = w.sx;
    const sxz = this.sxz;
    const q = this.addQ;
    while (!q.empty) {
      const idx = q.shift();
      const y = Math.floor(idx / sxz);
      const r = idx - y * sxz;
      const z = Math.floor(r / sx);
      const x = r - z * sx;
      const light = this.get(channel, x, y, z);
      if (light <= 1) continue;
      for (let d = 0; d < 6; d++) {
        const nx = x + DX[d]!;
        const ny = y + DY[d]!;
        const nz = z + DZ[d]!;
        if (!w.inBounds(nx, ny, nz)) continue;
        const op = LIGHT_OPACITY[w.get(nx, ny, nz)] as number;
        if (op >= 15) continue;
        let nl = light - (op > 1 ? op : 1);
        if (channel === SKY && d === DOWN && light === 15 && op === 0) nl = 15;
        if (nl > this.get(channel, nx, ny, nz)) {
          this.put(channel, nx, ny, nz, nl);
          q.push(this.pack(nx, ny, nz));
        }
      }
    }
  }
}
