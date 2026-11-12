// World generation, start to finish: terrain maps, voxels, the village, flora,
// then the first full lighting. Runs in the generation worker at load and in
// Node for tests. Headless and deterministic for a given config.

import { LightEngine } from '../light';
import { type VillagePlan, validateVillagePlan } from '../plan';
import { isStandable } from '../walk';
import type { World } from '../world';
import { fillWorld, plantFlora } from './fill';
import { type IslandConfig, type Terrain, buildTerrain } from './terrain';

export interface IslandInfo {
  config: IslandConfig;
  /** Where the player first stands: feet position. */
  spawn: { x: number; y: number; z: number };
  village: Terrain['village'];
  lake: Terrain['lake'];
  river: Terrain['river'];
}

export interface Island {
  world: World;
  info: IslandInfo;
  plan: VillagePlan | null;
  /** Milliseconds spent in each stage, for the loading screen and for tuning. */
  timings: Record<string, number>;
}

export type VillageBuilder = (world: World, terrain: Terrain, reserved: Uint8Array) => VillagePlan | null;

/**
 * Build the island. `buildVillage` lays out and constructs the village and
 * marks the columns it claims in `reserved` (1 for ground it has made, 2 for
 * ground under a roof) so flora stays off roads, fields and buildings;
 * without it the shelf is left as open meadow.
 *
 * Throws, naming what is wrong, if the village built does not match the plan
 * returned for it: the simulation takes the plan on trust, so a fault is
 * stopped here rather than met later as a resident walking into a wall.
 */
export function generateIsland(config: IslandConfig, buildVillage?: VillageBuilder, now: () => number = () => 0): Island {
  const timings: Record<string, number> = {};
  let t0 = now();
  const lap = (name: string): void => {
    const t1 = now();
    timings[name] = t1 - t0;
    t0 = t1;
  };

  const terrain = buildTerrain(config);
  lap('terrain');
  const world = fillWorld(terrain);
  lap('fill');
  const reserved = new Uint8Array(config.sx * config.sz);
  const plan = buildVillage ? buildVillage(world, terrain, reserved) : null;
  lap('village');
  plantFlora(world, terrain, reserved);
  lap('flora');
  world.recomputeHeightmap();
  lap('heightmap');
  new LightEngine(world).computeAll();
  lap('light');
  if (plan) {
    const problems = validateVillagePlan(world, plan);
    if (problems.length > 0) {
      const shown = problems.slice(0, 8).join('; ') + (problems.length > 8 ? `; and ${problems.length - 8} more` : '');
      throw new Error(`the village generated for seed ${config.seed} on a ${config.sx} by ${config.sz} island does not match its plan: ${shown}`);
    }
    lap('validate');
  }
  world.trackDirty = true;

  // Spawn at the village centre if there is one, otherwise on the shelf.
  let sx = plan ? plan.center.x : terrain.village.x;
  let sz = plan ? plan.center.z : terrain.village.z;
  let sy = plan ? plan.center.y : world.groundY(sx, sz) + 1;
  if (!isStandable(world, sx, sy, sz)) {
    // Walk outward until there is somewhere to stand.
    search: for (let r = 1; r < 40; r++) {
      for (let dz = -r; dz <= r; dz++) {
        for (let dx = -r; dx <= r; dx++) {
          const y = world.groundY(sx + dx, sz + dz) + 1;
          if (isStandable(world, sx + dx, y, sz + dz)) {
            sx += dx;
            sz += dz;
            sy = y;
            break search;
          }
        }
      }
    }
  }

  return {
    world,
    plan,
    timings,
    info: {
      config,
      spawn: { x: sx + 0.5, y: sy, z: sz + 0.5 },
      village: terrain.village,
      lake: terrain.lake,
      river: terrain.river,
    },
  };
}
