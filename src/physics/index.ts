// The physics layer behind one facade: finite water, loose blocks, structural
// collapse and rigid bodies, all driven by the voxel world and one `step`.
//
// Every edit to the world, by anyone, reaches the four systems through
// `World.changed`. The listener only takes notes: each system does its work
// inside `step`, so an edit made by one of them (which re-enters the listener)
// is queued like any other and nothing recurses.
//
// Headless and deterministic: no DOM, no randomness, no wall clock. The same
// sequence of edits and `step(dt)` calls gives the same world and bodies.

import RAPIER from '@dimforge/rapier3d-compat';
import { Emitter } from '../core/events';
import { LOOSE, REPLACEABLE, SOLID, STATE_COUNT } from '../world/blocks';
import type { ItemStack } from '../world/items';
import type { BlockChange, World } from '../world/world';
import type { Body } from './body';
import { Fluid } from './fluid';
import { addItem, collectItems, dropBlock } from './items';
import { LooseBlocks } from './loose';
import { RigidBodies } from './rigid';
import { toItems } from './settle';
import { Structure, type DetachedCell } from './structure';
import { FLUID_DT, RIGID_DT, type BodyView, type PhysicsEvent, type PhysicsOptions, type PhysicsStats } from './types';

export { FLUID_DT, GRAVITY, ITEM_SIZE, RIGID_DT } from './types';
export type { BodyCell, BodyKind, BodyView, PhysicsEvent, PhysicsOptions, PhysicsStats } from './types';

/** Longest stretch of real time one `step` will simulate; a longer frame is slowed down rather than caught up. */
const MAX_STEP = 0.25;
const MAX_FLUID_TICKS = 2;
/** A felled tree leans away from the player when they are this close, in blocks. */
const LEAN_RANGE = 6;

/** Per state: 1 when a change to or from it can matter to anything but the fluid. */
const MATTERS = new Uint8Array(STATE_COUNT);
for (let s = 0; s < STATE_COUNT; s++) MATTERS[s] = SOLID[s] || LOOSE[s] || !REPLACEABLE[s] ? 1 : 0;

export class Physics {
  /** Splashes, impacts, collapses, bursts and landings, for particles and sound. Emitted during `step`. */
  readonly events = new Emitter<PhysicsEvent>();
  /** One view per body in flight or at rest: rigid bodies, items and falling loose blocks. Order is not stable; the objects are. */
  readonly bodies: readonly BodyView[];
  /** Counts and timings, refreshed by every `step`. */
  readonly stats: PhysicsStats = {
    fluidActive: 0, falling: 0, bodies: 0, awakeBodies: 0, colliders: 0, terrainChunks: 0,
    fluidMs: 0, looseMs: 0, structureMs: 0, rigidMs: 0, stepMs: 0,
  };

  private readonly views: BodyView[] = [];
  private readonly fluid: Fluid;
  private readonly loose: LooseBlocks;
  private readonly structure: Structure;
  private readonly rigid: RigidBodies;
  private readonly unsubscribe: () => void;
  private readonly now: (() => number) | undefined;
  private nextBodyId = 1;
  private rigidTime = 0;
  private fluidTime = 0;
  private pusher: { x: number; y: number; z: number } | null = null;

  /** Rapier loads asynchronously, so a `Physics` is made with `await Physics.create(world)`. */
  static async create(world: World, opts: PhysicsOptions = {}): Promise<Physics> {
    await RigidBodies.init();
    return new Physics(world, opts);
  }

  private constructor(world: World, opts: PhysicsOptions) {
    this.bodies = this.views;
    this.now = opts.now;
    const emit = (e: PhysicsEvent): void => this.events.emit(e);
    const shared = {
      emit,
      nextId: (): number => this.nextBodyId++,
      addView: (v: BodyView): void => {
        this.views.push(v);
      },
      removeView: (v: BodyView): void => {
        const i = this.views.indexOf(v);
        if (i < 0) return;
        const last = this.views.pop() as BodyView;
        if (i < this.views.length) this.views[i] = last;
      },
    };
    const drop = (state: number, x: number, y: number, z: number): void => {
      if (!dropBlock(this.rigid, state, x, y, z)) emit({ type: 'burst', x, y, z, state });
    };
    this.fluid = new Fluid(world, emit, {
      seed: opts.seed, sourceRate: opts.sourceRate, evaporateTicks: opts.evaporateTicks, maxCellsPerTick: opts.maxFluidCells,
    });
    this.rigid = new RigidBodies(world, { ...shared, fluid: this.fluid }, opts);
    this.loose = new LooseBlocks(world, {
      ...shared,
      displace: (x, y, z) => this.fluid.displace(x, y, z),
      blocked: (x, y, z) => this.rigid.pusherIn(x, y, z),
      drop,
    }, { seed: opts.seed });
    this.structure = new Structure(world, {
      emit,
      detach: (cells, tree) => {
        this.rigid.createFromWorld(cells, tree, tree ? this.lean(cells) : undefined);
      },
      drop,
    }, { seed: opts.seed, pieceSize: opts.pieceSize, maxLeavesPerTree: opts.maxLeavesPerTree, cantilever: opts.cantilever });
    this.unsubscribe = world.changed.on(this.onChange);
  }

  /** Stop listening to the world and release the physics library's memory. The instance is dead afterwards. */
  dispose(): void {
    this.unsubscribe();
    this.rigid.dispose();
  }

  /**
   * Advance real time by `dt` seconds: rigid bodies and falling blocks in
   * fixed steps of 1/60 s, the fluid about six times a second, structural
   * checks as blocks are removed.
   */
  step(dt: number): void {
    if (!(dt > 0)) return;
    const now = this.now;
    const s = this.stats;
    const t0 = now ? now() : 0;
    dt = Math.min(dt, MAX_STEP);
    this.rigidTime += dt;
    this.fluidTime += dt;

    // Collapses first, so what lost its support this frame starts falling this frame.
    this.structure.step();
    const t1 = now ? now() : 0;

    let looseMs = 0;
    let rigidMs = 0;
    // The tolerance keeps sixty calls of 1/60 s at sixty substeps despite rounding.
    while (this.rigidTime >= RIGID_DT - 1e-9) {
      this.rigidTime -= RIGID_DT;
      const a = now ? now() : 0;
      this.loose.step(RIGID_DT);
      const b = now ? now() : 0;
      this.rigid.substep();
      looseMs += b - a;
      if (now) rigidMs += now() - b;
    }
    const t2 = now ? now() : 0;
    for (let ticks = 0; this.fluidTime >= FLUID_DT - 1e-9; ticks++) {
      this.fluidTime -= FLUID_DT;
      if (ticks >= MAX_FLUID_TICKS) continue;
      this.fluid.tick();
      this.rigid.fluidTicked();
    }
    const t3 = now ? now() : 0;

    s.fluidActive = this.fluid.activeCount;
    s.falling = this.loose.fallingCount;
    s.bodies = this.rigid.bodies.length;
    s.awakeBodies = this.rigid.awake;
    s.colliders = this.rigid.colliderCount;
    s.terrainChunks = this.rigid.terrain.chunkCount;
    s.structureMs = t1 - t0;
    s.looseMs = looseMs;
    s.rigidMs = rigidMs;
    s.fluidMs = t3 - t2;
    s.stepMs = t3 - t0;
  }

  /**
   * Throw a block into the world as a body. (x, y, z) is where its centre
   * starts, so a block leaving cell (cx, cy, cz) starts at cx + 0.5 and so on.
   * Returns the body id.
   */
  spawnBlock(state: number, x: number, y: number, z: number, velocity?: { x: number; y: number; z: number }): number {
    return this.rigid.create([{ dx: 0, dy: 0, dz: 0, state }], x, y, z, { velocity }).view.id;
  }

  /**
   * Drop `count` of an item at a point. If an identical stack already lies
   * within reach the items join it, and that body's id is returned.
   */
  spawnItem(itemId: number, count: number, x: number, y: number, z: number, velocity?: { x: number; y: number; z: number }): number {
    return addItem(this.rigid, itemId, count, x, y, z, velocity).view.id;
  }

  /** Pick up every item body within `radius` of a point. The bodies are removed; the result has one stack per kind of item. */
  collectItems(x: number, y: number, z: number, radius: number): ItemStack[] {
    return collectItems(this.rigid, x, y, z, radius);
  }

  /** Horizontal water velocity, in metres per second, in the cell containing a point. Zero outside water and in still sources. */
  flowAt(x: number, y: number, z: number): { x: number; z: number } {
    const out = { x: 0, z: 0 };
    this.fluid.flowInto(Math.floor(x), Math.floor(y), Math.floor(z), out);
    return out;
  }

  /**
   * Tell physics where the player's body is: feet at (x, y, z), a box
   * `halfWidth` to each side and `height` tall. Call it once per `step`. Bodies
   * it overlaps are shoved aside, and nothing lands or re-forms inside it.
   */
  setPusher(x: number, y: number, z: number, halfWidth: number, height: number): void {
    this.pusher = { x, y, z };
    this.rigid.pusher.set(x, y, z, halfWidth, height);
  }

  /**
   * Fell the tree whose trunk contains this log cell (the contract of
   * `WorldActions.fellTree`): its lowest log is cut, and the next `step` finds
   * the rest unsupported and brings it down as one body. Returns the number of
   * logs in the tree, counting the one cut; 0 if the cell is not a log.
   */
  fellTree(x: number, y: number, z: number): number {
    return this.structure.fellTree(x, y, z);
  }

  /** Pour finite water into a cell, in sixteenths of a block. Returns what fitted. */
  addWater(x: number, y: number, z: number, units: number): number {
    return this.fluid.addWater(x, y, z, units);
  }

  /**
   * The nearest rigid body or item a ray meets within `maxDistance` metres,
   * as of the last step: what the player's crosshair is on, if it is on a
   * body rather than the grid. Terrain does not stop the ray; compare the
   * distance with the block hit by the caller's own grid ray.
   */
  pickBody(ox: number, oy: number, oz: number, dx: number, dy: number, dz: number, maxDistance: number): { id: number; distance: number } | null {
    const length = Math.hypot(dx, dy, dz);
    if (!(length > 0)) return null;
    const ray = new RAPIER.Ray({ x: ox, y: oy, z: oz }, { x: dx / length, y: dy / length, z: dz / length });
    const hit = this.rigid.rapier.castRay(ray, maxDistance, true, RAPIER.QueryFilterFlags.EXCLUDE_FIXED);
    const body = hit?.collider.parent()?.userData as Body | undefined;
    return hit && body && !body.dead ? { id: body.view.id, distance: hit.timeOfImpact } : null;
  }

  /**
   * Break a block or compound body into the item drops of its blocks, where
   * it lies: the player hitting a piece of rubble that never went back into
   * the grid. Returns false if there is no such body.
   */
  breakBody(id: number): boolean {
    const body = this.rigid.bodies.find((b) => b.view.id === id && !b.dead);
    if (!body || body.kind === 'item') return false;
    toItems(this.rigid, body);
    return true;
  }

  // -------------------------------------------------------------------------

  private readonly onChange = (c: BlockChange): void => {
    // The fluid's own edits are water, air and washed-out plants: nobody else's business, and it tracks them itself.
    if (this.fluid.busy) return;
    const { x, y, z, old, state } = c;
    this.fluid.wake(x, y, z);
    if ((MATTERS[old] as number) === 0 && (MATTERS[state] as number) === 0) return;
    this.loose.onBlockChanged(x, y, z, old, state);
    this.structure.onBlockChanged(x, y, z, old, state);
    this.rigid.onBlockChanged(x, y, z, old, state);
  };

  /** Which way a felled tree should go over: away from the player if they are beside it, else a direction fixed by where it stands. */
  private lean(cells: readonly DetachedCell[]): { x: number; z: number } {
    let base = cells[0] as DetachedCell;
    for (const c of cells) if (c.y < base.y) base = c;
    const p = this.pusher;
    if (p) {
      const dx = base.x + 0.5 - p.x;
      const dz = base.z + 0.5 - p.z;
      if (Math.hypot(dx, dz) < LEAN_RANGE && Math.abs(base.y - p.y) < LEAN_RANGE) {
        // Along one axis, so the trunk has a chance of lying square to the grid when it lands.
        return Math.abs(dx) >= Math.abs(dz) ? { x: dx >= 0 ? 1 : -1, z: 0 } : { x: 0, z: dz >= 0 ? 1 : -1 };
      }
    }
    return this.structure.leanDirection(base.x, base.y, base.z);
  }
}
