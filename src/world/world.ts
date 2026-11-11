// Voxel storage for the whole island. The world is bounded and lives entirely
// in memory, split into 32^3 sections. A section that holds one state
// everywhere (open air, solid rock) stores no array at all, which is what keeps
// a 768 x 128 x 768 world affordable. Headless and worker-safe.

import { Emitter } from '../core/events';
import { B, BLOCKS_RAIN, COLLISION, CONNECT, OPAQUE, SHAPE, SHAPE_CONNECT, SOLID, isGate } from './blocks';

export const SECTION_SIZE = 32;
export const SECTION_VOLUME = SECTION_SIZE * SECTION_SIZE * SECTION_SIZE;

export interface BlockChange {
  x: number;
  y: number;
  z: number;
  old: number;
  state: number;
}

export interface WorldData {
  sx: number;
  sy: number;
  sz: number;
  seaLevel: number;
  blocks: (Uint16Array | null)[];
  uniform: Uint16Array;
  light: (Uint8Array | null)[];
  uniformLight: Uint8Array;
  heightmap: Uint8Array;
}

export class World {
  readonly sx: number;
  readonly sy: number;
  readonly sz: number;
  readonly nsx: number;
  readonly nsy: number;
  readonly nsz: number;
  readonly sectionCount: number;
  /** Water fills every open cell with y < seaLevel in the sea. */
  readonly seaLevel: number;

  /** Per-section state arrays; null means the whole section is `uniform[i]`. */
  readonly blocks: (Uint16Array | null)[];
  readonly uniform: Uint16Array;
  /** Per-section packed light (sky << 4 | block); null means `uniformLight[i]` everywhere. */
  readonly light: (Uint8Array | null)[];
  readonly uniformLight: Uint8Array;
  /** Per column: y + 1 of the highest block that stops rain, or 0. */
  readonly heightmap: Uint8Array;

  /** Fired after every successful `set`. Listeners run synchronously, in subscription order. */
  readonly changed = new Emitter<BlockChange>();
  /** Sections whose mesh is stale. The renderer drains this; headless users may ignore it. */
  readonly dirty = new Set<number>();
  /** Set false during bulk generation, when everything will be meshed anyway. */
  trackDirty = true;

  constructor(sx: number, sy: number, sz: number, seaLevel: number, data?: WorldData) {
    if (sx % SECTION_SIZE || sy % SECTION_SIZE || sz % SECTION_SIZE) throw new Error('world dimensions must be multiples of 32');
    if (sy > 255) throw new Error('world height must fit the 8-bit heightmap');
    this.sx = sx;
    this.sy = sy;
    this.sz = sz;
    this.seaLevel = seaLevel;
    this.nsx = sx / SECTION_SIZE;
    this.nsy = sy / SECTION_SIZE;
    this.nsz = sz / SECTION_SIZE;
    this.sectionCount = this.nsx * this.nsy * this.nsz;
    if (data) {
      this.blocks = data.blocks;
      this.uniform = data.uniform;
      this.light = data.light;
      this.uniformLight = data.uniformLight;
      this.heightmap = data.heightmap;
    } else {
      this.blocks = new Array<Uint16Array | null>(this.sectionCount).fill(null);
      this.uniform = new Uint16Array(this.sectionCount);
      this.light = new Array<Uint8Array | null>(this.sectionCount).fill(null);
      this.uniformLight = new Uint8Array(this.sectionCount).fill(0xf0);
      this.heightmap = new Uint8Array(sx * sz);
    }
  }

  /** The plain-data view of this world, for transfer between threads. */
  data(): WorldData {
    return {
      sx: this.sx, sy: this.sy, sz: this.sz, seaLevel: this.seaLevel,
      blocks: this.blocks, uniform: this.uniform, light: this.light, uniformLight: this.uniformLight, heightmap: this.heightmap,
    };
  }

  static fromData(d: WorldData): World {
    return new World(d.sx, d.sy, d.sz, d.seaLevel, d);
  }

  clone(): World {
    return new World(this.sx, this.sy, this.sz, this.seaLevel, {
      sx: this.sx, sy: this.sy, sz: this.sz, seaLevel: this.seaLevel,
      blocks: this.blocks.map((b) => (b ? b.slice() : null)),
      uniform: this.uniform.slice(),
      light: this.light.map((l) => (l ? l.slice() : null)),
      uniformLight: this.uniformLight.slice(),
      heightmap: this.heightmap.slice(),
    });
  }

  inBounds(x: number, y: number, z: number): boolean {
    return x >= 0 && y >= 0 && z >= 0 && x < this.sx && y < this.sy && z < this.sz;
  }

  sectionIndex(sxi: number, syi: number, szi: number): number {
    return (syi * this.nsz + szi) * this.nsx + sxi;
  }

  /**
   * State at a cell. Outside the world: bedrock below, air above, and to the
   * sides open sea below sea level and air above it, so the island reads as
   * standing in an endless ocean.
   */
  get(x: number, y: number, z: number): number {
    if (y < 0) return B.bedrock;
    if (y >= this.sy) return B.air;
    if (x < 0 || z < 0 || x >= this.sx || z >= this.sz) return y < this.seaLevel ? B.water_source : B.air;
    const si = ((y >> 5) * this.nsz + (z >> 5)) * this.nsx + (x >> 5);
    const s = this.blocks[si];
    return s ? (s[((y & 31) << 10) | ((z & 31) << 5) | (x & 31)] as number) : (this.uniform[si] as number);
  }

  /** Write a state. Returns false when out of bounds or unchanged. */
  set(x: number, y: number, z: number, state: number): boolean {
    if (!this.inBounds(x, y, z)) return false;
    const si = ((y >> 5) * this.nsz + (z >> 5)) * this.nsx + (x >> 5);
    const li = ((y & 31) << 10) | ((z & 31) << 5) | (x & 31);
    let s = this.blocks[si];
    const old = s ? (s[li] as number) : (this.uniform[si] as number);
    if (old === state) return false;
    if (!s) {
      s = new Uint16Array(SECTION_VOLUME);
      const u = this.uniform[si] as number;
      if (u !== 0) s.fill(u);
      this.blocks[si] = s;
    }
    s[li] = state;
    this.updateHeight(x, y, z, state);
    if (this.trackDirty) this.markDirtyAround(x, y, z);
    this.changed.emit({ x, y, z, old, state });
    return true;
  }

  /** Bulk write used by generation: no events, no dirty marking, no heightmap upkeep. */
  setRaw(x: number, y: number, z: number, state: number): void {
    const si = ((y >> 5) * this.nsz + (z >> 5)) * this.nsx + (x >> 5);
    let s = this.blocks[si];
    if (!s) {
      if ((this.uniform[si] as number) === state) return;
      s = new Uint16Array(SECTION_VOLUME);
      const u = this.uniform[si] as number;
      if (u !== 0) s.fill(u);
      this.blocks[si] = s;
    }
    s[((y & 31) << 10) | ((z & 31) << 5) | (x & 31)] = state;
  }

  /** Packed light (sky << 4 | block). Outside the world the sky is open. */
  getLight(x: number, y: number, z: number): number {
    if (y < 0) return 0;
    if (y >= this.sy || x < 0 || z < 0 || x >= this.sx || z >= this.sz) return 0xf0;
    const si = ((y >> 5) * this.nsz + (z >> 5)) * this.nsx + (x >> 5);
    const l = this.light[si];
    return l ? (l[((y & 31) << 10) | ((z & 31) << 5) | (x & 31)] as number) : (this.uniformLight[si] as number);
  }

  setLight(x: number, y: number, z: number, value: number): void {
    const si = ((y >> 5) * this.nsz + (z >> 5)) * this.nsx + (x >> 5);
    let l = this.light[si];
    if (!l) {
      const u = this.uniformLight[si] as number;
      if (u === value) return;
      l = new Uint8Array(SECTION_VOLUME);
      if (u !== 0) l.fill(u);
      this.light[si] = l;
    }
    l[((y & 31) << 10) | ((z & 31) << 5) | (x & 31)] = value;
    if (this.trackDirty) this.markDirtyAround(x, y, z);
  }

  skyLight(x: number, y: number, z: number): number {
    return this.getLight(x, y, z) >> 4;
  }

  blockLight(x: number, y: number, z: number): number {
    return this.getLight(x, y, z) & 15;
  }

  /** y + 1 of the highest rain-stopping block in the column (0 if empty); `sy` outside is treated as open. */
  height(x: number, z: number): number {
    if (x < 0 || z < 0 || x >= this.sx || z >= this.sz) return 0;
    return this.heightmap[z * this.sx + x] as number;
  }

  /** True when nothing overhead stops rain from reaching this cell. */
  exposed(x: number, y: number, z: number): boolean {
    return y >= this.height(x, z);
  }

  /**
   * y of the highest solid cell at or below `fromY` whose cell above is not
   * solid: the ground a walker would stand on. Returns -1 if none.
   */
  groundY(x: number, z: number, fromY = this.sy - 1): number {
    for (let y = Math.min(fromY, this.sy - 1); y >= 0; y--) {
      if (SOLID[this.get(x, y, z)] && !SOLID[this.get(x, y + 1, z)]) return y;
    }
    return -1;
  }

  recomputeHeightmap(): void {
    const { sx, sz, sy } = this;
    for (let z = 0; z < sz; z++) {
      for (let x = 0; x < sx; x++) {
        let h = 0;
        for (let y = sy - 1; y >= 0; y--) {
          if (BLOCKS_RAIN[this.get(x, y, z)]) {
            h = y + 1;
            break;
          }
        }
        this.heightmap[z * sx + x] = h;
      }
    }
  }

  private updateHeight(x: number, y: number, z: number, state: number): void {
    const i = z * this.sx + x;
    const h = this.heightmap[i] as number;
    if (BLOCKS_RAIN[state]) {
      if (y + 1 > h) this.heightmap[i] = y + 1;
    } else if (y + 1 === h) {
      let ny = y - 1;
      while (ny >= 0 && !BLOCKS_RAIN[this.get(x, ny, z)]) ny--;
      this.heightmap[i] = ny + 1;
    }
  }

  /** Mark every section whose mesh can see this cell (meshing reads one cell past each face). */
  markDirtyAround(x: number, y: number, z: number): void {
    const x0 = Math.max(0, (x - 1) >> 5);
    const x1 = Math.min(this.nsx - 1, (x + 1) >> 5);
    const y0 = Math.max(0, (y - 1) >> 5);
    const y1 = Math.min(this.nsy - 1, (y + 1) >> 5);
    const z0 = Math.max(0, (z - 1) >> 5);
    const z1 = Math.min(this.nsz - 1, (z + 1) >> 5);
    for (let sy = y0; sy <= y1; sy++) {
      for (let sz = z0; sz <= z1; sz++) {
        for (let sx = x0; sx <= x1; sx++) this.dirty.add((sy * this.nsz + sz) * this.nsx + sx);
      }
    }
  }

  /**
   * Collision boxes of the block at a cell, in world coordinates, appended to
   * `out` as (x0, y0, z0, x1, y1, z1) runs. Fences and walls grow arms toward
   * what they connect to, so their collision depends on their neighbours.
   */
  collisionBoxes(x: number, y: number, z: number, out: number[]): void {
    const state = this.get(x, y, z);
    const boxes = COLLISION[state] as Float32Array;
    for (let i = 0; i < boxes.length; i += 6) {
      out.push(x + (boxes[i] as number), y + (boxes[i + 1] as number), z + (boxes[i + 2] as number), x + (boxes[i + 3] as number), y + (boxes[i + 4] as number), z + (boxes[i + 5] as number));
    }
    if (SHAPE[state] === SHAPE_CONNECT) {
      const mask = this.connectMask(x, y, z, state);
      const lo = 0.375;
      const hi = 0.625;
      if (mask & 1) out.push(x + hi, y, z + lo, x + 1, y + 1.5, z + hi);
      if (mask & 2) out.push(x, y, z + lo, x + lo, y + 1.5, z + hi);
      if (mask & 4) out.push(x + lo, y, z + hi, x + hi, y + 1.5, z + 1);
      if (mask & 8) out.push(x + lo, y, z, x + hi, y + 1.5, z + lo);
    }
  }

  /** Which horizontal neighbours a fence or wall joins: bit 0 +x, bit 1 -x, bit 2 +z, bit 3 -z. */
  connectMask(x: number, y: number, z: number, state = this.get(x, y, z)): number {
    const group = CONNECT[state] as number;
    let mask = 0;
    if (this.connectsTo(this.get(x + 1, y, z), group)) mask |= 1;
    if (this.connectsTo(this.get(x - 1, y, z), group)) mask |= 2;
    if (this.connectsTo(this.get(x, y, z + 1), group)) mask |= 4;
    if (this.connectsTo(this.get(x, y, z - 1), group)) mask |= 8;
    return mask;
  }

  private connectsTo(neighbour: number, group: number): boolean {
    if (CONNECT[neighbour] === group) return true;
    if (isGate(neighbour)) return true;
    // Join onto full opaque blocks so a fence run meets a wall cleanly.
    return OPAQUE[neighbour] === 1;
  }
}

/** A flat test world: stone, three layers of dirt, grass on top at `groundY`. */
export function createFlatWorld(sx = 64, sz = 64, groundY = 31, sy = 64): World {
  const world = new World(sx, sy, sz, 0);
  world.trackDirty = false;
  for (let z = 0; z < sz; z++) {
    for (let x = 0; x < sx; x++) {
      for (let y = 0; y <= groundY; y++) {
        world.setRaw(x, y, z, y === 0 ? B.bedrock : y === groundY ? B.grass : y >= groundY - 3 ? B.dirt : B.stone);
      }
    }
  }
  world.recomputeHeightmap();
  world.trackDirty = true;
  return world;
}
