// Dropped items: small bodies that pile up into stacks, wait to be picked up,
// and fade after a while. Identical items lying together merge into one body,
// so mining a hundred blocks leaves a few stacks rather than a hundred cubes.

import { MAT, MATERIAL } from '../world/blocks';
import { ITEMS, dropOf, type ItemDef, type ItemStack } from '../world/items';
import type { Body } from './body';
import type { RigidBodies } from './rigid';
import { ITEM_SIZE } from './types';

export const ITEM_HALF = ITEM_SIZE / 2;
/** Identical items closer than this merge, in metres. */
const MERGE_RADIUS = 1.2;
/** ...unless either is moving faster than this, so stacks form on the ground and not in mid-air. */
const MERGE_SPEED = 2;

/** The material an item's body is made of: its block's, or wood-like for goods (they float). */
export function itemMaterial(item: number): number {
  const def = ITEMS[item];
  return def && def.block >= 0 ? (MATERIAL[def.block] as number) : MAT.wood;
}

function stackLimit(item: number): number {
  return (ITEMS[item] as ItemDef | undefined)?.stack ?? 99;
}

/**
 * Spawn an item body, or add to an identical stack already lying within reach
 * of the spot. Returns the body that now holds the items.
 */
export function addItem(sys: RigidBodies, item: number, count: number, x: number, y: number, z: number, velocity?: { x: number; y: number; z: number }): Body {
  const limit = stackLimit(item);
  // Thrown items are on their way somewhere; only something dropped in place joins a stack at once.
  if (!velocity || Math.hypot(velocity.x, velocity.y, velocity.z) < MERGE_SPEED) {
    for (const b of sys.bodies) {
      if (b.dead || b.kind !== 'item' || b.view.item !== item || b.view.count + count > limit) continue;
      const v = b.view;
      if ((v.x - x) ** 2 + (v.y - y) ** 2 + (v.z - z) ** 2 > MERGE_RADIUS * MERGE_RADIUS) continue;
      v.count += count;
      b.age = 0;
      return b;
    }
  }
  return sys.create([], x, y, z, { item, count, velocity });
}

/** Drop what a block state yields at a spot, if it yields anything. Returns false when it drops nothing. */
export function dropBlock(sys: RigidBodies, state: number, x: number, y: number, z: number): boolean {
  const def = dropOf(state);
  if (!def) return false;
  addItem(sys, def.id, 1, x, y, z);
  return true;
}

/** Merge identical item bodies lying close together; the older body keeps the stack. */
export function mergeItems(sys: RigidBodies): void {
  const items = sys.bodies.filter((b) => b.kind === 'item' && !b.dead);
  if (items.length < 2) return;
  // Sorted by kind then x, so candidates for a merge are neighbours in the list.
  items.sort((a, b) => a.view.item - b.view.item || a.view.x - b.view.x || a.born - b.born);
  for (let i = 0; i < items.length; i++) {
    const a = items[i] as Body;
    if (a.dead || Math.hypot(a.vx, a.vy, a.vz) > MERGE_SPEED) continue;
    const limit = stackLimit(a.view.item);
    for (let k = i + 1; k < items.length; k++) {
      const b = items[k] as Body;
      if (b.view.item !== a.view.item || b.view.x - a.view.x > MERGE_RADIUS) break;
      if (b.dead || Math.hypot(b.vx, b.vy, b.vz) > MERGE_SPEED || a.view.count + b.view.count > limit) continue;
      if ((b.view.x - a.view.x) ** 2 + (b.view.y - a.view.y) ** 2 + (b.view.z - a.view.z) ** 2 > MERGE_RADIUS * MERGE_RADIUS) continue;
      const keep = a.born < b.born ? a : b;
      const gone = keep === a ? b : a;
      keep.view.count += gone.view.count;
      keep.age = Math.min(keep.age, gone.age);
      sys.remove(gone);
      if (gone === a) break;
    }
  }
}

/** Remove the item bodies within `radius` of a point and return what they held, one stack per kind. */
export function collectItems(sys: RigidBodies, x: number, y: number, z: number, radius: number): ItemStack[] {
  const got = new Map<number, number>();
  for (const b of sys.bodies) {
    if (b.dead || b.kind !== 'item') continue;
    const v = b.view;
    if ((v.x - x) ** 2 + (v.y - y) ** 2 + (v.z - z) ** 2 > radius * radius) continue;
    got.set(v.item, (got.get(v.item) ?? 0) + v.count);
    sys.remove(b);
  }
  return [...got.entries()].sort((a, b) => a[0] - b[0]).map(([item, count]) => ({ item, count }));
}

/** Items past their lifetime vanish, and so do the oldest when there are too many. Both are counted as gone. */
export function despawnOldItems(sys: RigidBodies): void {
  let live = 0;
  for (const b of sys.bodies) {
    if (b.dead || b.kind !== 'item') continue;
    if (b.age >= sys.itemLifetime) sys.forget(b);
    else live++;
  }
  if (live <= sys.maxItems) return;
  const oldest = sys.bodies.filter((b) => b.kind === 'item' && !b.dead).sort((a, b) => a.born - b.born);
  for (let i = 0; i < live - sys.maxItems; i++) sys.forget(oldest[i] as Body);
}
