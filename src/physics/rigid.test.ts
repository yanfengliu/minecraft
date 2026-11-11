import { describe, expect, it } from 'vitest';
import { B, MAT } from '../world/blocks';
import { item } from '../world/items';
import { World, createFlatWorld } from '../world/world';
import { Physics, RIGID_DT, type BodyView, type PhysicsEvent, type PhysicsOptions } from './index';

const GROUND = 31;
/** Height of the top of the ground. */
const TOP = GROUND + 1;
/** Tests of motion want bodies to stay bodies, so settling into the grid is put off for good. */
const NEVER = 1e9;

async function setup(opts: PhysicsOptions = {}, world: World = createFlatWorld(64, 64, GROUND)): Promise<{ world: World; physics: Physics; events: PhysicsEvent[] }> {
  const physics = await Physics.create(world, opts);
  const events: PhysicsEvent[] = [];
  physics.events.on((e) => events.push(e));
  return { world, physics, events };
}

function run(physics: Physics, seconds: number): void {
  for (let i = 0; i < Math.round(seconds / RIGID_DT); i++) physics.step(RIGID_DT);
}

function view(physics: Physics, id: number): BodyView {
  const v = physics.bodies.find((b) => b.id === id);
  if (!v) throw new Error(`no body ${id}`);
  return v;
}

/** Angle in radians a body has turned from upright. */
const turned = (v: BodyView): number => 2 * Math.acos(Math.min(1, Math.abs(v.qw)));

describe('rigid bodies', () => {
  it('drops a cube from two metres to rest on the ground, asleep', async () => {
    const { physics, events } = await setup({ settleTime: NEVER });
    const id = physics.spawnBlock(B.stone, 20.3, TOP + 2.5, 20.7);
    const v = view(physics, id);
    expect(v.kind).toBe('block');
    expect(v.state).toBe(B.stone);
    run(physics, 0.3);
    expect(v.y).toBeLessThan(TOP + 2.2);
    expect(v.sleeping).toBe(false);
    run(physics, 3.7);
    expect(v.y).toBeGreaterThan(TOP + 0.47);
    expect(v.y).toBeLessThan(TOP + 0.53);
    expect(Math.abs(v.x - 20.3)).toBeLessThan(0.05);
    expect(turned(v)).toBeLessThan(0.02);
    expect(v.sleeping).toBe(true);
    expect(physics.stats.awakeBodies).toBe(0);
    // It hit the ground at sqrt(2 * 9.81 * 2) = 6.3 m/s: half of 2600 kg times that squared is about 51 kJ, a little more with the rebound.
    const hits = events.filter((e) => e.type === 'impact');
    expect(hits.length).toBeGreaterThanOrEqual(1);
    const first = hits[0] as Extract<PhysicsEvent, { type: 'impact' }>;
    expect(first.material).toBe(MAT.stone);
    expect(first.energy).toBeGreaterThan(40000);
    expect(first.energy).toBeLessThan(70000);
    expect(first.y).toBeLessThan(TOP + 0.2);
    console.log(`rigid drop: centre ${(v.y - TOP).toFixed(4)} m above the ground, asleep, ${hits.length} impact(s), first ${(first.energy / 1000).toFixed(1)} kJ`);
    physics.dispose();
  });

  it('keeps a stack of five standing for five seconds', async () => {
    const { physics } = await setup({ settleTime: NEVER });
    const states = [B.stone, B.oak_planks, B.bricks, B.oak_log, B.cobble];
    const ids = states.map((s, i) => physics.spawnBlock(s, 30.5, TOP + 0.5 + i * 1.002, 30.5));
    run(physics, 5);
    const views = ids.map((id) => view(physics, id));
    views.forEach((v, i) => {
      expect(Math.abs(v.y - (TOP + 0.5 + i))).toBeLessThan(0.03);
      expect(Math.hypot(v.x - 30.5, v.z - 30.5)).toBeLessThan(0.03);
      expect(turned(v)).toBeLessThan(0.03);
    });
    expect(views.every((v) => v.sleeping)).toBe(true);
    console.log(`rigid stack: heights ${views.map((v) => (v.y - TOP).toFixed(3)).join(', ')}; worst sideways drift ${Math.max(...views.map((v) => Math.hypot(v.x - 30.5, v.z - 30.5))).toFixed(4)} m`);
    physics.dispose();
  });

  it('slides over flat ground of blocks, slabs and paths without catching on a seam', async () => {
    // Expected stopping distance of a block sliding at v0 with friction mu: v0^2 / (2 mu g).
    const v0 = 9;
    const cases: { name: string; lay: (w: World) => void; surface: number; mu: number }[] = [
      { name: 'grass blocks', lay: () => {}, surface: TOP, mu: (0.6 + 0.7) / 2 },
      {
        name: 'slab floor', surface: TOP + 0.5, mu: (0.6 + 0.7) / 2,
        lay: (w) => { for (let z = 16; z < 48; z++) for (let x = 8; x < 56; x++) w.setRaw(x, TOP, z, B.cobble_slab); },
      },
      {
        // Paths are a sixteenth short of a full block, so they are separate box colliders, merged along the run.
        name: 'path', surface: TOP - 1 / 16, mu: (0.6 + 0.8) / 2,
        lay: (w) => { for (let z = 16; z < 48; z++) for (let x = 8; x < 56; x++) w.setRaw(x, GROUND, z, B.path); },
      },
    ];
    for (const c of cases) {
      const world = createFlatWorld(64, 64, GROUND);
      c.lay(world);
      const { physics } = await setup({ settleTime: NEVER }, world);
      // Each run crosses six or so cell edges. The first crosses the collision-chunk edge at x = 24; the second
      // the chunk and section edge at x = 32, with the block astride a line of seams in z all the way.
      const a = view(physics, physics.spawnBlock(B.oak_planks, 20.37, c.surface + 0.5, 30.5, { x: v0, y: 0, z: 0 }));
      const b = view(physics, physics.spawnBlock(B.oak_planks, 27.37, c.surface + 0.5, 36.0, { x: v0, y: 0, z: 0 }));
      let lift = 0;
      let spin = 0;
      for (let i = 0; i < 300; i++) {
        physics.step(RIGID_DT);
        lift = Math.max(lift, a.y - c.surface - 0.5, b.y - c.surface - 0.5);
        spin = Math.max(spin, turned(a), turned(b));
      }
      const expected = (v0 * v0) / (2 * c.mu * 9.81);
      expect(a.sleeping && b.sleeping).toBe(true);
      expect(Math.abs(a.x - 20.37 - expected)).toBeLessThan(0.2);
      expect(Math.abs(b.x - 27.37 - expected)).toBeLessThan(0.2);
      expect(Math.abs(a.z - 30.5)).toBeLessThan(0.05);
      expect(Math.abs(b.z - 36.0)).toBeLessThan(0.05);
      // A caught edge shows up as a hop or a tumble.
      expect(lift).toBeLessThan(0.01);
      expect(spin).toBeLessThan(0.02);
      console.log(`rigid slide (${c.name}): travelled ${(a.x - 20.37).toFixed(3)} and ${(b.x - 27.37).toFixed(3)} m, friction predicts ${expected.toFixed(3)}; max lift ${(lift * 1000).toFixed(2)} mm, max turn ${spin.toFixed(4)} rad`);
      physics.dispose();
    }
  });

  it('tumbles a cube down a flight of stairs', async () => {
    const world = createFlatWorld(64, 64, GROUND);
    // Eight stairs rising toward +x, five wide, on solid fill.
    for (let k = 0; k < 8; k++) {
      for (let z = 28; z <= 32; z++) {
        world.setRaw(20 + k, TOP + k, z, B.cobble_stairs + 1);
        for (let y = TOP; y < TOP + k; y++) world.setRaw(20 + k, y, z, B.cobble);
      }
    }
    const { physics } = await setup({ settleTime: NEVER }, world);
    const v = view(physics, physics.spawnBlock(B.oak_planks, 26.3, TOP + 8.5, 30.5));
    run(physics, 8);
    // From the seventh step it has come all the way down and off the bottom.
    expect(v.x).toBeLessThan(20);
    expect(v.y).toBeLessThan(TOP + 0.6);
    expect(v.sleeping).toBe(true);
    console.log(`rigid stairs: came to rest at x = ${v.x.toFixed(2)}, ${(v.y - TOP).toFixed(3)} m above the ground, having started at x = 26.3 seven steps up`);
    physics.dispose();
  });

  it('floats oak and sinks stone', async () => {
    const world = createFlatWorld(64, 64, GROUND);
    // A lake four deep, surface level with the ground.
    for (let y = GROUND - 3; y <= GROUND; y++) for (let z = 20; z <= 31; z++) for (let x = 20; x <= 31; x++) world.setRaw(x, y, z, B.water_source);
    const { physics, events } = await setup({ settleTime: NEVER }, world);
    const oak = view(physics, physics.spawnBlock(B.oak_planks, 23.5, TOP + 2.5, 25.5));
    const stone = view(physics, physics.spawnBlock(B.stone, 28.5, TOP + 2.5, 25.5));
    run(physics, 10);
    // Oak is 650 kg per cubic metre: 65% under, so its centre rides 15 cm below the surface and its top 35 cm above.
    expect(oak.y + 0.5).toBeGreaterThan(TOP + 0.2);
    expect(oak.y).toBeGreaterThan(TOP - 0.25);
    expect(oak.y).toBeLessThan(TOP - 0.05);
    // Stone goes to the bottom: the lake floor is four blocks down.
    expect(stone.y).toBeGreaterThan(TOP - 4 + 0.45);
    expect(stone.y).toBeLessThan(TOP - 4 + 0.55);
    expect(events.filter((e) => e.type === 'splash')).toHaveLength(2);
    console.log(`rigid water: oak centre ${(TOP - oak.y).toFixed(3)} m below the surface (0.15 expected), asleep ${oak.sleeping}; stone ${(TOP - stone.y).toFixed(3)} m down on the bed`);
    physics.dispose();
  });

  it('carries what floats along a river', async () => {
    const world = createFlatWorld(64, 64, GROUND);
    // A channel three wide and two deep running toward +x.
    for (let y = GROUND - 1; y <= GROUND; y++) for (let z = 29; z <= 31; z++) for (let x = 10; x <= 54; x++) world.setRaw(x, y, z, B.river);
    const { physics } = await setup({ settleTime: NEVER }, world);
    expect(physics.flowAt(20.5, GROUND + 0.5, 30.5).x).toBeCloseTo(1.5);
    const v = view(physics, physics.spawnBlock(B.oak_log, 14.5, TOP, 30.5));
    run(physics, 10);
    // The current is 1.5 m/s; after ten seconds, less the time to get up to speed, the log is well downstream.
    expect(v.x).toBeGreaterThan(14.5 + 10);
    expect(Math.abs(v.z - 30.5)).toBeLessThan(0.6);
    console.log(`rigid river: the log drifted ${(v.x - 14.5).toFixed(1)} m in 10 s`);
    physics.dispose();
  });

  it('merges items dropped together and hands them to whoever collects', async () => {
    const { physics } = await setup();
    const logs = item('oak_log').id;
    const bread = item('bread').id;
    const ids = new Set<number>();
    for (let i = 0; i < 30; i++) ids.add(physics.spawnItem(logs, 1, 20.5 + (i % 5) * 0.15, TOP + 1, 20.5 + (i % 3) * 0.15));
    // Thirty broken blocks at one spot are one body, not thirty.
    expect(ids.size).toBe(1);
    expect(physics.bodies).toHaveLength(1);
    expect((physics.bodies[0] as BodyView).count).toBe(30);
    // Thrown ones land apart and join up once they are lying together.
    for (let i = 0; i < 6; i++) physics.spawnItem(logs, 2, 22 + i * 0.5, TOP + 2, 20.5, { x: -1.5 - i * 0.3, y: 2, z: 0 });
    physics.spawnItem(bread, 3, 20.5, TOP + 1, 20.5);
    expect(physics.bodies.length).toBe(8);
    run(physics, 4);
    const items = physics.bodies.filter((b) => b.kind === 'item');
    expect(items.filter((b) => b.item === logs).length).toBeLessThanOrEqual(3);
    expect(items.filter((b) => b.item === bread)).toHaveLength(1);
    const resting = items.find((b) => b.item === logs) as BodyView;
    expect(resting.y).toBeGreaterThan(TOP + 0.12);
    expect(resting.y).toBeLessThan(TOP + 0.5);
    const before = items.length;
    // Out of reach: nothing.
    expect(physics.collectItems(40, TOP + 1, 40, 1.5)).toEqual([]);
    const got = physics.collectItems(20.5, TOP + 0.5, 20.5, 4);
    expect(got).toEqual([{ item: logs, count: 42 }, { item: bread, count: 3 }].sort((a, b) => a.item - b.item));
    expect(physics.bodies.filter((b) => b.kind === 'item')).toHaveLength(0);
    console.log(`rigid items: 36 drops became ${before} bodies; collected ${got.map((s) => `${s.count} x item ${s.item}`).join(', ')}`);
    physics.dispose();
  });

  it('despawns items after their lifetime', async () => {
    const { physics } = await setup({ itemLifetime: 2 });
    physics.spawnItem(item('coal').id, 4, 20.5, TOP + 1, 20.5);
    run(physics, 1.5);
    expect(physics.bodies).toHaveLength(1);
    run(physics, 1);
    expect(physics.bodies).toHaveLength(0);
    physics.dispose();
  });

  it('lets the player shove an item but not a boulder', async () => {
    const { physics } = await setup({ settleTime: NEVER });
    const crate = view(physics, physics.spawnItem(item('bread').id, 1, 20.5, TOP + 0.2, 20.5));
    const rock = view(physics, physics.spawnBlock(B.stone, 20.5, TOP + 0.5, 24.5));
    run(physics, 1);
    // Walk through both at 3 m/s, from -x.
    for (let i = 0; i < 120; i++) {
      const px = 17.5 + i * 3 * RIGID_DT;
      physics.setPusher(px, TOP, 20.5, 0.3, 1.8);
      physics.step(RIGID_DT);
    }
    const moved = crate.x - 20.5;
    for (let i = 0; i < 120; i++) {
      const px = 17.5 + i * 3 * RIGID_DT;
      physics.setPusher(px, TOP, 24.5, 0.3, 1.8);
      physics.step(RIGID_DT);
    }
    expect(moved).toBeGreaterThan(1);
    expect(rock.x - 20.5).toBeLessThan(0.4);
    console.log(`rigid push: walking through at 3 m/s moved the item ${moved.toFixed(2)} m and the 2600 kg stone ${(rock.x - 20.5).toFixed(3)} m`);
    physics.dispose();
  });

  it('steps two hundred awake bodies in under 4 ms', async () => {
    const times: number[] = [];
    const scenario = async (measure: boolean): Promise<void> => {
      const { physics } = await setup({ settleTime: NEVER });
      const states = [B.stone, B.oak_planks, B.bricks, B.oak_log, B.cobble, B.dirt];
      for (let i = 0; i < 200; i++) {
        const x = 8 + (i % 15) * 3.1 + ((i * 37) % 10) * 0.03;
        const z = 8 + Math.floor(i / 15) * 3.1 + ((i * 53) % 10) * 0.03;
        physics.spawnBlock(states[i % states.length] as number, x, TOP + 3 + (i % 7) * 1.3, z, { x: ((i % 5) - 2) * 0.8, y: 0, z: ((i % 3) - 1) * 0.8 });
      }
      for (let i = 0; i < 150; i++) {
        const t0 = performance.now();
        physics.step(RIGID_DT);
        const ms = performance.now() - t0;
        if (measure && physics.stats.awakeBodies === 200) times.push(ms);
      }
      physics.dispose();
    };
    await scenario(false);
    await scenario(true);
    times.sort((a, b) => a - b);
    const median = times[times.length >> 1] as number;
    expect(times.length).toBeGreaterThan(30);
    console.log(`rigid perf: ${times.length} steps with all 200 bodies awake: ${(times[0] as number).toFixed(2)} ms best, ${median.toFixed(2)} ms median, ${(times[Math.floor(times.length * 0.95)] as number).toFixed(2)} ms at the 95th percentile, ${(times[times.length - 1] as number).toFixed(2)} ms worst`);
    expect(median).toBeLessThan(4);
  });
});
