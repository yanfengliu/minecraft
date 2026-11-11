// Finite water. Levels are whole sixteenths of a block (`B.water + level - 1`)
// and live in the world grid itself; this system only keeps the set of cells
// worth looking at. Each tick an active cell drains into the cell below, then
// evens out with its four neighbours by moving whole units toward lower
// levels, and only where a move makes progress, so a pool settles and falls
// out of the active set. Sources (lake, sea, river) are never changed: they
// top up open neighbours and swallow what falls onto them.
//
// Volume is exact. Every unit that appears or disappears is counted in
// `created`, `absorbed`, `evaporated` or `lost`; nothing else changes the total.

import { hash3i } from '../core/rng';
import { B, REPLACEABLE, SOLID, WATER_LEVEL, WATER_SOURCE } from '../world/blocks';
import type { World } from '../world/world';
import { CellSet } from './cellset';
import { DX, DZ, PressureSearch, share, waterFlow } from './leveling';
import type { EmitEvent } from './types';

export { RIVER_SPEED } from './leveling';

// Local aliases: these tables are read several times per active cell, and a
// module-level constant is a plain variable read wherever the code runs, while
// an imported binding is not under every module loader (the test runner's, for one).
const LEVEL = WATER_LEVEL;
const SOURCE = WATER_SOURCE;
const OPEN = REPLACEABLE;
const HARD = SOLID;
const AIR = B.air;
const WATER = B.water;
const LAKE = B.water_source;
const RIVER = B.river;
const NX = DX;
const NZ = DZ;

export interface FluidOptions {
  seed?: number;
  /** Units a source gives each open neighbour beside it per tick. */
  sourceRate?: number;
  /** Ticks a thin film lasts before it evaporates (each cell adds its own jitter of up to half as much again). */
  evaporateTicks?: number;
  /** Cells examined per tick; the rest are held over, in order, to the next tick. */
  maxCellsPerTick?: number;
  /** Connected water cells a stalled cell may search for somewhere lower to send a unit. Sets how far a pool levels exactly. */
  searchCells?: number;
  /** Such searches allowed per tick; cells that miss out try again next tick. */
  searchesPerTick?: number;
}

/** Offsets of the four sideways neighbours inside a section array, whose index is (ly << 10) | (lz << 5) | lx. */
const OFF = [1, 32, -1, -32];
const WORDS = 1024;

export class Fluid {
  /** Units of finite water made by sources. */
  created = 0;
  /** Units swallowed by sources, including finite cells that healed into sources. */
  absorbed = 0;
  /** Units lost to evaporation. */
  evaporated = 0;
  /** Units destroyed because a block landed in water with nowhere to push it. */
  lost = 0;
  /** Ticks run so far. */
  ticks = 0;
  /** Cells examined by the last tick. */
  processed = 0;
  /** True while this system is writing to the world, so a change listener can tell its edits from everyone else's. */
  busy = false;

  private cur: CellSet;
  private next: CellSet;
  /** Cells that received water sideways this tick: they wait a tick before passing it on, so flow speed does not depend on scan direction. */
  private readonly moved: CellSet;
  private readonly pressure: PressureSearch;
  private searches = 0;
  private readonly wheel: number[][];
  private readonly wheelMask: number;
  private readonly seed: number;
  private readonly sourceRate: number;
  private readonly evaporateTicks: number;
  private readonly maxCells: number;
  private readonly searchesPerTick: number;

  // Scratch for the four neighbours of the cell being levelled.
  private readonly nLevel = new Int32Array(4);
  private readonly nGive = new Int32Array(4);
  private readonly nState = new Int32Array(4);
  private readonly nOpen = new Uint8Array(4);
  private readonly ord = new Int32Array(4);

  constructor(private readonly world: World, private readonly emit: EmitEvent, opts: FluidOptions = {}) {
    if (world.sx * world.sy * world.sz >= 2 ** 32) throw new Error('world too large for fluid cell keys');
    this.cur = new CellSet(world);
    this.next = new CellSet(world);
    this.moved = new CellSet(world);
    this.pressure = new PressureSearch(world, Math.max(4, opts.searchCells ?? 192));
    this.seed = opts.seed ?? 0;
    this.sourceRate = Math.max(1, Math.min(16, opts.sourceRate ?? 4));
    this.evaporateTicks = Math.max(1, opts.evaporateTicks ?? 90);
    this.maxCells = opts.maxCellsPerTick ?? 40000;
    this.searchesPerTick = opts.searchesPerTick ?? 16;
    let size = 4;
    while (size < this.evaporateTicks * 1.5 + 2) size *= 2;
    this.wheelMask = size - 1;
    this.wheel = Array.from({ length: size }, () => []);
  }

  /** Cells the next tick will examine. Zero means every pool has settled. */
  get activeCount(): number {
    return this.next.size;
  }

  /** A block changed here: look at it and its neighbours on the next tick. */
  wake(x: number, y: number, z: number): void {
    this.next.addAround(x, y, z);
  }

  /**
   * Add finite water to a cell from outside the simulation (a bucket, rain).
   * Returns the units that fitted; water poured into a source is swallowed and
   * counts as fitted.
   */
  addWater(x: number, y: number, z: number, units: number): number {
    const w = this.world;
    if (units <= 0 || !w.inBounds(x, y, z)) return 0;
    const s = w.get(x, y, z);
    if (SOURCE[s]) return units;
    const level = LEVEL[s] as number;
    if (level === 0 && !OPEN[s]) return 0;
    const add = Math.min(units, 16 - level);
    if (add <= 0) return 0;
    const was = this.busy;
    this.busy = true;
    this.setLevel(x, y, z, level + add, s);
    this.busy = was;
    return add;
  }

  /**
   * A block is about to take the place of the finite water in this cell: push
   * that water up the column so it is not destroyed. Whatever cannot be placed
   * within a few cells is counted in `lost`.
   */
  displace(x: number, y: number, z: number): void {
    const w = this.world;
    const s = w.get(x, y, z);
    let units = SOURCE[s] ? 0 : (LEVEL[s] as number);
    for (let yy = y + 1; units > 0 && yy < Math.min(w.sy, y + 33); yy++) {
      const a = w.get(x, yy, z);
      if (SOURCE[a]) {
        this.absorbed += units;
        units = 0;
        break;
      }
      if (LEVEL[a] === 0 && !OPEN[a]) break;
      units -= this.addWater(x, yy, z, units);
    }
    this.lost += units;
  }

  /** Horizontal water velocity at a cell, in metres per second, written into `out`. */
  flowInto(x: number, y: number, z: number, out: { x: number; z: number }): void {
    waterFlow(this.world, x, y, z, out);
  }

  /** Advance the fluid by one tick. */
  tick(): void {
    const w = this.world;
    this.busy = true;
    this.ticks++;
    this.searches = 0;
    const cur = this.next;
    this.next = this.cur;
    this.cur = cur;
    this.moved.clear();
    const sections = cur.sections;
    // Bottom sections first, so falling water vacates a cell before the cell above is looked at.
    sections.sort((a, b) => a - b);
    const nsx = w.nsx;
    const layer = nsx * w.nsz;
    let processed = 0;
    for (let s = 0; s < sections.length; s++) {
      const si = sections[s] as number;
      const words = cur.words[si] as Uint32Array;
      const bx = (si % nsx) << 5;
      const bz = (Math.floor(si / nsx) % w.nsz) << 5;
      const by = Math.floor(si / layer) << 5;
      for (let wi = 0; wi < WORDS; wi++) {
        let bits = words[wi] as number;
        if (bits === 0) continue;
        if (processed >= this.maxCells) {
          // Over budget: hold the rest over, untouched and still in order.
          this.next.absorb(cur, si, wi);
          for (let r = s + 1; r < sections.length; r++) this.next.absorb(cur, sections[r] as number, 0);
          s = sections.length;
          break;
        }
        const y = by + (wi >> 5);
        const z = bz + (wi & 31);
        while (bits !== 0) {
          const low = bits & -bits;
          bits ^= low;
          const lx = 31 - Math.clz32(low);
          this.cell(bx + lx, y, z, si, (wi << 5) | lx);
          processed++;
        }
      }
    }
    cur.clear();
    this.processed = processed;
    this.evaporateDue();
    this.busy = false;
  }

  // -------------------------------------------------------------------------

  /** Write a finite level (0 is air). `old` is the state being replaced, so a plant in the way is reported. */
  private setLevel(x: number, y: number, z: number, level: number, old: number = AIR): void {
    if (old !== AIR && LEVEL[old] === 0) this.emit({ type: 'burst', x: x + 0.5, y: y + 0.5, z: z + 0.5, state: old });
    this.world.set(x, y, z, level <= 0 ? AIR : WATER + level - 1);
    this.next.addAround(x, y, z);
  }

  private cell(x: number, y: number, z: number, si: number, idx: number): void {
    const w = this.world;
    // Most active cells are neighbours that hold no water, and most water sits
    // inside a section: read the section array directly and fall back to
    // world.get only for a neighbour across a section face.
    const raw = w.blocks[si] ?? null;
    const s = raw ? (raw[idx] as number) : (w.uniform[si] as number);
    const start = LEVEL[s] as number;
    if (start === 0) return;
    if (SOURCE[s]) {
      this.source(x, y, z);
      return;
    }
    const lx = idx & 31;
    const lz = (idx >> 5) & 31;
    const ly = idx >> 10;
    const inX = raw !== null && lx > 0 && lx < 31;
    const inZ = raw !== null && lz > 0 && lz < 31;
    const inY = raw !== null && ly > 0 && ly < 31;
    const inside = inX && inY && inZ;

    const nLevel = this.nLevel;
    const nGive = this.nGive;
    const nState = this.nState;
    const nOpen = this.nOpen;
    nState[0] = inX ? ((raw as Uint16Array)[idx + 1] as number) : w.get(x + 1, y, z);
    nState[1] = inZ ? ((raw as Uint16Array)[idx + 32] as number) : w.get(x, y, z + 1);
    nState[2] = inX ? ((raw as Uint16Array)[idx - 1] as number) : w.get(x - 1, y, z);
    nState[3] = inZ ? ((raw as Uint16Array)[idx - 32] as number) : w.get(x, y, z - 1);
    let sources = 0;
    let shallow = true;
    for (let i = 0; i < 4; i++) {
      const ns = nState[i] as number;
      const nl = LEVEL[ns] as number;
      nLevel[i] = nl;
      nGive[i] = 0;
      nOpen[i] = 0;
      if (nl > 1) shallow = false;
      if (SOURCE[ns]) sources++;
      else if ((nl > 0 || OPEN[ns]) && (inside || w.inBounds(x + (NX[i] as number), y, z + (NZ[i] as number)))) nOpen[i] = 1;
    }
    let level = start;

    // 1. Down, as much as fits.
    let below = inY ? ((raw as Uint16Array)[idx - 1024] as number) : w.get(x, y - 1, z);
    if (SOURCE[below]) {
      // Water lying on a lake is swallowed, unless it is in the lake's own
      // layer (a source beside it): then it is a hole in the lake filling up.
      if (sources === 0) {
        this.absorbed += level;
        level = 0;
      }
    } else if (OPEN[below]) {
      const bl = LEVEL[below] as number;
      const m = Math.min(level, 16 - bl);
      if (m > 0) {
        this.setLevel(x, y - 1, z, bl + m, below);
        level -= m;
        below = WATER + bl + m - 1;
      }
    }
    if (level === 0) {
      this.setLevel(x, y, z, 0);
      return;
    }

    // 2. Sideways, unless this water only just arrived sideways.
    if (this.moved.has(x, y, z)) {
      this.next.add(x, y, z);
      if (level !== start) this.setLevel(x, y, z, level);
      return;
    }
    // Rotate the starting direction so the odd unit does not always go the same way.
    const r = (x * 3 + z * 5 + this.ticks) & 3;
    const gave = share(level, r, nLevel, nGive, nOpen, this.ord);
    level -= gave;
    if (gave === 0) {
      // No whole step to shed. A unit may still go over an edge it can fall from...
      let over = false;
      for (let k = 0; k < 4 && !over; k++) {
        const i = (r + k) & 3;
        if (nOpen[i] !== 1 || (nLevel[i] as number) !== level - 1) continue;
        const under = inside ? ((raw as Uint16Array)[idx + (OFF[i] as number) - 1024] as number) : w.get(x + (NX[i] as number), y - 1, z + (NZ[i] as number));
        // Whatever can take falling water: air, a plant, water with room, or a source that swallows it.
        if (!OPEN[under] || ((LEVEL[under] as number) >= 16 && !SOURCE[under])) continue;
        nLevel[i] = level;
        nGive[i] = 1;
        level--;
        over = true;
      }
      // ...or through connected water to somewhere lower, if this is the surface.
      if (!over && LEVEL[inY ? ((raw as Uint16Array)[idx + 1024] as number) : w.get(x, y + 1, z)] === 0) level -= this.seek(x, y, z, level, below);
    }
    for (let i = 0; i < 4; i++) {
      if ((nGive[i] as number) === 0) continue;
      const nx = x + (NX[i] as number);
      const nz = z + (NZ[i] as number);
      this.setLevel(nx, y, nz, nLevel[i] as number, nState[i] as number);
      this.moved.add(nx, y, nz);
    }
    if (level === 0) {
      this.setLevel(x, y, z, 0);
      return;
    }

    // A full cell held between two sources, on a floor or on water, is part of the lake again.
    if (level === 16 && sources >= 2 && (SOURCE[below] || HARD[below])) {
      let heal: number = LAKE;
      for (let i = 0; i < 4; i++) {
        const ns = nState[i] as number;
        // Inside a river, take a neighbour's current so the flow stays unbroken.
        if (ns >= RIVER && ns < RIVER + 8) heal = ns;
      }
      this.absorbed += 16;
      w.set(x, y, z, heal);
      this.next.addAround(x, y, z);
      return;
    }
    if (level !== start) this.setLevel(x, y, z, level);
    if (level === 1 && shallow && sources === 0 && LEVEL[below] === 0 && LEVEL[w.get(x, y + 1, z)] === 0) {
      const delay = this.evaporateTicks + (hash3i(x, y, z, this.seed) % ((this.evaporateTicks >> 1) + 1));
      (this.wheel[(this.ticks + delay) & this.wheelMask] as number[]).push((y * w.sz + z) * w.sx + x);
    }
  }

  /** Send water from a stalled surface cell to a lower cell it is connected to under pressure. Returns the units sent. */
  private seek(x: number, y: number, z: number, level: number, below: number): number {
    if (!PressureSearch.canStart(level, below, this.nState, this.nOpen)) return 0;
    if (this.searches >= this.searchesPerTick) {
      // Out of search budget this tick: stay awake and try again.
      this.next.add(x, y, z);
      return 0;
    }
    this.searches++;
    const p = this.pressure;
    if (!p.find(x, y, z, level, below, this.nState, this.nOpen)) return 0;
    const there = LEVEL[p.tState] as number;
    // With a block or more of head behind it water moves faster.
    const sent = p.ty < y ? Math.min(level, 16 - there, 4) : 1;
    this.setLevel(p.tx, p.ty, p.tz, there + sent, p.tState);
    this.moved.add(p.tx, p.ty, p.tz);
    return sent;
  }

  private source(x: number, y: number, z: number): void {
    const w = this.world;
    // Below: pour a full stream.
    if (y > 0) {
      const b = w.get(x, y - 1, z);
      const bl = LEVEL[b] as number;
      if (!SOURCE[b] && OPEN[b] && bl < 16) {
        this.created += 16 - bl;
        this.setLevel(x, y - 1, z, 16, b);
      }
    }
    for (let i = 0; i < 4; i++) {
      const nx = x + (NX[i] as number);
      const nz = z + (NZ[i] as number);
      if (!w.inBounds(nx, y, nz)) continue;
      const ns = w.get(nx, y, nz);
      const nl = LEVEL[ns] as number;
      if (SOURCE[ns] || nl >= 16 || (nl === 0 && !OPEN[ns])) continue;
      const give = Math.min(this.sourceRate, 16 - nl);
      this.created += give;
      this.setLevel(nx, y, nz, nl + give, ns);
      this.moved.add(nx, y, nz);
    }
  }

  private evaporateDue(): void {
    const w = this.world;
    const due = this.wheel[this.ticks & this.wheelMask] as number[];
    for (let i = 0; i < due.length; i++) {
      const key = due[i] as number;
      const x = key % w.sx;
      const z = Math.floor(key / w.sx) % w.sz;
      const y = Math.floor(key / (w.sx * w.sz));
      if (w.get(x, y, z) !== WATER) continue;
      if (LEVEL[w.get(x, y - 1, z)] !== 0 || LEVEL[w.get(x, y + 1, z)] !== 0) continue;
      let thin = true;
      for (let d = 0; d < 4; d++) {
        if ((LEVEL[w.get(x + (NX[d] as number), y, z + (NZ[d] as number))] as number) > 1) thin = false;
      }
      if (!thin) continue;
      this.evaporated++;
      this.setLevel(x, y, z, 0);
    }
    due.length = 0;
  }
}
