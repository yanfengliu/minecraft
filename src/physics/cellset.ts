// A set of world cells kept as one bitset per 32^3 section. The fluid's active
// set lives here: marking a cell is a bit write rather than a hash insert, and
// walking the set in section, y, z, x order needs no sort, which is what makes
// a fluid tick independent of the order cells happened to be woken in.

import type { World } from '../world/world';

const WORDS = 1024;

function popcount(v: number): number {
  v >>>= 0;
  v -= (v >>> 1) & 0x55555555;
  v = (v & 0x33333333) + ((v >>> 2) & 0x33333333);
  return (Math.imul((v + (v >>> 4)) & 0x0f0f0f0f, 0x01010101) >>> 24);
}

/** Set `bit` in word `j`; returns 1 when it was clear before. */
function mark(w: Uint32Array, j: number, bit: number): number {
  const old = w[j] as number;
  if ((old & bit) !== 0) return 0;
  w[j] = old | bit;
  return 1;
}

export class CellSet {
  /** Bitset per section, allocated on first use; bit index is (ly << 10) | (lz << 5) | lx. */
  readonly words: (Uint32Array | null)[];
  /** Sections that may hold set bits, in the order they were first touched. */
  readonly sections: number[] = [];
  /** Number of cells in the set. */
  size = 0;

  private readonly listed: Uint8Array;
  private readonly sx: number;
  private readonly sy: number;
  private readonly sz: number;
  private readonly nsx: number;
  private readonly nsz: number;

  constructor(world: World) {
    this.sx = world.sx;
    this.sy = world.sy;
    this.sz = world.sz;
    this.nsx = world.nsx;
    this.nsz = world.nsz;
    this.words = new Array<Uint32Array | null>(world.sectionCount).fill(null);
    this.listed = new Uint8Array(world.sectionCount);
  }

  private section(si: number): Uint32Array {
    let w = this.words[si];
    if (!w) {
      w = new Uint32Array(WORDS);
      this.words[si] = w;
    }
    if (this.listed[si] === 0) {
      this.listed[si] = 1;
      this.sections.push(si);
    }
    return w;
  }

  /** Add one cell; cells outside the world are ignored. */
  add(x: number, y: number, z: number): void {
    if (x < 0 || y < 0 || z < 0 || x >= this.sx || y >= this.sy || z >= this.sz) return;
    const w = this.section(((y >> 5) * this.nsz + (z >> 5)) * this.nsx + (x >> 5));
    const idx = ((y & 31) << 10) | ((z & 31) << 5) | (x & 31);
    const bit = 1 << (idx & 31);
    const old = w[idx >>> 5] as number;
    if ((old & bit) === 0) {
      w[idx >>> 5] = old | bit;
      this.size++;
    }
  }

  /** Add a cell and its six face neighbours: everything a change to that cell can disturb. */
  addAround(x: number, y: number, z: number): void {
    if (x < 0 || y < 0 || z < 0 || x >= this.sx || y >= this.sy || z >= this.sz) {
      this.add(x + 1, y, z);
      this.add(x - 1, y, z);
      this.add(x, y + 1, z);
      this.add(x, y - 1, z);
      this.add(x, y, z + 1);
      this.add(x, y, z - 1);
      return;
    }
    const lx = x & 31;
    const ly = y & 31;
    const lz = z & 31;
    // Write this section's bitset directly; only a neighbour across a section face takes the general path.
    const w = this.section(((y >> 5) * this.nsz + (z >> 5)) * this.nsx + (x >> 5));
    // A word is one row of x; z neighbours are one word away and y neighbours 32 words away.
    const wi = (ly << 5) | lz;
    const bit = 1 << lx;
    let added: number;
    if (lx > 0 && lx < 31) {
      const row = w[wi] as number;
      const three = 7 << (lx - 1);
      w[wi] = row | three;
      added = popcount(three & ~row);
    } else {
      added = mark(w, wi, bit);
      this.add(x + 1, y, z);
      this.add(x - 1, y, z);
    }
    if (lz > 0 && lz < 31) added += mark(w, wi - 1, bit) + mark(w, wi + 1, bit);
    else {
      this.add(x, y, z + 1);
      this.add(x, y, z - 1);
    }
    if (ly > 0 && ly < 31) added += mark(w, wi - 32, bit) + mark(w, wi + 32, bit);
    else {
      this.add(x, y + 1, z);
      this.add(x, y - 1, z);
    }
    this.size += added;
  }

  has(x: number, y: number, z: number): boolean {
    if (x < 0 || y < 0 || z < 0 || x >= this.sx || y >= this.sy || z >= this.sz) return false;
    const w = this.words[((y >> 5) * this.nsz + (z >> 5)) * this.nsx + (x >> 5)];
    if (!w) return false;
    const idx = ((y & 31) << 10) | ((z & 31) << 5) | (x & 31);
    return ((w[idx >>> 5] as number) & (1 << (idx & 31))) !== 0;
  }

  /** Copy the bits of one section of `from`, from word `startWord` on, into this set. */
  absorb(from: CellSet, si: number, startWord: number): void {
    const src = from.words[si];
    if (!src) return;
    const dst = this.section(si);
    for (let i = startWord; i < WORDS; i++) {
      const s = src[i] as number;
      if (s === 0) continue;
      const d = dst[i] as number;
      this.size += popcount(s & ~d);
      dst[i] = d | s;
    }
  }

  clear(): void {
    for (const si of this.sections) {
      (this.words[si] as Uint32Array).fill(0);
      this.listed[si] = 0;
    }
    this.sections.length = 0;
    this.size = 0;
  }
}
