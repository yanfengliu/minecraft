// Rigid bodies: loose blocks, compounds of blocks and dropped items, simulated
// by Rapier against the voxel world (see terrain.ts) and each other. This file
// owns the Rapier world and the life of each body; water, coming to rest,
// breaking apart and items live beside it.

import RAPIER, { type World as RapierWorld } from '@dimforge/rapier3d-compat';
import { MATERIALS, type Material } from '../world/blocks';
import type { World } from '../world/world';
import { buoyancySamples, cellBounds, dominantMaterial, type Body } from './body';
import type { Fluid } from './fluid';
import { breakOnImpact } from './fracture';
import { ITEM_HALF, despawnOldItems, itemMaterial, mergeItems } from './items';
import { enforceBudget, trySettle } from './settle';
import { SOLID_VOLUME, mergeCells } from './shapes';
import type { DetachedCell } from './structure';
import { CHUNK, TerrainColliders } from './terrain';
import { GRAVITY, RIGID_DT, type BodyCell, type BodyKind, type BodyView, type EmitEvent, type PhysicsOptions } from './types';
import { applyWater, submersion, type WaterContext } from './water';

/** What the rigid-body system needs from the rest of physics. */
export interface RigidHost {
  emit: EmitEvent;
  nextId(): number;
  addView(view: BodyView): void;
  removeView(view: BodyView): void;
  fluid: Fluid;
}

/** A change of velocity in one step, beyond gravity, that counts as an impact (m/s). */
const IMPACT_SPEED = 2;
/** Terrain collision is kept this far around a body, plus a lookahead along its velocity. */
const TERRAIN_MARGIN = 1.5;
const TERRAIN_LOOKAHEAD = 0.1;
/** A body that leaves the island or falls out of the bottom of the world is forgotten. */
const WORLD_MARGIN = 8;
/** The most the player's body can push with, in newtons: enough to shove a crate, not a boulder. */
const PUSH_FORCE = 900;
const SETTLES_PER_STEP = 4;

const IDENTITY = { x: 0, y: 0, z: 0, w: 1 };
const ZERO = { x: 0, y: 0, z: 0 };
let warmed = false;

export class RigidBodies {
  readonly rapier: RapierWorld;
  readonly terrain: TerrainColliders;
  readonly bodies: Body[] = [];
  readonly water: WaterContext;
  /** Bodies awake after the last step. */
  awake = 0;
  readonly maxBodies: number;
  readonly maxItems: number;
  readonly itemLifetime: number;
  readonly settleTime: number;
  readonly snapDistance: number;
  readonly snapAngle: number;
  readonly seed: number;

  private born = 0;
  private steps = 0;
  private anyDead = false;
  // The player's body: feet position, size, velocity, and how many steps the last report is still good for.
  private readonly pusher = { x: 0, y: 0, z: 0, half: 0.3, height: 1.8, vx: 0, vz: 0, live: 0, fresh: false };
  private readonly t = { x: 0, y: 0, z: 0 };
  private readonly q = { x: 0, y: 0, z: 0, w: 1 };
  private readonly v = { x: 0, y: 0, z: 0 };
  private readonly j = { x: 0, y: 0, z: 0 };

  /** Load the physics library. Must have resolved before the first instance is made. */
  static async init(): Promise<void> {
    await RAPIER.init();
    if (warmed) return;
    warmed = true;
    // The library's first step compiles a good deal of itself and takes a
    // tenth of a second. Spend that here, at load, on a throwaway world.
    const w = new RAPIER.World({ x: 0, y: -GRAVITY, z: 0 });
    const ground = w.createCollider(RAPIER.ColliderDesc.voxels(new Int32Array([0, 0, 0]), { x: 0.5, y: 0.5, z: 0.5 }));
    ground.setVoxel(1, 0, 0, true);
    w.createCollider(RAPIER.ColliderDesc.cuboid(0.5, 0.5, 0.5), w.createRigidBody(RAPIER.RigidBodyDesc.dynamic().setTranslation(0.5, 1.2, 0.25).setCcdEnabled(true)));
    for (let i = 0; i < 4; i++) w.step();
    w.free();
  }

  constructor(readonly world: World, readonly host: RigidHost, opts: PhysicsOptions = {}) {
    this.rapier = new RAPIER.World({ x: 0, y: -GRAVITY, z: 0 });
    this.rapier.timestep = RIGID_DT;
    this.terrain = new TerrainColliders(world, this.rapier);
    this.water = { world, fluid: host.fluid, emit: host.emit };
    this.maxBodies = opts.maxBodies ?? 300;
    this.maxItems = opts.maxItems ?? 400;
    this.itemLifetime = opts.itemLifetime ?? 300;
    this.settleTime = opts.settleTime ?? 3;
    this.snapDistance = opts.snapDistance ?? 0.4;
    this.snapAngle = opts.snapAngle ?? 0.3;
    this.seed = opts.seed ?? 0;
  }

  dispose(): void {
    this.rapier.free();
  }

  /** Colliders alive in the Rapier world, terrain included. */
  get colliderCount(): number {
    return this.rapier.colliders.len();
  }

  // --- making and removing bodies ------------------------------------------

  /**
   * Create a body from body-local cells at a pose. One cell makes a 'block',
   * more a 'compound'; no cells and an item id make an 'item'.
   */
  create(
    cells: BodyCell[], x: number, y: number, z: number,
    opts: { rotation?: { x: number; y: number; z: number; w: number }; velocity?: { x: number; y: number; z: number }; spin?: { x: number; y: number; z: number }; tree?: boolean; item?: number; count?: number; kind?: BodyKind } = {},
  ): Body {
    const kind: BodyKind = opts.kind ?? (opts.item !== undefined ? 'item' : cells.length === 1 ? 'block' : 'compound');
    const vel = opts.velocity ?? ZERO;
    const rot = opts.rotation ?? IDENTITY;
    const desc = RAPIER.RigidBodyDesc.dynamic()
      .setTranslation(x, y, z)
      .setRotation(rot)
      .setLinvel(vel.x, vel.y, vel.z)
      .setAngvel(opts.spin ?? ZERO)
      // Small fast things are the ones that tunnel; a big compound is slow and costly to sweep.
      .setCcdEnabled(kind !== 'compound');
    const rb = this.rapier.createRigidBody(desc);
    const view: BodyView = {
      id: this.host.nextId(), kind, x, y, z, qx: rot.x, qy: rot.y, qz: rot.z, qw: rot.w, sleeping: false,
      state: kind === 'block' ? (cells[0] as BodyCell).state : 0,
      item: opts.item ?? -1, count: kind === 'item' ? (opts.count ?? 1) : 0,
      cells: kind === 'compound' ? cells : [], version: 0,
    };
    const body: Body = {
      view, rb, kind, cells, material: 0, mass: 1, volume: 1,
      min: [0, 0, 0], max: [0, 0, 0], radius: 1, com: [0, 0, 0], samples: new Float32Array(0),
      wet: 0, inWater: false, dry: 1, angDamp: 0, vx: vel.x, vy: vel.y, vz: vel.z,
      quiet: 1, asleep: 0, snapRefused: false, age: 0, born: this.born++, tree: opts.tree === true,
      range: new Int32Array(6).fill(-1), dead: false,
    };
    this.fit(body);
    this.bodies.push(body);
    this.host.addView(view);
    this.needTerrain(body);
    return body;
  }

  /** Create a body from blocks given in world cell coordinates, as the structure system hands them over. */
  createFromWorld(cells: readonly DetachedCell[], tree: boolean, lean?: { x: number; z: number }): Body {
    // Origin on the cell nearest the centroid, so local coordinates stay small.
    let cx = 0;
    let cy = 0;
    let cz = 0;
    for (const c of cells) {
      cx += c.x;
      cy += c.y;
      cz += c.z;
    }
    cx /= cells.length;
    cy /= cells.length;
    cz /= cells.length;
    let origin = cells[0] as DetachedCell;
    let best = Infinity;
    for (const c of cells) {
      const d = (c.x - cx) ** 2 + (c.y - cy) ** 2 + (c.z - cz) ** 2;
      if (d < best) {
        best = d;
        origin = c;
      }
    }
    const local = cells.map((c) => ({ dx: c.x - origin.x, dy: c.y - origin.y, dz: c.z - origin.z, state: c.state }));
    // A felled tree is tipped about a level axis so its top moves the way it leans.
    const spin = tree && lean ? { x: lean.z * 0.6, y: 0, z: -lean.x * 0.6 } : undefined;
    return this.create(local, origin.x + 0.5, origin.y + 0.5, origin.z + 0.5, { tree, spin });
  }

  /** (Re)build a body's colliders and everything derived from its cells. Called at creation and when its cells change. */
  fit(b: Body): void {
    const rb = b.rb;
    for (let i = rb.numColliders() - 1; i >= 0; i--) this.rapier.removeCollider(rb.collider(i), false);
    if (b.kind === 'item') {
      const m = MATERIALS[itemMaterial(b.view.item)] as Material;
      this.rapier.createCollider(RAPIER.ColliderDesc.cuboid(ITEM_HALF, ITEM_HALF, ITEM_HALF).setDensity(m.density).setFriction(m.friction).setRestitution(m.restitution), rb);
      b.material = itemMaterial(b.view.item);
      b.min = [-ITEM_HALF, -ITEM_HALF, -ITEM_HALF];
      b.max = [ITEM_HALF, ITEM_HALF, ITEM_HALF];
      b.volume = (ITEM_HALF * 2) ** 3;
    } else {
      for (const box of mergeCells(b.cells)) {
        const m = MATERIALS[box.material] as Material;
        this.rapier.createCollider(
          RAPIER.ColliderDesc.cuboid(box.hx, box.hy, box.hz).setTranslation(box.x, box.y, box.z).setDensity(m.density).setFriction(m.friction).setRestitution(m.restitution),
          rb,
        );
      }
      b.material = dominantMaterial(b.cells);
      const bounds = cellBounds(b.cells);
      b.min = bounds.min;
      b.max = bounds.max;
      b.volume = b.cells.reduce((sum, c) => sum + (SOLID_VOLUME[c.state] || 1), 0);
    }
    rb.recomputeMassPropertiesFromColliders();
    b.mass = rb.mass();
    const com = rb.localCom(this.t);
    b.com = [com.x, com.y, com.z];
    b.radius = Math.hypot(Math.max(-b.min[0], b.max[0]), Math.max(-b.min[1], b.max[1]), Math.max(-b.min[2], b.max[2]));
    b.samples = buoyancySamples(b.kind, b.cells);
    b.range.fill(-1);
  }

  remove(b: Body): void {
    if (b.dead) return;
    b.dead = true;
    this.anyDead = true;
    this.rapier.removeRigidBody(b.rb);
    this.host.removeView(b.view);
  }

  // --- the outside world -----------------------------------------------------

  onBlockChanged(x: number, y: number, z: number, old: number, state: number): void {
    this.terrain.onBlockChanged(x, y, z, old, state);
  }

  /** Where the player's body is. Call once per `step`; it stops pushing a little after the calls stop. */
  setPusher(x: number, y: number, z: number, halfWidth: number, height: number): void {
    const p = this.pusher;
    if (p.live > 0) {
      // Velocity from the move since the last report; a jump of several blocks is a teleport, not a shove.
      const dx = x - p.x;
      const dz = z - p.z;
      const far = Math.hypot(dx, dz) > 3;
      p.vx = far ? 0 : dx;
      p.vz = far ? 0 : dz;
      p.fresh = true;
    } else {
      p.vx = 0;
      p.vz = 0;
    }
    p.x = x;
    p.y = y;
    p.z = z;
    p.half = halfWidth;
    p.height = height;
    p.live = 30;
  }

  /** True when the player's body overlaps this cell. */
  pusherIn(x: number, y: number, z: number): boolean {
    const p = this.pusher;
    return p.live > 0 && x + 1 > p.x - p.half && x < p.x + p.half && z + 1 > p.z - p.half && z < p.z + p.half && y + 1 > p.y && y < p.y + p.height;
  }

  /** The fluid has ticked: wake sleepers whose water rose or drained away. */
  fluidTicked(): void {
    for (const b of this.bodies) {
      if (!b.view.sleeping || b.dead) continue;
      if (Math.abs(submersion(this.water, b) - b.wet) > 0.08) b.rb.wakeUp();
    }
  }

  // --- stepping --------------------------------------------------------------

  /** Advance every body by one fixed step of `RIGID_DT`. */
  substep(): void {
    const dt = RIGID_DT;
    this.steps++;
    this.terrain.flush(this.wakeNear);
    this.push(dt);
    for (const b of this.bodies) {
      if (b.view.sleeping) continue;
      this.needTerrain(b);
      applyWater(this.water, b, dt);
    }
    this.rapier.step();
    let awake = 0;
    let settles = 0;
    for (let i = 0; i < this.bodies.length; i++) {
      const b = this.bodies[i] as Body;
      if (b.dead) continue;
      if (this.sync(b, dt)) awake++;
      else if (b.kind !== 'item' && !b.snapRefused && b.asleep >= this.settleTime && settles < SETTLES_PER_STEP) {
        settles++;
        if (!trySettle(this, b)) b.snapRefused = true;
      }
    }
    this.awake = awake;
    if (this.steps % 15 === 0) {
      mergeItems(this);
      despawnOldItems(this);
    }
    if (this.steps % 60 === 0) {
      enforceBudget(this);
      // Every body re-declares the ground it needs; what nobody claims twice running is dropped.
      for (const b of this.bodies) {
        if (b.dead) continue;
        b.range.fill(-1);
        this.needTerrain(b);
      }
      this.terrain.sweep();
    }
    if (this.anyDead) {
      let n = 0;
      for (const b of this.bodies) if (!b.dead) this.bodies[n++] = b;
      this.bodies.length = n;
      this.anyDead = false;
    }
  }

  // -------------------------------------------------------------------------

  /** Wake whatever rests on or against a cell whose collision changed. */
  private readonly wakeNear = (x: number, y: number, z: number): void => {
    // By our own records rather than a query of the physics world: the bodies are few, and a query callback must not touch them.
    for (const b of this.bodies) {
      if (b.dead || !b.view.sleeping) continue;
      const v = b.view;
      const reach = b.radius + 1;
      if (Math.abs(v.x - x - 0.5) < reach && Math.abs(v.y - y - 0.5) < reach && Math.abs(v.z - z - 0.5) < reach) b.rb.wakeUp();
    }
  };

  /** Make sure the terrain around a body has collision, asking only when the body has moved to new chunks. */
  private needTerrain(b: Body): void {
    const v = b.view;
    const reach = b.radius + TERRAIN_MARGIN;
    const ax = Math.abs(b.vx) * TERRAIN_LOOKAHEAD;
    const ay = Math.abs(b.vy) * TERRAIN_LOOKAHEAD;
    const az = Math.abs(b.vz) * TERRAIN_LOOKAHEAD;
    const x0 = v.x - reach - ax;
    const y0 = v.y - reach - ay;
    const z0 = v.z - reach - az;
    const x1 = v.x + reach + ax;
    const y1 = v.y + reach + ay;
    const z1 = v.z + reach + az;
    const r = b.range;
    const c0 = Math.floor(x0 / CHUNK);
    const c1 = Math.floor(y0 / CHUNK);
    const c2 = Math.floor(z0 / CHUNK);
    const c3 = Math.floor(x1 / CHUNK);
    const c4 = Math.floor(y1 / CHUNK);
    const c5 = Math.floor(z1 / CHUNK);
    if (r[0] === c0 && r[1] === c1 && r[2] === c2 && r[3] === c3 && r[4] === c4 && r[5] === c5) return;
    r[0] = c0;
    r[1] = c1;
    r[2] = c2;
    r[3] = c3;
    r[4] = c4;
    r[5] = c5;
    this.terrain.ensure(x0, y0, z0, x1, y1, z1);
  }

  /** Copy a body's state out of Rapier after a step. Returns true if it is awake. */
  private sync(b: Body, dt: number): boolean {
    const rb = b.rb;
    const view = b.view;
    b.age += dt;
    b.quiet += dt;
    const sleeping = rb.isSleeping();
    if (sleeping && view.sleeping) {
      b.asleep += dt;
      return false;
    }
    const t = rb.translation(this.t);
    view.x = t.x;
    view.y = t.y;
    view.z = t.z;
    const q = rb.rotation(this.q);
    view.qx = q.x;
    view.qy = q.y;
    view.qz = q.z;
    view.qw = q.w;
    if (sleeping) {
      // Just fell asleep: the pose read above is where it stays.
      view.sleeping = true;
      b.asleep = dt;
      b.vx = 0;
      b.vy = 0;
      b.vz = 0;
      return false;
    }
    if (view.sleeping) {
      view.sleeping = false;
      b.snapRefused = false;
    }
    b.asleep = 0;
    const v = rb.linvel(this.v);
    // What the step changed beyond gravity is what hit the body.
    const dx = v.x - b.vx;
    const dy = v.y - b.vy + GRAVITY * dt;
    const dz = v.z - b.vz;
    b.vx = v.x;
    b.vy = v.y;
    b.vz = v.z;
    const w = this.world;
    if (t.y < -WORLD_MARGIN || t.x < -WORLD_MARGIN || t.z < -WORLD_MARGIN || t.x > w.sx + WORLD_MARGIN || t.z > w.sz + WORLD_MARGIN) {
      this.remove(b);
      return false;
    }
    const hit = dx * dx + dy * dy + dz * dz;
    if (hit > IMPACT_SPEED * IMPACT_SPEED && b.quiet > 0.1) {
      b.quiet = 0;
      const speed = Math.sqrt(hit);
      // The blow came from the side the velocity change points away from.
      const r = Math.min(0.5, b.radius);
      this.host.emit({ type: 'impact', x: t.x - (dx / speed) * r, y: t.y - (dy / speed) * r, z: t.z - (dz / speed) * r, energy: 0.5 * b.mass * hit, material: b.material });
      breakOnImpact(this, b, speed);
    }
    return !b.dead;
  }

  /** The player's body shoves aside what it overlaps, with limited force. */
  private push(dt: number): void {
    const p = this.pusher;
    if (p.live <= 0) return;
    p.live--;
    // The reported move happened over one outer step; spread as a velocity over the substeps until the next report.
    const pvx = p.fresh ? p.vx / dt : 0;
    const pvz = p.fresh ? p.vz / dt : 0;
    p.fresh = false;
    const cy = p.y + p.height / 2;
    for (const b of this.bodies) {
      if (b.dead) continue;
      const v = b.view;
      const reach = Math.min(b.radius, 1) + p.half;
      const dx = v.x - p.x;
      const dz = v.z - p.z;
      if (Math.abs(dx) > reach || Math.abs(dz) > reach || Math.abs(v.y - cy) > p.height / 2 + Math.min(b.radius, 1)) continue;
      const d = Math.hypot(dx, dz);
      const nx = d > 1e-3 ? dx / d : 1;
      const nz = d > 1e-3 ? dz / d : 0;
      // Enough to move it out of the way at the player's own pace and a little more, capped by what a person can push.
      const closing = (pvx - b.vx) * nx + (pvz - b.vz) * nz + 0.6;
      if (closing <= 0) continue;
      const jn = Math.min(b.mass * closing, PUSH_FORCE * dt);
      this.j.x = nx * jn;
      this.j.y = 0;
      this.j.z = nz * jn;
      b.rb.applyImpulse(this.j, true);
      b.vx += this.j.x / b.mass;
      b.vz += this.j.z / b.mass;
    }
  }
}
