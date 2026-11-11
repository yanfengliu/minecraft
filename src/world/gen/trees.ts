// Tree shapes. World generation plants them and the flora simulation grows
// them from saplings, so a wood felled today regrows into the same kind of
// forest. Headless and deterministic for a given Rng.

import type { Rng } from '../../core/rng';
import { B, IS_LEAVES, REPLACEABLE, WATER_LEVEL } from '../blocks';
import type { World } from '../world';

export const TREE_SPECIES = ['oak', 'birch', 'pine'] as const;
export type TreeSpecies = (typeof TREE_SPECIES)[number];

export const LOG_OF: Record<TreeSpecies, number> = { oak: B.oak_log, birch: B.birch_log, pine: B.pine_log };
export const LEAVES_OF: Record<TreeSpecies, number> = { oak: B.oak_leaves, birch: B.birch_leaves, pine: B.pine_leaves };
export const SAPLING_OF: Record<TreeSpecies, number> = { oak: B.oak_sapling, birch: B.birch_sapling, pine: B.pine_sapling };

export function speciesOfSapling(state: number): TreeSpecies | null {
  if (state === B.oak_sapling) return 'oak';
  if (state === B.birch_sapling) return 'birch';
  if (state === B.pine_sapling) return 'pine';
  return null;
}

export interface TreeBlock {
  dx: number;
  dy: number;
  dz: number;
  state: number;
  trunk: boolean;
}

function blob(out: TreeBlock[], leaves: number, cx: number, cy: number, cz: number, rx: number, ry: number, rng: Rng): void {
  const r = Math.ceil(rx);
  const h = Math.ceil(ry);
  for (let dy = -h; dy <= h; dy++) {
    for (let dz = -r; dz <= r; dz++) {
      for (let dx = -r; dx <= r; dx++) {
        const d = (dx * dx + dz * dz) / (rx * rx) + (dy * dy) / (ry * ry);
        // Ragged edge: the outer shell is kept only some of the time.
        if (d > 1 || (d > 0.72 && rng.chance(0.45))) continue;
        out.push({ dx: cx + dx, dy: cy + dy, dz: cz + dz, state: leaves, trunk: false });
      }
    }
  }
}

/** Blocks of one tree relative to its base (the lowest trunk block is at dy = 0). Trunk blocks come first. */
export function treeBlocks(species: TreeSpecies, rng: Rng): TreeBlock[] {
  const log = LOG_OF[species];
  const leaves = LEAVES_OF[species];
  const trunk: TreeBlock[] = [];
  const crown: TreeBlock[] = [];

  if (species === 'oak') {
    const big = rng.chance(0.22);
    const height = big ? rng.intRange(7, 9) : rng.intRange(4, 6);
    for (let y = 0; y < height; y++) trunk.push({ dx: 0, dy: y, dz: 0, state: log, trunk: true });
    blob(crown, leaves, 0, height, 0, big ? 3.6 : 2.7, big ? 2.6 : 2.1, rng);
    if (big) {
      // A few limbs reaching out, each carrying its own tuft.
      const limbs = rng.intRange(2, 3);
      for (let i = 0; i < limbs; i++) {
        const dir = rng.int(4);
        const sx = dir === 0 ? 1 : dir === 1 ? -1 : 0;
        const sz = dir === 2 ? 1 : dir === 3 ? -1 : 0;
        const y = height - rng.intRange(2, 4);
        const axis = sx !== 0 ? 1 : 2;
        trunk.push({ dx: sx, dy: y, dz: sz, state: log + axis, trunk: true });
        trunk.push({ dx: sx * 2, dy: y + 1, dz: sz * 2, state: log + axis, trunk: true });
        blob(crown, leaves, sx * 3, y + 2, sz * 3, 2.2, 1.6, rng);
      }
    }
  } else if (species === 'birch') {
    const height = rng.intRange(5, 8);
    for (let y = 0; y < height; y++) trunk.push({ dx: 0, dy: y, dz: 0, state: log, trunk: true });
    blob(crown, leaves, 0, height - 1, 0, 2.1, 2.9, rng);
  } else {
    const height = rng.intRange(7, 12);
    for (let y = 0; y < height; y++) trunk.push({ dx: 0, dy: y, dz: 0, state: log, trunk: true });
    // Tiered skirts, wide then narrow, tapering to a spike.
    const start = rng.intRange(2, 3);
    for (let y = start; y <= height + 1; y++) {
      const t = (y - start) / (height + 1 - start);
      const wide = (y - start) % 2 === 0;
      const radius = Math.max(0, Math.round((1 - t) * 3.2 + (wide ? 0.4 : -0.6)));
      for (let dz = -radius; dz <= radius; dz++) {
        for (let dx = -radius; dx <= radius; dx++) {
          if (dx === 0 && dz === 0 && y < height) continue;
          if (Math.abs(dx) + Math.abs(dz) > radius + (radius > 1 ? 1 : 0)) continue;
          if (radius > 1 && Math.abs(dx) === radius && Math.abs(dz) === radius) continue;
          crown.push({ dx, dy: y, dz, state: leaves, trunk: false });
        }
      }
    }
    crown.push({ dx: 0, dy: height + 1, dz: 0, state: leaves, trunk: false });
  }
  return trunk.concat(crown);
}

/** True when every trunk cell is free (air, plants or foliage) and in bounds. */
export function canPlaceTree(world: World, x: number, y: number, z: number, blocks: readonly TreeBlock[]): boolean {
  for (const b of blocks) {
    if (!b.trunk) continue;
    const bx = x + b.dx;
    const by = y + b.dy;
    const bz = z + b.dz;
    if (!world.inBounds(bx, by, bz)) return false;
    const s = world.get(bx, by, bz);
    // The base cell may hold the sapling the tree grows from.
    if (!REPLACEABLE[s] && !IS_LEAVES[s]) return false;
  }
  return true;
}

/**
 * Place a tree with its base at (x, y, z). Leaves only fill free cells, so a
 * tree never eats a wall. With `raw` the writes skip events (world generation).
 * Returns false and writes nothing when the trunk does not fit.
 */
export function growTree(world: World, x: number, y: number, z: number, species: TreeSpecies, rng: Rng, raw = false): boolean {
  const blocks = treeBlocks(species, rng);
  if (!canPlaceTree(world, x, y, z, blocks)) return false;
  for (const b of blocks) {
    const bx = x + b.dx;
    const by = y + b.dy;
    const bz = z + b.dz;
    if (!world.inBounds(bx, by, bz)) continue;
    if (!b.trunk) {
      // Foliage fills air and brushes plants aside, but never displaces water or anything solid.
      const s = world.get(bx, by, bz);
      if (!REPLACEABLE[s] || WATER_LEVEL[s] !== 0) continue;
    }
    if (raw) world.setRaw(bx, by, bz, b.state);
    else world.set(bx, by, bz, b.state);
  }
  return true;
}
