// Turns the terrain maps into voxels: rock, soil and water, then ore veins and
// caves, then trees and ground plants. Headless and deterministic.

import { clamp } from '../../core/math';
import { fbm2 } from '../../core/noise';
import { Rng, hash2i, rand2 } from '../../core/rng';
import { B, SOLID } from '../blocks';
import { World } from '../world';
import {
  BIOME_BEACH, BIOME_FOREST, BIOME_HIGHLAND, BIOME_MEADOW, BIOME_PINE, BIOME_ROCK, BIOME_SEA, BIOME_SNOW,
  BIOME_VILLAGE, type Terrain,
} from './terrain';
import { type TreeSpecies, growTree } from './trees';

export function fillWorld(t: Terrain): World {
  const { sx, sy, sz, seaLevel, seed } = t.config;
  const world = new World(sx, sy, sz, seaLevel);
  world.trackDirty = false;
  const { height, water, flow, biome } = t;
  const detail = t.noise.detail;

  // Sections wholly below the soil and surface rock start as solid stone without allocating anything.
  for (let szi = 0; szi < world.nsz; szi++) {
    for (let sxi = 0; sxi < world.nsx; sxi++) {
      let lowest = Infinity;
      for (let lz = 0; lz < 32; lz++) {
        for (let lx = 0; lx < 32; lx++) lowest = Math.min(lowest, height[(szi * 32 + lz) * sx + sxi * 32 + lx] as number);
      }
      for (let syi = 0; syi < world.nsy && syi * 32 + 31 < lowest - 7; syi++) {
        world.uniform[world.sectionIndex(sxi, syi, szi)] = B.stone;
      }
    }
  }

  for (let z = 0; z < sz; z++) {
    for (let x = 0; x < sx; x++) {
      const i = z * sx + x;
      const h = height[i] as number;
      const w = water[i] as number;
      const b = biome[i] as number;
      const rocky = fbm2(detail, x / 17 + 90, z / 17 - 40, 2);

      let top: number = B.grass;
      let under: number = B.dirt;
      let soil = 3;
      if (b === BIOME_SEA) {
        const depth = w - h;
        const bed = fbm2(detail, x / 26 - 7, z / 26 + 19, 2);
        top = depth <= 3 ? B.sand : bed > 0.3 ? B.gravel : bed < -0.34 ? B.clay : depth > 14 && bed > 0.05 ? B.stone : B.sand;
        under = top === B.stone ? B.stone : B.sand;
        soil = 2;
      } else if (b === BIOME_BEACH) {
        top = rocky > 0.42 ? B.gravel : B.sand;
        under = B.sand;
      } else if (b === BIOME_SNOW) {
        top = B.snow;
        under = B.stone;
        soil = 1;
      } else if (b === BIOME_ROCK) {
        top = rocky > 0.12 ? B.granite : rocky < -0.36 && h < 96 ? B.gravel : B.stone;
        under = B.stone;
        soil = 0;
      } else if (b === BIOME_HIGHLAND) {
        top = rocky > 0.38 ? B.stone : B.grass;
        soil = 2;
      } else if (b === BIOME_FOREST || b === BIOME_PINE) {
        top = rand2(x, z, seed + 5) < (b === BIOME_PINE ? 0.7 : 0.45) + rocky * 0.5 ? B.forest_floor : B.grass;
      }

      // The world's floor is the bedrock `World.get` reports below y = 0, so no bedrock layer is stored.
      // In uniform-rock sections nothing needs writing: setRaw skips cells that already match.
      for (let y = 0; y <= h; y++) {
        let s: number = B.stone;
        if (y === h) s = top;
        else if (y > h - 1 - soil) s = under;
        else if (y > h - 7 && b === BIOME_ROCK && rocky > 0.05) s = B.granite;
        world.setRaw(x, y, z, s);
      }
      if (w >= 0) {
        const f = flow[i] as number;
        const ws = f >= 0 ? B.river + f : B.water_source;
        for (let y = h + 1; y <= w; y++) world.setRaw(x, y, z, ws);
      }
    }
  }

  placeOres(world, t);
  carveCaves(world, t);
  return world;
}

/** Veins as short random walks, so ore comes in lodes a miner can follow. */
function placeOres(world: World, t: Terrain): void {
  const { sx, sz, seed } = t.config;
  const rng = new Rng(seed ^ 0x0ae5);
  const veins = Math.round((sx * sz) / 420);
  for (let v = 0; v < veins; v++) {
    const coal = rng.chance(0.6);
    let x = rng.int(sx);
    let z = rng.int(sz);
    const ground = t.height[z * sx + x] as number;
    if ((t.water[z * sx + x] as number) >= 0 && rng.chance(0.8)) continue;
    let y = coal ? rng.intRange(10, Math.max(11, ground - 3)) : rng.intRange(5, Math.max(6, Math.min(ground - 6, 58)));
    const size = coal ? rng.intRange(5, 14) : rng.intRange(3, 8);
    for (let k = 0; k < size; k++) {
      if (world.inBounds(x, y, z) && world.get(x, y, z) === B.stone) world.setRaw(x, y, z, coal ? B.coal_ore : B.iron_ore);
      const d = rng.int(6);
      if (d === 0) x++;
      else if (d === 1) x--;
      else if (d === 2) y++;
      else if (d === 3) y--;
      else if (d === 4) z++;
      else z--;
    }
  }
}

/** Winding tunnels in the hills, kept clear of the sea, lake and river so nothing floods. */
function carveCaves(world: World, t: Terrain): void {
  const { sx, sz, seaLevel, seed } = t.config;
  const rng = new Rng(seed ^ 0xca7e);
  const count = Math.round((sx * sz) / 14000);
  const dry = (x: number, z: number): boolean => {
    for (let dz = -5; dz <= 5; dz += 5) {
      for (let dx = -5; dx <= 5; dx += 5) {
        const qx = clamp(x + dx, 0, sx - 1);
        const qz = clamp(z + dz, 0, sz - 1);
        if ((t.water[qz * sx + qx] as number) >= 0) return false;
      }
    }
    return true;
  };
  for (let c = 0; c < count; c++) {
    let x = rng.range(20, sx - 20);
    let z = rng.range(20, sz - 20);
    const ground = t.height[Math.floor(z) * sx + Math.floor(x)] as number;
    if (ground < seaLevel + 14) continue;
    const vd = Math.hypot(x - t.village.x, z - t.village.z);
    if (vd < t.village.radius * 1.3) continue;
    let y = rng.range(seaLevel + 4, ground - 2);
    let yaw = rng.range(0, Math.PI * 2);
    let pitch = rng.range(-0.3, 0.2);
    const length = rng.intRange(50, 160);
    for (let s = 0; s < length; s++) {
      const radius = 1.4 + 1.3 * Math.abs(Math.sin(s * 0.07 + c));
      const ix = Math.floor(x);
      const iz = Math.floor(z);
      if (ix < 6 || iz < 6 || ix >= sx - 6 || iz >= sz - 6 || y < seaLevel + 2) break;
      if (dry(ix, iz)) {
        const r = Math.ceil(radius);
        for (let dy = -r; dy <= r; dy++) {
          for (let dz = -r; dz <= r; dz++) {
            for (let dx = -r; dx <= r; dx++) {
              if (dx * dx + dy * dy * 1.6 + dz * dz > radius * radius) continue;
              const bx = ix + dx;
              const by = Math.floor(y) + dy;
              const bz = iz + dz;
              const s0 = world.get(bx, by, bz);
              if (s0 === B.stone || s0 === B.granite || s0 === B.dirt || s0 === B.coal_ore || s0 === B.iron_ore || s0 === B.grass || s0 === B.forest_floor) {
                world.setRaw(bx, by, bz, B.air);
              }
            }
          }
        }
      }
      yaw += rng.range(-0.28, 0.28);
      pitch = clamp(pitch + rng.range(-0.12, 0.12), -0.5, 0.4);
      x += Math.cos(yaw) * Math.cos(pitch) * 1.4;
      z += Math.sin(yaw) * Math.cos(pitch) * 1.4;
      y += Math.sin(pitch) * 1.4;
    }
  }
}

/** Trees and ground plants. Skips columns the village has claimed in `reserved`. */
export function plantFlora(world: World, t: Terrain, reserved: Uint8Array | null): void {
  const { sx, sz, seed } = t.config;
  const rng = new Rng(seed ^ 0xf10a);
  const patch = t.noise.patch;
  const surface = (x: number, z: number): number => {
    // Caves may have opened the ground; find the real top solid block.
    let y = t.height[z * sx + x] as number;
    while (y > 1 && !SOLID[world.get(x, y, z)]) y--;
    return y;
  };

  // Trees on a jittered grid so they never touch trunk to trunk.
  const cell = 4;
  for (let gz = 0; gz < sz; gz += cell) {
    for (let gx = 0; gx < sx; gx += cell) {
      const x = gx + (hash2i(gx, gz, seed + 1) % cell);
      const z = gz + (hash2i(gx, gz, seed + 2) % cell);
      if (x < 4 || z < 4 || x >= sx - 4 || z >= sz - 4) continue;
      const i = z * sx + x;
      if (reserved && reserved[i]) continue;
      const b = biome(t, i);
      let density = 0;
      if (b === BIOME_FOREST) density = 0.62;
      else if (b === BIOME_PINE) density = 0.6;
      else if (b === BIOME_MEADOW) density = 0.035;
      else if (b === BIOME_HIGHLAND) density = 0.05;
      else if (b === BIOME_VILLAGE) density = 0.02;
      if (density === 0 || rand2(x, z, seed + 3) > density) continue;
      const y = surface(x, z);
      const ground = world.get(x, y, z);
      if (ground !== B.grass && ground !== B.forest_floor) continue;
      let species: TreeSpecies;
      if (b === BIOME_PINE || b === BIOME_HIGHLAND) species = rand2(x, z, seed + 4) < 0.88 ? 'pine' : 'birch';
      else species = fbm2(patch, x / 60, z / 60, 2) + rand2(x, z, seed + 4) * 0.5 > 0.42 ? 'birch' : 'oak';
      growTree(world, x, y + 1, z, species, rng, true);
    }
  }

  // Ground cover.
  for (let z = 1; z < sz - 1; z++) {
    for (let x = 1; x < sx - 1; x++) {
      const i = z * sx + x;
      if (reserved && reserved[i]) continue;
      const b = biome(t, i);
      if (b === BIOME_SEA) {
        const depth = (t.water[i] as number) - (t.height[i] as number);
        const fresh = (t.flow[i] as number) >= 0 || (t.water[i] as number) > t.config.seaLevel;
        if (!fresh && depth >= 2 && depth <= 9 && rand2(x, z, seed + 20) < 0.16 + 0.2 * fbm2(patch, x / 30, z / 30, 2)) {
          const y = (t.height[i] as number) + 1;
          if (world.get(x, y, z) === B.water_source && world.get(x, y + 1, z) === B.water_source) world.setRaw(x, y, z, B.seagrass);
        } else if (fresh && (t.flow[i] as number) < 0 && rand2(x, z, seed + 21) < 0.045) {
          const y = (t.water[i] as number) + 1;
          if (world.get(x, y, z) === B.air) world.setRaw(x, y, z, B.lily_pad);
        }
        continue;
      }
      if (b === BIOME_BEACH || b === BIOME_ROCK || b === BIOME_SNOW) continue;
      const y = surface(x, z);
      const ground = world.get(x, y, z);
      if (world.get(x, y + 1, z) !== B.air) continue;
      if (ground !== B.grass && ground !== B.forest_floor) continue;
      const r = rand2(x, z, seed + 10);
      const p = fbm2(patch, x / 34, z / 34, 3);
      let plant = 0;
      // Reeds fringe fresh water.
      const nearWater = (t.water[i - 1] as number) >= 0 || (t.water[i + 1] as number) >= 0 || (t.water[i - sx] as number) >= 0 || (t.water[i + sx] as number) >= 0;
      if (nearWater && r < 0.55) plant = B.reeds;
      else if (b === BIOME_MEADOW || b === BIOME_VILLAGE) {
        if (r < 0.2 + p * 0.25) plant = B.tall_grass;
        else if (r > 0.93) {
          // Flowers drift in single-species patches.
          const q = fbm2(patch, x / 21 + 50, z / 21 - 50, 2);
          plant = q > 0.3 ? B.poppy : q > 0.08 ? B.buttercup : q > -0.12 ? B.daisy : q > -0.34 ? B.bluebell : 0;
        } else if (r > 0.921 && b === BIOME_MEADOW && p > 0.1) plant = B.berry_bush;
      } else if (b === BIOME_FOREST) {
        if (r < 0.12) plant = B.fern;
        else if (r < 0.2) plant = B.tall_grass;
        else if (r > 0.985) plant = B.mushroom_brown;
        else if (r > 0.98) plant = B.mushroom_red;
        else if (r > 0.966 && p < -0.1) plant = B.bluebell;
        else if (r > 0.956 && p > 0.2) plant = B.berry_bush;
      } else if (b === BIOME_PINE) {
        if (r < 0.14) plant = B.fern;
        else if (r > 0.985) plant = B.mushroom_brown;
      } else if (b === BIOME_HIGHLAND) {
        if (r < 0.16 + p * 0.2) plant = B.heather;
        else if (r < 0.26) plant = B.tall_grass;
      }
      if (plant) world.setRaw(x, y + 1, z, plant);
    }
  }
}

function biome(t: Terrain, i: number): number {
  return t.biome[i] as number;
}
