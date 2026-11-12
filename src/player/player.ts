// The first-person body: walking, sprinting, jumping, swimming, climbing and an
// optional free flight for looking around. Motion is integrated in fixed steps
// against block collision boxes. Units are metres and seconds; gravity is the
// same 9.81 m/s^2 everything else in the world falls under.

import { approach, clamp, damp } from '../core/math';
import { B, CLIMBABLE, WATER_LEVEL } from '../world/blocks';
import type { World } from '../world/world';
import { boxIsFree, moveBox } from './collide';
import type { Input } from './input';

export const GRAVITY = 9.81;
const HALF_WIDTH = 0.3;
const HEIGHT = 1.8;
const EYE = 1.62;
const STEP = 0.6;
const WALK = 4.3;
const SPRINT = 6.6;
const JUMP = 4.75; // reaches about 1.15 m, enough to mount a full block
const SWIM = 2.3;
const STEP_DT = 1 / 120;

/** Horizontal push of water at a point, in metres per second. */
export type FlowFn = (x: number, y: number, z: number) => { x: number; z: number };

export class Player {
  x: number;
  y: number;
  z: number;
  vx = 0;
  vy = 0;
  vz = 0;
  /** Radians; 0 faces +z, turning toward +x as it grows. */
  yaw = 0;
  pitch = 0;
  onGround = false;
  flying = false;
  /** Fraction of the body under water, 0..1. */
  submerged = 0;
  /** True when the eyes are under water. */
  headUnder = false;
  sprinting = false;
  /** Eye height above the feet, eased so step-ups do not jolt the view. */
  eyeY: number;
  /** Extra field of view while sprinting, 0..1. */
  rush = 0;
  /** Metres walked on the ground, for footsteps and view bob. */
  stride = 0;
  private debt = 0;
  private lift = 0;

  constructor(x: number, y: number, z: number) {
    this.x = x;
    this.y = y;
    this.z = z;
    this.eyeY = EYE;
  }

  get eye(): { x: number; y: number; z: number } {
    return { x: this.x, y: this.y + this.eyeY, z: this.z };
  }

  /** Unit vector the player is looking along. */
  get look(): { x: number; y: number; z: number } {
    const cp = Math.cos(this.pitch);
    return { x: Math.sin(this.yaw) * cp, y: Math.sin(this.pitch), z: Math.cos(this.yaw) * cp };
  }

  teleport(x: number, y: number, z: number): void {
    this.x = x;
    this.y = y;
    this.z = z;
    this.vx = this.vy = this.vz = 0;
  }

  update(dt: number, input: Input, world: World, flow?: FlowFn): void {
    const look = input.consumeLook();
    this.yaw -= look.x * 0.0023;
    this.pitch = clamp(this.pitch - look.y * 0.0023, -1.55, 1.55);
    if (input.hit('KeyF')) {
      this.flying = !this.flying;
      this.vy = 0;
    }

    this.debt += dt;
    let steps = Math.min(Math.floor(this.debt / STEP_DT), 24);
    this.debt -= steps * STEP_DT;
    while (steps-- > 0) this.step(STEP_DT, input, world, flow);

    // Ease the view back down after a step-up lifted the body.
    this.lift = damp(this.lift, 0, 14, dt);
    this.eyeY = EYE - this.lift;
    this.rush = damp(this.rush, this.sprinting && Math.hypot(this.vx, this.vz) > WALK + 0.5 ? 1 : 0, 8, dt);
  }

  private step(dt: number, input: Input, world: World, flow?: FlowFn): void {
    // What the body is in.
    const cx = Math.floor(this.x);
    const cz = Math.floor(this.z);
    const waterAt = (y: number): number => {
      const cy = Math.floor(y);
      const level = WATER_LEVEL[world.get(cx, cy, cz)] as number;
      if (level === 0) return -Infinity;
      // A cell with water above it is full; otherwise the surface sits at its level.
      const full = (WATER_LEVEL[world.get(cx, cy + 1, cz)] as number) > 0;
      return cy + (full ? 1 : (level / 16) * (15 / 16));
    };
    let surface = -Infinity;
    for (let y = this.y; y < this.y + HEIGHT + 1; y += 0.5) surface = Math.max(surface, waterAt(y));
    this.submerged = clamp((surface - this.y) / HEIGHT, 0, 1);
    this.headUnder = surface > this.y + this.eyeY;
    const feet = world.get(cx, Math.floor(this.y + 0.1), cz);
    const chest = world.get(cx, Math.floor(this.y + 1), cz);
    const climbing = !this.flying && (CLIMBABLE[feet] === 1 || CLIMBABLE[chest] === 1);

    // Wish direction from the keys, in the horizontal plane.
    const fwd = (input.down('KeyW') ? 1 : 0) - (input.down('KeyS') ? 1 : 0);
    const side = (input.down('KeyA') ? 1 : 0) - (input.down('KeyD') ? 1 : 0);
    const sy = Math.sin(this.yaw);
    const cyw = Math.cos(this.yaw);
    let wx = sy * fwd + cyw * side;
    let wz = cyw * fwd - sy * side;
    const wl = Math.hypot(wx, wz);
    if (wl > 1) {
      wx /= wl;
      wz /= wl;
    }
    this.sprinting = input.down('ShiftLeft') && fwd > 0;
    const swimming = this.submerged > 0.55 && !this.flying;

    if (this.flying) {
      const speed = this.sprinting ? 42 : 12;
      // Down is C and only C. It was Control as well, and Control with W, flying down and forward, is the
      // browser's own shortcut for closing the tab, which a page cannot stop.
      const up = (input.down('Space') ? 1 : 0) - (input.down('KeyC') ? 1 : 0);
      this.vx = approach(this.vx, wx * speed, 120 * dt);
      this.vz = approach(this.vz, wz * speed, 120 * dt);
      this.vy = approach(this.vy, up * speed, 120 * dt);
    } else if (climbing) {
      this.vx = approach(this.vx, wx * 2.2, 40 * dt);
      this.vz = approach(this.vz, wz * 2.2, 40 * dt);
      // On a ladder, pushing into it climbs; looking down and pushing descends.
      const climb = input.down('Space') ? 1 : fwd !== 0 ? (this.pitch < -0.5 ? -1 : 1) * Math.sign(fwd) : input.down('KeyC') ? -1 : 0;
      this.vy = approach(this.vy, climb * 2.6, 30 * dt);
    } else if (swimming) {
      // Swim where you look; water carries you and drags on you.
      const cp = Math.cos(this.pitch);
      const speed = this.sprinting ? SWIM * 1.5 : SWIM;
      let tx = (sy * cp * fwd + cyw * side) * speed;
      let tz = (cyw * cp * fwd - sy * side) * speed;
      let ty = Math.sin(this.pitch) * fwd * speed;
      if (input.down('Space')) ty += 1.9;
      if (input.down('KeyC')) ty -= 1.9;
      if (flow) {
        const f = flow(this.x, this.y + 0.6, this.z);
        tx += f.x;
        tz += f.z;
      }
      const grip = 9 * dt;
      this.vx = approach(this.vx, tx, grip);
      this.vz = approach(this.vz, tz, grip);
      // Buoyancy just beats gravity when fully under, so an idle swimmer floats with eyes at the surface.
      this.vy += (-GRAVITY + GRAVITY * 1.06 * this.submerged) * dt;
      this.vy = approach(this.vy, ty, grip) * Math.exp(-2.2 * this.submerged * dt);
    } else {
      const speed = this.sprinting ? SPRINT : WALK;
      const wading = 1 - 0.55 * this.submerged;
      const accel = this.onGround ? (wl > 0 ? 46 : 38) : 7;
      // Off the ground there is only weak control and no braking, so a jump carries.
      if (this.onGround || wl > 0) {
        this.vx = approach(this.vx, wx * speed * wading, accel * dt);
        this.vz = approach(this.vz, wz * speed * wading, accel * dt);
      }
      if (flow && this.submerged > 0.1) {
        const f = flow(this.x, this.y + 0.3, this.z);
        this.vx += f.x * 2 * this.submerged * dt;
        this.vz += f.z * 2 * this.submerged * dt;
      }
      this.vy -= GRAVITY * (1 - 0.6 * this.submerged) * dt;
      // Air resistance: sets a terminal speed of roughly 55 m/s.
      this.vy -= this.vy * Math.abs(this.vy) * 0.0032 * dt;
      if (this.onGround && input.down('Space')) {
        this.vy = JUMP;
        this.onGround = false;
      }
    }

    const wasGrounded = this.onGround;
    const r = moveBox(world, this.x, this.y, this.z, HALF_WIDTH, HEIGHT, this.vx * dt, this.vy * dt, this.vz * dt,
      this.flying || swimming ? 0 : STEP, wasGrounded && this.vy <= 0);
    if (this.onGround && !this.flying) this.stride += Math.hypot(r.x - this.x, r.z - this.z);
    this.x = r.x;
    this.y = r.y;
    this.z = r.z;
    if (r.hitX) this.vx = 0;
    if (r.hitZ) this.vz = 0;
    if (r.hitY) this.vy = 0;
    this.onGround = r.onGround && !this.flying;
    if (r.stepped > 0) this.lift = Math.min(this.lift + r.stepped, 1);

    // The world has edges: the open sea beyond them is not for swimming.
    this.x = clamp(this.x, 0.5, world.sx - 0.5);
    this.z = clamp(this.z, 0.5, world.sz - 0.5);
    if (this.y < -8) this.respawnAbove(world);
  }

  /** Put the player on the highest open ground of their column (after falling out, or to get unstuck). */
  respawnAbove(world: World): void {
    const x = Math.floor(this.x);
    const z = Math.floor(this.z);
    for (let y = world.sy - 2; y > 0; y--) {
      if (world.get(x, y, z) !== B.air && boxIsFree(world, x + 0.5, y + 1, z + 0.5, HALF_WIDTH, HEIGHT)) {
        this.teleport(x + 0.5, y + 1, z + 0.5);
        return;
      }
    }
  }
}
