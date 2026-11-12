// Contracts between the world, the simulations and the renderer. The village
// and wildlife simulations are headless: they read the voxel world, the clock
// and the weather, change blocks through the world, and expose their creatures
// as plain `EntityView`s for the renderer to draw. Nothing in src/sim may import
// from src/render, src/ui or the DOM.

import type { Rng } from '../core/rng';
import { B, IS_LEAVES, IS_LOG } from '../world/blocks';
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
  /** True while the creature is out of sight (down a burrow, say): it is not drawn and cannot be looked at. Absent means visible. */
  hidden?: boolean;
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
  /**
   * Bring an animal down from a distance, as an arrow from (fromX, fromZ) does.
   * It dies where it is and its body lies there a few minutes for the hunter to
   * come and `harvest`; the rest of its herd run from where the shot came.
   * False if it is already gone.
   */
  shoot(id: number, fromX: number, fromZ: number): boolean;
  /**
   * Take what an animal yields: a living one the hunter has reached, which this
   * kills, or the body of one shot earlier. Either way the body is carried off.
   * Null if it is gone, or is a body nobody shot.
   */
  harvest(id: number): { meat: number; hide: number } | null;
  /** How good the fishing is near a spot, 0 (fished out) .. 1 (teeming). */
  fishAbundance(x: number, z: number): number;
  /** Try to land one fish near a spot; removes it from the stock on success. */
  catchFish(x: number, z: number): boolean;
}

/** Implemented by the village simulation; used by predators. */
export interface LivestockApi {
  /** Nearest living farm animal within `radius` blocks, or null. With `kinds`, only animals of those kinds count. */
  findLivestock(x: number, z: number, radius: number, kinds?: readonly EntityKind[]): EntityView | null;
  killLivestock(id: number): void;
}

/** Side effects on the world that are richer than a single block write. */
export interface WorldActions {
  /**
   * Fell the tree whose trunk contains this log cell. Returns the number of log
   * blocks it yields (0 if the cell is not part of a tree). The headless default
   * removes the tree at once, and the game uses that default too, adding leaves
   * and dust in the air: a villager's tree does not topple as the player's does.
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

// World generation makes the plan and is a layer below this one, so the types and the validator are
// defined in the world layer. They are part of what the simulations are built against, so they are
// exported from here too, and simulation code takes them from this file.
export {
  BUILDING_KINDS, CROPS, validateVillagePlan,
  type Area, type Bed, type Building, type BuildingKind, type Cell, type CropName, type Field, type Pen, type Stall, type VillagePlan, type WorkSpot,
} from '../world/plan';
