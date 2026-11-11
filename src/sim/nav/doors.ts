// Doors and gates as walkers use them: whoever is about to pass opens the
// leaf, and it closes behind the last one through. A count per doorway keeps
// two people in the same doorway from shutting it on each other.

import { B, isDoor, isGate } from '../../world/blocks';
import type { World } from '../../world/world';
import { cellX, cellY, cellZ, packCell } from './cells';

export class Doors {
  private readonly world: World;
  /** Walkers currently holding each doorway open, by packed cell of the lower block. */
  private readonly holders = new Map<number, number>();

  constructor(world: World) {
    this.world = world;
  }

  /**
   * Open the door or gate in this feet cell, if there is one, and hold it.
   * Returns the key to release later, or -1 when the cell has no door.
   */
  acquire(x: number, y: number, z: number): number {
    const state = this.world.get(x, y, z);
    if (!isDoor(state) && !isGate(state)) return -1;
    const key = packCell(x, y, z);
    this.holders.set(key, (this.holders.get(key) ?? 0) + 1);
    this.setOpen(x, y, z, true);
    return key;
  }

  /** Let go of a doorway; it closes when nobody else is in it. */
  release(key: number): void {
    const n = (this.holders.get(key) ?? 0) - 1;
    if (n > 0) {
      this.holders.set(key, n);
      return;
    }
    this.holders.delete(key);
    this.setOpen(cellX(key), cellY(key), cellZ(key), false);
  }

  /** Doorways currently held open (for tests). */
  get held(): number {
    return this.holders.size;
  }

  private setOpen(x: number, y: number, z: number, open: boolean): void {
    const world = this.world;
    const bit = open ? 1 : 0;
    const state = world.get(x, y, z);
    if (isGate(state)) {
      world.set(x, y, z, B.gate + (((state - B.gate) & ~1) | bit));
      return;
    }
    if (!isDoor(state)) return;
    world.set(x, y, z, B.door + (((state - B.door) & ~1) | bit));
    // The other half of the leaf sits above a lower block and below an upper one.
    const oy = ((state - B.door) & 2) === 0 ? y + 1 : y - 1;
    const other = world.get(x, oy, z);
    if (isDoor(other)) world.set(x, oy, z, B.door + (((other - B.door) & ~1) | bit));
  }
}
