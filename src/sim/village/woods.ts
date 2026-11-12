// The woodland and the people who work it. The woodcutters fell real trees,
// one at a time, carry the logs to their yard and set a sapling in each stump,
// so the forest they draw on is as large a year on as when they began.

import { B, IS_LEAVES, IS_LOG, REPLACEABLE, SOLID, isWater } from '../../world/blocks';
import { LOG_OF, SAPLING_OF, type TreeSpecies, speciesOfSapling } from '../../world/gen/trees';
import type { Cell } from '../api';
import { packCell } from '../nav';
import { act, cue, face, gaveUp, go } from './agent';
import type { Core } from './core';
import type { Economy } from './economy';
import { G, TOOLS_ITEM } from './goods';
import { type Business, PACK_JOB, type Resident } from './model';
import { spotIn } from './outdoor';
import { gather, haul, toolFactor, unloadAtJob, workshop } from './work';

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

/** Logs a woodcutter expects from a tree being felled, when judging whether more are wanted. */
const LOGS_PER_TREE = 6;
/**
 * The woodland as the woodcutters know it: standing trees, and stumps waiting
 * for a sapling. A tree is one that stood in the forest when the village was
 * founded, or that has come up from a sapling since. Logs anybody sets down
 * among them are timber, not trees: no woodcutter takes an axe to a wall.
 */
export class Woods {
  private readonly core: Core;
  private readonly trees = new Map<number, Tree>();
  /** Where a sapling has just turned to wood: looked at on the next tick, when the whole tree is there to see. */
  private readonly sprouts: { x: number; y: number; z: number; species: TreeSpecies }[] = [];
  private readonly replant: { x: number; y: number; z: number; species: TreeSpecies; until: number }[] = [];
  private readonly unsubscribe: () => void;

  constructor(core: Core) {
    this.core = core;
    this.survey();
    const area = core.plan.forest;
    this.unsubscribe = core.world.changed.on((c) => {
      const species = speciesOfSapling(c.old);
      if (!species || c.state !== LOG_OF[species] || (c.x - area.x) ** 2 + (c.z - area.z) ** 2 > area.radius * area.radius) return;
      this.sprouts.push({ x: c.x, y: c.y, z: c.z, species });
    });
  }

  /** Stop listening to the world. Call when the simulation is discarded. */
  dispose(): void {
    this.unsubscribe();
  }

  /** Trees the woodcutters know of. */
  get standing(): number {
    return this.trees.size;
  }

  /** Walk the forest area column by column and note every trunk standing on the ground. Done once, at the founding. */
  private survey(): void {
    const core = this.core;
    const world = core.world;
    const area = core.plan.forest;
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
        this.trees.set(packCell(x, y + 1, z), { x, y: y + 1, z, species, claim: 0, skipUntil: 0 });
      }
    }
  }

  /**
   * A sapling grows into a whole tree at one stroke, so by the tick after it
   * turned to wood there is a trunk with its crown on top. A single log set
   * down where a sapling stood (the corner of somebody's cabin) is not that.
   */
  private grown(x: number, y: number, z: number, species: TreeSpecies): boolean {
    const world = this.core.world;
    const wood = LOG_OF[species];
    let top = y;
    while (world.get(x, top + 1, z) === wood) top++;
    return world.get(x, y, z) === wood && top > y && IS_LEAVES[world.get(x, top + 1, z)] === 1;
  }

  /** The nearest tree nobody else is felling, claimed for this resident, or null. */
  claimNearest(r: Resident): Tree | null {
    const core = this.core;
    const now = core.env.now;
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

  /** Note the trees that have just come up, and try the pending saplings; call about once a second. */
  tick(): void {
    for (const s of this.sprouts) {
      if (this.grown(s.x, s.y, s.z, s.species)) this.trees.set(packCell(s.x, s.y, s.z), { ...s, claim: 0, skipUntil: 0 });
    }
    this.sprouts.length = 0;
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
    // Fell only while the yard is short: counting what mates are already carrying or cutting, so three axes do not
    // answer one need. (A mate is cutting only while at work like this one: off on an errand, the same field
    // holds the seller being walked to.)
    let coming = 0;
    for (const w of b.workers) coming += (w.pack[G.oak_log] as number) + (w !== r && w.goal === r.goal && w.targetId > 0 ? LOGS_PER_TREE : 0);
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
