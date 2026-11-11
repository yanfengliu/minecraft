// What the player carries: stacks of items in slots (the first nine are the
// hotbar) and a purse of coins.

import { ITEMS, type ItemStack, item } from '../world/items';

export const HOTBAR = 9;
export const SLOTS = 36;

export class Inventory {
  readonly slots: (ItemStack | null)[] = new Array<ItemStack | null>(SLOTS).fill(null);
  selected = 0;
  coins = 60;
  /** Bumped on every change, so the interface knows when to redraw. */
  version = 0;

  get held(): ItemStack | null {
    return this.slots[this.selected] ?? null;
  }

  count(itemId: number): number {
    let n = 0;
    for (const s of this.slots) if (s && s.item === itemId) n += s.count;
    return n;
  }

  /** How many more of an item the pack can take: space in its stacks plus every empty slot. */
  room(itemId: number): number {
    const max = ITEMS[itemId]?.stack ?? 99;
    let n = 0;
    for (const s of this.slots) n += !s ? max : s.item === itemId ? max - s.count : 0;
    return n;
  }

  /** Add items, topping up existing stacks first. Returns how many did not fit. */
  add(itemId: number, count: number): number {
    const max = ITEMS[itemId]?.stack ?? 99;
    for (const s of this.slots) {
      if (count <= 0) break;
      if (s && s.item === itemId && s.count < max) {
        const n = Math.min(count, max - s.count);
        s.count += n;
        count -= n;
      }
    }
    for (let i = 0; i < SLOTS && count > 0; i++) {
      if (this.slots[i]) continue;
      const n = Math.min(count, max);
      this.slots[i] = { item: itemId, count: n };
      count -= n;
    }
    this.version++;
    return count;
  }

  /** Remove items if the player has that many. Returns whether it did. */
  remove(itemId: number, count: number): boolean {
    if (this.count(itemId) < count) return false;
    for (let i = SLOTS - 1; i >= 0 && count > 0; i--) {
      const s = this.slots[i];
      if (!s || s.item !== itemId) continue;
      const n = Math.min(count, s.count);
      s.count -= n;
      count -= n;
      if (s.count === 0) this.slots[i] = null;
    }
    this.version++;
    return true;
  }

  /** Take one from the held stack. */
  consumeHeld(): void {
    const s = this.slots[this.selected];
    if (!s) return;
    s.count--;
    if (s.count <= 0) this.slots[this.selected] = null;
    this.version++;
  }

  swap(a: number, b: number): void {
    const t = this.slots[a] ?? null;
    this.slots[a] = this.slots[b] ?? null;
    this.slots[b] = t;
    this.version++;
  }

  /** A builder's starting kit. */
  giveStarterKit(): void {
    const kit: [string, number][] = [
      ['oak_planks', 64], ['cobble', 64], ['stone_bricks', 48], ['oak_log', 32], ['window', 16], ['torch', 24],
      ['oak_stairs', 32], ['oak_slab', 32], ['lantern', 6], ['door', 2], ['fence', 24], ['ladder', 16],
      ['thatch', 48], ['sand', 32], ['gravel', 32], ['bread', 4],
    ];
    for (const [name, n] of kit) this.add(item(name).id, n);
  }
}
