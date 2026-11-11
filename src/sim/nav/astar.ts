// A* over standable cells. A node is a feet cell; a move goes to one of the
// eight neighbouring columns at the same level, one up or one down. A diagonal
// is allowed only when both orthogonal cells are standable, so nobody cuts a
// wall corner or squeezes past a door frame. The search is resumable: `run`
// spends a budget of expansions and returns, so a long route can be spread over
// several ticks. All scratch storage is typed arrays owned by the instance.

import type { WalkOptions } from '../../world/walk';
import type { World } from '../../world/world';
import { MAX_SPAN, type Path, VILLAGER_WALK, isClear, packCell } from './cells';
import { WalkGrid } from './walkgrid';

export const SEARCH_IDLE = 0;
export const SEARCH_RUNNING = 1;
export const SEARCH_FOUND = 2;
export const SEARCH_FAILED = 3;

const SQRT2 = Math.SQRT2;
/** Tallest rise or drop one step may take, in blocks: a full block and a little slack for path and farmland tops. */
const MAX_STEP = 1.07;
/**
 * Heuristic cost per cell of straight-line distance. The cheapest surface
 * (a path) costs 0.8, so this is admissible everywhere but on a made road,
 * where a slight overestimate keeps the search from fanning out.
 */
const H_SCALE = 0.9;
const CLIMB_COST = 0.4;
/** Cells flooded backwards from the goal before the search, to reject a walled-in goal cheaply. */
const ENCLOSURE_PROBE = 40;

const ORTH_X = [1, -1, 0, 0];
const ORTH_Z = [0, 0, 1, -1];
/** Diagonals as [dx, dz, index of the x-orthogonal, index of the z-orthogonal]. */
const DIAG = [[1, 1, 0, 2], [1, -1, 0, 3], [-1, 1, 1, 2], [-1, -1, 1, 3]] as const;

export class AStar {
  state = SEARCH_IDLE;
  /** Expansions spent on the current search so far. */
  expansions = 0;

  private readonly world: World;
  private readonly grid: WalkGrid;
  private readonly maxNodes: number;

  private cap: number;
  private nodeKey: Int32Array;
  private nodeG: Float32Array;
  private nodeH: Float32Array;
  private nodeParent: Int32Array;
  private nodeClosed: Uint8Array;
  private count = 0;

  private tabKey: Int32Array;
  private tabVal: Int32Array;
  private tabGen: Int32Array;
  private tabMask: number;
  private tabShift: number;
  private gen = 0;

  private heapNode: Int32Array;
  private heapF: Float64Array;
  private heapSize = 0;

  private gx = 0;
  private gz = 0;
  private goalKey = 0;
  private goalNode = -1;
  private limit = 0;
  private reachH = 0;
  private readonly lev = new Int32Array(4);

  /**
   * `grid` is the standability memo to search over; several searchers on one
   * world should share one. Left out, the searcher makes its own for `opt`.
   */
  constructor(world: World, opt: WalkOptions = VILLAGER_WALK, grid?: WalkGrid, initialNodes = 1 << 12, maxNodes = 1 << 18) {
    if (world.sx > MAX_SPAN || world.sz > MAX_SPAN || world.sy > 256) throw new Error('world too large for packed path cells');
    this.world = world;
    this.grid = grid ?? new WalkGrid(world, opt);
    this.maxNodes = maxNodes;
    this.cap = initialNodes;
    this.nodeKey = new Int32Array(this.cap);
    this.nodeG = new Float32Array(this.cap);
    this.nodeH = new Float32Array(this.cap);
    this.nodeParent = new Int32Array(this.cap);
    this.nodeClosed = new Uint8Array(this.cap);
    const slots = this.cap * 2;
    this.tabKey = new Int32Array(slots);
    this.tabVal = new Int32Array(slots);
    this.tabGen = new Int32Array(slots);
    this.tabMask = slots - 1;
    this.tabShift = 32 - Math.log2(slots);
    this.heapNode = new Int32Array(this.cap * 2);
    this.heapF = new Float64Array(this.cap * 2);
  }

  /** Start a search between two feet cells. Fails at once when either end cannot be stood in. */
  begin(sx: number, sy: number, sz: number, gx: number, gy: number, gz: number, maxExpansions: number): void {
    this.expansions = 0;
    this.limit = maxExpansions;
    this.goalNode = -1;
    this.gx = gx;
    this.gz = gz;
    this.goalKey = packCell(gx, gy, gz);
    const startH = this.grid.height(sx, sy, sz);
    const goalH = this.grid.height(gx, gy, gz);
    if (Number.isNaN(startH) || Number.isNaN(goalH)) {
      this.state = SEARCH_FAILED;
      return;
    }
    const startKey = packCell(sx, sy, sz);
    if (startKey !== this.goalKey && this.goalEnclosed(gx, gy, gz, goalH, startKey)) {
      this.state = SEARCH_FAILED;
      return;
    }
    this.reset();
    const start = this.addNode(startKey, startH);
    this.nodeG[start] = 0;
    this.nodeParent[start] = -1;
    this.push(start, this.heuristic(sx, sz));
    this.state = SEARCH_RUNNING;
  }

  /** Spend up to `budget` expansions. Returns how many were used. */
  run(budget: number): number {
    if (this.state !== SEARCH_RUNNING) return 0;
    let used = 0;
    while (used < budget) {
      if (this.heapSize === 0 || this.expansions >= this.limit) {
        this.state = SEARCH_FAILED;
        break;
      }
      const node = this.pop();
      if (this.nodeClosed[node]) continue;
      this.nodeClosed[node] = 1;
      if (this.nodeKey[node] === this.goalKey) {
        this.goalNode = node;
        this.state = SEARCH_FOUND;
        break;
      }
      used++;
      this.expansions++;
      if (!this.expand(node)) {
        this.state = SEARCH_FAILED;
        break;
      }
    }
    return used;
  }

  /** The route found by the last search. Only valid in state SEARCH_FOUND. */
  path(): Path {
    let n = 0;
    for (let i = this.goalNode; i >= 0; i = this.nodeParent[i] as number) n++;
    const xs = new Int16Array(n);
    const ys = new Int16Array(n);
    const zs = new Int16Array(n);
    let at = n - 1;
    for (let i = this.goalNode; i >= 0; i = this.nodeParent[i] as number) {
      const key = this.nodeKey[i] as number;
      xs[at] = key & 1023;
      zs[at] = (key >> 10) & 1023;
      ys[at] = key >> 20;
      at--;
    }
    return { length: n, xs, ys, zs, cost: this.nodeG[this.goalNode] as number, stale: false };
  }

  // -------------------------------------------------------------------------

  private heuristic(x: number, z: number): number {
    const dx = Math.abs(x - this.gx);
    const dz = Math.abs(z - this.gz);
    return (dx > dz ? dx + 0.4142 * dz : dz + 0.4142 * dx) * H_SCALE;
  }

  /**
   * Feet level of the cell in column (x, z) that one step from a cell at level
   * `y` and surface height `h0` can reach, or -1. Leaves the surface height of
   * that cell in `reachH`. A step up needs headroom over the cell being left;
   * a step down needs it over the cell being entered.
   */
  private reach(x: number, y: number, z: number, h0: number, upClear: boolean): number {
    const grid = this.grid;
    let h = grid.height(x, y, z);
    if (h === h) {
      if (Math.abs(h - h0) > MAX_STEP) return -1;
      this.reachH = h;
      return y;
    }
    if (upClear) {
      h = grid.height(x, y + 1, z);
      if (h === h && h - h0 <= MAX_STEP) {
        this.reachH = h;
        return y + 1;
      }
    }
    h = grid.height(x, y - 1, z);
    if (h === h && h0 - h <= MAX_STEP && isClear(this.world.get(x, y + 1, z))) {
      this.reachH = h;
      return y - 1;
    }
    return -1;
  }

  /** Relax every neighbour of a node. Returns false when storage ran out. */
  private expand(node: number): boolean {
    const key = this.nodeKey[node] as number;
    const x = key & 1023;
    const z = (key >> 10) & 1023;
    const y = key >> 20;
    const g = this.nodeG[node] as number;
    const h0 = this.nodeH[node] as number;
    const upClear = isClear(this.world.get(x, y + 2, z));
    const lev = this.lev;
    for (let d = 0; d < 4; d++) {
      const nx = x + (ORTH_X[d] as number);
      const nz = z + (ORTH_Z[d] as number);
      const ny = this.reach(nx, y, nz, h0, upClear);
      lev[d] = ny;
      if (ny >= 0 && !this.relax(node, nx, ny, nz, this.reachH, g, 1, ny !== y)) return false;
    }
    for (let d = 0; d < 4; d++) {
      const diag = DIAG[d] as readonly [number, number, number, number];
      const la = lev[diag[2]] as number;
      const lb = lev[diag[3]] as number;
      if (la < 0 || lb < 0) continue;
      const nx = x + diag[0];
      const nz = z + diag[1];
      const ny = this.reach(nx, y, nz, h0, upClear);
      if (ny < 0 || Math.abs(ny - la) > 1 || Math.abs(ny - lb) > 1) continue;
      if (!this.relax(node, nx, ny, nz, this.reachH, g, SQRT2, ny !== y)) return false;
    }
    return true;
  }

  private relax(from: number, x: number, y: number, z: number, h: number, g: number, len: number, climbs: boolean): boolean {
    const key = packCell(x, y, z);
    let node = this.find(key);
    if (node >= 0 && this.nodeClosed[node]) return true;
    const ng = g + len * this.grid.cost(x, y, z) + (climbs ? CLIMB_COST : 0);
    if (node < 0) {
      if (this.count >= this.cap && !this.grow()) return false;
      node = this.addNode(key, h);
    } else if (ng >= (this.nodeG[node] as number)) {
      return true;
    }
    this.nodeG[node] = ng;
    this.nodeParent[node] = from;
    return this.push(node, ng + this.heuristic(x, z));
  }

  /**
   * Flood backwards from the goal a few dozen cells. If the flood runs dry
   * without meeting the start, the goal is sealed off and the forward search
   * would only burn its whole budget finding that out.
   */
  private goalEnclosed(gx: number, gy: number, gz: number, goalH: number, startKey: number): boolean {
    this.reset();
    const first = this.addNode(packCell(gx, gy, gz), goalH);
    let head = first;
    while (head < this.count) {
      if (this.count > ENCLOSURE_PROBE) return false;
      const key = this.nodeKey[head] as number;
      const h0 = this.nodeH[head] as number;
      head++;
      const x = key & 1023;
      const z = (key >> 10) & 1023;
      const y = key >> 20;
      const upClear = isClear(this.world.get(x, y + 2, z));
      for (let d = 0; d < 4; d++) {
        const nx = x + (ORTH_X[d] as number);
        const nz = z + (ORTH_Z[d] as number);
        const ny = this.reach(nx, y, nz, h0, upClear);
        if (ny < 0) continue;
        const nk = packCell(nx, ny, nz);
        if (nk === startKey) return false;
        if (this.find(nk) < 0) this.addNode(nk, this.reachH);
      }
    }
    return true;
  }

  // --- node storage: an open-addressed table stamped with a generation, so a reset is O(1) ---

  private reset(): void {
    this.count = 0;
    this.heapSize = 0;
    this.gen++;
  }

  private slot(key: number): number {
    return Math.imul(key, 0x9e3779b1) >>> this.tabShift;
  }

  private find(key: number): number {
    let s = this.slot(key);
    while (this.tabGen[s] === this.gen) {
      if (this.tabKey[s] === key) return this.tabVal[s] as number;
      s = (s + 1) & this.tabMask;
    }
    return -1;
  }

  private addNode(key: number, h: number): number {
    const node = this.count++;
    this.nodeKey[node] = key;
    this.nodeH[node] = h;
    this.nodeG[node] = Infinity;
    this.nodeParent[node] = -1;
    this.nodeClosed[node] = 0;
    let s = this.slot(key);
    while (this.tabGen[s] === this.gen) s = (s + 1) & this.tabMask;
    this.tabGen[s] = this.gen;
    this.tabKey[s] = key;
    this.tabVal[s] = node;
    return node;
  }

  /** Double the node storage. Returns false at the hard ceiling. */
  private grow(): boolean {
    if (this.cap >= this.maxNodes) return false;
    const cap = this.cap * 2;
    const widen = <T extends Int32Array | Float32Array | Uint8Array>(old: T, fresh: T): T => {
      fresh.set(old);
      return fresh;
    };
    this.nodeKey = widen(this.nodeKey, new Int32Array(cap));
    this.nodeG = widen(this.nodeG, new Float32Array(cap));
    this.nodeH = widen(this.nodeH, new Float32Array(cap));
    this.nodeParent = widen(this.nodeParent, new Int32Array(cap));
    this.nodeClosed = widen(this.nodeClosed, new Uint8Array(cap));
    this.cap = cap;
    const slots = cap * 2;
    this.tabKey = new Int32Array(slots);
    this.tabVal = new Int32Array(slots);
    this.tabGen = new Int32Array(slots);
    this.tabMask = slots - 1;
    this.tabShift = 32 - Math.log2(slots);
    this.gen = 1;
    for (let node = 0; node < this.count; node++) {
      const key = this.nodeKey[node] as number;
      let s = this.slot(key);
      while (this.tabGen[s] === this.gen) s = (s + 1) & this.tabMask;
      this.tabGen[s] = this.gen;
      this.tabKey[s] = key;
      this.tabVal[s] = node;
    }
    return true;
  }

  // --- binary heap on f; stale duplicates are skipped when popped ---

  private push(node: number, f: number): boolean {
    if (this.heapSize >= this.heapNode.length) {
      if (this.heapNode.length >= this.maxNodes * 4) return false;
      const nodes = new Int32Array(this.heapNode.length * 2);
      const fs = new Float64Array(this.heapNode.length * 2);
      nodes.set(this.heapNode);
      fs.set(this.heapF);
      this.heapNode = nodes;
      this.heapF = fs;
    }
    const heapNode = this.heapNode;
    const heapF = this.heapF;
    let i = this.heapSize++;
    while (i > 0) {
      const parent = (i - 1) >> 1;
      if ((heapF[parent] as number) <= f) break;
      heapNode[i] = heapNode[parent] as number;
      heapF[i] = heapF[parent] as number;
      i = parent;
    }
    heapNode[i] = node;
    heapF[i] = f;
    return true;
  }

  private pop(): number {
    const heapNode = this.heapNode;
    const heapF = this.heapF;
    const top = heapNode[0] as number;
    const size = --this.heapSize;
    if (size > 0) {
      const node = heapNode[size] as number;
      const f = heapF[size] as number;
      let i = 0;
      for (;;) {
        let child = i * 2 + 1;
        if (child >= size) break;
        if (child + 1 < size && (heapF[child + 1] as number) < (heapF[child] as number)) child++;
        if ((heapF[child] as number) >= f) break;
        heapNode[i] = heapNode[child] as number;
        heapF[i] = heapF[child] as number;
        i = child;
      }
      heapNode[i] = node;
      heapF[i] = f;
    }
    return top;
  }
}
