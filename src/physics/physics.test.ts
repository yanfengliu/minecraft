import { describe, expect, it } from 'vitest';
import { Rng } from '../core/rng';
import { B, IS_LEAVES, IS_LOG, WATER_LEVEL, waterState } from '../world/blocks';
import { growTree } from '../world/gen/trees';
import { item } from '../world/items';
import { World, createFlatWorld } from '../world/world';
import { Physics, RIGID_DT, type BodyView, type PhysicsEvent, type PhysicsOptions } from './index';
import type { RigidBodies } from './rigid';

const GROUND = 31;
const TOP = GROUND + 1;

async function setup(opts: PhysicsOptions = {}, world: World = createFlatWorld(64, 64, GROUND, 96)): Promise<{ world: World; physics: Physics; events: PhysicsEvent[] }> {
  const physics = await Physics.create(world, opts);
  const events: PhysicsEvent[] = [];
  physics.events.on((e) => events.push(e));
  return { world, physics, events };
}

function run(physics: Physics, seconds: number, each?: (step: number) => void): void {
  for (let i = 0; i < Math.round(seconds / RIGID_DT); i++) {
    each?.(i);
    physics.step(RIGID_DT);
  }
}

/** The rigid-body system behind the facade, for the few tests that need a body the public calls cannot make (one that starts turned). */
const internals = (physics: Physics): RigidBodies => (physics as unknown as { rigid: RigidBodies }).rigid;

function count(world: World, pred: (state: number) => boolean, y0 = TOP, y1 = world.sy - 1): number {
  let n = 0;
  for (let y = y0; y <= y1; y++) for (let z = 0; z < world.sz; z++) for (let x = 0; x < world.sx; x++) if (pred(world.get(x, y, z))) n++;
  return n;
}

const cellsOf = (bodies: readonly BodyView[], pred: (state: number) => boolean): number =>
  bodies.reduce((n, b) => n + (b.kind === 'block' ? Number(pred(b.state)) : b.cells.filter((c) => pred(c.state)).length), 0);

describe('physics', () => {
  it('puts a block that comes to rest square to the grid back into it, and leaves a crooked one as a body', async () => {
    const { world, physics } = await setup();
    physics.spawnBlock(B.oak_log, 20.5, TOP + 1.5, 20.5);
    // One that starts turned 40 degrees about the vertical: it lands flat but not square.
    const crooked = internals(physics).create([{ dx: 0, dy: 0, dz: 0, state: B.bricks }], 30.5, TOP + 1.5, 30.5, {
      rotation: { x: 0, y: Math.sin(0.35), z: 0, w: Math.cos(0.35) },
    });
    run(physics, 2);
    expect(physics.bodies).toHaveLength(2);
    expect(world.get(20, TOP, 20)).toBe(B.air);
    run(physics, 4);
    // The log is a block of the world again; the brick is still a sleeping body.
    expect(world.get(20, TOP, 20)).toBe(B.oak_log);
    expect(physics.bodies).toHaveLength(1);
    expect(physics.bodies[0]).toBe(crooked.view);
    expect(crooked.view.sleeping).toBe(true);
    expect(world.get(30, TOP, 30)).toBe(B.air);
    physics.dispose();
  });

  it('lays a toppled log down with its grain along the ground', async () => {
    const { world, physics } = await setup();
    // Three logs end to end, lying on their side a little above the ground, as a compound turned a quarter about z.
    const s = Math.SQRT1_2;
    internals(physics).create(
      [0, 1, 2].map((dy) => ({ dx: 0, dy, dz: 0, state: B.oak_log })),
      22.5, TOP + 0.7, 24.5, { rotation: { x: 0, y: 0, z: s, w: s } },
    );
    run(physics, 6);
    expect(physics.bodies).toHaveLength(0);
    // Body +y went to world -x: the three logs lie along x, as x-axis logs.
    for (const x of [20, 21, 22]) expect(world.get(x, TOP, 24)).toBe(B.oak_log + 1);
    expect(count(world, (st) => IS_LOG[st] === 1)).toBe(3);
    physics.dispose();
  });

  it('turns the oldest sleepers into items when there are too many bodies', async () => {
    const { physics } = await setup({ maxBodies: 5 });
    const rigid = internals(physics);
    for (let i = 0; i < 12; i++) {
      rigid.create([{ dx: 0, dy: 0, dz: 0, state: B.cobble }], 12.5 + i * 3, TOP + 0.6, 30.5, { rotation: { x: 0, y: Math.sin(0.3), z: 0, w: Math.cos(0.3) } });
    }
    run(physics, 5);
    const blocks = physics.bodies.filter((b) => b.kind === 'block');
    const items = physics.bodies.filter((b) => b.kind === 'item');
    expect(blocks).toHaveLength(5);
    // The seven oldest went; the five youngest are left.
    expect(blocks.map((b) => Math.round((b.x - 12.5) / 3)).sort((a, b) => a - b)).toEqual([7, 8, 9, 10, 11]);
    expect(items.reduce((n, b) => n + b.count, 0)).toBe(7);
    expect(items.every((b) => b.item === item('cobble').id)).toBe(true);
    physics.dispose();
  });

  it('wakes a sleeping body when the block under it is dug away', async () => {
    const { world, physics } = await setup({ settleTime: 1e9 });
    world.set(20, TOP, 20, B.stone);
    world.set(20, TOP + 1, 20, B.stone);
    const id = physics.spawnBlock(B.oak_planks, 20.5, TOP + 2.6, 20.5);
    const v = physics.bodies.find((b) => b.id === id) as BodyView;
    run(physics, 3);
    expect(v.sleeping).toBe(true);
    expect(v.y).toBeCloseTo(TOP + 2.5, 1);
    world.set(20, TOP + 1, 20, B.air);
    run(physics, 3);
    expect(v.y).toBeCloseTo(TOP + 1.5, 1);
    expect(v.sleeping).toBe(true);
    physics.dispose();
  });

  it('brings a felled tree down as one body, sheds its leaves, and loses no logs', async () => {
    const { world, physics, events } = await setup();
    growTree(world, 30, TOP, 30, 'birch', new Rng(3), true);
    const logs = count(world, (s) => IS_LOG[s] === 1);
    const leaves = count(world, (s) => IS_LEAVES[s] === 1);
    physics.setPusher(28.5, TOP, 30.5, 0.3, 1.8);
    expect(physics.fellTree(30, TOP + 2, 30)).toBe(logs);
    physics.step(RIGID_DT);
    // The tree is out of the grid and is one compound body.
    expect(count(world, (s) => IS_LOG[s] === 1 || IS_LEAVES[s] === 1)).toBe(0);
    expect(physics.bodies).toHaveLength(1);
    const tree = physics.bodies[0] as BodyView;
    expect(tree.kind).toBe('compound');
    expect(tree.cells.filter((c) => IS_LOG[c.state]).length).toBe(logs - 1);
    expect(events.filter((e) => e.type === 'collapse')).toHaveLength(1);
    const startX = tree.x;
    let shedAt = -1;
    run(physics, 20, (i) => {
      if (shedAt < 0 && events.some((e) => e.type === 'burst')) shedAt = i;
    });
    // It went over away from the player (who stood on its -x side), and the crown came off when it hit.
    const bursts = events.filter((e) => e.type === 'burst').length;
    expect(bursts).toBe(leaves);
    expect(shedAt).toBeGreaterThan(20);
    // Every log is somewhere: back in the grid lying down, still a body, or an item.
    const inGrid = count(world, (s) => IS_LOG[s] === 1);
    const inBodies = cellsOf(physics.bodies, (s) => IS_LOG[s] === 1);
    const asItems = physics.bodies.filter((b) => b.kind === 'item').reduce((n, b) => n + b.count, 0);
    expect(inGrid + inBodies + asItems).toBe(logs - 1);
    let farthest = startX;
    for (let x = 0; x < world.sx; x++) for (let z = 26; z < 35; z++) for (let y = TOP; y < TOP + 3; y++) if (IS_LOG[world.get(x, y, z)]) farthest = Math.max(farthest, x);
    for (const b of physics.bodies) farthest = Math.max(farthest, b.x);
    expect(farthest).toBeGreaterThan(startX + 2);
    console.log(`physics tree: ${logs} logs and ${leaves} leaves; leaves shed ${(shedAt * RIGID_DT).toFixed(2)} s after the cut; after 20 s ${inGrid} logs lie in the grid, ${inBodies} are in bodies, ${asItems} are items; it fell toward +x as far as x = ${farthest.toFixed(1)}`);
    physics.dispose();
  });

  it('drops an undermined slab as chunks that break on landing, losing no blocks', async () => {
    const { world, physics, events } = await setup({ cantilever: false });
    // A 9 x 6 brick slab twelve blocks up on one pillar.
    for (let z = 20; z < 26; z++) for (let x = 20; x < 29; x++) world.setRaw(x, TOP + 12, z, B.bricks);
    for (let y = TOP; y < TOP + 12; y++) world.setRaw(24, y, 23, B.cobble);
    world.set(24, TOP + 5, 23, B.air);
    physics.step(RIGID_DT);
    const total = 54 + 6;
    // The slab and the stub of pillar hanging from it came away; the lower half of the pillar stands.
    expect(count(world, (s) => s === B.bricks)).toBe(0);
    expect(count(world, (s) => s === B.cobble)).toBe(5);
    const piecesAtStart = physics.bodies.length;
    expect(piecesAtStart).toBeGreaterThanOrEqual(2);
    expect(cellsOf(physics.bodies, (s) => s === B.bricks || s === B.cobble)).toBe(total);
    let most = piecesAtStart;
    run(physics, 12, () => {
      most = Math.max(most, physics.bodies.filter((b) => b.kind !== 'item').length);
    });
    // Twelve metres is a hard landing: the chunks broke up.
    expect(most).toBeGreaterThan(piecesAtStart);
    expect(events.some((e) => e.type === 'impact')).toBe(true);
    const inGrid = count(world, (s) => s === B.bricks || s === B.cobble) - 5;
    const inBodies = cellsOf(physics.bodies, (s) => s === B.bricks || s === B.cobble);
    const asItems = physics.bodies.filter((b) => b.kind === 'item').reduce((n, b) => n + b.count, 0);
    expect(inGrid + inBodies + asItems).toBe(total);
    console.log(`physics collapse: ${total} blocks left as ${piecesAtStart} pieces, were ${most} bodies at most; after 12 s ${inGrid} are back in the grid, ${inBodies} in bodies, ${asItems} items`);
    physics.dispose();
  });

  it('runs sand, water and a floating block together through the facade', async () => {
    const { world, physics, events } = await setup({ settleTime: 1e9 });
    // A dry stone basin with a plank lying in it, and a tank of water beside it.
    for (let y = TOP; y <= TOP + 2; y++) {
      for (let z = 20; z <= 26; z++) {
        for (let x = 20; x <= 32; x++) {
          const wall = x === 20 || x === 32 || z === 20 || z === 26 || x === 26;
          if (wall) world.setRaw(x, y, z, B.stone);
          else if (x < 26) world.setRaw(x, y, z, waterState(16));
        }
      }
    }
    const plankId = physics.spawnBlock(B.oak_planks, 29.5, TOP + 0.5, 23.5);
    const plank = physics.bodies.find((b) => b.id === plankId) as BodyView;
    run(physics, 2);
    expect(plank.sleeping).toBe(true);
    expect(physics.stats.fluidActive).toBe(0);
    // Open the wall between them at the bottom, and drop sand into the tank.
    world.set(26, TOP, 23, B.air);
    world.set(22, TOP + 8, 23, B.sand);
    run(physics, 25);
    // The sand sank to the tank floor; the water found one level; the plank woke and floats on it.
    expect(world.get(22, TOP, 23)).toBe(B.sand);
    expect(events.some((e) => e.type === 'splash')).toBe(true);
    expect(events.some((e) => e.type === 'land')).toBe(true);
    const depth = (x: number): number => [0, 1, 2, 3].reduce((u, dy) => u + (WATER_LEVEL[world.get(x, TOP + dy, 23)] as number), 0) / 16;
    expect(Math.abs(depth(23) - depth(29))).toBeLessThan(0.2);
    expect(depth(29)).toBeGreaterThan(1);
    expect(plank.y).toBeGreaterThan(TOP + depth(29) - 0.35);
    expect(plank.y).toBeLessThan(TOP + depth(29) + 0.1);
    expect(physics.stats.falling).toBe(0);
    console.log(`physics together: water ${depth(23).toFixed(2)} and ${depth(29).toFixed(2)} blocks deep either side; plank centre ${(TOP + depth(29) - plank.y).toFixed(2)} m below the surface`);
    physics.dispose();
  });

  it('reports counts, and timings when given a clock', async () => {
    let t = 0;
    const { physics } = await setup({ now: () => (t += 0.25) });
    physics.spawnBlock(B.stone, 20.5, TOP + 3, 20.5);
    physics.spawnItem(item('bread').id, 1, 25.5, TOP + 1, 25.5);
    physics.step(RIGID_DT);
    const s = physics.stats;
    expect(s.bodies).toBe(2);
    expect(s.awakeBodies).toBe(2);
    expect(s.terrainChunks).toBeGreaterThan(0);
    // The terrain's voxel collider, and one collider per body.
    expect(s.colliders).toBe(3);
    expect(s.rigidMs).toBeGreaterThan(0);
    expect(s.stepMs).toBeGreaterThanOrEqual(s.rigidMs + s.looseMs + s.structureMs + s.fluidMs);
    // Without a clock the timings stay zero and nothing reads the time.
    const quiet = await setup();
    quiet.physics.step(RIGID_DT);
    expect(quiet.physics.stats.stepMs).toBe(0);
    physics.dispose();
    quiet.physics.dispose();
  });

  it('gives identical results for the same edits and steps', async () => {
    const signature = async (): Promise<string> => {
      const world = createFlatWorld(64, 64, GROUND, 96);
      for (let y = GROUND - 2; y <= GROUND; y++) for (let z = 40; z <= 47; z++) for (let x = 40; x <= 47; x++) world.setRaw(x, y, z, B.water_source);
      growTree(world, 20, TOP, 20, 'oak', new Rng(11), true);
      for (let z = 28; z < 33; z++) for (let x = 28; x < 34; x++) world.setRaw(x, TOP + 6, z, B.stone_bricks);
      world.setRaw(30, TOP + 5, 30, B.cobble);
      for (let y = TOP; y < TOP + 5; y++) world.setRaw(30, y, 30, B.cobble);
      const { physics, events } = await setup({ seed: 5 }, world);
      const parts: string[] = [];
      // Uneven frame times, as a real loop has.
      const frames = [1 / 60, 1 / 45, 1 / 72, 1 / 30, 1 / 60, 1 / 144];
      for (let i = 0; i < 900; i++) {
        if (i === 5) physics.fellTree(20, TOP + 1, 20);
        if (i === 10) world.set(30, TOP + 2, 30, B.air);
        if (i === 20) for (let k = 0; k < 12; k++) world.set(12, TOP + 4 + k, 40, B.sand);
        if (i === 30) for (let k = 0; k < 6; k++) physics.spawnBlock(k % 2 ? B.oak_planks : B.stone, 42.3 + k * 0.9, TOP + 4 + k, 43.2 + k * 0.4, { x: k - 2, y: 0, z: 1 });
        if (i === 40) world.set(48, GROUND, 43, B.air);
        if (i === 60) for (let k = 0; k < 8; k++) physics.spawnItem(item('stone').id, 1, 10.5 + k * 0.4, TOP + 2, 10.5);
        if (i > 100 && i < 400) physics.setPusher(8 + i * 0.02, TOP, 10.5, 0.3, 1.8);
        physics.step(frames[i % frames.length] as number);
        if (i % 150 === 149) {
          const bodies = physics.bodies.slice().sort((a, b) => a.id - b.id);
          parts.push(bodies.map((b) => `${b.id}:${b.kind}:${b.x},${b.y},${b.z},${b.qx},${b.qy},${b.qz},${b.qw},${b.sleeping},${b.count},${b.version}`).join(';'));
        }
      }
      let hash = 0;
      for (let y = GROUND - 3; y < 96; y++) for (let z = 0; z < 64; z++) for (let x = 0; x < 64; x++) hash = (Math.imul(hash, 31) + world.get(x, y, z)) | 0;
      parts.push(`world ${hash}`, `events ${events.length}`, events.map((e) => `${e.type}@${e.x},${e.y},${e.z}`).join(';'));
      physics.dispose();
      return parts.join('\n');
    };
    const a = await signature();
    const b = await signature();
    expect(a.length).toBeGreaterThan(2000);
    expect(a === b).toBe(true);
  });
});
