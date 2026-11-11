// The player's body, as far as rigid bodies are concerned: a box that shoves
// aside whatever it overlaps. The player's own collision knows only the block
// grid, so a body is never an obstacle to them; without this they would wade
// through rubble and stand inside logs. The shove is as strong as it needs to
// be to keep a body moving ahead of the player, for the same reason: anything
// too heavy to push would simply be walked through.

import RAPIER, { type Collider, type Cuboid } from '@dimforge/rapier3d-compat';
import type { Body } from './body';
import type { RigidBodies } from './rigid';

/** Extra speed, m/s, a shoved body is given beyond the player's own, so it clears their path. */
const CLEARANCE = 0.6;
/** A body is shoved as if it weighed no more than this, in kg: a house-sized piece gives way slowly. */
const PUSH_MASS = 3000;
/** Substeps a reported position stays in force: the player has gone if `set` stops being called. */
const LIVE_STEPS = 30;
/** A reported move longer than this in one step is a teleport and carries no velocity. */
const TELEPORT = 3;

const NO_TURN = { x: 0, y: 0, z: 0, w: 1 };

export class Pusher {
  private x = 0;
  private y = 0;
  private z = 0;
  private half = 0.3;
  private height = 1.8;
  /** Displacement since the previous report, not yet turned into a shove. */
  private mx = 0;
  private mz = 0;
  private fresh = false;
  private live = 0;
  private shape: Cuboid | null = null;
  private readonly hits: Collider[] = [];
  private readonly at = { x: 0, y: 0, z: 0 };
  private readonly j = { x: 0, y: 0, z: 0 };
  private readonly collect = (c: Collider): boolean => {
    this.hits.push(c);
    return true;
  };

  /** Report where the player's body is: feet position, half width and height. */
  set(x: number, y: number, z: number, halfWidth: number, height: number): void {
    const dx = x - this.x;
    const dz = z - this.z;
    const moved = this.live > 0 && Math.hypot(dx, dz) <= TELEPORT;
    this.mx = moved ? dx : 0;
    this.mz = moved ? dz : 0;
    this.fresh = moved;
    this.x = x;
    this.y = y;
    this.z = z;
    if (halfWidth !== this.half || height !== this.height) this.shape = null;
    this.half = halfWidth;
    this.height = height;
    this.live = LIVE_STEPS;
  }

  /** True when the player's body overlaps this cell. */
  contains(x: number, y: number, z: number): boolean {
    return this.live > 0 && x + 1 > this.x - this.half && x < this.x + this.half && z + 1 > this.z - this.half && z < this.z + this.half
      && y + 1 > this.y && y < this.y + this.height;
  }

  /** Shove every body the player's box overlaps. Called once per substep, before the step. */
  apply(sys: RigidBodies, step: number, dt: number): void {
    if (this.live <= 0) return;
    this.live--;
    // The reported move covered one outer step: it is the player's velocity for the first substep after the report.
    const pvx = this.fresh ? this.mx / dt : 0;
    const pvz = this.fresh ? this.mz / dt : 0;
    this.fresh = false;
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
