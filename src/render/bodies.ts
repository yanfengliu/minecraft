// Draws the physics layer's bodies with the creature renderer's boxes. A
// falling block or a piece of rubble keeps the faces it had in the grid, built
// from the same boxes and tiles the mesher uses; a dropped item is a small copy
// of its block, or a plain cube in the colour of its good.

import { type BodyView, ITEM_SIZE } from '../physics/types';
import { BLOCKS, type BlockState, EMIT, SHAPE_BOXES, SHAPE_CONNECT, SHAPE_CROP, SHAPE_CROSS, TINT_BIRCH, TINT_FOLIAGE, TINT_GRASS } from '../world/blocks';
import { ITEMS } from '../world/items';
import type { World } from '../world/world';
import type { EntityRenderer } from './entities/renderer';
import type { Environment } from './environment';

type Rgb = readonly [number, number, number];

/** Linear colour of each good's drop. Block items take their block's tiles instead. */
const GOOD_COLOR: Record<string, Rgb> = {
  wheat: [0.6, 0.42, 0.07], barley: [0.55, 0.45, 0.12], flour: [0.85, 0.82, 0.72], bread: [0.5, 0.28, 0.08], turnip: [0.75, 0.6, 0.7],
  cabbage: [0.25, 0.5, 0.15], fish: [0.35, 0.45, 0.55], meat: [0.55, 0.12, 0.1], egg: [0.85, 0.78, 0.62], berries: [0.5, 0.03, 0.08],
  mushroom: [0.6, 0.45, 0.35], ale: [0.55, 0.3, 0.05], wool: [0.85, 0.85, 0.8], cloth: [0.3, 0.35, 0.6], hide: [0.4, 0.25, 0.12],
  firewood: [0.35, 0.22, 0.1], coal: [0.03, 0.03, 0.035], iron: [0.45, 0.47, 0.5], tools: [0.5, 0.42, 0.3],
};
const PLAIN: Rgb = [0.5, 0.5, 0.5];
const WHITE: Rgb = [1, 1, 1];

const v = { x: 0, y: 0, z: 0 };

/** Turn a body-local offset into world axes by the body's rotation; the result is left in `v`. */
function turn(b: BodyView, x: number, y: number, z: number): void {
  const { qx, qy, qz, qw } = b;
  // t = 2 q x p; p' = p + w t + q x t
  const tx = 2 * (qy * z - qz * y);
  const ty = 2 * (qz * x - qx * z);
  const tz = 2 * (qx * y - qy * x);
  v.x = x + qw * tx + (qy * tz - qz * ty);
  v.y = y + qw * ty + (qz * tx - qx * tz);
  v.z = z + qw * tz + (qx * ty - qy * tx);
}

export class BodyDrawer {
  private readonly world: World;

  constructor(world: World) {
    this.world = world;
  }

  /** Add every body within `range` metres (measured on the ground) of the camera to this frame's boxes. */
  draw(out: EntityRenderer, bodies: readonly BodyView[], env: Environment, camX: number, camZ: number, range = 220): void {
    const r2 = range * range;
    for (const b of bodies) {
      const dx = b.x - camX;
      const dz = b.z - camZ;
      if (dx * dx + dz * dz > r2) continue;
      if (b.kind === 'block') this.cell(out, b, 0, 0, 0, b.state, 1, env);
      else if (b.kind === 'compound') for (const c of b.cells) this.cell(out, b, c.dx, c.dy, c.dz, c.state, 1, env);
      else this.item(out, b, env);
    }
  }

  private item(out: EntityRenderer, b: BodyView, env: Environment): void {
    const def = ITEMS[b.item];
    if (!def) return;
    if (def.block >= 0) {
      this.cell(out, b, 0, 0, 0, def.block, ITEM_SIZE, env);
      // A stack shows as a second one tucked behind the first.
      if (b.count > 1) this.cell(out, b, 0.32, 0.18, 0.28, def.block, ITEM_SIZE, env);
      return;
    }
    const c = GOOD_COLOR[def.name] ?? PLAIN;
    const light = this.lightAt(b.x, b.y, b.z);
    const h = ITEM_SIZE / 2;
    out.addBox(b.x, b.y, b.z, h, h, h, b.qx, b.qy, b.qz, b.qw, c[0], c[1], c[2], (light >> 4) / 15, (light & 15) / 15);
    if (b.count > 1) {
      turn(b, 0.1, 0.06, 0.09);
      out.addBox(b.x + v.x, b.y + v.y, b.z + v.z, h, h, h, b.qx, b.qy, b.qz, b.qw, c[0] * 0.9, c[1] * 0.9, c[2] * 0.9, (light >> 4) / 15, (light & 15) / 15);
    }
  }

  /** One block of a body: its cell offset in the body's frame, drawn at `scale` (1 for a block, smaller for a dropped item). */
  private cell(out: EntityRenderer, b: BodyView, dx: number, dy: number, dz: number, state: number, scale: number, env: Environment): void {
    const s = BLOCKS[state] as BlockState | undefined;
    if (!s || state === 0) return;
    turn(b, dx * scale, dy * scale, dz * scale);
    const cx = b.x + v.x;
    const cy = b.y + v.y;
    const cz = b.z + v.z;
    const light = this.lightAt(cx, cy, cz);
    const sky = (light >> 4) / 15;
    const block = (light & 15) / 15;
    const tint = s.tint === TINT_GRASS ? env.grassTint : s.tint === TINT_FOLIAGE ? env.foliageTint : s.tint === TINT_BIRCH ? env.birchTint : WHITE;
    const glow = (EMIT[state] as number) > 0 ? 0.5 : 0;
    const { qx, qy, qz, qw } = b;
    if (s.shape === SHAPE_CROSS || s.shape === SHAPE_CROP) {
      // A plant is drawn as a card of its tile.
      out.addBox(cx, cy, cz, 0.5 * scale, 0.5 * scale, 0.03 * scale, qx, qy, qz, qw, tint[0], tint[1], tint[2], sky, block, glow, s.tiles);
      return;
    }
    const boxes = (s.shape === SHAPE_BOXES || s.shape === SHAPE_CONNECT) && s.boxes.length > 0 ? s.boxes : null;
    if (!boxes) {
      out.addBox(cx, cy, cz, 0.5 * scale, 0.5 * scale, 0.5 * scale, qx, qy, qz, qw, tint[0], tint[1], tint[2], sky, block, glow, s.tiles);
      return;
    }
    for (const q of boxes) {
      turn(b, ((q.x0 + q.x1) / 32 - 0.5) * scale, ((q.y0 + q.y1) / 32 - 0.5) * scale, ((q.z0 + q.z1) / 32 - 0.5) * scale);
      out.addBox(cx + v.x, cy + v.y, cz + v.z, ((q.x1 - q.x0) / 32) * scale, ((q.y1 - q.y0) / 32) * scale, ((q.z1 - q.z0) / 32) * scale,
        qx, qy, qz, qw, tint[0], tint[1], tint[2], sky, block, glow, q.tiles ?? s.tiles);
    }
  }

  /** Voxel light at a point, taking the cell above when the point itself is buried in something opaque. */
  private lightAt(x: number, y: number, z: number): number {
    const xi = Math.floor(x);
    const yi = Math.floor(y);
    const zi = Math.floor(z);
    const here = this.world.getLight(xi, yi, zi);
    return here !== 0 ? here : this.world.getLight(xi, yi + 1, zi);
  }
}
