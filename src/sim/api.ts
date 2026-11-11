// Contracts between the world, the simulations and the renderer. The village
// and wildlife simulations are headless: they read the voxel world, the clock
// and the weather, change blocks through the world, and expose their creatures
// as plain `EntityView`s for the renderer to draw. Nothing in src/sim may import
// from src/render, src/ui or the DOM.

import type { Rng } from '../core/rng';
import { B, IS_LEAVES, IS_LOG, isBed, isDoor } from '../world/blocks';
import { isStandable } from '../world/walk';
import type { World } from '../world/world';
import type { Clock } from './clock';
import type { WeatherView } from './weather';

// ---------------------------------------------------------------------------
// Entities, as the renderer and the inspector see them
// ---------------------------------------------------------------------------

export const ENTITY_KINDS = [
  'villager', 'child', 'sheep', 'cow', 'chicken', 'deer', 'rabbit', 'fox', 'wolf', 'boar',
  'songbird', 'crow', 'gull', 'duck', 'fish',
] as const;
export type EntityKind = (typeof ENTITY_KINDS)[number];

export const ANIM_STATES = [
  'idle', 'walk', 'run', 'work', 'eat', 'sleep', 'sit', 'talk', 'swim', 'fly', 'glide', 'dead',
] as const;
export type AnimState = (typeof ANIM_STATES)[number];

export interface EntityView {
  /** Unique across all simulations for the life of the world. Village ids are below 100000; wildlife ids start there. */
  id: number;
  kind: EntityKind;
  /** Appearance seed, stable for life: picks build, colours, hat. */
  look: number;
  /** For villagers: index into the village simulation's profession list. Otherwise 0. */
  role: number;
  /** Feet position in world coordinates (block units). */
  x: number;
  y: number;
  z: number;
  /** Heading in radians: 0 faces +z (south), PI/2 faces +x (east). */
  yaw: number;
  anim: AnimState;
  /** Seconds of animation phase, advanced by the simulation so a gait matches the ground covered. */
  animTime: number;
  /** 1 for an adult; young animals and children are smaller. */
  scale: number;
  /** Item id carried in the hands, or -1. */
  held: number;
  /** A short line shown above the head while it is set, or ''. */
  bubble: string;
}

/** What the inspector panel shows for one entity. */
export interface InspectInfo {
  title: string;
  subtitle: string;
  /** Free text lines: current activity, thoughts, purse, home, workplace. */
  lines: string[];
  /** Named levels in 0..1: hunger, energy, health and so on. */
  bars: { label: string; value: number }[];
}

// ---------------------------------------------------------------------------
// Cross-simulation services (each is optional so a simulation runs alone in tests)
// ---------------------------------------------------------------------------

/** Implemented by the wildlife simulation; used by hunters and fishers. */
export interface WildlifeApi {
  /** Nearest living wild animal of one of these kinds within `radius` blocks, or null. */
  findAnimal(x: number, z: number, radius: number, kinds: readonly EntityKind[]): EntityView | null;
  /** Kill an animal a hunter has reached. Returns what it yields, or null if it is gone. */
  harvest(id: number): { meat: number; hide: number } | null;
  /** How good the fishing is near a spot, 0 (fished out) .. 1 (teeming). */
  fishAbundance(x: number, z: number): number;
  /** Try to land one fish near a spot; removes it from the stock on success. */
  catchFish(x: number, z: number): boolean;
}

/** Implemented by the village simulation; used by predators. */
export interface LivestockApi {
  /** Nearest living farm animal within `radius` blocks, or null. */
  findLivestock(x: number, z: number, radius: number): EntityView | null;
  killLivestock(id: number): void;
}

/** Side effects on the world that are richer than a single block write. */
export interface WorldActions {
  /**
   * Fell the tree whose trunk contains this log cell. Returns the number of log
   * blocks it yields (0 if the cell is not part of a tree). The headless default
   * removes the tree at once; the game replaces it with a physical collapse.
   */
  fellTree(x: number, y: number, z: number): number;
  /** A purely visual or audible cue: 'smoke', 'sparks', 'splash', 'dust', 'chop', 'hammer', 'feathers'. Safe to ignore. */
  effect(kind: string, x: number, y: number, z: number): void;
}

/** Where the player is, for creatures that flee, greet or trade. Null when there is no player (tests). */
export interface PlayerView {
  x: number;
  y: number;
  z: number;
}

export interface SimContext {
  world: World;
  clock: Clock;
  weather: WeatherView;
  /** Each simulation forks its own stream from this. */
  rng: Rng;
  actions: WorldActions;
  player: PlayerView | null;
  wildlife?: WildlifeApi;
  livestock?: LivestockApi;
  /** Living people (villagers and children), for animals that keep their distance. */
  people?: () => readonly EntityView[];
}

/** Default actions for headless runs: trees vanish when felled, effects are dropped. */
export function createBasicActions(world: World): WorldActions {
  return {
    fellTree(x, y, z) {
      if (!IS_LOG[world.get(x, y, z)]) return 0;
      // Flood through the connected trunk and canopy. Bounded so a forest of touching crowns cannot all fall at once.
      const seen = new Set<string>();
      const stack: [number, number, number][] = [[x, y, z]];
      let logs = 0;
      while (stack.length > 0 && seen.size < 600) {
        const [cx, cy, cz] = stack.pop() as [number, number, number];
        const key = `${cx},${cy},${cz}`;
        if (seen.has(key)) continue;
        const s = world.get(cx, cy, cz);
        const log = IS_LOG[s] === 1;
        if (!log && !IS_LEAVES[s]) continue;
        // Leaves only count while close to the trunk column being felled.
        if (!log && Math.abs(cx - x) + Math.abs(cz - z) > 4) continue;
        seen.add(key);
        if (log) logs++;
        world.set(cx, cy, cz, B.air);
        for (let dy = -1; dy <= 1; dy++) {
          for (let dz = -1; dz <= 1; dz++) {
            for (let dx = -1; dx <= 1; dx++) {
              if (dx || dy || dz) stack.push([cx + dx, cy + dy, cz + dz]);
            }
          }
        }
      }
      return logs;
    },
    effect() {},
  };
}

// ---------------------------------------------------------------------------
// The village plan: what world generation built, described for the simulation
// ---------------------------------------------------------------------------

/** Integer block coordinates. For a standing spot, this is the cell the feet are in. */
export interface Cell {
  x: number;
  y: number;
  z: number;
}

export const BUILDING_KINDS = [
  'house', 'farm', 'mill', 'bakery', 'tavern', 'smithy', 'carpenter', 'weaver', 'store', 'chapel', 'hall',
  'fishery', 'hunter', 'woodcutter', 'mine', 'shepherd', 'guardhouse',
] as const;
export type BuildingKind = (typeof BUILDING_KINDS)[number];

export const CROPS = ['wheat', 'barley', 'turnip', 'cabbage'] as const;
export type CropName = (typeof CROPS)[number];

export interface WorkSpot {
  /** What is worked at: 'oven', 'forge', 'anvil', 'loom', 'millstone', 'workbench', 'vat', 'counter', 'cauldron', 'altar', 'desk', 'woodpile'. */
  kind: string;
  /** Where the worker stands. */
  stand: Cell;
  /** The block being worked, if there is one (lit while in use for ovens and forges). */
  block: Cell | null;
}

export interface Bed {
  /** Where the sleeper stands before lying down. */
  stand: Cell;
  /** The foot-end bed block; the sleeper lies here. */
  block: Cell;
}

export interface Building {
  id: number;
  kind: BuildingKind;
  /** "Baker's house", "The Gilded Gull". */
  name: string;
  /** Footprint, inclusive, in block coordinates. */
  x0: number;
  z0: number;
  x1: number;
  z1: number;
  /** y of the feet cell on the ground floor. */
  floorY: number;
  /** Standing cell just outside the door. */
  entry: Cell;
  /** The lower door block, or null for an open-fronted building. */
  door: Cell | null;
  beds: Bed[];
  work: WorkSpot[];
  /** Standing cells beside stools and benches, for eating, drinking and resting. */
  seats: Cell[];
  /** Standing cell beside the building's store chest, or null. */
  storage: Cell | null;
  /** Lantern blocks the occupants light at dusk and put out at bedtime. */
  lights: Cell[];
  /** Top of the chimney, where smoke rises while the hearth is in use, or null. */
  chimney: Cell | null;
}

export interface Field {
  id: number;
  /** Building id of the farm that works it. */
  owner: number;
  crop: CropName;
  /** Farmland rectangle, inclusive; `y` is the farmland block's cell and crops grow in `y + 1`. */
  x0: number;
  z0: number;
  x1: number;
  z1: number;
  y: number;
}

export interface Pen {
  id: number;
  owner: number;
  animal: 'sheep' | 'cow' | 'chicken';
  /** Fenced interior rectangle, inclusive; `y` is the feet cell. */
  x0: number;
  z0: number;
  x1: number;
  z1: number;
  y: number;
  /** The gate block and the standing cell just outside it. */
  gate: Cell;
  outside: Cell;
}

export interface Stall {
  id: number;
  /** Where the seller stands, and where a customer stands. */
  stand: Cell;
  customer: Cell;
}

export interface Area {
  x: number;
  z: number;
  radius: number;
}

export interface VillagePlan {
  name: string;
  /** A standing cell at the heart of the village square. */
  center: Cell;
  buildings: Building[];
  fields: Field[];
  pens: Pen[];
  /** Market stalls on the square. */
  stalls: Stall[];
  /** Standing cell beside the well. */
  well: Cell;
  /** Standing cells around the square where people gather and talk. */
  gathering: Cell[];
  /** Standing cells at the end of the pier, for fishing. */
  dock: Cell[];
  /** Mine entrance (standing cell) and the standing cells at the working faces. */
  mine: { entrance: Cell; faces: Cell[] } | null;
  /** Woodland the woodcutters fell and replant. */
  forest: Area;
  /** Open meadow where the shepherd grazes the flock. */
  pasture: Area;
  /** Wild country the hunter works. */
  hunting: Area;
  /** Street lantern blocks, lit at dusk. */
  lamps: Cell[];
  /** Standing cells the night watch walks between, in order. */
  patrol: Cell[];
}

/**
 * Check that a plan matches the blocks actually in the world. World generation
 * and every test fixture must pass this, so the simulation can trust the plan.
 * Returns a list of problems; empty means valid.
 */
export function validateVillagePlan(world: World, plan: VillagePlan): string[] {
  const problems: string[] = [];
  const opt = { opensGates: true };
  const stand = (c: Cell, what: string): void => {
    if (!isStandable(world, c.x, c.y, c.z, opt)) problems.push(`${what} at ${c.x},${c.y},${c.z} is not standable`);
  };
  stand(plan.center, 'centre');
  stand(plan.well, 'well');
  plan.gathering.forEach((c, i) => stand(c, `gathering[${i}]`));
  plan.dock.forEach((c, i) => stand(c, `dock[${i}]`));
  plan.patrol.forEach((c, i) => stand(c, `patrol[${i}]`));
  if (plan.mine) {
    stand(plan.mine.entrance, 'mine entrance');
    plan.mine.faces.forEach((c, i) => stand(c, `mine face[${i}]`));
  }
  const ids = new Set<number>();
  for (const b of plan.buildings) {
    const tag = `${b.kind}#${b.id}`;
    if (ids.has(b.id)) problems.push(`${tag}: duplicate building id`);
    ids.add(b.id);
    stand(b.entry, `${tag} entry`);
    if (b.door && !isDoor(world.get(b.door.x, b.door.y, b.door.z))) problems.push(`${tag}: no door block at ${b.door.x},${b.door.y},${b.door.z}`);
    b.beds.forEach((bed, i) => {
      stand(bed.stand, `${tag} bed[${i}] stand`);
      if (!isBed(world.get(bed.block.x, bed.block.y, bed.block.z))) problems.push(`${tag}: bed[${i}] is not a bed block`);
    });
    b.work.forEach((wk, i) => stand(wk.stand, `${tag} work[${i}] (${wk.kind})`));
    b.seats.forEach((c, i) => stand(c, `${tag} seat[${i}]`));
    if (b.storage) stand(b.storage, `${tag} storage`);
    b.lights.forEach((c, i) => {
      const s = world.get(c.x, c.y, c.z);
      const lantern = (s >= B.lantern && s < B.lantern + 2) || (s >= B.hanging_lantern && s < B.hanging_lantern + 2);
      if (!lantern) problems.push(`${tag}: light[${i}] at ${c.x},${c.y},${c.z} is not a lantern`);
    });
  }
  for (const f of plan.fields) {
    if (!ids.has(f.owner)) problems.push(`field#${f.id}: unknown owner ${f.owner}`);
    for (let z = f.z0; z <= f.z1; z++) {
      for (let x = f.x0; x <= f.x1; x++) {
        const s = world.get(x, f.y, z);
        if (s !== B.farmland && s !== B.farmland + 1) {
          problems.push(`field#${f.id}: ${x},${f.y},${z} is not farmland`);
          z = f.z1 + 1;
          break;
        }
      }
    }
  }
  for (const p of plan.pens) {
    if (!ids.has(p.owner)) problems.push(`pen#${p.id}: unknown owner ${p.owner}`);
    stand(p.outside, `pen#${p.id} outside gate`);
    stand({ x: p.x0, y: p.y, z: p.z0 }, `pen#${p.id} interior`);
  }
  for (const s of plan.stalls) {
    stand(s.stand, `stall#${s.id} seller`);
    stand(s.customer, `stall#${s.id} customer`);
  }
  for (const c of plan.lamps) {
    const s = world.get(c.x, c.y, c.z);
    const lantern = (s >= B.lantern && s < B.lantern + 2) || (s >= B.hanging_lantern && s < B.hanging_lantern + 2);
    if (!lantern) problems.push(`lamp at ${c.x},${c.y},${c.z} is not a lantern`);
  }
  return problems;
}
