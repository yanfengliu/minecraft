// A small hand-shaped landscape for the wildlife tests: every habitat the
// ecosystem cares about within 256 blocks, so a soak can run in seconds. West
// to east it is sea, a sand shore, meadow with a pond and a short river, three
// woods (one per tree species) and a stony highland in the north-east corner.
// Built with raw writes, like world generation, then the heightmap is rebuilt.

import { clamp, smoothstep } from '../../core/math';
import { createNoise, fbm2 } from '../../core/noise';
import { Rng } from '../../core/rng';
import { B } from '../../world/blocks';
import { growTree, type TreeSpecies } from '../../world/gen/trees';
import { World } from '../../world/world';

interface Wood {
  x: number;
  z: number;
  radius: number;
  species: TreeSpecies;
}

/** Landmarks of the fixture, for tests that need to stand somewhere in particular. */
export const FIXTURE = {
  size: 256,
  height: 64,
  seaLevel: 16,
  /** Still water whose top cell is y = 17. */
  pond: { x: 118, z: 66, radius: 10 },
  highland: { x: 208, z: 48, radius: 26 },
  woods: [
    { x: 92, z: 160, radius: 30, species: 'oak' },
    { x: 170, z: 206, radius: 24, species: 'birch' },
    { x: 160, z: 118, radius: 22, species: 'pine' },
  ] as readonly Wood[],
  /** Open grass well away from the woods and the water. */
  meadow: { x: 208, z: 160 },
  /** A point on the river, between the pond and the sea. */
  river: { x: 74, z: 70 },
} as const;

const SIZE = FIXTURE.size;
const SEA = FIXTURE.seaLevel;
/** y of the top water cell of the pond; its banks are level with it. */
const POND_TOP = 17;
/** The river leaves the pond here and runs west to the sea. */
const RIVER_X1 = FIXTURE.pond.x - FIXTURE.pond.radius + 2;

/** x of the waterline at this z: a gently wavy coast. */
function shoreX(z: number): number {
  return 36 + 4 * Math.sin(z / 23) + 2 * Math.sin(z / 7.3 + 1);
}

/** z of the middle of the river at this x. */
export function fixtureRiverZ(x: number): number {
  return FIXTURE.pond.z + 7 * Math.sin((x - 40) / 13);
}

/** y of the top water cell of the river at this x: it drops two steps on its way to the sea. */
function riverTop(x: number): number {
  return x >= 86 ? POND_TOP : x >= 62 ? POND_TOP - 1 : SEA - 1;
}

export function createFixtureLandscape(seed = 1): World {
  const world = new World(SIZE, FIXTURE.height, SIZE, SEA);
  const noise = createNoise(seed);
  const rng = new Rng(seed).fork('fixture');
  world.trackDirty = false;

  const top = new Int16Array(SIZE * SIZE);
  /** Woodland ground: 1 + index of the wood this column belongs to (4 for the copse), or 0. */
  const wood = new Uint8Array(SIZE * SIZE);

  // --- terrain ---------------------------------------------------------------
  for (let z = 0; z < SIZE; z++) {
    const coast = shoreX(z);
    for (let x = 0; x < SIZE; x++) {
      const i = z * SIZE + x;
      const d = x - coast;
      const roll = fbm2(noise, x / 46, z / 46, 3);
      let h: number;
      let surface: number = B.grass;
      /** y of the top water cell in this column, or -1 when it is dry. */
      let water = -1;
      let river = false;

      if (d < 0) {
        h = Math.round(clamp(14 + d * 0.24, 5, 14));
        surface = B.sand;
        water = SEA - 1;
      } else {
        if (d < 8) {
          h = 15 + Math.floor(d / 3);
          surface = B.sand;
        } else {
          h = 18 + Math.round(roll * 2.4 + Math.min(2, (d - 8) / 60));
          if (d < 12) h = Math.min(h, 18);
        }

        // The highland: a broad dome, gentle enough to walk up, stony on top.
        const hd = Math.hypot(x - FIXTURE.highland.x, z - FIXTURE.highland.z);
        const t = smoothstep(64, FIXTURE.highland.radius, hd);
        if (t > 0) {
          const crag = fbm2(noise, x / 11 + 40, z / 11 - 17, 2);
          h += Math.round(t * 15 + t * crag * 1.6);
          if (t > 0.42) {
            const patch = fbm2(noise, x / 9 - 80, z / 9 + 31, 2);
            surface = patch > 0.42 && t < 0.9 ? B.grass : patch < -0.38 ? B.gravel : patch < -0.12 ? B.granite : B.stone;
          }
        }

        // The pond: a bowl of still water with level banks.
        const pd = Math.hypot(x - FIXTURE.pond.x, z - FIXTURE.pond.z) + fbm2(noise, x / 6, z / 6 + 99, 2) * 1.5;
        if (pd < FIXTURE.pond.radius) {
          h = POND_TOP - 1 - Math.floor(2.4 * (1 - pd / FIXTURE.pond.radius));
          surface = pd < FIXTURE.pond.radius * 0.5 ? B.clay : B.gravel;
          water = POND_TOP;
        } else if (pd < FIXTURE.pond.radius + 5) {
          h = Math.min(Math.max(h, POND_TOP), POND_TOP + Math.floor((pd - FIXTURE.pond.radius) / 2.5));
        }

        // The river: three wide, cut through meadow and beach alike.
        if (water < 0 && x <= RIVER_X1) {
          const rd = Math.abs(z - fixtureRiverZ(x));
          const level = riverTop(x);
          if (rd < 1.5) {
            h = level - (rd < 0.5 ? 2 : 1);
            surface = B.gravel;
            water = level;
            river = true;
          } else if (rd < 6) {
            // Banks step down to the water so animals can reach it, and never dip below it.
            h = Math.max(level, Math.min(h, level + Math.floor((rd - 1.5) / 1.5)));
          }
        }
      }

      if (surface === B.grass) {
        for (const [wi, w] of FIXTURE.woods.entries()) {
          const wd = Math.hypot(x - w.x, z - w.z) / w.radius + fbm2(noise, x / 14 + wi * 31, z / 14 - wi * 17, 2) * 0.22;
          if (wd < 1) wood[i] = wi + 1;
        }
        // A small mixed copse in the western meadow.
        if (Math.hypot(x - 62, z - 108) < 11 + roll * 3) wood[i] = 4;
        if (wood[i]) surface = B.forest_floor;
      }

      top[i] = h;
      const soil = surface === B.sand ? B.sand : surface === B.grass || surface === B.forest_floor ? B.dirt : B.stone;
      world.setRaw(x, 0, z, B.bedrock);
      for (let y = 1; y < h; y++) world.setRaw(x, y, z, y >= h - 3 ? soil : B.stone);
      world.setRaw(x, h, z, surface);
      if (water >= 0) {
        // River water remembers which way it runs: west, bending with the channel.
        let state: number = B.water_source;
        if (river) {
          const bend = fixtureRiverZ(x - 1) - fixtureRiverZ(x);
          state = B.river + (bend > 0.25 ? 5 : bend < -0.25 ? 3 : 4);
        }
        for (let y = h + 1; y <= water; y++) world.setRaw(x, y, z, state);
      }
    }
  }

  // --- trees -----------------------------------------------------------------
  // One tree per cell of a jittered grid keeps trunks apart without looking planted.
  const mixed: readonly TreeSpecies[] = ['oak', 'birch', 'oak'];
  for (let gz = 2; gz < SIZE - 6; gz += 5) {
    for (let gx = 2; gx < SIZE - 6; gx += 5) {
      if (!rng.chance(0.8)) continue;
      const x = gx + rng.int(4);
      const z = gz + rng.int(4);
      const which = wood[z * SIZE + x] as number;
      if (which === 0) continue;
      const species = which === 4 ? rng.pick(mixed) : (FIXTURE.woods[which - 1] as Wood).species;
      growTree(world, x, (top[z * SIZE + x] as number) + 1, z, species, rng, true);
    }
  }

  // --- plants ----------------------------------------------------------------
  const flowers = [B.poppy, B.daisy, B.bluebell, B.buttercup];
  const wooded = (x: number, z: number): boolean => (wood[clamp(z, 0, SIZE - 1) * SIZE + clamp(x, 0, SIZE - 1)] as number) !== 0;
  for (let z = 1; z < SIZE - 1; z++) {
    for (let x = 1; x < SIZE - 1; x++) {
      const h = top[z * SIZE + x] as number;
      const y = h + 1;
      if (world.get(x, y, z) !== B.air) continue;
      const ground = world.get(x, h, z);
      const r = rng.float();
      if (ground === B.forest_floor) {
        if (r < 0.07) world.setRaw(x, y, z, B.fern);
        else if (r < 0.076) world.setRaw(x, y, z, B.mushroom_brown);
        continue;
      }
      if (ground !== B.grass) {
        if (ground === B.stone && r < 0.02) world.setRaw(x, y, z, B.heather);
        continue;
      }
      // Bushes fringe the woods; a few stand out in the open.
      const edge = wooded(x + 3, z) || wooded(x - 3, z) || wooded(x, z + 3) || wooded(x, z - 3);
      if (r < (edge ? 0.035 : 0.0006)) {
        world.setRaw(x, y, z, B.berry_bush);
        continue;
      }
      // Reeds at the water's edge.
      if (isWet(world, x + 1, h, z) || isWet(world, x - 1, h, z) || isWet(world, x, h, z + 1) || isWet(world, x, h, z - 1)) {
        if (r < 0.3) world.setRaw(x, y, z, B.reeds);
        continue;
      }
      const lush = 0.5 + 0.5 * fbm2(noise, x / 19 + 7, z / 19 + 3, 2);
      if (r > 0.08 + 0.14 * lush) continue;
      const bloom = fbm2(noise, x / 13 - 50, z / 13 + 21, 2);
      const pick = rng.float();
      if (bloom > 0.3 && pick < 0.45) {
        // Each kind of flower has its own stretches of the meadow.
        const which = Math.floor(clamp(fbm2(noise, x / 31, z / 31, 1) * 1.6 + 0.5, 0, 0.999) * 4);
        world.setRaw(x, y, z, flowers[which] as number);
      } else if (pick < 0.07) world.setRaw(x, y, z, B.fern);
      else world.setRaw(x, y, z, B.tall_grass);
    }
  }

  world.recomputeHeightmap();
  world.trackDirty = true;
  return world;
}

function isWet(world: World, x: number, y: number, z: number): boolean {
  const s = world.get(x, y, z);
  return s === B.water_source || (s >= B.river && s < B.river + 8);
}
