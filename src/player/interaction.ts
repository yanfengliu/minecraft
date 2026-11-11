// What the player does to blocks: aim, break (held left button, time by
// hardness), place or use (right button). Orientation of placed blocks follows
// where the player stands and what they clicked.

import {
  B, BLOCKS, FACING_STEP, REPLACEABLE, SOLID, WATER_LEVEL, bedState, doorIsOpen, doorState, gateState, isBed, isDoor,
  isGate,
} from '../world/blocks';
import { ITEMS, dropOf, item } from '../world/items';
import { type RayHit, raycast } from '../world/raycast';
import type { World } from '../world/world';
import type { Inventory } from './inventory';

export const REACH = 5.2;

export interface InteractionHooks {
  /** A block was broken by the player; `drop` is what it yields, if anything. */
  broke?(x: number, y: number, z: number, state: number, drop: { item: number; count: number } | null): void;
  placed?(x: number, y: number, z: number, state: number): void;
  /** Give other systems first refusal on a right click (talking to a villager, say). Return true if handled. */
  use?(hit: RayHit | null): boolean;
  /**
   * Something came off a block that stays where it is (berries off a bush): put `count` of `item`
   * into the world at that cell. Without this hook it goes straight into the pack, and only if it fits.
   */
  gained?(x: number, y: number, z: number, item: number, count: number): void;
}

/** The part of the input the interaction reads; `Input` satisfies it, and a test can stand in for it. */
export interface Controls {
  readonly buttons: ReadonlySet<number>;
  readonly enabled: boolean;
  click(button: number): boolean;
  hit(code: string): boolean;
  consumeWheel(): number;
}

/** Where the player is and where they are looking; `Player` satisfies it. */
export interface Aim {
  readonly x: number;
  readonly y: number;
  readonly z: number;
  readonly yaw: number;
  readonly eye: { x: number; y: number; z: number };
  readonly look: { x: number; y: number; z: number };
}

const BERRIES_PER_BUSH = 2;

/** Facing index (0 N, 1 E, 2 S, 3 W) the player is looking toward. */
function facingOf(yaw: number): number {
  const sx = Math.sin(yaw);
  const cz = Math.cos(yaw);
  if (Math.abs(sx) > Math.abs(cz)) return sx > 0 ? 1 : 3;
  return cz > 0 ? 2 : 0;
}

const litFamilies = new Set(['lantern', 'hanging_lantern', 'campfire']);

export class Interaction {
  target: RayHit | null = null;
  /** 0..1 progress of the block being broken. */
  progress = 0;
  private breaking: { x: number; y: number; z: number } | null = null;
  private placeCooldown = 0;

  /** `reach` shortens the arm when something that is not a block (a loose body) is in the way. */
  update(dt: number, input: Controls, player: Aim, world: World, inv: Inventory, hooks: InteractionHooks = {}, reach = REACH): void {
    const e = player.eye;
    const l = player.look;
    const aim = (): RayHit | null => raycast(world, e.x, e.y, e.z, l.x, l.y, l.z, Math.min(reach, REACH));
    this.target = aim();
    this.placeCooldown = Math.max(0, this.placeCooldown - dt);

    // --- breaking ---
    let t = this.target;
    if (input.buttons.has(0) && t && input.enabled) {
      if (!this.breaking || this.breaking.x !== t.x || this.breaking.y !== t.y || this.breaking.z !== t.z) {
        this.breaking = { x: t.x, y: t.y, z: t.z };
        this.progress = 0;
      }
      const hardness = (BLOCKS[t.state] as (typeof BLOCKS)[number]).hardness;
      if (Number.isFinite(hardness)) {
        this.progress += dt / Math.max(hardness, 0.05);
        if (this.progress >= 1) {
          this.breakBlock(world, inv, t, hooks);
          this.breaking = null;
          this.progress = 0;
          // The block aimed at is gone. Whatever else happens this frame (a right click) must act on what
          // is there now: used on the old hit, a door that had just been broken was written back.
          t = this.target = aim();
        }
      }
    } else {
      this.breaking = null;
      this.progress = 0;
    }

    // --- using and placing ---
    if ((input.click(2) || (input.buttons.has(2) && this.placeCooldown === 0)) && input.enabled) {
      if (input.click(2) && hooks.use?.(t)) {
        this.placeCooldown = 0.25;
      } else if (t && input.click(2) && this.useBlock(world, inv, t, hooks)) {
        this.placeCooldown = 0.25;
      } else if (t && this.placeCooldown === 0) {
        if (this.place(world, inv, player, t, hooks)) this.placeCooldown = 0.22;
      }
    }

    // --- hotbar selection ---
    for (let i = 0; i < 9; i++) if (input.hit(`Digit${i + 1}`)) inv.selected = i;
    const wheel = input.consumeWheel();
    if (wheel !== 0) inv.selected = (inv.selected + wheel + 9) % 9;
  }

  private breakBlock(world: World, inv: Inventory, t: RayHit, hooks: InteractionHooks): void {
    const state = t.state;
    const d = dropOf(state);
    let drop = d ? { item: d.id, count: 1 } : null;
    // Ripe crops give a harvest; leaves now and then give a sapling.
    const family = (BLOCKS[state] as (typeof BLOCKS)[number]).family;
    if (drop && (family === 'wheat' || family === 'barley' || family === 'turnip' || family === 'cabbage')) drop.count = 2;
    // A ripe bush that is grubbed up still gives its berries (they are lost only if nobody can take them).
    if (family === 'berry_bush' && state === B.berry_bush + 1) {
      if (hooks.gained) hooks.gained(t.x, t.y, t.z, item('berries').id, BERRIES_PER_BUSH);
      else inv.add(item('berries').id, Math.min(BERRIES_PER_BUSH, inv.room(item('berries').id)));
    }
    if (!drop && family.endsWith('_leaves') && (t.x * 7 + t.y * 13 + t.z * 31) % 11 === 0) {
      drop = { item: item(family.replace('_leaves', '_sapling')).id, count: 1 };
    }

    // A waterlogged plant leaves its water behind.
    world.set(t.x, t.y, t.z, WATER_LEVEL[state] && state === B.seagrass ? B.water_source : B.air);
    // A bed is two blocks; take the other half too. (A door's other half comes away by itself: see world/attach.ts.)
    if (isBed(state)) {
      const v = state - B.bed;
      const [dx, dz] = FACING_STEP[v >> 1] as readonly [number, number];
      const head = (v & 1) === 1;
      const ox = t.x + (head ? -dx : dx);
      const oz = t.z + (head ? -dz : dz);
      if (isBed(world.get(ox, t.y, oz))) world.set(ox, t.y, oz, B.air);
      drop = { item: item('bed').id, count: 1 };
    }
    hooks.broke?.(t.x, t.y, t.z, state, drop);
  }

  /** Right click on something that responds: doors, gates, lights, berry bushes. */
  private useBlock(world: World, inv: Inventory, t: RayHit, hooks: InteractionHooks): boolean {
    const s = t.state;
    if (isDoor(s)) {
      const v = s - B.door;
      const upper = (v & 2) !== 0;
      const open = !doorIsOpen(s);
      const facing = v >> 2;
      world.set(t.x, t.y, t.z, doorState(facing, upper, open));
      const oy = upper ? t.y - 1 : t.y + 1;
      if (isDoor(world.get(t.x, oy, t.z))) world.set(t.x, oy, t.z, doorState(facing, !upper, open));
      return true;
    }
    if (isGate(s)) {
      const v = s - B.gate;
      world.set(t.x, t.y, t.z, gateState(v >> 1, (v & 1) === 0));
      return true;
    }
    const def = BLOCKS[s] as (typeof BLOCKS)[number];
    if (litFamilies.has(def.family)) {
      world.set(t.x, t.y, t.z, s - def.variant + (def.variant ? 0 : 1));
      return true;
    }
    if (s === B.berry_bush + 1) {
      const berries = item('berries').id;
      // Picked into the world for the game to hand over, or into the pack; never stripped for nothing.
      if (hooks.gained) hooks.gained(t.x, t.y, t.z, berries, BERRIES_PER_BUSH);
      else if (inv.room(berries) >= BERRIES_PER_BUSH) inv.add(berries, BERRIES_PER_BUSH);
      // No room: the bush keeps its berries, and the click was still meant for it, not for placing a block.
      else return true;
      world.set(t.x, t.y, t.z, B.berry_bush);
      return true;
    }
    return false;
  }

  private place(world: World, inv: Inventory, player: Aim, t: RayHit, hooks: InteractionHooks): boolean {
    const held = inv.held;
    if (!held) return false;
    const def = ITEMS[held.item];
    if (!def || def.block < 0) return false;

    // Into the clicked cell if what is there gives way (grass, water); otherwise against the clicked face.
    let x = t.x;
    let y = t.y;
    let z = t.z;
    if (!REPLACEABLE[t.state]) {
      x += t.nx;
      y += t.ny;
      z += t.nz;
    }
    if (!world.inBounds(x, y, z) || !REPLACEABLE[world.get(x, y, z)]) return false;

    const base = def.block;
    const family = def.name;
    const facing = facingOf(player.yaw);
    let state = base;
    let second: { x: number; y: number; z: number; state: number } | null = null;

    if (family.endsWith('_stairs')) state = base + facing;
    else if (family.endsWith('_slab')) state = base + (t.ny < 0 || (t.ny === 0 && t.py - Math.floor(t.py) > 0.5) ? 1 : 0);
    else if (family.endsWith('_log') || family === 'beam') state = base + (t.nx !== 0 ? 1 : t.nz !== 0 ? 2 : 0);
    else if (family === 'ladder') {
      if (t.ny !== 0) return false;
      // Fixed to the face that was clicked.
      state = base + (t.nz === 1 ? 0 : t.nx === -1 ? 1 : t.nz === -1 ? 2 : 3);
    } else if (family === 'torch') {
      if (t.ny < 0) return false;
      if (t.ny === 0) state = B.wall_torch + (t.nz === -1 ? 0 : t.nx === 1 ? 1 : t.nz === 1 ? 2 : 3);
    } else if (family === 'lantern') {
      state = t.ny < 0 ? B.hanging_lantern + 1 : B.lantern + 1;
    } else if (family === 'oven') state = base + ((facing + 2) & 3) * 2;
    else if (family === 'gate') state = gateState(facing === 0 || facing === 2 ? 0 : 1, false);
    else if (family === 'anvil') state = base + (facing === 0 || facing === 2 ? 1 : 0);
    else if (family === 'door') {
      if (!REPLACEABLE[world.get(x, y + 1, z)] || !SOLID[world.get(x, y - 1, z)]) return false;
      // The leaf hangs on the edge of the cell nearest the player.
      const f = (facing + 2) & 3;
      state = doorState(f, false, false);
      second = { x, y: y + 1, z, state: doorState(f, true, false) };
    } else if (family === 'bed') {
      const [dx, dz] = FACING_STEP[facing] as readonly [number, number];
      if (!REPLACEABLE[world.get(x + dx, y, z + dz)]) return false;
      state = bedState(facing, false);
      second = { x: x + dx, y, z: z + dz, state: bedState(facing, true) };
    }

    // Never wall the player into the block they are standing in.
    if (SOLID[state]) {
      const hw = 0.3;
      if (x + 1 > player.x - hw && x < player.x + hw && z + 1 > player.z - hw && z < player.z + hw && y + 1 > player.y && y < player.y + 1.8) return false;
    }
    world.set(x, y, z, state);
    if (second) world.set(second.x, second.y, second.z, second.state);
    inv.consumeHeld();
    hooks.placed?.(x, y, z, state);
    return true;
  }
}
