// Structural support. When a solid block goes, whatever touched it is traced
// through face-connected solid blocks to the ground. A piece that reaches no
// ground has nothing holding it up: its cells leave the grid and are handed to
// the rigid-body system. Ordinary digging ends at once, because natural ground
// with natural ground under it is itself support.

import { hash3i } from '../core/rng';
import { B, IS_LEAVES, IS_LOG, LOOSE, NATURAL, SOLID, WATER_LEVEL } from '../world/blocks';
import type { World } from '../world/world';
import { cantileverFailures } from './cantilever';
import type { EmitEvent } from './types';

// Local aliases keep table reads cheap under any module loader (see fluid.ts).
const HARD = SOLID;
const IS_LOOSE = LOOSE;
const IS_NATURAL = NATURAL;
const LEAF = IS_LEAVES;
const LOG = IS_LOG;
const LEVEL = WATER_LEVEL;
const AIR = B.air;
const BEDROCK = B.bedrock;

/** A natural block counts as ground when this many cells straight below it are natural and solid too. */
const GROUND_DEPTH = 3;
/** A connected piece larger than this is taken to be terrain. */
const VISIT_CAP = 4096;
/** Leaves further than this many steps from a felled trunk stay where they are. */
const LEAF_REACH = 6;
const MAX_TREE_LOGS = 512;

const FACE_DX = [1, -1, 0, 0, 0, 0];
const FACE_DY = [0, 0, 1, -1, 0, 0];
const FACE_DZ = [0, 0, 0, 0, 1, -1];

/** A block of a detached piece, in world cell coordinates. */
export interface DetachedCell {
  x: number;
  y: number;
  z: number;
  state: number;
}

/** What the structure system needs from the rest of physics. */
export interface StructureHost {
  emit: EmitEvent;
  /**
   * Take over a piece that has already been removed from the grid. `tree` marks
   * a felled trunk with its crown, which should topple rather than drop.
   */
  detach(cells: DetachedCell[], tree: boolean): void;
  /** A fitting (torch, ladder, plant) lost the block it was fixed to. */
  drop(state: number, x: number, y: number, z: number): void;
}

export interface StructureOptions {
  seed?: number;
  /** Removals examined per step. */
  maxChecksPerStep?: number;
  /** Detached pieces larger than this are split into pieces of about this many blocks. */
  pieceSize?: number;
  /** Leaves a felled tree takes with it; the rest burst. */
  maxLeavesPerTree?: number;
  /** Apply the cantilever rule after each removal. */
  cantilever?: boolean;
}

/** True for blocks that carry load: solid, not loose, not foliage. */
export function isStructural(state: number): boolean {
  return HARD[state] === 1 && IS_LOOSE[state] === 0 && LEAF[state] === 0;
}

/** True when the block at this cell is ground: bedrock, the bottom of the world, or natural rock and soil with more of the same beneath. */
export function isGround(world: World, x: number, y: number, z: number, state: number): boolean {
  if (y <= 0 || state === BEDROCK) return true;
  if (!IS_NATURAL[state] || !HARD[state]) return false;
  for (let d = 1; d <= GROUND_DEPTH; d++) {
    if (y - d < 0) return true;
    const s = world.get(x, y - d, z);
    if (!IS_NATURAL[s] || !HARD[s]) return false;
  }
  return true;
}

export class Structure {
  /** True while this system is removing a detached piece, so its own edits are not queued as fresh removals. */
  busy = false;
  /** Pieces detached so far. */
  collapses = 0;

  private queue: number[] = [];
  private head = 0;
  private readonly seed: number;
  private readonly maxChecks: number;
  private readonly pieceSize: number;
  private readonly maxLeaves: number;
  private readonly cantilever: boolean;

  constructor(private readonly world: World, private readonly host: StructureHost, opts: StructureOptions = {}) {
    this.seed = opts.seed ?? 0;
    this.maxChecks = opts.maxChecksPerStep ?? 64;
    this.pieceSize = Math.max(4, opts.pieceSize ?? 32);
    this.maxLeaves = opts.maxLeavesPerTree ?? 96;
    this.cantilever = opts.cantilever ?? true;
  }

  /** Removals waiting to be examined. */
  get pending(): number {
    return (this.queue.length - this.head) / 2;
  }

  /** A block changed. A solid block that stopped being solid may have been holding something up. */
  onBlockChanged(x: number, y: number, z: number, old: number, state: number): void {
    if (this.busy || !HARD[old] || HARD[state]) return;
    const w = this.world;
    this.queue.push((y * w.sz + z) * w.sx + x, old);
  }

  step(): void {
    const w = this.world;
    const end = Math.min(this.queue.length, this.head + this.maxChecks * 2);
    while (this.head < end) {
      const key = this.queue[this.head] as number;
      const old = this.queue[this.head + 1] as number;
      this.head += 2;
      const x = key % w.sx;
      const z = Math.floor(key / w.sx) % w.sz;
      this.check(x, Math.floor(key / (w.sx * w.sz)), z, old);
    }
    if (this.head === this.queue.length) {
      this.queue.length = 0;
      this.head = 0;
    }
  }

  /**
   * Fell the tree whose trunk contains this log cell: cut its lowest log and
   * let the next step find the rest unsupported. Returns the number of logs in
   * the tree, counting the one cut, or 0 if the cell is not a log.
   */
  fellTree(x: number, y: number, z: number): number {
    const w = this.world;
    if (!LOG[w.get(x, y, z)]) return 0;
    const logs = this.connectedLogs(x, y, z);
    // The lowest log; among equals, the one under the cell that was struck.
    let base = logs[0] as DetachedCell;
    for (const c of logs) {
      if (c.y < base.y || (c.y === base.y && c.x === x && c.z === z)) base = c;
    }
    w.set(base.x, base.y, base.z, AIR);
    return logs.length;
  }

  // -------------------------------------------------------------------------

  /** Examine what a removed block may have been holding up. */
  private check(x: number, y: number, z: number, old: number): void {
    const w = this.world;
    // Cells already visited by this check, with the piece each belongs to; pieces found grounded stop being searched.
    let seen: Map<number, number> | null = null;
    const grounded: boolean[] = [];
    const key = (cx: number, cy: number, cz: number): number => (cy * w.sz + cz) * w.sx + cx;

    for (let n = 0; n < 26; n++) {
      // Faces first; edge and corner neighbours matter only between logs, whose limbs join diagonally.
      let dx: number;
      let dy: number;
      let dz: number;
      if (n < 6) {
        dx = FACE_DX[n] as number;
        dy = FACE_DY[n] as number;
        dz = FACE_DZ[n] as number;
      } else {
        if (!LOG[old]) break;
        const m = DIAGONALS[n - 6] as readonly [number, number, number];
        dx = m[0];
        dy = m[1];
        dz = m[2];
      }
      const sx = x + dx;
      const sy = y + dy;
      const sz = z + dz;
      const s = w.get(sx, sy, sz);
      if (!isStructural(s) || (n >= 6 && !LOG[s])) continue;
      if (!w.inBounds(sx, sy, sz) || isGround(w, sx, sy, sz, s)) continue;
      seen ??= new Map<number, number>();
      if (seen.has(key(sx, sy, sz))) continue;
      const piece = this.trace(sx, sy, sz, seen, grounded);
      if (piece) this.release(piece);
    }
    if (this.cantilever) {
      const failed = cantileverFailures(w, x, y, z, old);
      if (failed.length > 0) this.release(failed);
    }
  }

  /**
   * Flood from a seed through connected structural blocks. Returns the cells
   * of the piece if it reaches no ground, or null if it is held up.
   */
  private trace(sx: number, sy: number, sz: number, seen: Map<number, number>, grounded: boolean[]): DetachedCell[] | null {
    const w = this.world;
    const id = grounded.length;
    grounded.push(false);
    const cells: DetachedCell[] = [{ x: sx, y: sy, z: sz, state: w.get(sx, sy, sz) }];
    seen.set((sy * w.sz + sz) * w.sx + sx, id);
    for (let head = 0; head < cells.length; head++) {
      const c = cells[head] as DetachedCell;
      const log = LOG[c.state] === 1;
      for (let n = 0; n < (log ? 26 : 6); n++) {
        let nx: number;
        let ny: number;
        let nz: number;
        if (n < 6) {
          nx = c.x + (FACE_DX[n] as number);
          ny = c.y + (FACE_DY[n] as number);
          nz = c.z + (FACE_DZ[n] as number);
        } else {
          const m = DIAGONALS[n - 6] as readonly [number, number, number];
          nx = c.x + m[0];
          ny = c.y + m[1];
          nz = c.z + m[2];
        }
        const s = w.get(nx, ny, nz);
        if (!HARD[s] || (n >= 6 && !LOG[s])) continue;
        // Anything solid that is ground holds the piece up, loose sand included; only structural blocks carry the search on.
        if (n < 6 && (!w.inBounds(nx, ny, nz) || isGround(w, nx, ny, nz, s))) {
          grounded[id] = true;
          return null;
        }
        if (!isStructural(s)) continue;
        const k = (ny * w.sz + nz) * w.sx + nx;
        const other = seen.get(k);
        if (other !== undefined) {
          if (other !== id) {
            // Joined a piece an earlier seed already traced; it can only have been a grounded one.
            grounded[id] = true;
            return null;
          }
          continue;
        }
        seen.set(k, id);
        cells.push({ x: nx, y: ny, z: nz, state: s });
        if (cells.length > VISIT_CAP) {
          grounded[id] = true;
          return null;
        }
      }
    }
    return cells;
  }

  /** Take a detached piece out of the grid and hand it on, as one toppling tree or as chunks. */
  private release(cells: DetachedCell[]): void {
    const w = this.world;
    const tree = cells.every((c) => LOG[c.state] === 1);
    let body = cells;
    const shed: DetachedCell[] = [];
    if (tree) {
      const leaves = this.crown(cells);
      body = cells.concat(leaves.slice(0, this.maxLeaves));
      for (let i = this.maxLeaves; i < leaves.length; i++) shed.push(leaves[i] as DetachedCell);
    }
    this.busy = true;
    for (const c of body) w.set(c.x, c.y, c.z, AIR);
    for (const c of shed) {
      w.set(c.x, c.y, c.z, AIR);
      this.host.emit({ type: 'burst', x: c.x + 0.5, y: c.y + 0.5, z: c.z + 0.5, state: c.state });
    }
    this.busy = false;
    this.dropFittings(cells);
    let cx = 0;
    let cy = 0;
    let cz = 0;
    for (const c of body) {
      cx += c.x + 0.5;
      cy += c.y + 0.5;
      cz += c.z + 0.5;
    }
    this.collapses++;
    this.host.emit({ type: 'collapse', x: cx / body.length, y: cy / body.length, z: cz / body.length, blocks: body.length + shed.length });
    // A tree goes as one body. Anything else goes as face-connected chunks, which also separates parts that only touched at a corner.
    if (tree) this.host.detach(body, true);
    else for (const piece of this.split(body)) this.host.detach(piece, false);
  }

  /**
   * Leaves that belong to a felled trunk: those nearer to it, counting steps
   * through foliage, than to any tree left standing. Returned nearest first.
   */
  private crown(logs: DetachedCell[]): DetachedCell[] {
    const w = this.world;
    const key = (x: number, y: number, z: number): number => (y * w.sz + z) * w.sx + x;
    const own = new Set<number>();
    for (const c of logs) own.add(key(c.x, c.y, c.z));
    // Pass 1: every leaf within reach of the felled logs, and the standing logs those leaves touch.
    const dist = new Map<number, number>();
    const found: DetachedCell[] = [];
    const rivals: DetachedCell[] = [];
    const rivalSeen = new Set<number>();
    let frontier: DetachedCell[] = logs;
    for (let d = 1; d <= LEAF_REACH && frontier.length > 0; d++) {
      const next: DetachedCell[] = [];
      for (const c of frontier) {
        for (let dy = -1; dy <= 1; dy++) {
          for (let dz = -1; dz <= 1; dz++) {
            for (let dx = -1; dx <= 1; dx++) {
              if (dx === 0 && dy === 0 && dz === 0) continue;
              const x = c.x + dx;
              const y = c.y + dy;
              const z = c.z + dz;
              const s = w.get(x, y, z);
              const k = key(x, y, z);
              if (LOG[s] && !own.has(k) && !rivalSeen.has(k) && w.inBounds(x, y, z)) {
                rivalSeen.add(k);
                rivals.push({ x, y, z, state: s });
              }
              if (!LEAF[s] || dist.has(k) || !w.inBounds(x, y, z)) continue;
              dist.set(k, d);
              const leaf = { x, y, z, state: s };
              found.push(leaf);
              next.push(leaf);
            }
          }
        }
      }
      frontier = next;
    }
    if (rivals.length === 0) return found;
    // Pass 2: the same walk from the standing logs; a leaf they reach first, or as soon, stays on its tree.
    const theirs = new Map<number, number>();
    frontier = rivals;
    for (let d = 1; d <= LEAF_REACH && frontier.length > 0; d++) {
      const next: DetachedCell[] = [];
      for (const c of frontier) {
        for (let dy = -1; dy <= 1; dy++) {
          for (let dz = -1; dz <= 1; dz++) {
            for (let dx = -1; dx <= 1; dx++) {
              const x = c.x + dx;
              const y = c.y + dy;
              const z = c.z + dz;
              const k = key(x, y, z);
              if (!dist.has(k) || theirs.has(k)) continue;
              theirs.set(k, d);
              next.push({ x, y, z, state: 0 });
            }
          }
        }
      }
      frontier = next;
    }
    return found.filter((c) => {
      const k = key(c.x, c.y, c.z);
      const t = theirs.get(k);
      return t === undefined || (dist.get(k) as number) < t;
    });
  }

  /** Cut a large piece into face-connected chunks of about `pieceSize` blocks, growing each from the lowest free cell. */
  private split(cells: DetachedCell[]): DetachedCell[][] {
    const w = this.world;
    const key = (c: DetachedCell): number => (c.y * w.sz + c.z) * w.sx + c.x;
    const sorted = cells.slice().sort((a, b) => key(a) - key(b));
    const index = new Map<number, number>();
    sorted.forEach((c, i) => index.set(key(c), i));
    const taken = new Uint8Array(sorted.length);
    const pieces: DetachedCell[][] = [];
    for (let i = 0; i < sorted.length; i++) {
      if (taken[i]) continue;
      taken[i] = 1;
      const piece: DetachedCell[] = [sorted[i] as DetachedCell];
      for (let head = 0; head < piece.length && piece.length < this.pieceSize; head++) {
        const c = piece[head] as DetachedCell;
        for (let n = 0; n < 6 && piece.length < this.pieceSize; n++) {
          const j = index.get(((c.y + (FACE_DY[n] as number)) * w.sz + c.z + (FACE_DZ[n] as number)) * w.sx + c.x + (FACE_DX[n] as number));
          if (j === undefined || taken[j]) continue;
          // The key of a cell one step over a world edge can alias a real cell; the coordinates settle it.
          const o = sorted[j] as DetachedCell;
          if (Math.abs(o.x - c.x) + Math.abs(o.y - c.y) + Math.abs(o.z - c.z) !== 1) continue;
          taken[j] = 1;
          piece.push(o);
        }
      }
      pieces.push(piece);
    }
    return pieces;
  }

  /** Torches, ladders and plants that were fixed to blocks that just left: break them off. */
  private dropFittings(cells: DetachedCell[]): void {
    const w = this.world;
    for (const c of cells) {
      for (let n = 0; n < 6; n++) {
        const x = c.x + (FACE_DX[n] as number);
        const y = c.y + (FACE_DY[n] as number);
        const z = c.z + (FACE_DZ[n] as number);
        const s = w.get(x, y, z);
        if (s === AIR || HARD[s] || LEVEL[s] !== 0 || !w.inBounds(x, y, z)) continue;
        // Something standing on the block always goes; something beside or under it goes if nothing else solid touches it.
        if (n !== 2 && this.touchesSolid(x, y, z)) continue;
        w.set(x, y, z, AIR);
        this.host.drop(s, x + 0.5, y + 0.5, z + 0.5);
      }
    }
  }

  private touchesSolid(x: number, y: number, z: number): boolean {
    const w = this.world;
    for (let n = 0; n < 6; n++) {
      if (HARD[w.get(x + (FACE_DX[n] as number), y + (FACE_DY[n] as number), z + (FACE_DZ[n] as number))]) return true;
    }
    return false;
  }

  /** The logs joined to a log cell, limbs included (they meet the trunk and each other diagonally). */
  private connectedLogs(x: number, y: number, z: number): DetachedCell[] {
    const w = this.world;
    const seen = new Set<number>([(y * w.sz + z) * w.sx + x]);
    const logs: DetachedCell[] = [{ x, y, z, state: w.get(x, y, z) }];
    for (let head = 0; head < logs.length && logs.length < MAX_TREE_LOGS; head++) {
      const c = logs[head] as DetachedCell;
      for (let dy = -1; dy <= 1; dy++) {
        for (let dz = -1; dz <= 1; dz++) {
          for (let dx = -1; dx <= 1; dx++) {
            const nx = c.x + dx;
            const ny = c.y + dy;
            const nz = c.z + dz;
            const s = w.get(nx, ny, nz);
            const k = (ny * w.sz + nz) * w.sx + nx;
            if (!LOG[s] || seen.has(k) || !w.inBounds(nx, ny, nz)) continue;
            seen.add(k);
            logs.push({ x: nx, y: ny, z: nz, state: s });
          }
        }
      }
    }
    return logs;
  }

  /** Which way a felled tree at this cell leans: one of the four axis directions, fixed by position. */
  leanDirection(x: number, y: number, z: number): { x: number; z: number } {
    const i = hash3i(x, y, z, this.seed) & 3;
    return { x: i === 0 ? 1 : i === 1 ? -1 : 0, z: i === 2 ? 1 : i === 3 ? -1 : 0 };
  }
}

/** The twenty edge and corner offsets. */
const DIAGONALS: readonly (readonly [number, number, number])[] = (() => {
  const out: [number, number, number][] = [];
  for (let dy = -1; dy <= 1; dy++) {
    for (let dz = -1; dz <= 1; dz++) {
      for (let dx = -1; dx <= 1; dx++) {
        if (Math.abs(dx) + Math.abs(dy) + Math.abs(dz) >= 2) out.push([dx, dy, dz]);
      }
    }
  }
  return out;
})();
