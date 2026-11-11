import { describe, expect, it } from 'vitest';
import { B, doorIsOpen, doorState, gateState, isDoor, waterState } from '../../world/blocks';
import { isStandable } from '../../world/walk';
import { type World, createFlatWorld } from '../../world/world';
import type { EntityView } from '../api';
import {
  Doors, MOVE_ARRIVED, MOVE_WALKING, Navigator, PATH_FAILED, PATH_FOUND, PATH_PENDING, type Path, VILLAGER_WALK, createMover,
  nearestStandable, packCell, startPath, stepMover,
} from './index';

const G = 32;

function view(x: number, y: number, z: number): EntityView {
  return { id: 1, kind: 'villager', look: 0, role: 0, x: x + 0.5, y, z: z + 0.5, yaw: 0, anim: 'idle', animTime: 0, scale: 1, held: -1, bubble: '' };
}

function wall(world: World, x0: number, z0: number, x1: number, z1: number, height = 3, state = B.stone): void {
  for (let z = z0; z <= z1; z++) for (let x = x0; x <= x1; x++) for (let y = G; y < G + height; y++) world.set(x, y, z, state);
}

/** Every step of a route must be a move the rules allow. Returns the first problem, or ''. */
function illegalStep(world: World, p: Path): string {
  for (let i = 0; i < p.length; i++) {
    const x = p.xs[i]!;
    const y = p.ys[i]!;
    const z = p.zs[i]!;
    if (!isStandable(world, x, y, z, VILLAGER_WALK)) return `cell ${i} (${x},${y},${z}) is not standable`;
    if (i === 0) continue;
    const dx = x - p.xs[i - 1]!;
    const dy = y - p.ys[i - 1]!;
    const dz = z - p.zs[i - 1]!;
    if (Math.abs(dx) > 1 || Math.abs(dz) > 1 || Math.abs(dy) > 1 || (dx === 0 && dz === 0)) return `step ${i} jumps`;
    if (dx !== 0 && dz !== 0) {
      const px = p.xs[i - 1]!;
      const py = p.ys[i - 1]!;
      const pz = p.zs[i - 1]!;
      const side = (cx: number, cz: number): boolean => [py - 1, py, py + 1].some((cy) => isStandable(world, cx, cy, cz, VILLAGER_WALK));
      if (!side(px + dx, pz) || !side(px, pz + dz)) return `step ${i} cuts a corner`;
    }
  }
  return '';
}

function find(nav: Navigator, a: [number, number, number], b: [number, number, number]): Path | null {
  const req = nav.request(a[0], a[1], a[2], b[0], b[1], b[2]);
  for (let i = 0; i < 400 && req.status === PATH_PENDING; i++) nav.update();
  return req.status === PATH_FOUND ? req.path : null;
}

describe('pathfinding', () => {
  it('walks straight across open ground and takes the diagonal', () => {
    const world = createFlatWorld(64, 64, 31);
    const nav = new Navigator(world);
    const p = find(nav, [10, G, 10], [20, G, 20]);
    expect(p).not.toBeNull();
    expect(p!.length).toBe(11);
    expect(illegalStep(world, p!)).toBe('');
  });

  it('finds a route around a wall and never cuts its corners', () => {
    const world = createFlatWorld(64, 64, 31);
    wall(world, 20, 10, 20, 40);
    wall(world, 21, 40, 30, 40);
    const nav = new Navigator(world);
    const p = find(nav, [15, G, 25], [25, G, 25]);
    expect(p).not.toBeNull();
    expect(illegalStep(world, p!)).toBe('');
    expect(p!.length).toBeGreaterThan(25);
    for (let i = 0; i < p!.length; i++) expect(p!.xs[i] === 20 && p!.zs[i]! >= 10 && p!.zs[i]! <= 40).toBe(false);
  });

  it('prefers a made path to open grass and avoids crossing a field', () => {
    const world = createFlatWorld(64, 64, 31);
    // A field lies across the straight line; a path loops round it.
    for (let z = 20; z <= 30; z++) for (let x = 20; x <= 30; x++) world.set(x, 31, z, B.farmland);
    for (let x = 14; x <= 36; x++) world.set(x, 31, 18, B.path);
    for (let z = 18; z <= 25; z++) {
      world.set(14, 31, z, B.path);
      world.set(36, 31, z, B.path);
    }
    const nav = new Navigator(world);
    const p = find(nav, [14, G, 25], [36, G, 25]);
    expect(p).not.toBeNull();
    let onField = 0;
    let onPath = 0;
    for (let i = 0; i < p!.length; i++) {
      const below = world.get(p!.xs[i]!, p!.ys[i]! - 1, p!.zs[i]!);
      if (below === B.farmland) onField++;
      if (below === B.path) onPath++;
    }
    expect(onField).toBe(0);
    expect(onPath).toBeGreaterThan(p!.length * 0.8);
  });

  it('goes through a door, and the follower opens it ahead and closes it behind', () => {
    const world = createFlatWorld(64, 64, 31);
    wall(world, 20, 20, 26, 20);
    wall(world, 20, 26, 26, 26);
    wall(world, 20, 20, 20, 26);
    wall(world, 26, 20, 26, 26);
    world.set(23, G, 26, doorState(2, false, false));
    world.set(23, G + 1, 26, doorState(2, true, false));
    const nav = new Navigator(world);
    const p = find(nav, [23, G, 32], [23, G, 23]);
    expect(p).not.toBeNull();
    expect(illegalStep(world, p!)).toBe('');
    let throughDoor = false;
    for (let i = 0; i < p!.length; i++) if (p!.xs[i] === 23 && p!.zs[i] === 26) throughDoor = true;
    expect(throughDoor).toBe(true);

    const doors = new Doors(world);
    const v = view(23, G, 32);
    const m = createMover(v, 1.5, 1.5, true, VILLAGER_WALK);
    expect(startPath(m, p!, world, doors)).toBe(MOVE_WALKING);
    let sawOpen = false;
    let ticks = 0;
    while (stepMover(m, world, doors) === MOVE_WALKING && ticks++ < 2000) {
      const lower = world.get(23, G, 26);
      const upper = world.get(23, G + 1, 26);
      expect(isDoor(lower) && isDoor(upper)).toBe(true);
      expect(doorIsOpen(lower)).toBe(doorIsOpen(upper));
      if (doorIsOpen(lower)) sawOpen = true;
      // While in the doorway the leaf must be open.
      if (Math.floor(v.x) === 23 && Math.floor(v.z) === 26) expect(doorIsOpen(lower)).toBe(true);
    }
    expect(sawOpen).toBe(true);
    expect(world.get(23, G, 26)).toBe(doorState(2, false, false));
    expect(world.get(23, G + 1, 26)).toBe(doorState(2, true, false));
    expect(doors.held).toBe(0);
    expect(Math.floor(v.x)).toBe(23);
    expect(Math.floor(v.z)).toBe(23);
    // Heading follows the direction walked: north is -z, so yaw is near PI.
    expect(Math.abs(Math.abs(v.yaw) - Math.PI)).toBeLessThan(0.2);
    expect(v.animTime).toBeGreaterThan(5);
  });

  it('opens gates for villagers', () => {
    const world = createFlatWorld(64, 64, 31);
    for (let z = 0; z < 64; z++) world.set(30, G, z, B.fence);
    world.set(30, G, 20, gateState(1, false));
    const nav = new Navigator(world);
    const p = find(nav, [25, G, 40], [35, G, 40]);
    expect(p).not.toBeNull();
    expect(illegalStep(world, p!)).toBe('');
    let viaGate = false;
    for (let i = 0; i < p!.length; i++) if (p!.xs[i] === 30 && p!.zs[i] === 20) viaGate = true;
    expect(viaGate).toBe(true);
  });

  it('climbs up and down steps one level at a time, with a smoothly changing height', () => {
    const world = createFlatWorld(64, 64, 31);
    // A ridge two blocks high the whole width of the world, crossed only by steps at z = 20.
    for (let z = 0; z < 64; z++) wall(world, 31, z, 32, z, 2);
    world.set(29, G, 20, B.oak_slab);
    world.set(30, G, 20, B.cobble_stairs + 1);
    world.set(33, G, 20, B.stone);
    const nav = new Navigator(world);
    const p = find(nav, [25, G, 30], [38, G, 30]);
    expect(p).not.toBeNull();
    expect(illegalStep(world, p!)).toBe('');
    let top = 0;
    for (let i = 0; i < p!.length; i++) top = Math.max(top, p!.ys[i]!);
    expect(top).toBe(G + 2);

    const doors = new Doors(world);
    const v = view(25, G, 30);
    const m = createMover(v, 1.5, 1.5, true, VILLAGER_WALK);
    startPath(m, p!, world, doors);
    let maxY = v.y;
    let biggestJump = 0;
    let deepest = 0;
    let prev = v.y;
    let result = MOVE_WALKING;
    for (let t = 0; t < 3000 && result === MOVE_WALKING; t++) {
      result = stepMover(m, world, doors);
      biggestJump = Math.max(biggestJump, Math.abs(v.y - prev));
      prev = v.y;
      maxY = Math.max(maxY, v.y);
      // How far the feet are below the top of whatever they are over: a walker goes up a step before
      // crossing onto it and comes down after leaving it, so never inside the edge of a block.
      const fx = Math.floor(v.x);
      const fz = Math.floor(v.z);
      for (let y = Math.floor(v.y); y <= Math.floor(v.y) + 1; y++) {
        const boxes: number[] = [];
        world.collisionBoxes(fx, y, fz, boxes);
        for (let i = 0; i < boxes.length; i += 6) {
          const inside = v.x >= boxes[i]! && v.x <= boxes[i + 3]! && v.z >= boxes[i + 2]! && v.z <= boxes[i + 5]!;
          if (inside && boxes[i + 1]! <= v.y) deepest = Math.max(deepest, boxes[i + 4]! - v.y);
        }
      }
    }
    expect(result).toBe(MOVE_ARRIVED);
    expect(maxY).toBeCloseTo(G + 2, 5);
    expect(v.y).toBeCloseTo(G, 5);
    expect(biggestJump).toBeLessThan(0.5);
    expect(deepest).toBeLessThan(0.1);
  });

  it('gives a search room in proportion to the distance, so a long way round is still found', () => {
    const world = createFlatWorld(256, 96, 31);
    // Baffles every eight blocks, open at alternate ends: the only way along is a zigzag through thirty
    // rooms, and the search has to flood each of them. That is more than the fixed allowance that suits a
    // village, as the walk from the square to the woods of the generated island was.
    for (let i = 1; i <= 30; i++) {
      const open = i % 2 === 0 ? 2 : 93;
      for (let z = 0; z < 96; z++) if (Math.abs(z - open) > 1) wall(world, i * 8, z, i * 8, z);
    }
    const nav = new Navigator(world);
    const far = find(nav, [4, G, 48], [250, G, 48]);
    expect(far).not.toBeNull();
    expect(illegalStep(world, far!)).toBe('');
    expect(nav.stats.expansions).toBeGreaterThan(18000);

    // A goal a few steps off behind a wall with no way round still costs no more than the fixed allowance.
    const shut = createFlatWorld(256, 96, 31);
    for (let z = 0; z < 96; z++) wall(shut, 40, z, 40, z);
    const near = new Navigator(shut);
    expect(find(near, [36, G, 48], [44, G, 48])).toBeNull();
    expect(near.stats.expansions).toBeLessThanOrEqual(14000);
  });

  it('wades shallow water but refuses deep water', () => {
    const shallow = createFlatWorld(64, 64, 31);
    for (let z = 0; z < 64; z++) for (let x = 40; x <= 41; x++) shallow.set(x, G, z, waterState(4));
    const wade = find(new Navigator(shallow), [35, G, 30], [45, G, 30]);
    expect(wade).not.toBeNull();
    expect(illegalStep(shallow, wade!)).toBe('');

    const deep = createFlatWorld(64, 64, 31);
    for (let z = 0; z < 64; z++) for (let x = 40; x <= 41; x++) {
      deep.set(x, 31, z, B.water_source);
      deep.set(x, 30, z, B.water_source);
    }
    expect(find(new Navigator(deep), [35, G, 30], [45, G, 30])).toBeNull();

    const tooDeep = createFlatWorld(64, 64, 31);
    for (let z = 0; z < 64; z++) for (let x = 40; x <= 41; x++) tooDeep.set(x, G, z, waterState(9));
    expect(find(new Navigator(tooDeep), [35, G, 30], [45, G, 30])).toBeNull();
  });

  it('returns no route when the goal or the start is walled in, without burning the budget', () => {
    const world = createFlatWorld(64, 64, 31);
    wall(world, 30, 30, 34, 30);
    wall(world, 30, 34, 34, 34);
    wall(world, 30, 30, 30, 34);
    wall(world, 34, 30, 34, 34);
    const nav = new Navigator(world);
    const inside = nav.request(10, G, 10, 32, G, 32);
    expect(inside.status).toBe(PATH_FAILED);
    expect(nav.stats.expansions).toBeLessThan(50);
    const outside = nav.request(32, G, 32, 10, G, 10);
    for (let i = 0; i < 50 && outside.status === PATH_PENDING; i++) nav.update();
    expect(outside.status).toBe(PATH_FAILED);
    expect(nav.stats.expansions).toBeLessThan(100);
    // A goal inside solid rock is no route either.
    expect(nav.request(10, G, 10, 30, G, 30).status).toBe(PATH_FAILED);
  });

  it('spreads a long search over ticks within its budget', () => {
    const world = createFlatWorld(64, 64, 31);
    wall(world, 30, 0, 30, 58);
    const nav = new Navigator(world, { budgetPerTick: 60 });
    const req = nav.request(25, G, 5, 35, G, 5);
    expect(req.status).toBe(PATH_PENDING);
    let ticks = 0;
    let before = nav.stats.expansions;
    while (req.status === PATH_PENDING && ticks < 500) {
      nav.update();
      ticks++;
      expect(nav.stats.expansions - before).toBeLessThanOrEqual(60);
      before = nav.stats.expansions;
    }
    expect(req.status).toBe(PATH_FOUND);
    expect(ticks).toBeGreaterThan(3);
    expect(illegalStep(world, req.path!)).toBe('');
  });

  it('caches routes, reuses them reversed, and drops them when a nearby edit changes the ground', () => {
    const world = createFlatWorld(64, 64, 31);
    const nav = new Navigator(world);
    const first = find(nav, [10, G, 10], [30, G, 10]);
    expect(first).not.toBeNull();
    expect(nav.stats.searches).toBe(1);
    expect(find(nav, [10, G, 10], [30, G, 10])).toBe(first);
    const back = find(nav, [30, G, 10], [10, G, 10]);
    expect(back!.length).toBe(first!.length);
    expect(back!.xs[0]).toBe(30);
    expect(nav.stats.searches).toBe(1);
    expect(nav.stats.cacheHits).toBe(2);

    // Edits that change nothing a walker cares about leave the cache alone.
    world.set(20, G + 4, 10, B.lantern);
    world.set(20, G + 4, 10, B.lantern + 1);
    world.set(50, G, 50, B.stone);
    expect(find(nav, [10, G, 10], [30, G, 10])).toBe(first);

    world.set(20, G, 10, B.stone);
    world.set(20, G + 1, 10, B.stone);
    expect(first!.stale).toBe(true);
    const again = find(nav, [10, G, 10], [30, G, 10]);
    expect(again).not.toBe(first);
    expect(illegalStep(world, again!)).toBe('');
    expect(nav.stats.searches).toBe(2);
    expect(nav.stats.invalidated).toBeGreaterThan(0);
    nav.dispose();
  });

  it('finds the nearest standable cell beside an obstacle', () => {
    const world = createFlatWorld(64, 64, 31);
    world.set(10, G, 10, B.stone);
    world.set(10, G + 1, 10, B.stone);
    const key = nearestStandable(world, 10, G, 10, 2);
    expect(key).toBeGreaterThanOrEqual(0);
    expect(key).not.toBe(packCell(10, G, 10));
    expect(nearestStandable(world, 5, G, 5, 2)).toBe(packCell(5, G, 5));
  });
});
