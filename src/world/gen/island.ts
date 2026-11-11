// World generation, start to finish: terrain maps, voxels, the village, flora,
// then the first full lighting. Runs in the generation worker at load and in
// Node for tests. Headless and deterministic for a given config.

import type { VillagePlan } from '../../sim/api';
import { LightEngine } from '../light';
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
 * marks the columns it claims in `reserved` so flora stays off roads, fields
 * and roofs; without it the shelf is left as open meadow.
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
