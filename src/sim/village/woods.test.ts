// The woodland: what goes when one tree is felled, and which trunks the
// woodcutters take for trees. The trees are grown by the real `growTree`, alone
// and in pairs close enough for their crowns to mingle, as they do in the
// generated forest.

import { describe, expect, it } from 'vitest';
import { Rng } from '../../core/rng';
import { B, IS_LEAVES, IS_LOG, SOLID } from '../../world/blocks';
import { TREE_SPECIES, type TreeSpecies, growTree } from '../../world/gen/trees';
import { type World, createFlatWorld } from '../../world/world';
import { createBasicActions } from '../api';
import { FEET } from './fixture-build';
import { TICKS_PER_DAY, createHeadlessVillage } from './headless';
import { Woods } from './woods';

/** The part of a test world the trees stand in: wide and tall enough for two of the largest side by side. */
const BOX = { x0: 6, x1: 42, z0: 8, z1: 40, y1: FEET + 18 };
const AX = 20;
const AZ = 24;

const at = (x: number, y: number, z: number): string => `${x},${y},${z}`;

/** Every cell in the box whose state is marked in `table`. */
function cellsOf(world: World, table: Uint8Array): Set<string> {
  const out = new Set<string>();
  for (let y = FEET; y <= BOX.y1; y++) {
    for (let z = BOX.z0; z <= BOX.z1; z++) {
      for (let x = BOX.x0; x <= BOX.x1; x++) if (table[world.get(x, y, z)]) out.add(at(x, y, z));
    }
  }
  return out;
}

/** Cells of `all` that cannot be reached from `from`, stepping through `all` to any of the 26 cells round each. */
function cutOff(all: Set<string>, from: Iterable<string>, alsoFromBeside = false): number {
  const reached = new Set<string>();
  const queue: string[] = [];
  const visit = (key: string): void => {
    const [x, y, z] = key.split(',').map(Number) as [number, number, number];
    for (let dy = -1; dy <= 1; dy++) {
      for (let dz = -1; dz <= 1; dz++) {
        for (let dx = -1; dx <= 1; dx++) {
          const k = at(x + dx, y + dy, z + dz);
          if (!all.has(k) || reached.has(k)) continue;
          reached.add(k);
          queue.push(k);
        }
      }
    }
  };
  for (const key of from) {
    if (all.has(key)) {
      if (!reached.has(key)) {
        reached.add(key);
        queue.push(key);
      }
    } else if (alsoFromBeside) visit(key);
  }
  while (queue.length > 0) visit(queue.pop() as string);
  return all.size - reached.size;
}

/**
 * What a felling must never leave: wood joined to nothing that stands on the
 * ground, and leaves joined, leaf to leaf, to no wood at all.
 */
function adrift(world: World): { logs: number; leaves: number } {
  const logs = cellsOf(world, IS_LOG);
  const leaves = cellsOf(world, IS_LEAVES);
  const standing = [...logs].filter((key) => {
    const [x, y, z] = key.split(',').map(Number) as [number, number, number];
    const under = world.get(x, y - 1, z);
    return SOLID[under] === 1 && !IS_LOG[under] && !IS_LEAVES[under];
  });
  return { logs: cutOff(logs, standing), leaves: cutOff(leaves, logs, true) };
}

function grow(world: World, x: number, z: number, species: TreeSpecies, seed: number): boolean {
  return growTree(world, x, FEET, z, species, new Rng(seed));
}

describe('felling a tree', () => {
  it('takes a tree that stands alone whole, whatever its kind and shape, and counts its logs', () => {
    let limbed = 0;
    let wide = 0;
    for (const species of TREE_SPECIES) {
      const world = createFlatWorld(64, 64, FEET - 1);
      const actions = createBasicActions(world);
      for (let seed = 1; seed <= 60; seed++) {
        expect(grow(world, AX, AZ, species, seed)).toBe(true);
        const logs = cellsOf(world, IS_LOG);
        const leaves = cellsOf(world, IS_LEAVES);
        if ([...logs].some((key) => !key.startsWith(`${AX},`) || !key.endsWith(`,${AZ}`))) limbed++;
        if ([...leaves].some((key) => {
          const [x, , z] = key.split(',').map(Number) as [number, number, number];
          return Math.abs(x - AX) + Math.abs(z - AZ) > 4;
        })) wide++;
        // From the foot, or from any other log of the trunk: it is the same tree.
        const cut = FEET + (seed % 3);
        expect(actions.fellTree(AX, cut, AZ), `${species} ${seed}`).toBe(logs.size);
        expect(cellsOf(world, IS_LOG).size, `${species} ${seed}: logs left`).toBe(0);
        expect(cellsOf(world, IS_LEAVES).size, `${species} ${seed}: leaves left`).toBe(0);
        // The ground it stood on is untouched.
        expect(world.get(AX, FEET - 1, AZ)).toBe(B.grass);
      }
    }
    // The shapes that matter were among them: oaks with limbs, and crowns reaching well out from the trunk.
    expect(limbed).toBeGreaterThan(5);
    expect(wide).toBeGreaterThan(40);
  });

  it('leaves the tree beside it whole when their crowns mingle, and no leaf or log hanging', () => {
    // Trunk to trunk, a step apart, and out to where only the tips of the crowns touch.
    const offsets: [number, number][] = [[1, 0], [1, 1], [2, 0], [2, 2], [3, 0], [3, 1], [4, 0], [4, 2], [5, 0], [6, 3]];
    let pairs = 0;
    let mingled = 0;
    const world = createFlatWorld(64, 64, FEET - 1);
    const actions = createBasicActions(world);
    for (let seed = 1; seed <= 14; seed++) {
      for (const a of TREE_SPECIES) {
        for (const b of TREE_SPECIES) {
          for (const [dx, dz] of offsets) {
            const tag = `${a} and ${b} ${dx},${dz} apart, seed ${seed}`;
            expect(grow(world, AX, AZ, a, seed)).toBe(true);
            const mine = cellsOf(world, IS_LOG);
            const alone = cellsOf(world, IS_LEAVES).size;
            // A second trunk that does not fit beside the first is no pair.
            if (!grow(world, AX + dx, AZ + dz, b, seed * 31 + 7)) {
              actions.fellTree(AX, FEET, AZ);
              expect(cellsOf(world, IS_LOG).size + cellsOf(world, IS_LEAVES).size, tag).toBe(0);
              continue;
            }
            pairs++;
            const both = cellsOf(world, IS_LOG);
            const theirs = [...both].filter((key) => !mine.has(key));
            const leavesBefore = cellsOf(world, IS_LEAVES).size;
            // Fewer leaves than the two would have apart means the second crown grew into the first.
            if (leavesBefore < alone * 2) mingled++;

            const yielded = actions.fellTree(AX, FEET, AZ);
            const left = cellsOf(world, IS_LOG);
            for (const key of theirs) expect(left.has(key), `${tag}: lost its log at ${key}`).toBe(true);
            // Paid for what came down and nothing else, and the trunk that was cut is gone. (A limb of the
            // neighbour may reach over where it stood.)
            expect(yielded, tag).toBe(both.size - left.size);
            expect(yielded, tag).toBeGreaterThanOrEqual(4);
            for (let y = FEET; y <= BOX.y1; y++) if (mine.has(at(AX, y, AZ))) expect(left.has(at(AX, y, AZ)), tag).toBe(false);
            expect(adrift(world), tag).toEqual({ logs: 0, leaves: 0 });
            // The neighbour still has a crown.
            expect(cellsOf(world, IS_LEAVES).size, tag).toBeGreaterThan(8);

            // Then the neighbour: between them the two fellings take everything, once.
            const second = actions.fellTree(AX + dx, FEET, AZ + dz);
            expect(yielded + second, tag).toBe(both.size);
            expect(cellsOf(world, IS_LOG).size + cellsOf(world, IS_LEAVES).size, tag).toBe(0);
          }
        }
      }
    }
    expect(pairs).toBeGreaterThan(900);
    expect(mingled).toBeGreaterThan(pairs * 0.5);
  });

  it('yields nothing for wood that is not a standing trunk, and never takes more than one stem', () => {
    const world = createFlatWorld(64, 64, FEET - 1);
    const actions = createBasicActions(world);
    const before = (): number => cellsOf(world, IS_LOG).size;

    // Not wood at all; a log lying on its side; a log held up by nothing.
    expect(actions.fellTree(10, FEET - 1, 10)).toBe(0);
    world.set(10, FEET, 10, B.oak_log + 1);
    world.set(10, FEET + 1, 10, B.oak_log + 1);
    expect(actions.fellTree(10, FEET, 10)).toBe(0);
    world.set(14, FEET + 3, 10, B.oak_log);
    world.set(14, FEET + 4, 10, B.oak_log);
    expect(actions.fellTree(14, FEET + 3, 10)).toBe(0);
    expect(before()).toBe(4);

    // The limb of an oak is not its trunk.
    let limb: [number, number, number] | undefined;
    for (let seed = 1; !limb; seed++) {
      expect(grow(world, AX, AZ, 'oak', seed)).toBe(true);
      limb = [...cellsOf(world, IS_LOG)].map((key) => key.split(',').map(Number) as [number, number, number])
        .find(([x, , z]) => Math.abs(x - AX) + Math.abs(z - AZ) > 0 && Math.abs(x - AX) <= 3 && Math.abs(z - AZ) <= 3);
      if (!limb) actions.fellTree(AX, FEET, AZ);
    }
    const standing = before();
    expect(actions.fellTree(limb[0], limb[1], limb[2])).toBe(0);
    expect(before()).toBe(standing);
    actions.fellTree(AX, FEET, AZ);
    expect(before()).toBe(4);

    // A wall of upright logs with a log roof laid across it: one post is the most that can ever come away, and
    // the roof, which rests on the other posts, stays up.
    for (let x = 30; x <= 36; x++) {
      for (let y = FEET; y < FEET + 3; y++) world.set(x, y, 30, B.oak_log);
      world.set(x, FEET + 3, 30, B.oak_log + 1);
    }
    const wall = before();
    expect(actions.fellTree(33, FEET, 30)).toBe(3);
    expect(before()).toBe(wall - 3);
    for (let x = 30; x <= 36; x++) expect(world.get(x, FEET + 3, 30)).toBe(B.oak_log + 1);
  });
});

describe('what the woodcutters take for a tree', () => {
  it('knows the trees of the forest and those that come up from saplings, and nothing anybody sets down', () => {
    const h = createHeadlessVillage(5);
    const { world, plan } = h;
    const woods = new Woods(h.sim.core);
    const known = woods.standing;
    expect(known).toBeGreaterThan(8);

    // Open ground at the southern edge of the forest, clear of every crown.
    const z = plan.forest.z + plan.forest.radius - 1;
    for (let x = 24; x <= 32; x++) for (let y = FEET; y < FEET + 12; y++) expect(world.get(x, y, z)).toBe(B.air);

    // A sapling is not a tree yet; when it grows, it is.
    world.set(24, FEET, z, B.birch_sapling);
    woods.tick();
    expect(woods.standing).toBe(known);
    expect(growTree(world, 24, FEET, z, 'birch', new Rng(3))).toBe(true);
    woods.tick();
    expect(woods.standing).toBe(known + 1);
    const walker = h.sim.core.residents[0]!;
    walker.view.x = 24.5;
    walker.view.z = z + 1.5;
    expect(woods.claimNearest(walker)).toMatchObject({ x: 24, y: FEET, z, species: 'birch' });

    // A post, a wall, and a log set down where a sapling stood, built up afterwards and even topped with leaves.
    for (let y = FEET; y < FEET + 4; y++) world.set(28, y, z, B.oak_log);
    for (let x = 30; x <= 32; x++) for (let y = FEET; y < FEET + 2; y++) world.set(x, y, z, B.oak_log);
    world.set(29, FEET, z - 2, B.oak_sapling);
    world.set(29, FEET, z - 2, B.oak_log);
    woods.tick();
    world.set(29, FEET + 1, z - 2, B.oak_log);
    world.set(29, FEET + 2, z - 2, B.oak_leaves);
    woods.tick();
    expect(woods.standing).toBe(known + 1);

    // A tree that grows outside the forest is not the woodcutters' either.
    const far = plan.forest.z + plan.forest.radius + 3;
    world.set(20, FEET, far, B.oak_sapling);
    expect(growTree(world, 20, FEET, far, 'oak', new Rng(4))).toBe(true);
    woods.tick();
    expect(woods.standing).toBe(known + 1);
    woods.dispose();
    h.sim.dispose();
  });

  it('fells trees and leaves the logs of a build among them alone', () => {
    const h = createHeadlessVillage(5);
    const { world, plan, sim } = h;
    h.weather.force('clear');
    // On the way from the yard to the nearest trees, where a woodcutter looking for something to fell comes first.
    const z = plan.forest.z + plan.forest.radius - 1;
    const built: [number, number, number][] = [];
    const put = (x: number, y: number, zz: number): void => {
      expect(world.get(x, y, zz)).toBe(B.air);
      world.set(x, y, zz, B.oak_log);
      built.push([x, y, zz]);
    };
    for (let y = FEET; y < FEET + 3; y++) put(26, y, z);
    for (let x = 28; x <= 31; x++) for (let y = FEET; y < FEET + 2; y++) put(x, y, z);
    for (const [x, , zz] of built) expect((x - plan.forest.x) ** 2 + (zz - plan.forest.z) ** 2).toBeLessThanOrEqual(plan.forest.radius ** 2);

    const trunks = (): number => {
      let n = 0;
      const f = plan.forest;
      for (let zz = f.z - f.radius; zz <= f.z + f.radius; zz++) for (let x = f.x - f.radius; x <= f.x + f.radius; x++) if (IS_LOG[world.get(x, FEET, zz)]) n++;
      return n;
    };
    const stood = trunks();
    h.step(TICKS_PER_DAY * 2);
    for (const [x, y, zz] of built) expect(world.get(x, y, zz), `log at ${x},${y},${zz}`).toBe(B.oak_log);
    // And the day's work went on round it: trees came down, one trunk and one sapling to each felling.
    expect(sim.stats.treesFelled).toBeGreaterThanOrEqual(3);
    expect(stood - trunks()).toBe(sim.stats.treesFelled);
    expect(sim.stats.saplingsPlanted).toBe(sim.stats.treesFelled);
  });
});
