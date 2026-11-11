// What the player holds, drawn low on the right of the view as if in the
// hand. It swings with a blow and sways with a stride.

import type { ItemStack } from '../world/items';
import type { BodyDrawer } from './bodies';
import type { EntityRenderer } from './entities/renderer';
import type { Environment } from './environment';

interface View {
  x: number;
  y: number;
  z: number;
  yaw: number;
  pitch: number;
}

export class HeldItem {
  /** Set to 1 at the moment of a blow or a placement; it falls back to 0 by itself. */
  swing = 0;
  /** Metres walked, which drives the sway. */
  private stride = 0;

  /**
   * `speed` is the player's speed over the ground in m/s (0 in the air),
   * `digging` whether a block is being worked on, `time` the running clock in
   * seconds for the rhythm of the blows.
   */
  draw(bodies: BodyDrawer, out: EntityRenderer, cam: View, held: ItemStack | null, env: Environment, speed: number, digging: boolean, time: number, dt: number): void {
    this.swing = Math.max(0, this.swing - dt * 5);
    this.stride += speed * dt;
    if (!held) return;
    const sy = Math.sin(cam.yaw), cy = Math.cos(cam.yaw);
    const sp = Math.sin(cam.pitch), cp = Math.cos(cam.pitch);
    // The view's own axes: forward, right (level) and up.
    const fx = sy * cp, fy = sp, fz = cy * cp;
    const rx = -cy, rz = sy;
    const ux = -sy * sp, uy = cp, uz = -cy * sp;
    const blow = Math.max(this.swing, digging ? 0.35 + 0.35 * Math.sin(time * 17) : 0);
    const sway = Math.sin(this.stride * 1.6) * 0.012 * Math.min(1, speed / 3);
    const ahead = 0.5 + 0.12 * blow;
    const side = 0.36 - 0.06 * blow + sway;
    const down = 0.3 + 0.08 * blow + Math.abs(sway) * 0.6;
    const turn = cam.yaw + 0.62 - 0.5 * blow;
    bodies.item(out, {
      x: cam.x + fx * ahead + rx * side - ux * down, y: cam.y + fy * ahead - uy * down, z: cam.z + fz * ahead + rz * side - uz * down,
      qx: 0, qy: Math.sin(turn / 2), qz: 0, qw: Math.cos(turn / 2),
    }, held.item, 1, env, 0.17);
  }
}
