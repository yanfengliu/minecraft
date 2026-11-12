// The player's body, as far as rigid bodies are concerned: a box that shoves
// aside whatever it overlaps. The player's own collision knows only the block
// grid, so a body is never an obstacle to them; without this they would wade
// through rubble and stand inside logs. The shove is as strong as it needs to
// be to keep a body moving ahead of the player, for the same reason: anything
// too heavy to push would simply be walked through.
//
// The player's speed is not told to physics, only where they are, once per
// outer step. It is worked out from how far they moved and how long the step
// that followed was, so the shove is the same at any frame rate: the same
// walk reported 30 or 144 times a second moves a rock the same way.

import RAPIER, { type Collider, type Cuboid } from '@dimforge/rapier3d-compat';
import type { Body } from './body';
import type { RigidBodies } from './rigid';

/** Extra speed, m/s, a shoved body is given beyond the player's own, so it clears their path. */
const CLEARANCE = 0.6;
/** A body is shoved as if it weighed no more than this, in kg: a house-sized piece gives way slowly. */
const PUSH_MASS = 3000;
/** Substeps a reported position stays in force: the player has gone if `set` stops being called. */
const LIVE_STEPS = 30;
/** A reported move longer than this, or faster than `TOO_FAST`, is a teleport and carries no velocity. */
const TELEPORT = 3;
const TOO_FAST = 60;
/**
 * The speed is averaged over about this long, in seconds. The player's own
 * motion advances in fixed steps that need not line up with the frames it is
 * reported in, so one frame's move can be a step more or less than its share.
 */
const SMOOTHING = 0.05;

const NO_TURN = { x: 0, y: 0, z: 0, w: 1 };

export class Pusher {
  private x = 0;
  private y = 0;
  private z = 0;
  private half = 0.3;
  private height = 1.8;
  /** Where the player was when their speed was last worked out, and whether they have reported since. */
  private fromX = 0;
  private fromZ = 0;
  private reported = false;
  /** The player's speed, m/s, and for how many more seconds of substeps it is to be believed. */
  private vx = 0;
  private vz = 0;
  private hold = 0;
  private live = 0;
  private shape: Cuboid | null = null;
  private readonly hits: Collider[] = [];
  private readonly at = { x: 0, y: 0, z: 0 };
  private readonly j = { x: 0, y: 0, z: 0 };
  private readonly collect = (c: Collider): boolean => {
    this.hits.push(c);
    return true;
  };

  /** Report where the player's body is: feet position, half width and height. Call it before the outer step their move belongs to. */
  set(x: number, y: number, z: number, halfWidth: number, height: number): void {
    if (this.live <= 0) {
      // Not heard from for a while: wherever they were before says nothing about how they are moving now.
      this.fromX = x;
      this.fromZ = z;
      this.vx = 0;
      this.vz = 0;
    }
    this.x = x;
    this.y = y;
    this.z = z;
    if (halfWidth !== this.half || height !== this.height) this.shape = null;
    this.half = halfWidth;
    this.height = height;
    this.live = LIVE_STEPS;
    this.reported = true;
  }

  /**
   * An outer step of `dt` seconds is about to be simulated. The move reported
   * since the last one took that long, which gives the player's speed; it is
   * held for those `dt` seconds of substeps and then, with no new report, the
   * player is taken to be standing where they were last seen.
   */
  advance(dt: number): void {
    if (!this.reported) return;
    this.reported = false;
    const dx = this.x - this.fromX;
    const dz = this.z - this.fromZ;
    this.fromX = this.x;
    this.fromZ = this.z;
    const moved = Math.hypot(dx, dz);
    if (moved > TELEPORT || moved > TOO_FAST * dt) {
      this.vx = 0;
      this.vz = 0;
      this.hold = 0;
      return;
    }
    const blend = 1 - Math.exp(-dt / SMOOTHING);
    this.vx += (dx / dt - this.vx) * blend;
    this.vz += (dz / dt - this.vz) * blend;
    this.hold = dt;
  }

  /** True when the player's body overlaps this cell. */
  contains(x: number, y: number, z: number): boolean {
    return this.live > 0 && x + 1 > this.x - this.half && x < this.x + this.half && z + 1 > this.z - this.half && z < this.z + this.half
      && y + 1 > this.y && y < this.y + this.height;
  }

  /** Shove every body the player's box overlaps. Called once per substep of `dt` seconds, before the step. */
  apply(sys: RigidBodies, step: number, dt: number): void {
    if (this.live <= 0) return;
    this.live--;
    const moving = this.hold > 1e-9;
    const pvx = moving ? this.vx : 0;
    const pvz = moving ? this.vz : 0;
    this.hold -= dt;
    this.shape ??= new RAPIER.Cuboid(this.half, this.height / 2, this.half);
    const hits = this.hits;
    hits.length = 0;
    this.at.x = this.x;
    this.at.y = this.y + this.height / 2;
    this.at.z = this.z;
    // The query only gathers: nothing in the physics world may be changed from inside its callback.
    sys.rapier.intersectionsWithShape(this.at, NO_TURN, this.shape, this.collect, RAPIER.QueryFilterFlags.EXCLUDE_FIXED);
    for (const c of hits) {
      const b = c.parent()?.userData as Body | undefined;
      if (!b || b.dead || b.pushedAt === step) continue;
      b.pushedAt = step;
      // Away from the player's axis, measured from the part of the body they are touching: a long trunk swings round rather than sliding end on.
      const part = c.translation(this.at);
      const dx = part.x - this.x;
      const dz = part.z - this.z;
      const d = Math.hypot(dx, dz);
      const nx = d > 1e-3 ? dx / d : 1;
      const nz = d > 1e-3 ? dz / d : 0;
      const closing = (pvx - b.vx) * nx + (pvz - b.vz) * nz + CLEARANCE;
      if (closing <= 0) continue;
      const jn = Math.min(b.mass, PUSH_MASS) * closing;
      this.j.x = nx * jn;
      this.j.y = 0;
      this.j.z = nz * jn;
      // At the height of the centre of mass, so a block slides instead of tipping over.
      part.y = sys.centre(b).y;
      b.rb.applyImpulseAtPoint(this.j, part, true);
      b.vx += this.j.x / b.mass;
      b.vz += this.j.z / b.mass;
    }
    hits.length = 0;
  }
}
