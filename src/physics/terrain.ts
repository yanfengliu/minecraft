// What rigid bodies collide with. The voxel world is far too large to hand to
// the physics library whole, so collision exists only in 8-cubed chunks near
// bodies and is kept in step with block edits.
//
// Full blocks, slabs and stairs go into voxel colliders with half-block
// voxels (Rapier's `Voxels` shape), one collider per chunk. A voxel shape
// knows which of its faces are interior, and neighbouring chunk colliders are
// told about each other, so a body sliding across flat ground never meets a
// seam, inside a chunk or between two. A block edit is an O(1) `setVoxel`.
// One collider per chunk rather than one for the world because editing a
// collider wakes every body that touches it: this way a block dug here does
// not wake rubble lying across the island.
//
// Everything else with collision (paths a sixteenth short of a full block,
// fences, furniture) cannot be expressed in half-blocks and gets exact cuboid
// colliders, merged where they line up.

import RAPIER, { type Collider, type World as RapierWorld } from '@dimforge/rapier3d-compat';
import { COLLISION, MATERIAL, MATERIALS, SHAPE, SHAPE_CONNECT, type Material } from '../world/blocks';
import type { World } from '../world/world';
import { IRREGULAR, VOXEL_MASK, mergeBoxes } from './shapes';

const MASK = VOXEL_MASK;
const ODD = IRREGULAR;
const KIND = SHAPE;

export const CHUNK = 8;
const CHUNK_CELLS = CHUNK * CHUNK * CHUNK;
/** Voxels along a chunk side: two per block. */
const SIDE = CHUNK * 2;
const VOXEL = { x: 0.5, y: 0.5, z: 0.5 };
/** Friction and bounce of the ground as a whole; a body's own material is averaged with these. */
const GROUND_FRICTION = 0.7;
const GROUND_RESTITUTION = 0.05;

const NX = [1, -1, 0, 0, 0, 0];
const NY = [0, 0, 1, -1, 0, 0];
const NZ = [0, 0, 0, 0, 1, -1];

interface Chunk {
  cx: number;
  cy: number;
  cz: number;
  /** Octants currently set in the voxel collider, per cell. */
  masks: Uint8Array;
  /** The chunk's voxel collider, made when its first voxel is set. Voxel coordinates are global, so it sits at the origin. */
  voxels: Collider | null;
  /** Voxels set in it. */
  filled: number;
  /** Cuboid colliders of this chunk's irregular cells. */
  boxes: Collider[];
  stale: boolean;
  /** Sweep number in which a body last needed this chunk. */
  used: number;
}

export class TerrainColliders {
  private readonly chunks = new Map<number, Chunk>();
  private readonly ncx: number;
  private readonly ncy: number;
  private readonly ncz: number;
  private pending: number[] = [];
  private sweepNo = 0;
  private readonly scratch: number[] = [];

  constructor(private readonly world: World, private readonly rapier: RapierWorld) {
    this.ncx = Math.ceil(world.sx / CHUNK);
    this.ncy = Math.ceil(world.sy / CHUNK);
    this.ncz = Math.ceil(world.sz / CHUNK);
  }

  /** Chunks that currently have collision geometry. */
  get chunkCount(): number {
    return this.chunks.size;
  }

  /** Give every chunk that overlaps this box (world coordinates) collision geometry, and mark it as needed. */
  ensure(x0: number, y0: number, z0: number, x1: number, y1: number, z1: number): void {
    const cx0 = Math.max(0, Math.floor(x0 / CHUNK));
    const cy0 = Math.max(0, Math.floor(y0 / CHUNK));
    const cz0 = Math.max(0, Math.floor(z0 / CHUNK));
    const cx1 = Math.min(this.ncx - 1, Math.floor(x1 / CHUNK));
    const cy1 = Math.min(this.ncy - 1, Math.floor(y1 / CHUNK));
    const cz1 = Math.min(this.ncz - 1, Math.floor(z1 / CHUNK));
    for (let cy = cy0; cy <= cy1; cy++) {
      for (let cz = cz0; cz <= cz1; cz++) {
        for (let cx = cx0; cx <= cx1; cx++) {
          const chunk = this.chunks.get((cy * this.ncz + cz) * this.ncx + cx) ?? this.activate(cx, cy, cz);
          chunk.used = this.sweepNo;
        }
      }
    }
  }

  /** A block changed. Remember it if its collision did; nothing is touched until `flush`. */
  onBlockChanged(x: number, y: number, z: number, old: number, state: number): void {
    if ((COLLISION[old] as Float32Array).length === 0 && (COLLISION[state] as Float32Array).length === 0) return;
    this.pending.push(x, y, z, old, state);
  }

  /** Bring the colliders up to date with the blocks changed since the last call. `changed` hears each such cell. */
  flush(changed: (x: number, y: number, z: number) => void): void {
    if (this.pending.length === 0) return;
    const pending = this.pending;
    this.pending = [];
    const w = this.world;
    let anyStale = false;
    for (let i = 0; i < pending.length; i += 5) {
      const x = pending[i] as number;
      const y = pending[i + 1] as number;
      const z = pending[i + 2] as number;
      changed(x, y, z);
      // The cell itself, and its neighbours: one of them may have just become, or stopped being, buried.
      this.sync(x, y, z);
      for (let n = 0; n < 6; n++) this.sync(x + (NX[n] as number), y + (NY[n] as number), z + (NZ[n] as number));
      if (ODD[pending[i + 3] as number] || ODD[pending[i + 4] as number]) anyStale = this.markStale(x, y, z) || anyStale;
      // Fences and walls grow arms toward what stands beside them.
      for (let n = 0; n < 6; n++) {
        if (n === 2 || n === 3) continue;
        const nx = x + (NX[n] as number);
        const nz = z + (NZ[n] as number);
        if (KIND[w.get(nx, y, nz)] === SHAPE_CONNECT) anyStale = this.markStale(nx, y, nz) || anyStale;
      }
    }
    if (!anyStale) return;
    for (const chunk of this.chunks.values()) {
      if (chunk.stale) this.rebuildBoxes(chunk);
    }
  }

  /**
   * Called now and then after every body has re-declared the chunks it needs:
   * drops the collision of chunks nobody asked for since the sweep before.
   */
  sweep(): void {
    for (const [key, chunk] of this.chunks) {
      if (chunk.used >= this.sweepNo - 1) continue;
      if (chunk.voxels) this.rapier.removeCollider(chunk.voxels, false);
      for (const c of chunk.boxes) this.rapier.removeCollider(c, false);
      this.chunks.delete(key);
    }
    this.sweepNo++;
  }

  // -------------------------------------------------------------------------

  private chunkAt(x: number, y: number, z: number): Chunk | undefined {
    const w = this.world;
    if (x < 0 || y < 0 || z < 0 || x >= w.sx || y >= w.sy || z >= w.sz) return undefined;
    return this.chunks.get(((y >> 3) * this.ncz + (z >> 3)) * this.ncx + (x >> 3));
  }

  private neighbour(c: Chunk, dx: number, dy: number, dz: number): Chunk | undefined {
    const cx = c.cx + dx;
    const cy = c.cy + dy;
    const cz = c.cz + dz;
    if (cx < 0 || cy < 0 || cz < 0 || cx >= this.ncx || cy >= this.ncy || cz >= this.ncz) return undefined;
    return this.chunks.get((cy * this.ncz + cz) * this.ncx + cx);
  }

  private markStale(x: number, y: number, z: number): boolean {
    const chunk = this.chunkAt(x, y, z);
    if (!chunk) return false;
    chunk.stale = true;
    return true;
  }

  private activate(cx: number, cy: number, cz: number): Chunk {
    const chunk: Chunk = { cx, cy, cz, masks: new Uint8Array(CHUNK_CELLS), voxels: null, filled: 0, boxes: [], stale: false, used: this.sweepNo };
    this.chunks.set((cy * this.ncz + cz) * this.ncx + cx, chunk);
    const w = this.world;
    let odd = false;
    for (let i = 0; i < CHUNK_CELLS; i++) {
      const x = cx * CHUNK + (i & 7);
      const y = cy * CHUNK + (i >> 6);
      const z = cz * CHUNK + ((i >> 3) & 7);
      if (x >= w.sx || y >= w.sy || z >= w.sz) continue;
      const s = w.get(x, y, z);
      if (ODD[s]) odd = true;
      if (MASK[s] === 0) continue;
      const m = this.wanted(x, y, z, s);
      if (m !== 0) {
        chunk.masks[i] = m;
        // Filling a fresh chunk: its neighbours are told once, below, rather than voxel by voxel.
        this.setOctants(chunk, x, y, z, 0, m, false);
      }
    }
    this.join(chunk);
    if (odd) this.rebuildBoxes(chunk);
    return chunk;
  }

  /**
   * Tell a chunk's voxel collider and each neighbour's about one another, so
   * the faces where they meet count as interior. Only the six chunks that
   * share a face matter: a voxel's exposed features follow from its face
   * neighbours alone (measured: joining all 26 changes nothing).
   */
  private join(chunk: Chunk): void {
    if (!chunk.voxels) return;
    for (let n = 0; n < 6; n++) {
      const other = this.neighbour(chunk, NX[n] as number, NY[n] as number, NZ[n] as number)?.voxels;
      if (other) chunk.voxels.combineVoxelStates(other, 0, 0, 0);
    }
  }

  /**
   * The octants a cell should have in the voxel collider: its shape, except
   * that a full block buried on all six sides is left out. Nothing can touch
   * it, and leaving it out keeps the collider to the ground's surface shell.
   */
  private wanted(x: number, y: number, z: number, s: number): number {
    const m = MASK[s] as number;
    if (m !== 0xff) return m;
    const w = this.world;
    for (let n = 0; n < 6; n++) {
      if (MASK[w.get(x + (NX[n] as number), y + (NY[n] as number), z + (NZ[n] as number))] !== 0xff) return m;
    }
    return 0;
  }

  private sync(x: number, y: number, z: number): void {
    const chunk = this.chunkAt(x, y, z);
    if (!chunk) return;
    const i = ((y & 7) << 6) | ((z & 7) << 3) | (x & 7);
    const have = chunk.masks[i] as number;
    const want = this.wanted(x, y, z, this.world.get(x, y, z));
    if (have === want) return;
    chunk.masks[i] = want;
    this.setOctants(chunk, x, y, z, have, want, true);
  }

  /** Change which octants of a cell are set. With `tell`, neighbouring chunks hear of changes on the chunk's faces. */
  private setOctants(chunk: Chunk, x: number, y: number, z: number, have: number, want: number, tell: boolean): void {
    const diff = have ^ want;
    for (let k = 0; k < 8; k++) {
      if ((diff & (1 << k)) === 0) continue;
      const ix = 2 * x + (k & 1);
      const iy = 2 * y + ((k >> 1) & 1);
      const iz = 2 * z + ((k >> 2) & 1);
      const on = (want & (1 << k)) !== 0;
      chunk.filled += on ? 1 : -1;
      if (!chunk.voxels) {
        // The shape cannot exist empty, so the collider is born with its first voxel.
        chunk.voxels = this.rapier.createCollider(
          RAPIER.ColliderDesc.voxels(new Int32Array([ix, iy, iz]), VOXEL).setFriction(GROUND_FRICTION).setRestitution(GROUND_RESTITUTION),
        );
        if (tell) this.join(chunk);
        continue;
      }
      chunk.voxels.setVoxel(ix, iy, iz, on);
      if (tell) this.tell(chunk, ix, iy, iz);
    }
    if (chunk.filled === 0 && chunk.voxels) {
      this.rapier.removeCollider(chunk.voxels, false);
      chunk.voxels = null;
    }
  }

  /** A voxel on a face of the chunk changed: let the chunk across each such face update its side of the seam. */
  private tell(chunk: Chunk, ix: number, iy: number, iz: number): void {
    const lx = ix - chunk.cx * SIDE;
    const ly = iy - chunk.cy * SIDE;
    const lz = iz - chunk.cz * SIDE;
    const ax = lx === 0 ? -1 : lx === SIDE - 1 ? 1 : 0;
    const ay = ly === 0 ? -1 : ly === SIDE - 1 ? 1 : 0;
    const az = lz === 0 ? -1 : lz === SIDE - 1 ? 1 : 0;
    // The call is made on the collider whose voxel changed, naming the one to bring up to date.
    const voxels = chunk.voxels as Collider;
    const across = (dx: number, dy: number, dz: number): void => {
      const other = this.neighbour(chunk, dx, dy, dz)?.voxels;
      if (other) voxels.propagateVoxelChange(other, ix, iy, iz, 0, 0, 0);
    };
    if (ax !== 0) across(ax, 0, 0);
    if (ay !== 0) across(0, ay, 0);
    if (az !== 0) across(0, 0, az);
  }

  private rebuildBoxes(chunk: Chunk): void {
    for (const c of chunk.boxes) this.rapier.removeCollider(c, false);
    chunk.boxes.length = 0;
    chunk.stale = false;
    const w = this.world;
    const scratch = this.scratch;
    const all: number[] = [];
    for (let i = 0; i < CHUNK_CELLS; i++) {
      const x = chunk.cx * CHUNK + (i & 7);
      const y = chunk.cy * CHUNK + (i >> 6);
      const z = chunk.cz * CHUNK + ((i >> 3) & 7);
      const s = w.get(x, y, z);
      if (!ODD[s] || !w.inBounds(x, y, z)) continue;
      scratch.length = 0;
      w.collisionBoxes(x, y, z, scratch);
      for (let b = 0; b < scratch.length; b += 6) {
        all.push(scratch[b] as number, scratch[b + 1] as number, scratch[b + 2] as number, scratch[b + 3] as number, scratch[b + 4] as number, scratch[b + 5] as number, MATERIAL[s] as number);
      }
    }
    const merged = mergeBoxes(all);
    for (let b = 0; b < merged.length; b += 7) {
      const x0 = merged[b] as number;
      const y0 = merged[b + 1] as number;
      const z0 = merged[b + 2] as number;
      const x1 = merged[b + 3] as number;
      const y1 = merged[b + 4] as number;
      const z1 = merged[b + 5] as number;
      const mat = MATERIALS[merged[b + 6] as number] as Material;
      const desc = RAPIER.ColliderDesc.cuboid((x1 - x0) / 2, (y1 - y0) / 2, (z1 - z0) / 2)
        .setTranslation((x0 + x1) / 2, (y0 + y1) / 2, (z0 + z1) / 2)
        .setFriction(mat.friction)
        .setRestitution(mat.restitution);
      chunk.boxes.push(this.rapier.createCollider(desc));
    }
  }
}
