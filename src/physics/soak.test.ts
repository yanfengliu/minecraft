import { describe, expect, it } from 'vitest';
import { Rng } from '../core/rng';
import { B, IS_LOG, LOOSE, REPLACEABLE } from '../world/blocks';
import { growTree } from '../world/gen/trees';
import { ITEM_COUNT } from '../world/items';
import { World, createFlatWorld } from '../world/world';
import { Physics, RIGID_DT } from './index';
import { VOXEL_MASK } from './shapes';

const GROUND = 31;
const TOP = GROUND + 1;
const SIZE = 64;

/** A small landscape with something for every system: a lake, a dune, a wood and a hut on stilts. */
function landscape(seed: number): World {
  const world = createFlatWorld(SIZE, SIZE, GROUND, 96);
  const rng = new Rng(seed);
  for (let y = GROUND - 2; y <= GROUND; y++) for (let z = 6; z <= 16; z++) for (let x = 6; x <= 18; x++) world.setRaw(x, y, z, B.water_source);
  for (let z = 40; z <= 56; z++) {
    for (let x = 6; x <= 22; x++) {
      const h = Math.max(0, 5 - Math.floor(Math.hypot(x - 14, z - 48) / 1.6));
      for (let y = TOP; y < TOP + h; y++) world.setRaw(x, y, z, rng.chance(0.3) ? B.gravel : B.sand);
    }
  }
  for (let i = 0; i < 7; i++) growTree(world, 34 + (i % 4) * 7, TOP, 8 + Math.floor(i / 4) * 8, (['oak', 'birch', 'pine'] as const)[i % 3] as 'oak', rng, true);
  for (let z = 40; z <= 47; z++) for (let x = 36; x <= 46; x++) world.setRaw(x, TOP + 3, z, B.oak_planks);
  for (const [x, z] of [[36, 40], [46, 40], [36, 47], [46, 47], [41, 43]] as const) for (let y = TOP; y < TOP + 3; y++) world.setRaw(x, y, z, B.cobble);
  for (let y = TOP + 4; y <= TOP + 6; y++) for (let x = 36; x <= 46; x++) world.setRaw(x, y, 40, x % 3 === 0 ? B.window : B.bricks);
  world.recomputeHeightmap();
  return world;
}

function surface(world: World, x: number, z: number): number {
  for (let y = world.sy - 2; y > 0; y--) if (world.get(x, y, z) !== B.air) return y;
  return 0;
}

async function soak(seed: number, seconds: number): Promise<{ signature: string; report: string }> {
  const world = landscape(seed);
  const physics = await Physics.create(world, { seed, maxBodies: 120, maxItems: 120 });
  const rng = new Rng(seed * 7919);
  const placeable = [B.stone, B.oak_planks, B.sand, B.gravel, B.oak_log, B.window, B.cobble_slab, B.oak_stairs + 1, B.fence, B.bricks, B.snow, B.thatch];
  const frames = [1 / 60, 1 / 60, 1 / 50, 1 / 75, 1 / 30];
  let events = 0;
  let mostBodies = 0;
  let mostFluid = 0;
  physics.events.on(() => events++);
  const check = (): void => {
    mostBodies = Math.max(mostBodies, physics.bodies.length);
    mostFluid = Math.max(mostFluid, physics.stats.fluidActive);
    for (const b of physics.bodies) {
      const ok = Number.isFinite(b.x + b.y + b.z + b.qx + b.qy + b.qz + b.qw) && b.y > -9 && b.y < 400 && b.x > -9 && b.x < SIZE + 9 && b.z > -9 && b.z < SIZE + 9;
      if (!ok) throw new Error(`body ${b.id} (${b.kind}) left the world or went non-finite: ${b.x}, ${b.y}, ${b.z}`);
      if (Math.abs(Math.hypot(b.qx, b.qy, b.qz, b.qw) - 1) > 1e-3) throw new Error(`body ${b.id} has a rotation that is not a unit quaternion`);
    }
  };
  let t = 0;
  for (let i = 0; t < seconds; i++) {
    if (i % 5 === 0) {
      const x = 2 + rng.int(SIZE - 4);
      const z = 2 + rng.int(SIZE - 4);
      const y = surface(world, x, z);
      const roll = rng.int(100);
      if (roll < 30) world.set(x, y, z, B.air);
      else if (roll < 50) world.set(x, y + 1, z, rng.pick(placeable));
      else if (roll < 60) physics.addWater(x, y + 1 + rng.int(4), z, 1 + rng.int(16));
      else if (roll < 75) physics.spawnBlock(rng.pick(placeable), x + rng.float(), y + 3 + rng.int(6), z + rng.float(), { x: rng.range(-4, 4), y: rng.range(-2, 4), z: rng.range(-4, 4) });
      else if (roll < 88) physics.spawnItem(rng.int(ITEM_COUNT), 1 + rng.int(3), x + 0.5, y + 2, z + 0.5, rng.chance(0.5) ? { x: rng.range(-3, 3), y: 3, z: rng.range(-3, 3) } : undefined);
      else if (roll < 94) {
        // Fell whatever tree this column belongs to, if any.
        for (let ty = TOP; ty < TOP + 3; ty++) if (IS_LOG[world.get(x, ty, z)]) physics.fellTree(x, ty, z);
        physics.fellTree(34 + rng.int(4) * 7, TOP + 1, 8 + rng.int(2) * 8);
      } else physics.collectItems(x, y + 1, z, 6);
    }
    physics.setPusher(32 + 20 * Math.sin(t * 0.3), TOP, 32 + 20 * Math.cos(t * 0.23), 0.3, 1.8);
    const dt = frames[i % frames.length] as number;
    physics.step(dt);
    t += dt;
    if (i % 4 === 0) check();
  }
  // Leave it alone for a while: everything that can come to rest should.
  for (let i = 0; i < 20 / RIGID_DT; i++) {
    physics.step(RIGID_DT);
    if (i % 10 === 0) check();
  }
  // No loose block is left hanging over a cell it could fall into, and nothing is still in the air.
  let hanging = 0;
  let hash = 0;
  for (let y = 1; y < world.sy; y++) {
    for (let z = 0; z < SIZE; z++) {
      for (let x = 0; x < SIZE; x++) {
        const s = world.get(x, y, z);
        hash = (Math.imul(hash, 31) + s) | 0;
        if (LOOSE[s] && REPLACEABLE[world.get(x, y - 1, z)]) hanging++;
      }
    }
  }
  expect(hanging).toBe(0);
  expect(physics.stats.falling).toBe(0);
  // Budgets held throughout: 120 blocks and compounds, 120 items, and a moment's overshoot between the checks that enforce them.
  expect(mostBodies).toBeLessThan(120 + 120 + 80);
  expect(physics.stats.colliders).toBeGreaterThan(0);
  const solid = physics.bodies.filter((b) => b.kind !== 'item');
  // No cube has come to rest with its centre inside a block of the ground.
  let entombed = 0;
  for (const b of solid) {
    if (b.kind === 'block' && VOXEL_MASK[b.state] === 0xff && b.sleeping && VOXEL_MASK[world.get(Math.floor(b.x), Math.floor(b.y), Math.floor(b.z))] === 0xff) entombed++;
  }
  expect(entombed).toBe(0);
  // Twenty seconds after the last disturbance nearly everything is asleep (something may still be bobbing in a puddle).
  expect(physics.stats.awakeBodies).toBeLessThanOrEqual(3);
  const bodies = physics.bodies.slice().sort((a, b) => a.id - b.id);
  const signature = `${hash}|${events}|${bodies.map((b) => `${b.id}:${b.x},${b.y},${b.z},${b.qw},${b.count}`).join(';')}`;
  const report = `${physics.bodies.length} bodies at the end (${solid.length} blocks and compounds, ${physics.stats.awakeBodies} awake), ${mostBodies} at most; ${events} events; fluid active set peaked at ${mostFluid}, ${physics.stats.fluidActive} at the end; ${physics.stats.terrainChunks} terrain chunks`;
  physics.dispose();
  return { signature, report };
}

describe('physics soak', () => {
  it('survives a minute of random digging, building, pouring, throwing and felling, and comes to rest', async () => {
    for (const seed of [1, 2, 3]) {
      const { report } = await soak(seed, 60);
      console.log(`physics soak (seed ${seed}): ${report}`);
    }
  });

  it('replays the same minute exactly', async () => {
    const a = await soak(4, 30);
    const b = await soak(4, 30);
    expect(a.signature.length).toBeGreaterThan(100);
    expect(a.signature === b.signature).toBe(true);
  });
});
