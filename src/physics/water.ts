// Bodies in water: buoyancy by displaced volume, drag toward the water's own
// velocity (so a river carries what floats in it), and the splash on entry.
// Buoyancy is integrated over a few sample points per body; each point's
// share ramps in as it goes under, which keeps the force smooth while a body
// bobs through the surface.

import { WATER_LEVEL } from '../world/blocks';
import type { World } from '../world/world';
import type { Body } from './body';
import type { Fluid } from './fluid';
import { GRAVITY, WATER_DENSITY, type EmitEvent } from './types';

const LEVEL = WATER_LEVEL;

/** Per second: how fast water drags a fully submerged body to its own velocity, sideways and vertically. */
const DRAG_SIDE = 2;
const DRAG_UP = 3;
/** Angular damping of a fully submerged body. */
const DRAG_SPIN = 2.5;
/** Entry speed below which nothing splashes, m/s. */
const SPLASH_SPEED = 1.5;

export interface WaterContext {
  world: World;
  fluid: Fluid;
  emit: EmitEvent;
}

const flow = { x: 0, z: 0 };
const impulse = { x: 0, y: 0, z: 0 };
const torque = { x: 0, y: 0, z: 0 };
let surfaceSeen = 0;

/**
 * Fraction of the body's volume under water at its current pose, and (through
 * the module scratch) the buoyant force and its torque about the centre of mass.
 */
function measure(world: World, b: Body): number {
  const v = b.view;
  const { qx, qy, qz, qw } = v;
  // Rotation matrix rows.
  const r00 = 1 - 2 * (qy * qy + qz * qz);
  const r01 = 2 * (qx * qy - qz * qw);
  const r02 = 2 * (qx * qz + qy * qw);
  const r10 = 2 * (qx * qy + qz * qw);
  const r11 = 1 - 2 * (qx * qx + qz * qz);
  const r12 = 2 * (qy * qz - qx * qw);
  const r20 = 2 * (qx * qz - qy * qw);
  const r21 = 2 * (qy * qz + qx * qw);
  const r22 = 1 - 2 * (qx * qx + qy * qy);
  const cx = b.com[0];
  const cy = b.com[1];
  const cz = b.com[2];
  const samples = b.samples;
  let wet = 0;
  let total = 0;
  let force = 0;
  let tx = 0;
  let tz = 0;
  surfaceSeen = -Infinity;
  for (let i = 0; i < samples.length; i += 5) {
    const lx = samples[i] as number;
    const ly = samples[i + 1] as number;
    const lz = samples[i + 2] as number;
    const vol = samples[i + 3] as number;
    const h = samples[i + 4] as number;
    total += vol;
    const px = v.x + r00 * lx + r01 * ly + r02 * lz;
    const py = v.y + r10 * lx + r11 * ly + r12 * lz;
    const pz = v.z + r20 * lx + r21 * ly + r22 * lz;
    const gx = Math.floor(px);
    const gy = Math.floor(py);
    const gz = Math.floor(pz);
    const level = LEVEL[world.get(gx, gy, gz)] as number;
    let f = 0;
    if (level > 0) {
      const surface = gy + level / 16;
      f = (surface - py) / h + 0.5;
      // Near the top of a full cell the water may go on above it.
      if (f < 1 && level === 16 && LEVEL[world.get(gx, gy + 1, gz)] !== 0) f = 1;
      if (surface > surfaceSeen) surfaceSeen = surface;
    } else if (py - gy < h / 2) {
      // The point is in air, but its lower part may dip into the cell below.
      const under = LEVEL[world.get(gx, gy - 1, gz)] as number;
      if (under > 0) {
        const surface = gy - 1 + under / 16;
        f = 0.5 - (py - surface) / h;
        if (surface > surfaceSeen) surfaceSeen = surface;
      }
    }
    if (f <= 0) continue;
    if (f > 1) f = 1;
    const push = WATER_DENSITY * GRAVITY * vol * f;
    wet += vol * f;
    force += push;
    // Torque of an upward force at the sample about the centre of mass: r x (0, F, 0).
    const rx = px - (v.x + r00 * cx + r01 * cy + r02 * cz);
    const rz = pz - (v.z + r20 * cx + r21 * cy + r22 * cz);
    tx -= rz * push;
    tz += rx * push;
  }
  impulse.y = force;
  torque.x = tx;
  torque.z = tz;
  return total > 0 ? wet / total : 0;
}

/** How much of a body is under water right now, without acting on it. Used to notice water rising or draining around a sleeper. */
export function submersion(ctx: WaterContext, b: Body): number {
  return measure(ctx.world, b);
}

/** Apply one substep of buoyancy, drag and current to an awake body. */
export function applyWater(ctx: WaterContext, b: Body, dt: number): void {
  const fs = measure(ctx.world, b);
  if (fs <= 0) {
    b.wet = 0;
    b.dry += dt;
    if (b.dry > 0.4) b.inWater = false;
    if (b.angDamp !== 0) {
      b.angDamp = 0;
      b.rb.setAngularDamping(0);
    }
    return;
  }
  const v = b.view;
  if (!b.inWater) {
    b.inWater = true;
    const speed = Math.hypot(b.vx, b.vy, b.vz);
    if (speed > SPLASH_SPEED) {
      ctx.emit({ type: 'splash', x: v.x, y: Number.isFinite(surfaceSeen) ? surfaceSeen : v.y, z: v.z, strength: speed * Math.cbrt(b.volume) });
    }
  }
  b.wet = fs;
  b.dry = 0;
  ctx.fluid.flowInto(Math.floor(v.x), Math.floor(v.y), Math.floor(v.z), flow);
  const side = Math.min(1, DRAG_SIDE * fs * dt);
  const up = Math.min(1, DRAG_UP * fs * dt);
  impulse.x = b.mass * (flow.x - b.vx) * side;
  impulse.y = impulse.y * dt - b.mass * b.vy * up;
  impulse.z = b.mass * (flow.z - b.vz) * side;
  torque.x *= dt;
  torque.y = 0;
  torque.z *= dt;
  // Never wake by force alone: a body floating at rest is allowed to fall asleep.
  b.rb.applyImpulse(impulse, false);
  b.rb.applyTorqueImpulse(torque, false);
  b.vx += impulse.x / b.mass;
  b.vy += impulse.y / b.mass;
  b.vz += impulse.z / b.mass;
  const damp = DRAG_SPIN * fs;
  if (Math.abs(damp - b.angDamp) > 0.2) {
    b.angDamp = damp;
    b.rb.setAngularDamping(damp);
  }
}
