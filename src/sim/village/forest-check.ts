// What a felling must never leave behind, counted from the blocks alone. For
// the tests of the woodland, which use it on small test worlds and on the
// fixture village's forest after a fortnight of woodcutting.

import { IS_LEAVES, IS_LOG, SOLID } from '../../world/blocks';
import type { World } from '../../world/world';

/** A part of the world, inclusive at both ends. */
export interface Box {
  x0: number;
  x1: number;
  z0: number;
  z1: number;
  y0: number;
  y1: number;
}

const at = (x: number, y: number, z: number): string => `${x},${y},${z}`;

/** Every cell of the box whose state is marked in `table`, as "x,y,z". */
export function cellsOf(world: World, box: Box, table: Uint8Array): Set<string> {
  const out = new Set<string>();
  for (let y = box.y0; y <= box.y1; y++) {
    for (let z = box.z0; z <= box.z1; z++) {
      for (let x = box.x0; x <= box.x1; x++) if (table[world.get(x, y, z)]) out.add(at(x, y, z));
    }
  }
  return out;
}

/** Take out of `cells` everything joined to `from`, stepping to any of the 26 cells round each. What is left is cut off. */
function prune(cells: Set<string>, from: Iterable<string>): void {
  let wave = [...from];
  for (const key of wave) cells.delete(key);
  while (wave.length > 0) {
    const next: string[] = [];
    for (const key of wave) {
      const [x, y, z] = key.split(',').map(Number) as [number, number, number];
      for (let dy = -1; dy <= 1; dy++) {
        for (let dz = -1; dz <= 1; dz++) {
          for (let dx = -1; dx <= 1; dx++) {
            const k = at(x + dx, y + dy, z + dz);
            if (cells.delete(k)) next.push(k);
          }
        }
      }
    }
    wave = next;
  }
}

/**
 * Wood and foliage left hanging in a box: logs joined, log to log, to none
 * that stands on the ground, and leaves joined, leaf to leaf, to no log at all.
 */
export function adrift(world: World, box: Box): { logs: number; leaves: number } {
  const logs = cellsOf(world, box, IS_LOG);
  const leaves = cellsOf(world, box, IS_LEAVES);
  const wood = [...logs];
  const standing = wood.filter((key) => {
    const [x, y, z] = key.split(',').map(Number) as [number, number, number];
    const under = world.get(x, y - 1, z);
    return SOLID[under] === 1 && !IS_LOG[under] && !IS_LEAVES[under];
  });
  prune(logs, standing);
  prune(leaves, wood);
  return { logs: logs.size, leaves: leaves.size };
}
