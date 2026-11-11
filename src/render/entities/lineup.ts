// One of every creature stood in two rows, for looking at models and poses.

import { type AnimState, ENTITY_KINDS, type EntityView } from '../../sim/api';
import type { World } from '../../world/world';

/** Ids used by the line-up; no simulation hands these out. */
const FIRST_ID = 900000;

/** Views for a row of every kind of creature in front of a viewer at (x, y, z) facing `yaw`, each in the given pose. */
export function lineUp(world: World, x: number, y: number, z: number, yaw: number, anim: AnimState): EntityView[] {
  const out: EntityView[] = [];
  const fx = Math.sin(yaw);
  const fz = Math.cos(yaw);
  ENTITY_KINDS.forEach((kind, i) => {
    for (let row = 0; row < 2; row++) {
      const side = (i - (ENTITY_KINDS.length - 1) / 2) * 1.5;
      const ahead = 5 + row * 2.2;
      const px = x + fx * ahead + fz * side;
      const pz = z + fz * ahead - fx * side;
      const py = world.groundY(Math.floor(px), Math.floor(pz), Math.floor(y) + 6) + 1;
      out.push({
        id: FIRST_ID + i * 2 + row, kind, look: i * 7 + row * 3 + 1, role: i + row * 5, x: px, y: py, z: pz, yaw: yaw + Math.PI + (row ? 0.6 : 0),
        anim, animTime: i * 0.3, scale: 1, held: -1, bubble: '',
      });
    }
  });
  return out;
}
