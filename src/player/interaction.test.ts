import { describe, expect, it } from 'vitest';
import type { EntityView } from '../sim/api';
import { watchAttachments } from '../world/attach';
import { B, doorState, isDoor } from '../world/blocks';
import { dropOf, item } from '../world/items';
import { type World, createFlatWorld } from '../world/world';
import { type Aim, type Controls, Interaction, type InteractionHooks } from './interaction';
import { Inventory, SLOTS } from './inventory';
import { CREATURE_HEIGHT, pickCreature } from './pick';

const GROUND = 32; // feet rest here on the flat world

/** A player standing at (x, GROUND, z) looking at a point. */
function aimAt(x: number, z: number, tx: number, ty: number, tz: number): Aim {
  const eye = { x, y: GROUND + 1.62, z };
  const d = Math.hypot(tx - eye.x, ty - eye.y, tz - eye.z);
  const look = { x: (tx - eye.x) / d, y: (ty - eye.y) / d, z: (tz - eye.z) / d };
  return { x, y: GROUND, z, yaw: Math.atan2(look.x, look.z), eye, look };
}

/** Input for one frame: which buttons are held, and which were pressed this frame. */
const controls = (held: number[], clicked: number[] = []): Controls => ({
  buttons: new Set(held),
  enabled: true,
  click: (b) => clicked.includes(b),
  hit: () => false,
  consumeWheel: () => 0,
});

/** A world with the drops of everything that comes loose collected, as the game collects them. */
function scene(): { world: World; inv: Inventory; drops: number[]; hooks: InteractionHooks } {
  const world = createFlatWorld(32, 32, GROUND - 1, 64);
  const inv = new Inventory();
  const drops: number[] = [];
  const take = (id: number, count: number): void => {
    for (let i = 0; i < count; i++) drops.push(id);
  };
  watchAttachments(world, (_x, _y, _z, state) => {
    const d = dropOf(state);
    if (d) take(d.id, 1);
  });
  const hooks: InteractionHooks = {
    broke: (_x, _y, _z, _state, drop) => {
      if (drop) take(drop.item, drop.count);
    },
    gained: (_x, _y, _z, id, count) => take(id, count),
  };
  return { world, inv, drops, hooks };
}

describe('breaking, using and placing blocks', () => {
  it('takes as long to break a block as its hardness says, and yields its drop once', () => {
    const { world, inv, drops, hooks } = scene();
    world.set(10, GROUND, 12, B.oak_planks);
    const act = new Interaction();
    const player = aimAt(10.5, 9.5, 10.5, GROUND + 0.5, 12);
    // Wood takes a second by hand.
    for (let i = 0; i < 50; i++) act.update(1 / 60, controls([0]), player, world, inv, hooks);
    expect(world.get(10, GROUND, 12)).toBe(B.oak_planks);
    expect(act.progress).toBeGreaterThan(0.7);
    for (let i = 0; i < 20; i++) act.update(1 / 60, controls([0]), player, world, inv, hooks);
    expect(world.get(10, GROUND, 12)).toBe(B.air);
    expect(drops).toEqual([item('oak_planks').id]);
  });

  it('does not bring back a door that is broken and right-clicked in the same frame', () => {
    const { world, inv, drops, hooks } = scene();
    world.set(10, GROUND, 12, doorState(0, false, false));
    world.set(10, GROUND + 1, 12, doorState(0, true, false));
    const act = new Interaction();
    const player = aimAt(10.5, 9.5, 10.5, GROUND + 0.5, 12.1);
    let frames = 0;
    // Hold the left button until the frame that breaks it; on that very frame the right button is pressed too.
    while (isDoor(world.get(10, GROUND, 12)) && frames++ < 600) {
      const last = act.progress + (1 / 60) / 1 >= 1;
      act.update(1 / 60, controls([0, ...(last ? [2] : [])], last ? [2] : []), player, world, inv, hooks);
    }
    expect(frames).toBeLessThan(600);
    // Both halves are gone and stay gone, and the door came away once.
    expect(isDoor(world.get(10, GROUND, 12))).toBe(false);
    expect(isDoor(world.get(10, GROUND + 1, 12))).toBe(false);
    expect(drops.filter((d) => d === item('door').id)).toHaveLength(1);
  });

  it('opens a door with a right click, both halves together', () => {
    const { world, inv, hooks } = scene();
    world.set(10, GROUND, 12, doorState(0, false, false));
    world.set(10, GROUND + 1, 12, doorState(0, true, false));
    const act = new Interaction();
    act.update(1 / 60, controls([2], [2]), aimAt(10.5, 9.5, 10.5, GROUND + 0.5, 12.1), world, inv, hooks);
    expect(world.get(10, GROUND, 12)).toBe(doorState(0, false, true));
    expect(world.get(10, GROUND + 1, 12)).toBe(doorState(0, true, true));
  });

  it('picks a ripe bush into the world, and into a pack only when it fits', () => {
    const { world, inv, drops, hooks } = scene();
    const berries = item('berries').id;
    const player = aimAt(10.5, 9.5, 10.5, GROUND + 0.4, 12.5);
    const click = (h: InteractionHooks): void => new Interaction().update(1 / 60, controls([2], [2]), player, world, inv, h);

    // With the game's hook the berries are handed over and the bush is left bare.
    world.set(10, GROUND, 12, B.berry_bush + 1);
    click(hooks);
    expect(world.get(10, GROUND, 12)).toBe(B.berry_bush);
    expect(drops).toEqual([berries, berries]);

    // Without one they go into the pack, unless it is full: then the bush is left alone.
    world.set(10, GROUND, 12, B.berry_bush + 1);
    for (let i = 0; i < SLOTS; i++) inv.slots[i] = { item: item('stone').id, count: 99 };
    click({});
    expect(world.get(10, GROUND, 12)).toBe(B.berry_bush + 1);
    expect(inv.count(berries)).toBe(0);
    inv.slots[5] = null;
    click({});
    expect(world.get(10, GROUND, 12)).toBe(B.berry_bush);
    expect(inv.count(berries)).toBe(2);
  });

  it('places the held block against the face aimed at, and never where the player stands', () => {
    const { world, inv, hooks } = scene();
    inv.slots[0] = { item: item('cobble').id, count: 2 };
    const act = new Interaction();
    // Aimed at the ground two blocks ahead: the block goes on top of it.
    act.update(1 / 60, controls([2], [2]), aimAt(10.5, 9.5, 10.5, GROUND - 0.001, 11.5), world, inv, hooks);
    expect(world.get(10, GROUND, 11)).toBe(B.cobble);
    expect(inv.count(item('cobble').id)).toBe(1);
    // Aimed at the ground under their own feet: nothing is placed.
    const down = new Interaction();
    down.update(1 / 60, controls([2], [2]), aimAt(20.5, 20.5, 20.5, GROUND - 0.001, 20.5), world, inv, hooks);
    expect(world.get(20, GROUND, 20)).toBe(B.air);
    expect(inv.count(item('cobble').id)).toBe(1);
  });
});

describe('the pack', () => {
  it('knows how much more of a thing it can take', () => {
    const inv = new Inventory();
    const bread = item('bread').id;
    expect(inv.room(bread)).toBe(SLOTS * 99);
    for (let i = 0; i < SLOTS; i++) inv.slots[i] = { item: item('stone').id, count: 99 };
    expect(inv.room(bread)).toBe(0);
    inv.slots[3] = { item: bread, count: 90 };
    inv.slots[4] = null;
    expect(inv.room(bread)).toBe(9 + 99);
    expect(inv.add(bread, 120)).toBe(12);
  });
});

describe('looking at creatures', () => {
  const creature = (kind: EntityView['kind'], scale: number): EntityView => ({
    id: 1, kind, look: 1, role: 0, x: 10.5, y: GROUND, z: 14.5, yaw: 0, anim: 'idle', animTime: 0, scale, held: -1, bubble: '',
  });

  it('finds a child by its head as well as its feet', () => {
    const child = creature('child', 0.68);
    const eye = { x: 10.5, y: GROUND + 1.62, z: 10.5 };
    const toward = (ty: number): { x: number; y: number; z: number } => {
      const d = Math.hypot(ty - eye.y, 4);
      return { x: 0, y: (ty - eye.y) / d, z: 4 / d };
    };
    // The head of a child drawn at this scale is about a metre up; its feet are on the ground.
    expect(pickCreature([child], eye, toward(GROUND + 1.03), 6.5)).toBe(child);
    expect(pickCreature([child], eye, toward(GROUND + 0.2), 6.5)).toBe(child);
    // Over its head there is nothing.
    expect(pickCreature([child], eye, toward(GROUND + CREATURE_HEIGHT.child * 0.68 + 0.25), 6.5)).toBeNull();
  });

  it('does not reach past a nearer block, nor beyond its range', () => {
    const adult = creature('villager', 1);
    const eye = { x: 10.5, y: GROUND + 1.62, z: 10.5 };
    const look = { x: 0, y: -0.15, z: 0.9887 };
    expect(pickCreature([adult], eye, look, 6.5)).toBe(adult);
    expect(pickCreature([adult], eye, look, 2)).toBeNull();
    expect(pickCreature([{ ...adult, z: 19 }], eye, look, 6.5)).toBeNull();
  });
});
