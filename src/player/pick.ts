// Which creature the player is looking at: the view ray against a box round
// each one near enough to matter.

import type { EntityKind, EntityView } from '../sim/api';

/**
 * Rough standing height of each kind of creature in metres at scale 1, for picking and for placing
 * words above it; the height of a particular one is this times its `scale`. A child is the adult
 * model drawn small (with a larger head), so its entry is the adult's and its scale does the rest.
 */
export const CREATURE_HEIGHT: Record<EntityKind, number> = {
  villager: 1.8, child: 1.8, sheep: 0.9, cow: 1.3, chicken: 0.5, deer: 1.45, rabbit: 0.45, fox: 0.6, wolf: 0.95, boar: 0.85,
  songbird: 0.3, crow: 0.35, gull: 0.35, duck: 0.4, fish: 0.3,
};

interface Point {
  x: number;
  y: number;
  z: number;
}

/** The nearest creature the ray from `eye` along `look` meets before `reach` metres, or null. */
export function pickCreature(seen: readonly EntityView[], eye: Point, look: Point, reach: number): EntityView | null {
  let best: EntityView | null = null;
  let bestT = reach;
  const o = [eye.x, eye.y, eye.z];
  const d = [look.x, look.y, look.z];
  for (const v of seen) {
    const dx = v.x - eye.x;
    const dz = v.z - eye.z;
    if (dx * dx + dz * dz > 64) continue;
    const h = CREATURE_HEIGHT[v.kind] * v.scale;
    const r = Math.max(0.28, h * 0.3);
    // Slab test against a box around the creature.
    let t0 = 0;
    let t1 = bestT;
    const lo = [v.x - r, v.y, v.z - r];
    const hi = [v.x + r, v.y + h, v.z + r];
    let hit = true;
    for (let a = 0; a < 3 && hit; a++) {
      if (Math.abs(d[a] as number) < 1e-9) {
        if ((o[a] as number) < (lo[a] as number) || (o[a] as number) > (hi[a] as number)) hit = false;
        continue;
      }
      let ta = ((lo[a] as number) - (o[a] as number)) / (d[a] as number);
      let tb = ((hi[a] as number) - (o[a] as number)) / (d[a] as number);
      if (ta > tb) [ta, tb] = [tb, ta];
      t0 = Math.max(t0, ta);
      t1 = Math.min(t1, tb);
      if (t0 > t1) hit = false;
    }
    if (hit && t0 < bestT) {
      bestT = t0;
      best = v;
    }
  }
  return best;
}
