// The path service the village walks on: a queue of route requests worked off
// within a per-tick budget of A* expansions, and a cache of routes between
// places people go every day. A cached route is dropped when a block edit near
// it changes what can be walked on. Deterministic: requests are served in the
// order they were made.

import { SOLID, STATE_COUNT, TOP_HEIGHT, WALK_COST, WATER_LEVEL, isDoor, isGate } from '../../world/blocks';
import { WADE_LEVEL, type WalkOptions } from '../../world/walk';
import type { BlockChange, World } from '../../world/world';
import { AStar, SEARCH_FOUND, SEARCH_RUNNING } from './astar';
import { type Path, VILLAGER_WALK, packCell, reversePath } from './cells';
import { WalkGrid } from './walkgrid';

export const PATH_PENDING = 0;
export const PATH_FOUND = 1;
export const PATH_FAILED = 2;

export interface PathRequest {
  status: number;
  path: Path | null;
  /** Set by the requester to abandon a queued search. */
  cancelled: boolean;
  readonly sx: number;
  readonly sy: number;
  readonly sz: number;
  readonly gx: number;
  readonly gy: number;
  readonly gz: number;
  readonly cache: boolean;
}

export interface NavOptions {
  /** A* expansions the service may spend per tick across all requests. */
  budgetPerTick?: number;
  /** Expansions after which a search gives up, for a near goal; a far one is allowed more, by its distance. */
  maxExpansions?: number;
  /** Routes held before the least recently used half is forgotten. */
  cacheLimit?: number;
  walk?: WalkOptions;
}

export interface NavStats {
  requests: number;
  cacheHits: number;
  /** Requests answered by a straight line, with no search. */
  direct: number;
  searches: number;
  found: number;
  failed: number;
  expansions: number;
  invalidated: number;
}

/**
 * What a state means to a walker, reduced to one number: two states with the
 * same signature are interchangeable for standing, for passing and for what a
 * step costs, so swapping one for the other (a door opening, a crop growing, a
 * lantern lit, soil wetted) leaves the remembered costs and every cached route
 * as good as they were. The signature is made from exactly what `standHeight`,
 * `walkCost` and the doorway surcharge read from a state, and from all of it:
 * a path ploughed into farmland stands as high as before and costs five times
 * as much to cross, and a cell of open ground costs more to wade with every
 * sixteenth of water that comes into it.
 */
const WALK_SIGNATURE = (() => {
  const sig = new Uint16Array(STATE_COUNT);
  const ids = new Map<string, number>();
  for (let s = 0; s < STATE_COUNT; s++) {
    const water = WATER_LEVEL[s] as number;
    let key: string;
    if (isDoor(s)) key = 'door';
    else if (isGate(s)) key = 'gate';
    else if (SOLID[s]) key = `solid ${TOP_HEIGHT[s]} ${WALK_COST[s]}`;
    else key = water > WADE_LEVEL ? 'deep' : `open ${water}`;
    let id = ids.get(key);
    if (id === undefined) {
      id = ids.size;
      ids.set(key, id);
    }
    sig[s] = id;
  }
  return sig;
})();

/** Columns per side of an invalidation bucket. */
const BUCKET_SHIFT = 3;
/** Farthest apart two cells may be for a straight line to be tried before a search. */
const DIRECT_REACH = 12;
/** Step cost from which ground counts as something to walk round rather than across (farmland is 4). */
const ROUGH_GROUND = 3;
/** Expansions allowed per block of straight-line distance; measured routes over hills and round a river need about 110. */
const EXPANSIONS_PER_BLOCK = 260;

export class Navigator {
  readonly stats: NavStats = { requests: 0, cacheHits: 0, direct: 0, searches: 0, found: 0, failed: 0, expansions: 0, invalidated: 0 };

  private readonly world: World;
  private readonly walk: WalkOptions;
  private readonly budgetPerTick: number;
  private readonly maxExpansions: number;
  private readonly cacheLimit: number;

  /** What can be stood in and what a step costs, remembered between searches and shared by both searchers. */
  private readonly grid: WalkGrid;
  private readonly search: AStar;
  /** A second searcher for `findNow`, so a synchronous lookup never disturbs a search in flight. */
  private quick: AStar | null = null;

  private readonly queue: PathRequest[] = [];
  private queueHead = 0;
  private active: PathRequest | null = null;
  private budget: number;

  private readonly routes = new Map<number, Map<number, Path>>();
  private routeCount = 0;
  /** When each cached route was last handed out, as a count of uses, for choosing what to forget. */
  private readonly usedAt = new Map<Path, number>();
  private stamp = 0;
  private readonly buckets = new Map<number, Set<Path>>();
  private readonly unsubscribe: () => void;

  constructor(world: World, options: NavOptions = {}) {
    this.world = world;
    this.walk = options.walk ?? VILLAGER_WALK;
    this.budgetPerTick = options.budgetPerTick ?? 700;
    this.maxExpansions = options.maxExpansions ?? 14000;
    this.cacheLimit = options.cacheLimit ?? 6000;
    this.budget = this.budgetPerTick;
    this.grid = new WalkGrid(world, this.walk);
    this.search = new AStar(world, this.walk, this.grid);
    this.unsubscribe = world.changed.on((c) => this.onChange(c));
  }

  /** Stop listening to the world. Call when the simulation is discarded. */
  dispose(): void {
    this.unsubscribe();
  }

  /** Call once per tick: refills the budget and carries on with queued searches. */
  update(): void {
    this.budget = this.budgetPerTick;
    if (this.active || this.queueHead < this.queue.length) this.pump();
  }

  /**
   * Ask for a route between two feet cells. The answer may be there at once
   * (a cached route, or a search that fits what is left of this tick's budget);
   * otherwise poll `status` on later ticks. `cache` should be false for one-off
   * destinations such as a field cell or a tree.
   */
  request(sx: number, sy: number, sz: number, gx: number, gy: number, gz: number, cache = true): PathRequest {
    this.stats.requests++;
    const req: PathRequest = { status: PATH_PENDING, path: null, cancelled: false, sx, sy, sz, gx, gy, gz, cache };
    const hit = this.lookup(packCell(sx, sy, sz), packCell(gx, gy, gz)) ?? this.direct(sx, sy, sz, gx, gy, gz);
    if (hit) {
      req.status = PATH_FOUND;
      req.path = hit;
      return req;
    }
    this.queue.push(req);
    this.pump();
    return req;
  }

  /**
   * The straight line between two cells a few steps apart on the same level,
   * if every cell of it can be walked: no search needed to cross a yard or to
   * step along a row of crops. Null when anything is in the way or the line
   * would cut across a field that neither end is in, where the search's choice
   * of the way round is wanted.
   */
  private direct(sx: number, sy: number, sz: number, gx: number, gy: number, gz: number): Path | null {
    const dx = gx - sx;
    const dz = gz - sz;
    const n = Math.max(Math.abs(dx), Math.abs(dz));
    if (sy !== gy || n === 0 || n > DIRECT_REACH) return null;
    const grid = this.grid;
    let h = grid.height(sx, sy, sz);
    if (h !== h) return null;
    const rough = Math.max(grid.cost(sx, sy, sz), grid.cost(gx, gy, gz)) >= ROUGH_GROUND;
    const xs = new Int16Array(n + 1);
    const ys = new Int16Array(n + 1).fill(sy);
    const zs = new Int16Array(n + 1);
    xs[0] = sx;
    zs[0] = sz;
    let x = sx;
    let z = sz;
    let cost = 0;
    for (let i = 1; i <= n; i++) {
      const nx = sx + Math.round((dx * i) / n);
      const nz = sz + Math.round((dz * i) / n);
      const nh = grid.height(nx, sy, nz);
      if (nh !== nh || Math.abs(nh - h) > 0.6) return null;
      const step = grid.cost(nx, sy, nz);
      if (step >= ROUGH_GROUND && !rough) return null;
      const diagonal = nx !== x && nz !== z;
      // The same rule as the search: no diagonal past a corner.
      if (diagonal && (Number.isNaN(grid.height(nx, sy, z)) || Number.isNaN(grid.height(x, sy, nz)))) return null;
      cost += step * (diagonal ? Math.SQRT2 : 1);
      xs[i] = nx;
      zs[i] = nz;
      x = nx;
      z = nz;
      h = nh;
    }
    this.stats.direct++;
    return { length: n + 1, xs, ys, zs, cost, stale: false };
  }

  /**
   * Find a route right now, outside the queue and the per-tick budget. Meant
   * for short hops (into a pen, across a field) where waiting a tick would
   * show; `maxExpansions` keeps the cost bounded.
   */
  findNow(sx: number, sy: number, sz: number, gx: number, gy: number, gz: number, maxExpansions = 1500, cache = false): Path | null {
    const from = packCell(sx, sy, sz);
    const to = packCell(gx, gy, gz);
    const hit = this.lookup(from, to) ?? this.direct(sx, sy, sz, gx, gy, gz);
    if (hit) return hit;
    this.quick ??= new AStar(this.world, this.walk, this.grid);
    const quick = this.quick;
    quick.begin(sx, sy, sz, gx, gy, gz, maxExpansions);
    this.stats.searches++;
    this.stats.expansions += quick.run(maxExpansions + 1);
    if (quick.state !== SEARCH_FOUND) {
      this.stats.failed++;
      return null;
    }
    this.stats.found++;
    const path = quick.path();
    if (cache) this.store(from, to, path);
    return path;
  }

  /** Number of routes currently cached. */
  get cachedRoutes(): number {
    return this.routeCount;
  }

  /**
   * Expansions a search between two columns may spend before it gives up. A
   * fixed number that suits a village is too few for the country round it: on
   * the generated island the 200 blocks from the square to the hunting ground
   * take 18,000 to 23,000, so the allowance grows with the distance.
   */
  private limitFor(sx: number, sz: number, gx: number, gz: number): number {
    return Math.max(this.maxExpansions, Math.round(Math.hypot(gx - sx, gz - sz) * EXPANSIONS_PER_BLOCK));
  }

  // -------------------------------------------------------------------------

  private pump(): void {
    while (this.budget > 0) {
      if (!this.active) {
        let next: PathRequest | null = null;
        while (this.queueHead < this.queue.length) {
          const candidate = this.queue[this.queueHead++] as PathRequest;
          if (!candidate.cancelled) {
            next = candidate;
            break;
          }
        }
        if (this.queueHead === this.queue.length) {
          this.queue.length = 0;
          this.queueHead = 0;
        }
        if (!next) return;
        // An identical request earlier in the queue may have filled the cache meanwhile.
        const hit = next.cache ? this.lookup(packCell(next.sx, next.sy, next.sz), packCell(next.gx, next.gy, next.gz)) : null;
        if (hit) {
          next.status = PATH_FOUND;
          next.path = hit;
          continue;
        }
        this.active = next;
        this.stats.searches++;
        this.search.begin(next.sx, next.sy, next.sz, next.gx, next.gy, next.gz, this.limitFor(next.sx, next.sz, next.gx, next.gz));
      }
      const req = this.active;
      const search = this.search;
      if (search.state === SEARCH_RUNNING && !req.cancelled) {
        const used = search.run(this.budget);
        // A search that ends without expanding anything must still cost something, or a queue of hopeless requests would spin here.
        this.budget -= Math.max(used, 1);
        this.stats.expansions += used;
        if (search.state === SEARCH_RUNNING) return;
      }
      if (search.state === SEARCH_FOUND && !req.cancelled) {
        const path = search.path();
        req.path = path;
        req.status = PATH_FOUND;
        this.stats.found++;
        if (req.cache) this.store(packCell(req.sx, req.sy, req.sz), packCell(req.gx, req.gy, req.gz), path);
      } else {
        req.status = PATH_FAILED;
        if (!req.cancelled) this.stats.failed++;
      }
      this.active = null;
    }
  }

  private lookup(from: number, to: number): Path | null {
    let path = this.routes.get(from)?.get(to);
    if (!path) {
      // Every move is legal in both directions, so the way back is the way there reversed.
      const back = this.routes.get(to)?.get(from);
      if (!back) return null;
      path = reversePath(back);
      this.store(from, to, path);
    }
    this.stats.cacheHits++;
    this.usedAt.set(path, ++this.stamp);
    return path;
  }

  private store(from: number, to: number, path: Path): void {
    if (this.routeCount >= this.cacheLimit) this.evict();
    this.usedAt.set(path, ++this.stamp);
    let row = this.routes.get(from);
    if (!row) {
      row = new Map();
      this.routes.set(from, row);
    }
    if (!row.has(to)) this.routeCount++;
    row.set(to, path);
    let last = -1;
    for (let i = 0; i < path.length; i++) {
      const bucket = (((path.zs[i] as number) >> BUCKET_SHIFT) << 10) | ((path.xs[i] as number) >> BUCKET_SHIFT);
      if (bucket === last) continue;
      last = bucket;
      let set = this.buckets.get(bucket);
      if (!set) {
        set = new Set();
        this.buckets.set(bucket, set);
      }
      set.add(path);
    }
  }

  private onChange(c: BlockChange): void {
    if (WALK_SIGNATURE[c.old] === WALK_SIGNATURE[c.state]) return;
    this.grid.invalidate(c.x, c.y, c.z);
    if (this.routeCount === 0) return;
    // A changed block alters standing in its own column (up to two cells above it) and passing diagonally beside it.
    const bx0 = (c.x - 1) >> BUCKET_SHIFT;
    const bx1 = (c.x + 1) >> BUCKET_SHIFT;
    const bz0 = (c.z - 1) >> BUCKET_SHIFT;
    const bz1 = (c.z + 1) >> BUCKET_SHIFT;
    let dropped = false;
    for (let bz = bz0; bz <= bz1; bz++) {
      for (let bx = bx0; bx <= bx1; bx++) {
        const set = this.buckets.get((bz << 10) | bx);
        if (!set) continue;
        for (const path of set) {
          if (path.stale) {
            set.delete(path);
            continue;
          }
          if (touches(path, c.x, c.y, c.z)) {
            path.stale = true;
            set.delete(path);
            dropped = true;
            this.stats.invalidated++;
          }
        }
      }
    }
    if (dropped) this.sweepStale();
  }

  private sweepStale(): void {
    for (const [from, row] of this.routes) {
      for (const [to, path] of row) {
        if (path.stale) {
          row.delete(to);
          this.usedAt.delete(path);
          this.routeCount--;
        }
      }
      if (row.size === 0) this.routes.delete(from);
    }
  }

  /** The cache is full: forget the half of the routes that have gone longest unused, and keep the ones people walk every day. */
  private evict(): void {
    const stamps = [...this.usedAt.values()].sort((a, b) => a - b);
    const cut = stamps[stamps.length >> 1] ?? 0;
    for (const [path, at] of this.usedAt) if (at <= cut) path.stale = true;
    this.sweepStale();
    for (const set of this.buckets.values()) for (const path of set) if (path.stale) set.delete(path);
  }
}

function touches(path: Path, x: number, y: number, z: number): boolean {
  const { xs, ys, zs } = path;
  for (let i = 0; i < path.length; i++) {
    const dx = (xs[i] as number) - x;
    const dz = (zs[i] as number) - z;
    if (dx < -1 || dx > 1 || dz < -1 || dz > 1) continue;
    const dy = (ys[i] as number) - y;
    if (dy >= -2 && dy <= 3) return true;
  }
  return false;
}
