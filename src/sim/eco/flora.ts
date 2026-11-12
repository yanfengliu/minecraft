// Plant life. Each tick a handful of random columns are visited and whatever
// grows there is given its chance: bare grass may sprout, a bush may ripen, a
// crown may drop a seed, a mushroom may come up or fade. Nothing is ever
// scanned, so the cost is fixed, and because the visits are uniform the same
// counts double as an estimate of plant cover for the census.
//
// The rules only ever write to air above grass or forest floor, to plants, and
// to berry bushes: farmland, crops, paths and anything built are never touched.

import { type Rng, hash32 } from '../../core/rng';
import { B, IS_LEAVES, IS_LOG, NATURAL, SHAPE, SHAPE_CROP, SOLID } from '../../world/blocks';
import { SAPLING_OF, type TreeSpecies, growTree, speciesOfSapling } from '../../world/gen/trees';
import type { World } from '../../world/world';
import { H_WOOD } from './habitat';
import { ALL_KINDS, FISH, FOOD_FLOWER, FOOD_GRASS, bit } from './species';
import type { Eco } from './state';
import { FOOD, SOFT, isCanopy } from './terrain';

/** Chance that a visited cell of bare open grass sprouts, by season, on soaked ground. */
const GROWTH = [0.14, 0.07, 0.03, 0];
/** Dry ground grows at this share of the soaked rate. */
const DRY = 0.35;
/** A cell sprouts only with at most this many plants among its eight neighbours: the bound on density. */
const MAX_NEIGHBOURS = 1;
/** A cell with no plant beside it sprouts at this share of the rate: plants spread from plants. */
const ISOLATED = 0.5;
/** Chance that a visited crown block drops a seed that is given a try, by season. */
const SEEDING = [0.012, 0.006, 0.012, 0];
/** How far a seed falls from the crown it came from. */
const SEED_REACH = 6;
/** Chance that a visited bush ripens, by season. */
const RIPEN = [0, 0.35, 0.5, 0];
const MUSHROOM = 0.02;
/** Days a sapling stands before it can become a tree, and after which one that cannot grow dies. */
const SAPLING_DAYS = 3;
const SAPLING_GIVE_UP = 14;
/** Sky light a sapling needs. */
const SAPLING_LIGHT = 12;
/** Ticks between one sapling becoming a tree and the next, when several are ready in the same hour. */
const GROW_SPACING = 20;
/** Woodland may spread onto grass until it covers this much more than it did at the start. */
const WOOD_GROWTH = 1.12;
/** One visit per tick for every this many columns of world, so each column is seen about once a day. */
const COLUMNS_PER_VISIT = 16384;

const AUTUMN = 2;
const WINTER = 3;

export interface PlantCover {
  /** Share of open grass that carries a plant, 0..1. */
  cover: number;
  /** Estimated blocks of each kind in the world, scaled up from the columns sampled over the last day. */
  tallGrass: number;
  flowers: number;
  mushrooms: number;
  berryBushes: number;
  /** Bushes known to be ripe, and saplings known to be growing. */
  ripeBushes: number;
  saplings: number;
  /** Share of the world's columns under tree crowns, 0..1. */
  canopy: number;
}

interface Tally {
  visits: number;
  open: number;
  plants: number;
  tall: number;
  flowers: number;
  mushrooms: number;
  bushes: number;
  canopy: number;
}

const emptyTally = (): Tally => ({ visits: 0, open: 0, plants: 0, tall: 0, flowers: 0, mushrooms: 0, bushes: 0, canopy: 0 });

export class Flora {
  /** Columns visited each tick. */
  readonly perTick: number;
  /** Lifetime counts, for tests and the census. */
  sprouted = 0;
  seeded = 0;
  treesGrown = 0;
  saplingsLost = 0;

  private readonly e: Eco;
  private readonly world: World;
  private readonly rng: Rng;
  private readonly ripe = new Set<number>();
  /** Known saplings: packed cell to the day each was first seen. */
  private readonly saplings = new Map<number, number>();
  private readonly woodLimit: number;
  private readonly window: number;
  private now: Tally = emptyTally();
  private last: Tally = emptyTally();
  /** Kinds whose presence holds a sapling back from becoming a tree on top of them. */
  private readonly inTheWay = ALL_KINDS & ~bit(FISH);
  /** Saplings are being looked over, and one may yet be ready to grow. */
  private growing = false;

  constructor(e: Eco, rng: Rng) {
    this.e = e;
    this.world = e.world;
    this.rng = rng;
    const columns = e.world.sx * e.world.sz;
    this.perTick = Math.max(1, Math.min(48, Math.round(columns / COLUMNS_PER_VISIT)));
    this.window = this.perTick * 14400;
    this.woodLimit = (e.habitat.total[H_WOOD] as number) * WOOD_GROWTH + 8;
    // A first look round without changing anything, so the cover figures mean something from the start.
    for (let i = 0; i < 6000; i++) this.visit(rng.int(e.world.sx), rng.int(e.world.sz), false);
    this.now.visits = 6000;
    this.last = this.now;
    this.now = emptyTally();
  }

  tick(): void {
    const w = this.world;
    const rng = this.rng;
    for (let i = 0; i < this.perTick; i++) this.visit(rng.int(w.sx), rng.int(w.sz), true);
    this.now.visits += this.perTick;
    if (this.now.visits >= this.window) {
      this.last = this.now;
      this.now = emptyTally();
    }
    // Once an hour the saplings are looked over, and those that are ready come up one at a time, a couple of
    // seconds apart. Saplings come of age by the day, so several are ready in the same hour; a tree is some
    // hundreds of block writes, each relit, and all of them in one tick was a frame a tenth of a second long.
    if (this.e.tick % 600 === 0) this.growing = true;
    if (this.growing && this.e.tick % GROW_SPACING === 0) this.growing = this.growSapling();
  }

  /** The calendar was set forward or back by `days`: the saplings are no older or younger for it. */
  carry(days: number): void {
    for (const [key, since] of this.saplings) this.saplings.set(key, since + days);
  }

  cover(): PlantCover {
    const t = this.last;
    const scale = (this.world.sx * this.world.sz) / Math.max(1, t.visits);
    return {
      cover: t.open > 0 ? t.plants / t.open : 0,
      tallGrass: Math.round(t.tall * scale),
      flowers: Math.round(t.flowers * scale),
      mushrooms: Math.round(t.mushrooms * scale),
      berryBushes: Math.round(t.bushes * scale),
      ripeBushes: this.ripe.size,
      saplings: this.saplings.size,
      canopy: t.canopy / Math.max(1, t.visits),
    };
  }

  private key(x: number, y: number, z: number): number {
    return (y * this.world.sz + z) * this.world.sx + x;
  }

  /** Look at one column and let whatever is there take its turn. With `act` false, only count. */
  private visit(x: number, z: number, act: boolean): void {
    const w = this.world;
    const t = this.now;
    const h = w.height(x, z);
    if (h < 1 || h >= w.sy - 1) return;
    const roof = w.get(x, h - 1, z);
    let y = h;
    let shaded = false;
    if (isCanopy(roof)) {
      t.canopy++;
      if (act && IS_LEAVES[roof]) this.dropSeed(x, z, roof);
      y = h - 2;
      while (y > 0 && SOFT[w.get(x, y, z)]) y--;
      y++;
      shaded = true;
    }
    // In the open `y` is the first cell above the top of the column, so it is exposed to the sky by construction.
    const ground = w.get(x, y - 1, z);
    const c = w.get(x, y, z);
    if (c === B.air) {
      if (ground === B.grass) {
        if (!shaded) {
          t.open++;
          if (act) this.sprout(x, y, z);
        } else if (act) this.mushroom(x, y, z, 0.5);
      } else if (ground === B.forest_floor && act) this.mushroom(x, y, z, 1);
      return;
    }
    const food = FOOD[c] as number;
    if (food & (FOOD_GRASS | FOOD_FLOWER)) {
      if (ground === B.grass && !shaded) {
        t.open++;
        t.plants++;
      }
      if (c === B.tall_grass) t.tall++;
      else if (food & FOOD_FLOWER) {
        t.flowers++;
        // Flowers die back in winter and return with the spring growth.
        if (act && this.e.season === WINTER && this.rng.chance(0.3)) w.set(x, y, z, B.air);
      }
      return;
    }
    if (c === B.berry_bush || c === B.berry_bush + 1) {
      t.bushes++;
      if (act) this.bush(x, y, z, c === B.berry_bush + 1);
      return;
    }
    if (c === B.mushroom_brown || c === B.mushroom_red) {
      t.mushrooms++;
      // Mushrooms are an autumn thing: gone with the first weeks of winter, and stragglers by spring.
      if (act && this.e.season !== AUTUMN && this.rng.chance(this.e.season === WINTER ? 0.5 : 0.25)) w.set(x, y, z, B.air);
      return;
    }
    if (act && speciesOfSapling(c)) {
      const key = this.key(x, y, z);
      if (!this.saplings.has(key)) this.saplings.set(key, this.e.day);
    }
  }

  private sprout(x: number, y: number, z: number): void {
    const e = this.e;
    const rate = (GROWTH[e.season] as number) * (DRY + (1 - DRY) * e.wetness);
    if (rate <= 0 || this.rng.float() >= rate) return;
    const w = this.world;
    let n = 0;
    let like = 0;
    for (let dz = -1; dz <= 1; dz++) {
      for (let dx = -1; dx <= 1; dx++) {
        if (dx === 0 && dz === 0) continue;
        const s = w.get(x + dx, y, z + dz);
        if (FOOD[s] & (FOOD_GRASS | FOOD_FLOWER)) {
          n++;
          like = s;
        }
      }
    }
    if (n > MAX_NEIGHBOURS) return;
    if (n === 0 && !this.rng.chance(ISOLATED)) return;
    // Often the same as a neighbour, so flowers stand in drifts rather than a speckle.
    w.set(x, y, z, like !== 0 && this.rng.chance(0.55) ? like : this.seedling(x, z));
    this.sprouted++;
  }

  private seedling(x: number, z: number): number {
    const e = this.e;
    const r = this.rng.float();
    const flowers = e.season === 0 ? 0.24 : e.season === 1 ? 0.18 : 0.05;
    if (r < flowers) return r < flowers * 0.25 ? B.poppy : r < flowers * 0.55 ? B.daisy : r < flowers * 0.8 ? B.bluebell : B.buttercup;
    // Ferns keep to the edge of the woods.
    const ferns = e.habitat.share(H_WOOD, x, z) > 0.1 ? 0.3 : 0.04;
    return r < flowers + ferns ? B.fern : B.tall_grass;
  }

  private bush(x: number, y: number, z: number, ripe: boolean): void {
    const key = this.key(x, y, z);
    const p = RIPEN[this.e.season] as number;
    if (p > 0) {
      if (!ripe && this.rng.chance(p)) {
        this.world.set(x, y, z, B.berry_bush + 1);
        this.ripe.add(key);
      } else if (ripe) this.ripe.add(key);
      else this.ripe.delete(key);
    } else if (ripe && this.rng.chance(0.8)) {
      // Out of season the berries drop.
      this.world.set(x, y, z, B.berry_bush);
      this.ripe.delete(key);
    } else if (!ripe) this.ripe.delete(key);
  }

  /** An animal or a forager has eaten the berries of the bush at this cell. */
  strip(x: number, y: number, z: number): void {
    if (this.world.get(x, y, z) === B.berry_bush + 1) this.world.set(x, y, z, B.berry_bush);
    this.ripe.delete(this.key(x, y, z));
  }

  /** The ripe bush nearest to a point within `radius`, written to `out` as its cell. False when none is known. */
  ripeNear(x: number, z: number, radius: number, out: { x: number; y: number; z: number }): boolean {
    const w = this.world;
    let best = radius * radius;
    let found = false;
    for (const key of this.ripe) {
      const bx = key % w.sx;
      const rest = (key - bx) / w.sx;
      const bz = rest % w.sz;
      const d = (bx - x) * (bx - x) + (bz - z) * (bz - z);
      if (d >= best) continue;
      const by = (rest - bz) / w.sz;
      if (w.get(bx, by, bz) !== B.berry_bush + 1) {
        // Someone else picked it since it was last seen.
        this.ripe.delete(key);
        continue;
      }
      best = d;
      out.x = bx;
      out.y = by;
      out.z = bz;
      found = true;
    }
    return found;
  }

  private mushroom(x: number, y: number, z: number, share: number): void {
    const e = this.e;
    if (e.season !== AUTUMN || this.rng.float() >= MUSHROOM * share * (0.4 + 0.6 * e.wetness)) return;
    const w = this.world;
    for (let dz = -1; dz <= 1; dz++) {
      for (let dx = -1; dx <= 1; dx++) {
        const s = w.get(x + dx, y, z + dz);
        if (s === B.mushroom_brown || s === B.mushroom_red) return;
      }
    }
    w.set(x, y, z, this.rng.chance(0.75) ? B.mushroom_brown : B.mushroom_red);
  }

  /** A crown block may drop a seed onto open ground nearby, where it stands as a sapling. */
  private dropSeed(x: number, z: number, leaf: number): void {
    const e = this.e;
    const p = SEEDING[e.season] as number;
    if (p <= 0 || this.rng.float() >= p) return;
    const w = this.world;
    const tx = x + this.rng.intRange(-SEED_REACH, SEED_REACH);
    const tz = z + this.rng.intRange(-SEED_REACH, SEED_REACH);
    if (tx < 3 || tz < 3 || tx >= w.sx - 3 || tz >= w.sz - 3) return;
    const ty = w.height(tx, tz);
    const ground = w.get(tx, ty - 1, tz);
    if (ground !== B.grass && ground !== B.forest_floor) return;
    const c = w.get(tx, ty, tz);
    if (c !== B.air && !(FOOD[c] & FOOD_GRASS)) return;
    if (e.habitat.inAvoid(tx, tz)) return;
    // Felled woodland regrows on its own soil; onto grass the woods may only creep a little, so meadows stay meadows.
    if (ground === B.grass && (e.habitat.total[H_WOOD] as number) > this.woodLimit) return;
    if (!this.clearForTree(tx, ty, tz)) return;
    const species: TreeSpecies = leaf === B.birch_leaves ? 'birch' : leaf === B.pine_leaves ? 'pine' : 'oak';
    w.set(tx, ty, tz, SAPLING_OF[species]);
    this.saplings.set(this.key(tx, ty, tz), e.day);
    this.seeded++;
  }

  /**
   * A tree may stand here only with no trunk or sapling within two blocks,
   * and nothing built, sown or paved within three: the village keeps its
   * fields, paths and walls clear of the woods.
   */
  private clearForTree(x: number, y: number, z: number, spaced = true): boolean {
    const w = this.world;
    for (let dz = -3; dz <= 3; dz++) {
      for (let dx = -3; dx <= 3; dx++) {
        const cx = x + dx;
        const cz = z + dz;
        const s = w.get(cx, y, cz);
        if (spaced && Math.abs(dx) <= 2 && Math.abs(dz) <= 2 && (dx !== 0 || dz !== 0)) {
          if (IS_LOG[s] || IS_LOG[w.get(cx, y + 1, cz)] || speciesOfSapling(s)) return false;
        }
        if (SHAPE[s] === SHAPE_CROP) return false;
        if (SOLID[s] && !NATURAL[s] && !IS_LEAVES[s]) return false;
        let g = w.get(cx, y - 1, cz);
        if (g === B.air) g = w.get(cx, y - 2, cz);
        if (g === B.path || g === B.farmland || g === B.farmland + 1) return false;
        if (SOLID[g] && !NATURAL[g] && !IS_LEAVES[g]) return false;
      }
    }
    return true;
  }

  private roomToGrow(x: number, y: number, z: number): boolean {
    const w = this.world;
    for (let dz = -2; dz <= 2; dz++) {
      for (let dx = -2; dx <= 2; dx++) {
        if (dx === 0 && dz === 0) continue;
        for (let dy = 0; dy <= 3; dy++) if (IS_LOG[w.get(x + dx, y + dy, z + dz)]) return false;
      }
    }
    return true;
  }

  /**
   * Look over the saplings and make a tree of the first that has stood its
   * days and has room and sky. Returns true if one grew, so there may be more
   * waiting; false once all have been looked at.
   */
  private growSapling(): boolean {
    const e = this.e;
    const w = this.world;
    for (const [key, since] of this.saplings) {
      const x = key % w.sx;
      const rest = (key - x) / w.sx;
      const z = rest % w.sz;
      const y = (rest - z) / w.sz;
      const species = speciesOfSapling(w.get(x, y, z));
      if (!species) {
        this.saplings.delete(key);
        continue;
      }
      const age = e.day - since;
      // Three to five days, fixed for each sapling by where it stands.
      if (age < SAPLING_DAYS + (hash32(key) % 3) || e.season === WINTER) continue;
      if (w.exposed(x, y, z) && w.skyLight(x, y, z) >= SAPLING_LIGHT && this.roomToGrow(x, y, z)) {
        // Not while an animal is standing, or a bird perched, where the trunk and crown will be: a big oak's
        // limbs carry leaves five blocks out from the trunk. Nor while a villager or the player is: a tree
        // once grew round whoever stood by the sapling.
        if (e.hash.nearest(x + 0.5, z + 0.5, 7, this.inTheWay, null, -1) || e.personNear(x + 0.5, y, z + 0.5, 7)) continue;
        // Nor ever beside something built. Seeds do not fall there, but a sapling planted by hand against a
        // house did become a tree, and its crown filled the rooms with leaves. Such a sapling stands its
        // fortnight and dies, as one in deep shade does. (Other trunks near it are `roomToGrow`'s business.)
        if (!this.clearForTree(x, y, z, false)) {
          if (age > SAPLING_GIVE_UP) this.wither(key, x, y, z);
          continue;
        }
        if (growTree(w, x, y, z, species, this.rng)) {
          this.saplings.delete(key);
          this.treesGrown++;
          return true;
        }
      }
      if (age > SAPLING_GIVE_UP) this.wither(key, x, y, z);
    }
    return false;
  }

  /** Shaded out, crowded or hemmed in by what is built: the sapling never made a tree. */
  private wither(key: number, x: number, y: number, z: number): void {
    this.world.set(x, y, z, B.air);
    this.saplings.delete(key);
    this.saplingsLost++;
  }
}
