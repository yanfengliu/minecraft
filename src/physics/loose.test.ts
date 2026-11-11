import { describe, expect, it } from 'vitest';
import { B, LOOSE, WATER_LEVEL, WATER_SOURCE, waterState } from '../world/blocks';
import { World, createFlatWorld } from '../world/world';
import { Fluid } from './fluid';
import { LooseBlocks, type LooseHost } from './loose';
import { RIGID_DT, type BodyView, type PhysicsEvent } from './types';

const GROUND = 31;

interface Rig {
  loose: LooseBlocks;
  fluid: Fluid;
  views: BodyView[];
  events: PhysicsEvent[];
  drops: { state: number; x: number; y: number; z: number }[];
  /** Step until nothing is falling or queued; returns the simulated seconds that took. */
  settle(maxSeconds?: number): number;
}

/** The loose-block system wired to a fluid the way the facade wires them, without rigid bodies. */
function rig(world: World, blocked: (x: number, y: number, z: number) => boolean = () => false): Rig {
  const views: BodyView[] = [];
  const events: PhysicsEvent[] = [];
  const drops: Rig['drops'] = [];
  const fluid = new Fluid(world, (e) => events.push(e));
  let id = 1;
  const host: LooseHost = {
    emit: (e) => events.push(e),
    nextId: () => id++,
    addView: (v) => views.push(v),
    removeView: (v) => views.splice(views.indexOf(v), 1),
    displace: (x, y, z) => fluid.displace(x, y, z),
    blocked,
    drop: (state, x, y, z) => drops.push({ state, x, y, z }),
  };
  const loose = new LooseBlocks(world, host);
  world.changed.on((c) => {
    if (fluid.busy) return;
    fluid.wake(c.x, c.y, c.z);
    loose.onBlockChanged(c.x, c.y, c.z, c.old, c.state);
  });
  const settle = (maxSeconds = 60): number => {
    let t = 0;
    let sinceFluid = 0;
    while (t < maxSeconds && !(loose.idle && fluid.activeCount === 0)) {
      loose.step(RIGID_DT);
      t += RIGID_DT;
      sinceFluid += RIGID_DT;
      if (sinceFluid >= 1 / 6) {
        sinceFluid -= 1 / 6;
        fluid.tick();
      }
    }
    return t;
  };
  return { loose, fluid, views, events, drops, settle };
}

function heightAbove(world: World, x: number, z: number): number {
  let h = 0;
  while (LOOSE[world.get(x, GROUND + 1 + h, z)]) h++;
  return h;
}

describe('loose blocks', () => {
  it('drops a sand block whose support is removed and lands it on the next floor', () => {
    const world = createFlatWorld(64, 64, GROUND);
    const r = rig(world);
    // Sand resting on a stone shelf five blocks up.
    world.set(20, GROUND + 5, 20, B.stone);
    world.set(20, GROUND + 6, 20, B.sand);
    r.settle();
    expect(world.get(20, GROUND + 6, 20)).toBe(B.sand);
    expect(r.views).toHaveLength(0);

    world.set(20, GROUND + 5, 20, B.air);
    r.loose.step(RIGID_DT);
    // It has left the grid and is a body the renderer can draw.
    expect(world.get(20, GROUND + 6, 20)).toBe(B.air);
    expect(r.views).toHaveLength(1);
    const view = r.views[0] as BodyView;
    expect(view.kind).toBe('block');
    expect(view.state).toBe(B.sand);
    const startY = view.y;
    for (let i = 0; i < 20; i++) r.loose.step(RIGID_DT);
    expect(view.y).toBeLessThan(startY - 0.3);
    expect(view.x).toBe(20.5);

    const seconds = 21 * RIGID_DT + r.settle();
    expect(world.get(20, GROUND + 1, 20)).toBe(B.sand);
    expect(r.views).toHaveLength(0);
    expect(r.events.filter((e) => e.type === 'land')).toHaveLength(1);
    // Five blocks under gravity take about a second: sqrt(2 * 5 / 9.81) = 1.01 s.
    expect(seconds).toBeGreaterThan(0.9);
    expect(seconds).toBeLessThan(1.3);
    console.log(`loose fall: 5 blocks in ${seconds.toFixed(2)} s`);
  });

  it('settles a dropped column into a heap no steeper than one block per block', () => {
    const world = createFlatWorld(64, 64, GROUND, 128);
    const r = rig(world);
    const count = 40;
    for (let i = 0; i < count; i++) world.set(30, GROUND + 6 + i, 30, B.sand);
    const seconds = r.settle(120);
    expect(r.loose.idle).toBe(true);
    expect(r.views).toHaveLength(0);
    let total = 0;
    let peak = 0;
    let steepest = 0;
    for (let z = 20; z <= 40; z++) {
      for (let x = 20; x <= 40; x++) {
        const h = heightAbove(world, x, z);
        total += h;
        peak = Math.max(peak, h);
        for (const [dx, dz] of [[1, 0], [0, 1]] as const) steepest = Math.max(steepest, Math.abs(h - heightAbove(world, x + dx, z + dz)));
      }
    }
    // Nothing lost, nothing left in the air, a heap rather than a tower.
    expect(total).toBe(count);
    expect(r.drops).toHaveLength(0);
    expect(steepest).toBeLessThanOrEqual(1);
    expect(peak).toBeLessThanOrEqual(5);
    expect(peak).toBeGreaterThanOrEqual(2);
    console.log(`loose heap: ${count} blocks settled in ${seconds.toFixed(1)} s, peak ${peak}, steepest step ${steepest}`);
  });

  it('sinks sand through water to the bottom and pushes the water aside', () => {
    const world = createFlatWorld(64, 64, GROUND);
    const r = rig(world);
    // A pool three deep in a pit, full to the brim with finite water.
    for (let y = GROUND - 2; y <= GROUND; y++) for (let z = 20; z <= 24; z++) for (let x = 20; x <= 24; x++) world.setRaw(x, y, z, waterState(16));
    const units = (): number => {
      let u = 0;
      for (let y = GROUND - 3; y <= GROUND + 4; y++) for (let z = 16; z <= 28; z++) for (let x = 16; x <= 28; x++) {
        const s = world.get(x, y, z);
        if (!WATER_SOURCE[s]) u += WATER_LEVEL[s] as number;
      }
      return u;
    };
    const before = units();
    world.set(22, GROUND + 6, 22, B.sand);
    const seconds = r.settle();
    expect(world.get(22, GROUND - 2, 22)).toBe(B.sand);
    expect(world.get(22, GROUND - 1, 22)).not.toBe(B.sand);
    expect(r.events.some((e) => e.type === 'splash')).toBe(true);
    // The block's own volume of water was displaced, not destroyed.
    expect(r.fluid.lost).toBe(0);
    expect(units()).toBe(before - r.fluid.evaporated);
    // Sinking three blocks at 3 m/s after a six-block drop takes well over a second.
    expect(seconds).toBeGreaterThan(1.8);
    console.log(`loose sink: reached the bottom and settled in ${seconds.toFixed(2)} s`);
  });

  it('turns a block into an item when it lands on the player', () => {
    const world = createFlatWorld(64, 64, GROUND);
    const r = rig(world, (x, y, z) => x === 10 && z === 10 && y === GROUND + 1);
    world.set(10, GROUND + 4, 10, B.gravel);
    r.settle();
    expect(world.get(10, GROUND + 1, 10)).toBe(B.air);
    expect(r.drops).toEqual([{ state: B.gravel, x: 10.5, y: GROUND + 1.5, z: 10.5 }]);
  });

  it('bounds a cascade per step and still finishes it', () => {
    const world = createFlatWorld(64, 64, GROUND);
    const r = rig(world);
    // A wall of gravel two thick and eight high: far steeper than it can stand.
    for (let y = GROUND + 1; y <= GROUND + 8; y++) for (let x = 20; x <= 40; x++) for (let z = 30; z <= 31; z++) world.setRaw(x, y, z, B.gravel);
    // Disturb one block; the rest follow as their neighbours move.
    world.set(30, GROUND + 8, 30, B.air);
    r.loose.step(RIGID_DT);
    expect(r.loose.fallingCount).toBeLessThanOrEqual(128);
    r.settle(180);
    expect(r.loose.idle).toBe(true);
    let steepest = 0;
    for (let x = 21; x <= 39; x++) for (let z = 24; z <= 37; z++) steepest = Math.max(steepest, Math.abs(heightAbove(world, x, z) - heightAbove(world, x, z + 1)));
    expect(steepest).toBeLessThanOrEqual(1);
  });
});
