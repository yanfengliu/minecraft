import { describe, expect, it } from 'vitest';
import { Rng } from '../core/rng';
import { B, BLOCKS, IS_LOG, LOOSE, SOLID, allFamilies } from '../world/blocks';
import { growTree } from '../world/gen/trees';
import { ITEMS, ITEM_COUNT, dropOf } from '../world/items';
import { SECTION_VOLUME, World, createFlatWorld } from '../world/world';
import { Physics, RIGID_DT } from './index';
import { VOXEL_MASK } from './shapes';

const GROUND = 31;
const TOP = GROUND + 1;
const SIZE = 64;
const MAX_BODIES = 60;
const MAX_ITEMS = 40;

// The books. Everything solid is counted by kind: the item it is or would drop, or, for a block that drops
// nothing (leaves), its own family. A block is the same kind in the grid, in a body and as an item, so
// physics may move it between the three as it likes but may not make or lose one. Water is counted apart.
const FAMILIES = allFamilies();
const NONE = -1;
const KINDS = ITEM_COUNT + FAMILIES.length;
const KIND = Int32Array.from(BLOCKS, (b) => (b.id === B.air || b.waterLevel > 0 ? NONE : (dropOf(b.id)?.id ?? ITEM_COUNT + FAMILIES.indexOf(b.family))));
const FINITE = Uint8Array.from(BLOCKS, (b) => (b.waterSource ? 0 : b.waterLevel));
const kindName = (k: number): string => (k < ITEM_COUNT ? (ITEMS[k] as (typeof ITEMS)[number]).name : `${FAMILIES[k - ITEM_COUNT]} (drops nothing)`);

/** How many of each kind there are, as blocks in the grid, in bodies and as items, and the finite water standing in the grid. */
function census(world: World, physics: Physics): { matter: Int32Array; water: number } {
  const matter = new Int32Array(KINDS);
  let water = 0;
  const count = (state: number, n: number): void => {
    const k = KIND[state] as number;
    if (k !== NONE) matter[k] = (matter[k] as number) + n;
    else water += (FINITE[state] as number) * n;
  };
  // By state first: the grid is some hundreds of thousands of cells, and this runs a hundred times a soak.
  const states = new Int32Array(BLOCKS.length);
  for (let si = 0; si < world.sectionCount; si++) {
    const cells = world.blocks[si];
    if (!cells) states[world.uniform[si] as number] = (states[world.uniform[si] as number] as number) + SECTION_VOLUME;
    else for (let i = 0; i < cells.length; i++) states[cells[i] as number] = (states[cells[i] as number] as number) + 1;
  }
  for (let s = 1; s < states.length; s++) if (states[s] !== 0) count(s, states[s] as number);
  for (const b of physics.bodies) {
    if (b.kind === 'item') matter[b.item] = (matter[b.item] as number) + b.count;
    else if (b.kind === 'block') count(b.state, 1);
    else for (const c of b.cells) count(c.state, 1);
  }
  return { matter, water };
}

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
  const physics = await Physics.create(world, { seed, maxBodies: MAX_BODIES, maxItems: MAX_ITEMS });
  const rng = new Rng(seed * 7919);
  const placeable = [B.stone, B.oak_planks, B.sand, B.gravel, B.oak_log, B.window, B.cobble_slab, B.oak_stairs + 1, B.fence, B.bricks, B.snow, B.thatch];
  const frames = [1 / 60, 1 / 60, 1 / 50, 1 / 75, 1 / 30];
  let events = 0;
  let mostBodies = 0;
  let mostFluid = 0;
  let audits = 0;

  // What there should be of each kind: what there was, and every piece this test puts in or takes out, less
  // what physics says it destroyed (a burst) or let go (the ledger). Whatever else changes a count is a leak.
  const began = census(world, physics);
  const due = Int32Array.from(began.matter);
  const put = (kind: number, n: number): void => {
    if (kind !== NONE) due[kind] = (due[kind] as number) + n;
  };
  physics.events.on((e) => {
    events++;
    if (e.type === 'burst') put(KIND[e.state] as number, -1);
  });
  // Felling cuts one log out of the tree, somewhere physics chooses; the write says which.
  let felling = false;
  world.changed.on((c) => {
    if (felling) put(KIND[c.old] as number, -1);
  });
  const fell = (x: number, y: number, z: number): void => {
    felling = true;
    physics.fellTree(x, y, z);
    felling = false;
  };
  const gone = new Int32Array(KINDS);
  const audit = (): void => {
    audits++;
    const now = census(world, physics);
    const { water, blocksGone, itemsGone } = physics.ledger;
    const held = began.water + water.poured + water.created - water.absorbed - water.evaporated - water.lost - water.pending;
    if (now.water !== held) throw new Error(`water: ${now.water} sixteenths stand in the world and the books say ${held} (${JSON.stringify(water)})`);
    gone.fill(0);
    for (const [state, n] of blocksGone) gone[KIND[state] as number] = (gone[KIND[state] as number] as number) + n;
    for (const [id, n] of itemsGone) gone[id] = (gone[id] as number) + n;
    for (let k = 0; k < KINDS; k++) {
      const want = (due[k] as number) - (gone[k] as number);
      if (now.matter[k] !== want) throw new Error(`${kindName(k)}: ${now.matter[k]} in the world as blocks, in bodies and as items, and the books say ${want}`);
    }
  };
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
      if (roll < 30) {
        // Dig whatever is on top. Where that is water there is nothing to take: the fluid keeps it.
        const old = world.get(x, y, z);
        if (world.set(x, y, z, B.air)) put(KIND[old] as number, -1);
      } else if (roll < 50) {
        const state = rng.pick(placeable);
        if (world.set(x, y + 1, z, state)) put(KIND[state] as number, 1);
      } else if (roll < 60) physics.addWater(x, y + 1 + rng.int(4), z, 1 + rng.int(16));
      else if (roll < 75) {
        const state = rng.pick(placeable);
        physics.spawnBlock(state, x + rng.float(), y + 3 + rng.int(6), z + rng.float(), { x: rng.range(-4, 4), y: rng.range(-2, 4), z: rng.range(-4, 4) });
        put(KIND[state] as number, 1);
      } else if (roll < 88) {
        const item = rng.int(ITEM_COUNT);
        const count = 1 + rng.int(3);
        physics.spawnItem(item, count, x + 0.5, y + 2, z + 0.5, rng.chance(0.5) ? { x: rng.range(-3, 3), y: 3, z: rng.range(-3, 3) } : undefined);
        put(item, count);
      } else if (roll < 94) {
        // Fell whatever tree this column belongs to, if any.
        for (let ty = TOP; ty < TOP + 3; ty++) if (IS_LOG[world.get(x, ty, z)]) fell(x, ty, z);
        fell(34 + rng.int(4) * 7, TOP + 1, 8 + rng.int(2) * 8);
      } else for (const s of physics.collectItems(x, y + 1, z, 6)) put(s.item, -s.count);
    }
    physics.setPusher(32 + 20 * Math.sin(t * 0.3), TOP, 32 + 20 * Math.cos(t * 0.23), 0.3, 1.8);
    const dt = frames[i % frames.length] as number;
    physics.step(dt);
    t += dt;
    if (i % 4 === 0) check();
    if (i % 25 === 0) audit();
  }
  // Leave it alone for a while: everything that can come to rest should.
  for (let i = 0; i < 20 / RIGID_DT; i++) {
    physics.step(RIGID_DT);
    if (i % 10 === 0) check();
    if (i % 100 === 0) audit();
  }
  // The films the last splashes left dry over the next twenty seconds or so. After that the water is still, and costs nothing.
  for (let i = 0; i < 40 / RIGID_DT && physics.stats.fluidActive > 0; i++) physics.step(RIGID_DT);
  expect(physics.stats.fluidActive).toBe(0);
  audit();
  // No loose block is left hanging over a cell it could fall into, and nothing is still in the air.
  let hanging = 0;
  let hash = 0;
  for (let y = 1; y < world.sy; y++) {
    for (let z = 0; z < SIZE; z++) {
      for (let x = 0; x < SIZE; x++) {
        const s = world.get(x, y, z);
        hash = (Math.imul(hash, 31) + s) | 0;
        if (LOOSE[s] && !SOLID[world.get(x, y - 1, z)]) hanging++;
      }
    }
  }
  expect(hanging).toBe(0);
  expect(physics.stats.falling).toBe(0);
  // Budgets held throughout: blocks and compounds, items, and a moment's overshoot between the checks that enforce them.
  expect(mostBodies).toBeLessThan(MAX_BODIES + MAX_ITEMS + 80);
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
  const { water, blocksGone, itemsGone } = physics.ledger;
  const sum = (m: ReadonlyMap<number, number>): number => [...m.values()].reduce((a, n) => a + n, 0);
  const report = `${physics.bodies.length} bodies at the end (${solid.length} blocks and compounds, ${physics.stats.awakeBodies} awake), ${mostBodies} at most; ${events} events; fluid active set peaked at ${mostFluid}, ${physics.stats.fluidActive} at the end; ${physics.stats.terrainChunks} terrain chunks; `
    + `books balanced at ${audits} audits: water poured ${water.poured}, made ${water.created}, swallowed ${water.absorbed}, dried ${water.evaporated}, lost ${water.lost}; ${sum(blocksGone)} blocks and ${sum(itemsGone)} items let go`;
  physics.dispose();
  return { signature, report };
}

describe('physics soak', () => {
  it('survives a minute of random digging, building, pouring, throwing and felling, loses nothing, and comes to rest', async () => {
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
