// The trades that work out in the country: the woodcutter fells real trees
// and replants them, the miner works the faces, the fisher and the hunter draw
// on the wildlife simulation when there is one and on plain luck when there is
// not. Each falls back to work at its own building in bad weather or darkness.

import { B, IS_LEAVES, IS_LOG, OPAQUE, REPLACEABLE, SOLID, isWater } from '../../world/blocks';
import { SAPLING_OF, type TreeSpecies } from '../../world/gen/trees';
import type { Area, Cell, EntityKind, EntityView } from '../api';
import { groundLevel, packCell } from '../nav';
import { act, cue, face, feetY, gaveUp, go } from './agent';
import type { Core } from './core';
import type { Economy } from './economy';
import { G, TOOLS_ITEM } from './goods';
import { type Business, PACK_JOB, type Resident } from './model';
import { FULL, gather, haul, toolFactor, unloadAtJob, workshop } from './work';

interface Tree {
  x: number;
  y: number;
  z: number;
  species: TreeSpecies;
  /** Resident on their way to fell it, or 0. */
  claim: number;
  /** Clock time before which nobody tries it again after failing to reach it. */
  skipUntil: number;
}

/** What the hunter goes after. Not duck: one shot on the water cannot be fetched. */
const PREY: readonly EntityKind[] = ['rabbit', 'deer', 'boar'];
/** How far the bow carries with a fair chance, in blocks: farther than any of the game lets a person come before it runs. */
const BOW_RANGE = 21;
/** How near the hunter comes before shooting when nothing is in the way: just outside where a deer takes fright. */
const BOW_STAND = 17.5;
/** Chance of hitting standing game at no distance; it falls with the square of the range and is more than halved on the move. */
const BOW_SKILL: Partial<Record<EntityKind, number>> = { deer: 0.9, boar: 0.85, rabbit: 0.6 };
/** Longest leg of a stalk, in blocks, before looking again at where the quarry has got to. */
const STALK_LEG = 28;
/** Legs of a stalk, a miss counting as two, before the beast is given best. */
const MAX_STALK = 14;
/** Simulated seconds before the hunter goes out again after giving a beast best. */
const REST_AFTER_FAILURE = 75;
/** How far from where the hunter stands game is worth going after when the home ground is empty. */
const TRACK_RANGE = 150;
/** Simulated seconds the ground is left alone after a kill: big game, and small. */
const REST_AFTER_BIG = 150;
const REST_AFTER_SMALL = 40;
/** Logs a woodcutter expects from a tree being felled, when judging whether more are wanted. */
const LOGS_PER_TREE = 6;

/** A standable spot somewhere in an area, or null if the try lands on water or a roof. */
function spotIn(core: Core, area: Area, spread = 0.85): Cell | null {
  const a = core.rng.range(0, Math.PI * 2);
  const d = Math.sqrt(core.rng.float()) * area.radius * spread;
  const x = Math.round(area.x + Math.sin(a) * d);
  const z = Math.round(area.z + Math.cos(a) * d);
  const y = groundLevel(core.world, x, z);
  return y < 0 ? null : { x, y, z };
}

/** The woodland as the woodcutters know it: standing trees, and stumps waiting for a sapling. */
export class Woods {
  private readonly core: Core;
  private trees = new Map<number, Tree>();
  private scanAt = -Infinity;
  private readonly replant: { x: number; y: number; z: number; species: TreeSpecies; until: number }[] = [];

  constructor(core: Core) {
    this.core = core;
  }

  get standing(): number {
    return this.trees.size;
  }

  /** Walk the forest area column by column and note every trunk standing on the ground. */
  private scan(): void {
    const core = this.core;
    const world = core.world;
    const area = core.plan.forest;
    const found = new Map<number, Tree>();
    const r2 = area.radius * area.radius;
    for (let z = Math.max(0, area.z - area.radius); z <= Math.min(world.sz - 1, area.z + area.radius); z++) {
      for (let x = Math.max(0, area.x - area.radius); x <= Math.min(world.sx - 1, area.x + area.radius); x++) {
        if ((x - area.x) ** 2 + (z - area.z) ** 2 > r2) continue;
        // Down through the crown to the first thing that is neither tree nor air: the ground.
        let y = world.height(x, z) - 1;
        const floor = Math.max(1, y - 40);
        while (y > floor) {
          const s = world.get(x, y, z);
          if (SOLID[s] && !IS_LOG[s] && !IS_LEAVES[s]) break;
          y--;
        }
        const base = world.get(x, y + 1, z);
        const species: TreeSpecies | null = base === B.oak_log ? 'oak' : base === B.birch_log ? 'birch' : base === B.pine_log ? 'pine' : null;
        if (!species || !IS_LOG[world.get(x, y + 2, z)]) continue;
        const key = packCell(x, y + 1, z);
        const known = this.trees.get(key);
        found.set(key, known ?? { x, y: y + 1, z, species, claim: 0, skipUntil: 0 });
      }
    }
    this.trees = found;
    this.scanAt = core.env.now;
  }

  /** The nearest tree nobody else is felling, claimed for this resident, or null. Rescans when trees run short. */
  claimNearest(r: Resident): Tree | null {
    const core = this.core;
    const now = core.env.now;
    // Look again at dawn each day, and when the known trees are used up (saplings may have grown), but not more than hourly.
    if (now - this.scanAt > 1440 || (this.trees.size === 0 && now - this.scanAt > 60)) this.scan();
    let best: Tree | null = null;
    let bestD = Infinity;
    for (const t of this.trees.values()) {
      if (t.skipUntil > now) continue;
      if (t.claim !== 0 && t.claim !== r.id && core.residentById.get(t.claim)?.targetId === packCell(t.x, t.y, t.z)) continue;
      const d = (t.x - r.view.x) ** 2 + (t.z - r.view.z) ** 2;
      if (d < bestD) {
        bestD = d;
        best = t;
      }
    }
    if (best) best.claim = r.id;
    return best;
  }

  get(key: number): Tree | null {
    return this.trees.get(key) ?? null;
  }

  remove(key: number): void {
    this.trees.delete(key);
  }

  /** Put a sapling where a tree stood, as soon as the stump's cell is clear. */
  plant(x: number, y: number, z: number, species: TreeSpecies): void {
    this.replant.push({ x, y, z, species, until: this.core.env.now + 120 });
    this.tick();
  }

  /** Try the pending saplings; call about once a second. */
  tick(): void {
    if (this.replant.length === 0) return;
    const core = this.core;
    const world = core.world;
    for (let i = this.replant.length - 1; i >= 0; i--) {
      const p = this.replant[i] as (typeof this.replant)[number];
      const here = world.get(p.x, p.y, p.z);
      const below = world.get(p.x, p.y - 1, p.z);
      const soil = below === B.grass || below === B.dirt || below === B.forest_floor;
      if (soil && REPLACEABLE[here] && !isWater(here)) {
        world.set(p.x, p.y, p.z, SAPLING_OF[p.species]);
        core.stats.saplingsPlanted++;
        this.replant.splice(i, 1);
      } else if (!soil || core.env.now > p.until) {
        this.replant.splice(i, 1);
      }
    }
  }
}

// --- woodcutter -----------------------------------------------------------------

export function woodcutterWork(core: Core, econ: Economy, woods: Woods, r: Resident): void {
  const b = r.job as Business;
  const env = core.env;
  const outdoors = !env.bad && env.daylight > 0.3;
  if (r.packKind === PACK_JOB && r.packCount > 0 && (r.packCount >= 6 || !outdoors) && r.targetId === 0) {
    unloadAtJob(core, r);
    return;
  }
  if ((r.haul || (r.targetId === 0 && r.packCount === 0)) && haul(core, econ, r)) return;
  if (outdoors) {
    // Fell only while the yard is short: counting what mates are already carrying or cutting, so three axes do not answer one need.
    let coming = 0;
    for (const w of b.workers) coming += (w.pack[G.oak_log] as number) + (w.targetId > 0 && w !== r ? LOGS_PER_TREE : 0);
    const logs = (b.stock[G.oak_log] as number) + coming;
    const short = logs < (b.target[G.oak_log] as number) * 1.2 || (b.stock[G.firewood] as number) + logs * 4 < (b.target[G.firewood] as number);
    if ((short || r.targetId !== 0) && fell(core, econ, woods, r)) return;
  } else {
    r.targetId = 0;
    r.target = null;
  }
  if (r.packKind === PACK_JOB && r.packCount > 0) {
    unloadAtJob(core, r);
    return;
  }
  workshop(core, econ, r);
}

/** Fell a tree and replant, or gather fallen wood when no tree is left standing. Uses `r.targetId` (tree key, -1 for deadwood) and `r.target`. */
function fell(core: Core, econ: Economy, woods: Woods, r: Resident): boolean {
  const now = core.env.now;
  if (r.target && gaveUp(r, r.target)) {
    const lost = r.targetId > 0 ? woods.get(r.targetId) : null;
    if (lost) lost.skipUntil = now + 600;
    r.targetId = 0;
    r.target = null;
  }
  if (r.targetId === 0) {
    const tree = woods.claimNearest(r);
    const stand = tree ? core.standNear(tree.x, tree.y, tree.z, 2) : null;
    if (tree && stand) {
      r.targetId = packCell(tree.x, tree.y, tree.z);
      r.target = stand;
    } else {
      if (tree) tree.skipUntil = now + 600;
      const spot = spotIn(core, core.plan.forest);
      if (!spot) return false;
      r.targetId = -1;
      r.target = spot;
    }
  }
  const stand = r.target as Cell;
  r.outdoor = true;
  if (r.targetId < 0) {
    r.activity = 'Gathering fallen wood in the forest';
    if (!go(core, r, stand, true, false)) return true;
    act(core, r, 'work', 35 * toolFactor(r), TOOLS_ITEM, () => {
      gather(econ, r, G.oak_log, 3, PACK_JOB);
      r.targetId = 0;
      r.target = null;
    });
    cue(core, r, 'chop', 2.2, stand);
    return true;
  }
  const key = r.targetId;
  const tree = woods.get(key);
  if (!tree || !IS_LOG[core.world.get(tree.x, tree.y, tree.z)]) {
    // Someone else had it down first (or the player did).
    woods.remove(key);
    r.targetId = 0;
    r.target = null;
    return false;
  }
  r.activity = `Felling a${tree.species === 'oak' ? 'n' : ''} ${tree.species} in the forest`;
  if (!go(core, r, stand, true, false)) return true;
  face(r, tree);
  act(core, r, 'work', 40 * toolFactor(r), TOOLS_ITEM, () => {
    const logs = core.ctx.actions.fellTree(tree.x, tree.y, tree.z);
    if (logs > 0) {
      gather(econ, r, G.oak_log, logs, PACK_JOB);
      core.stats.treesFelled++;
      woods.plant(tree.x, tree.y, tree.z, tree.species);
    }
    woods.remove(key);
    r.targetId = 0;
    r.target = null;
  });
  cue(core, r, 'chop', 1.2, tree);
  return true;
}

// --- miner ----------------------------------------------------------------------

/** What a spell at the face may yield, with the odds of each: a day's work by three miners is a few loads, not a mountain. */
const ORES: readonly (readonly [number, number])[] = [[G.stone, 0.3], [G.coal, 0.15], [G.iron_ore, 0.15]];

export function minerWork(core: Core, econ: Economy, r: Resident): void {
  const b = r.job as Business;
  const mine = core.plan.mine;
  if (r.packKind === PACK_JOB && r.packCount >= 10) {
    unloadAtJob(core, r);
    return;
  }
  if ((r.haul || r.packCount === 0) && haul(core, econ, r)) return;
  let wanted = false;
  for (const [g] of ORES) if ((b.stock[g] as number) + (r.pack[g] as number) < (b.target[g] as number) * FULL) wanted = true;
  const cell = mine && wanted ? core.claim(r, mine.faces) : null;
  // Underground the weather does not matter; an open pit is left when it rains.
  if (cell && !(core.env.bad && core.world.exposed(cell.x, cell.y, cell.z))) {
    r.activity = 'Working a face in the mine';
    if (!go(core, r, cell)) return;
    const world = core.world;
    let rock: Cell = cell;
    for (const [dx, dz] of [[1, 0], [-1, 0], [0, 1], [0, -1]] as const) {
      if (SOLID[world.get(cell.x + dx, cell.y, cell.z + dz)]) rock = { x: cell.x + dx, y: cell.y, z: cell.z + dz };
    }
    face(r, rock);
    act(core, r, 'work', 30 * toolFactor(r), TOOLS_ITEM, () => {
      for (const [g, odds] of ORES) {
        // What the yard is full of is left in the rock.
        if ((b.stock[g] as number) + (r.pack[g] as number) < (b.target[g] as number) * FULL && core.rng.chance(odds)) gather(econ, r, g, 1, PACK_JOB);
      }
    });
    cue(core, r, 'hammer', 1.5, rock);
    return;
  }
  if (r.packKind === PACK_JOB && r.packCount > 0) {
    unloadAtJob(core, r);
    return;
  }
  workshop(core, econ, r);
}

// --- fisher ---------------------------------------------------------------------

export function fisherWork(core: Core, econ: Economy, r: Resident): void {
  const b = r.job as Business;
  const env = core.env;
  const dock = core.plan.dock;
  const outdoors = !env.bad && env.daylight > 0.25;
  if (r.packKind === PACK_JOB && r.packCount > 0 && (r.packCount >= 6 || !outdoors)) {
    unloadAtJob(core, r);
    return;
  }
  if ((r.haul || r.packCount === 0) && haul(core, econ, r)) return;
  const wanted = (b.stock[G.fish] as number) + r.packCount < (b.target[G.fish] as number) * FULL;
  const cell = outdoors && wanted && r.restUntil <= env.now ? core.claim(r, dock) : null;
  if (cell) {
    r.activity = 'Fishing from the pier';
    r.outdoor = true;
    if (!go(core, r, cell)) return;
    const world = core.world;
    for (const [dx, dz] of [[1, 0], [-1, 0], [0, 1], [0, -1]] as const) {
      if (isWater(world.get(cell.x + dx, cell.y - 1, cell.z + dz))) face(r, { x: cell.x + dx, y: cell.y, z: cell.z + dz });
    }
    act(core, r, 'work', 35, -1, () => {
      const wild = core.ctx.wildlife;
      const x = cell.x + 0.5;
      const z = cell.z + 0.5;
      if (wild ? wild.catchFish(x, z) : core.rng.chance(0.55)) {
        gather(econ, r, G.fish, 1, PACK_JOB);
        core.stats.fishCaught++;
        core.ctx.actions.effect('splash', x, cell.y - 0.2, z);
      }
      // Fished out: leave the water alone for the rest of the morning so the stock can recover.
      if (wild && wild.fishAbundance(x, z) < 0.12) r.restUntil = core.env.now + 240;
    });
    return;
  }
  if (r.packKind === PACK_JOB && r.packCount > 0) {
    unloadAtJob(core, r);
    return;
  }
  workshop(core, econ, r);
}

// --- hunter ---------------------------------------------------------------------

export function hunterWork(core: Core, econ: Economy, r: Resident): void {
  const b = r.job as Business;
  const env = core.env;
  const outdoors = !env.bad && env.daylight > 0.3;
  if (r.packKind === PACK_JOB && r.packCount > 0 && (r.packCount >= 4 || !outdoors)) {
    unloadAtJob(core, r);
    return;
  }
  if ((r.haul || (r.packCount === 0 && !r.target)) && haul(core, econ, r)) return;
  const wanted = (b.stock[G.meat] as number) + (r.pack[G.meat] as number) < (b.target[G.meat] as number) * FULL
    || (b.stock[G.hide] as number) + (r.pack[G.hide] as number) < (b.target[G.hide] as number) * FULL;
  // A kill already down is fetched whatever the light or the weather: it is not left to lie.
  if ((r.targetId > 0 || (outdoors && wanted && r.restUntil <= env.now)) && hunt(core, econ, r)) return;
  if (r.packKind === PACK_JOB && r.packCount > 0) {
    unloadAtJob(core, r);
    return;
  }
  workshop(core, econ, r);
}

/** True when nothing the eye cannot see through stands between a hunter's eye and an animal's body. */
function sightline(core: Core, from: EntityView, to: EntityView): boolean {
  const world = core.world;
  const ox = from.x;
  const oy = from.y + 1.5;
  const oz = from.z;
  const dx = to.x - ox;
  const dy = to.y + 0.5 - oy;
  const dz = to.z - oz;
  const n = Math.ceil(Math.hypot(dx, dy, dz) / 0.4);
  for (let i = 1; i < n; i++) {
    const t = i / n;
    if (OPAQUE[world.get(Math.floor(ox + dx * t), Math.floor(oy + dy * t), Math.floor(oz + dz * t))]) return false;
  }
  return true;
}

/**
 * One step of a hunt with the bow. The game runs from a person long before
 * they could lay a hand on it, so the hunter closes to bowshot, no nearer,
 * shoots, and walks to what falls. Uses `r.step` to count the legs of a stalk
 * and the arrows spent on it, and, once something is down, `r.targetId` for the
 * animal's id and `r.target` for where it lies; otherwise `r.target` is the
 * spot on the hunting ground being watched from.
 */
function hunt(core: Core, econ: Economy, r: Resident): boolean {
  const wild = core.ctx.wildlife;
  const area = core.plan.hunting;
  const v = r.view;
  r.outdoor = true;
  if (wild) {
    if (r.targetId > 0 && r.target) {
      const body = r.target;
      const id = r.targetId;
      if (gaveUp(r, body)) {
        // It fell where nobody can walk: left for the crows.
        r.targetId = 0;
        r.target = null;
        return false;
      }
      r.activity = 'Fetching the kill';
      if (!go(core, r, body, true, false)) return true;
      act(core, r, 'work', 8, TOOLS_ITEM, () => {
        r.targetId = 0;
        r.target = null;
        const got = wild.harvest(id);
        // Nothing, if it lay too long and was cleared away.
        if (!got) return;
        gather(econ, r, G.meat, got.meat, PACK_JOB);
        gather(econ, r, G.hide, got.hide, PACK_JOB);
        // The ground is left quiet after a kill, and longer after a deer than after a rabbit.
        r.restUntil = core.env.now + (got.meat >= 3 ? REST_AFTER_BIG : REST_AFTER_SMALL);
      });
      return true;
    }
    r.targetId = 0;
    // Whatever is in bowshot already; else what is on the home ground; else the nearest that can be walked to today.
    const prey = wild.findAnimal(v.x, v.z, BOW_RANGE, PREY) ?? wild.findAnimal(area.x, area.z, area.radius, PREY) ?? wild.findAnimal(v.x, v.z, TRACK_RANGE, PREY);
    if (prey) {
      const d = Math.hypot(prey.x - v.x, prey.z - v.z);
      if (d <= BOW_RANGE && sightline(core, v, prey)) {
        r.activity = `Taking aim at a ${prey.kind}`;
        v.yaw = Math.atan2(prey.x - v.x, prey.z - v.z);
        act(core, r, 'work', 3, TOOLS_ITEM, () => {
          // It may have moved, or bolted, while the bow was drawn.
          const reach = Math.hypot(prey.x - v.x, prey.z - v.z);
          const moving = prey.anim === 'run' || prey.anim === 'fly';
          const odds = reach > BOW_RANGE * 1.3 ? 0 : (BOW_SKILL[prey.kind] ?? 0.5) * (1 - 0.45 * Math.min(1, reach / BOW_RANGE) ** 2) * (moving ? 0.4 : 1);
          if (!core.rng.chance(odds) || !wild.shoot(prey.id, v.x, v.z)) {
            // A miss costs as much patience as two legs of the stalk.
            r.step += 2;
            return;
          }
          r.step = 0;
          core.stats.animalsHunted++;
          r.targetId = prey.id;
          r.target = { x: Math.floor(prey.x), y: feetY(prey.y), z: Math.floor(prey.z) };
        });
        return true;
      }
      // A beast that keeps its distance, or stands where nobody can walk, is given best for a while. (At the
      // start of a stalk a failure left over from some other errand is not this one's.)
      if (r.step === 0) r.badKey = -1;
      if (r.badKey >= 0 || ++r.step > MAX_STALK) {
        r.badKey = -1;
        r.step = 0;
        r.target = null;
        r.restUntil = core.env.now + REST_AFTER_FAILURE;
        return false;
      }
      // Close in a leg at a time, since it will have moved by the end of one: to bowshot if it is out of
      // range, and most of the way when it is in range but behind a rise or a trunk.
      const leg = Math.min(d > BOW_RANGE ? d - BOW_STAND : d * 0.6, STALK_LEG);
      const tx = Math.floor(v.x + ((prey.x - v.x) / d) * leg);
      const tz = Math.floor(v.z + ((prey.z - v.z) / d) * leg);
      const ty = groundLevel(core.world, tx, tz);
      const c: Cell = ty >= 0 ? { x: tx, y: ty, z: tz } : { x: Math.floor(prey.x), y: feetY(prey.y), z: Math.floor(prey.z) };
      r.activity = `Stalking a ${prey.kind}`;
      // Held as the target so that no delivery calls the hunter away in the middle of a stalk.
      r.target = c;
      if (!go(core, r, c, true, false)) return true;
      // Arrived and still no shot: look again on the next thought.
      act(core, r, 'idle', 1, TOOLS_ITEM);
      return true;
    }
  }
  if (r.target && gaveUp(r, r.target)) r.target = null;
  r.target ??= spotIn(core, area);
  if (!r.target) return false;
  const spot = r.target;
  r.activity = 'Out hunting';
  if (!go(core, r, spot, true, false)) return true;
  // With real animals about, wait and watch; without them, the wait itself is the hunt.
  act(core, r, 'idle', wild ? 20 : 60, TOOLS_ITEM, () => {
    r.target = null;
    if (wild || !core.rng.chance(0.45)) return;
    gather(econ, r, G.meat, 2, PACK_JOB);
    gather(econ, r, G.hide, 1, PACK_JOB);
    core.stats.animalsHunted++;
  });
  return true;
}
