// Copies one section of the world, plus the one-cell border the mesher reads
// for face culling, ambient occlusion and smooth light, into flat arrays that
// can be handed to a worker. Headless.

import { OPAQUE } from '../world/blocks';
import type { World } from '../world/world';
import { PAD, PAD2, PAD3 } from './mesher';

export interface SectionCopy {
  states: Uint16Array;
  light: Uint8Array;
}

export function allocSectionCopy(): SectionCopy {
  return { states: new Uint16Array(PAD3), light: new Uint8Array(PAD3) };
}

/**
 * True when a section cannot produce any geometry: it is uniform air, or
 * uniform opaque rock with uniform opaque rock on all six sides.
 */
export function sectionIsHidden(world: World, sxi: number, syi: number, szi: number): boolean {
  const si = world.sectionIndex(sxi, syi, szi);
  if (world.blocks[si]) return false;
  const u = world.uniform[si] as number;
  if (u === 0) return true;
  if (!OPAQUE[u]) return false;
  const solid = (x: number, y: number, z: number): boolean => {
    if (y < 0) return true;
    if (x < 0 || z < 0 || x >= world.nsx || z >= world.nsz || y >= world.nsy) return false;
    const i = world.sectionIndex(x, y, z);
    return !world.blocks[i] && OPAQUE[world.uniform[i] as number] === 1;
  };
  return solid(sxi + 1, syi, szi) && solid(sxi - 1, syi, szi) && solid(sxi, syi + 1, szi) && solid(sxi, syi - 1, szi) && solid(sxi, syi, szi + 1) && solid(sxi, syi, szi - 1);
}

export function extractSection(world: World, sxi: number, syi: number, szi: number, out: SectionCopy): void {
  const { states, light } = out;
  const si = world.sectionIndex(sxi, syi, szi);
  const s = world.blocks[si];
  const l = world.light[si];
  const us = world.uniform[si] as number;
  const ul = world.uniformLight[si] as number;

  // Interior: whole rows at a time.
  for (let y = 0; y < 32; y++) {
    for (let z = 0; z < 32; z++) {
      const src = (y << 10) | (z << 5);
      const dst = (y + 1) * PAD2 + (z + 1) * PAD + 1;
      if (s) states.set(s.subarray(src, src + 32), dst);
      else states.fill(us, dst, dst + 32);
      if (l) light.set(l.subarray(src, src + 32), dst);
      else light.fill(ul, dst, dst + 32);
    }
  }

  // Border shell: read through the world, which also answers for cells beyond its edge.
  const x0 = sxi * 32;
  const y0 = syi * 32;
  const z0 = szi * 32;
  for (let y = -1; y <= 32; y++) {
    const edgeY = y === -1 || y === 32;
    for (let z = -1; z <= 32; z++) {
      const edgeZ = z === -1 || z === 32;
      const row = (y + 1) * PAD2 + (z + 1) * PAD + 1;
      if (edgeY || edgeZ) {
        for (let x = -1; x <= 32; x++) {
          states[row + x] = world.get(x0 + x, y0 + y, z0 + z);
          light[row + x] = world.getLight(x0 + x, y0 + y, z0 + z);
        }
      } else {
        states[row - 1] = world.get(x0 - 1, y0 + y, z0 + z);
        light[row - 1] = world.getLight(x0 - 1, y0 + y, z0 + z);
        states[row + 32] = world.get(x0 + 32, y0 + y, z0 + z);
        light[row + 32] = world.getLight(x0 + 32, y0 + y, z0 + z);
      }
    }
  }
}
