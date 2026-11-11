// The cantilever rule: a built block may reach sideways from something that
// carries it only as far as its material's span. It is applied around a
// removal, and only to what that removal changed: the neighbourhood is judged
// once with the removed block back in place and once without, and a block
// fails only if it stood before and does not stand now. Anything already
// beyond its span when the world was made is left alone, so opening a gate or
// lifting a floorboard cannot bring down a roof that never met the rule.

import { B, MATERIAL, MATERIALS, NATURAL, SOLID, type Material } from '../world/blocks';
import type { World } from '../world/world';
import { isStructural, type DetachedCell } from './structure';

const HARD = SOLID;
const IS_NATURAL = NATURAL;
const AIR = B.air;
const SPAN = Uint8Array.from(MATERIAL, (m) => (MATERIALS[m] as Material).span);

/**
 * Blocks further than this (in any axis) from the removal are taken as carried
 * by something out of sight. A block that relied on the removed one is within
 * a span of it, and what else might carry that block is within a span again,
 * so this covers the longest spans there are but for the last block or two of metal.
 */
const RADIUS = 14;
const MAX_CELLS = 900;
const FAR = 127;

const DX = [1, -1, 0, 0, 0, 0];
const DY = [0, 0, 1, -1, 0, 0];
const DZ = [0, 0, 0, 0, 1, -1];

const built = (s: number): boolean => isStructural(s) && IS_NATURAL[s] === 0;

/**
 * The built blocks near (px, py, pz) that stood while the block `old` was
 * there and are now further from support than their span allows.
 */
export function cantileverFailures(world: World, px: number, py: number, pz: number, old: number): DetachedCell[] {
  // Most removals carried nothing: digging in open ground, opening a gate
  // between two posts, lifting a floorboard. Only a built block that sat on
  // the removed one, or hung beside or under it with nothing solid beneath
  // itself, can have been relying on it.
  let any = false;
  for (let n = 0; n < 6 && !any; n++) {
    const x = px + (DX[n] as number);
    const y = py + (DY[n] as number);
    const z = pz + (DZ[n] as number);
    any = built(world.get(x, y, z)) && (n === 2 || !HARD[world.get(x, y - 1, z)]);
  }
  if (!any) return [];

  // The neighbourhood: built blocks joined by faces, starting from the hole (so the removed block itself is cell 0).
  const key = (x: number, y: number, z: number): number => ((y - py + RADIUS + 1) * 32 + (z - pz + RADIUS + 1)) * 32 + (x - px + RADIUS + 1);
  const index = new Map<number, number>([[key(px, py, pz), 0]]);
  const cells: DetachedCell[] = [{ x: px, y: py, z: pz, state: old }];
  const edge: boolean[] = [false];
  for (let head = 0; head < cells.length; head++) {
    // A cell on the rim is not searched past: it counts as carried from outside.
    if (edge[head]) continue;
    const c = cells[head] as DetachedCell;
    for (let n = 0; n < 6; n++) {
      const x = c.x + (DX[n] as number);
      const y = c.y + (DY[n] as number);
      const z = c.z + (DZ[n] as number);
      if (index.has(key(x, y, z))) continue;
      const s = world.get(x, y, z);
      if (!built(s) || !world.inBounds(x, y, z)) continue;
      if (cells.length >= MAX_CELLS) {
        // Out of budget: whatever lies beyond is assumed to hold this cell up.
        edge[head] = true;
        continue;
      }
      index.set(key(x, y, z), cells.length);
      cells.push({ x, y, z, state: s });
      edge.push(Math.max(Math.abs(x - px), Math.abs(y - py), Math.abs(z - pz)) >= RADIUS);
    }
  }

  const stands = (withRemoved: boolean): Uint8Array => {
    const at = (x: number, y: number, z: number): number => (x === px && y === py && z === pz ? (withRemoved ? old : AIR) : world.get(x, y, z));
    const present = (i: number): boolean => i !== 0 || (withRemoved && built(old));
    // dist: sideways steps from something that carries the block; FAR means nothing does.
    const dist = new Uint8Array(cells.length).fill(FAR);
    const buckets: number[][] = Array.from({ length: 10 }, () => []);
    let lowest = 0;
    const reach = (i: number, d: number): void => {
      if (!present(i) || d >= (dist[i] as number) || d > (SPAN[(cells[i] as DetachedCell).state] as number)) return;
      dist[i] = d;
      (buckets[d] as number[]).push(i);
      if (d < lowest) lowest = d;
    };
    for (let i = 0; i < cells.length; i++) {
      if (!present(i)) continue;
      const c = cells[i] as DetachedCell;
      const under = at(c.x, c.y - 1, c.z);
      // Carried outright: standing on terrain or the world floor, or reaching out of the neighbourhood.
      if (edge[i] || c.y === 0 || (HARD[under] && IS_NATURAL[under])) {
        reach(i, 0);
        continue;
      }
      // Fixed to terrain by a side or the top: one step out.
      for (let n = 0; n < 6; n++) {
        if (n === 3) continue;
        const s = at(c.x + (DX[n] as number), c.y + (DY[n] as number), c.z + (DZ[n] as number));
        if (HARD[s] && IS_NATURAL[s]) reach(i, 1);
      }
    }
    for (lowest = 0; lowest < buckets.length; ) {
      const bucket = buckets[lowest] as number[];
      const i = bucket.pop();
      if (i === undefined) {
        lowest++;
        continue;
      }
      const d = lowest;
      if (dist[i] !== d) continue;
      const c = cells[i] as DetachedCell;
      for (let n = 0; n < 6; n++) {
        const j = index.get(key(c.x + (DX[n] as number), c.y + (DY[n] as number), c.z + (DZ[n] as number)));
        // What rests on a block that stands is carried by it; what hangs beside or under it is one step further out.
        if (j !== undefined) reach(j, n === 2 ? 0 : d + 1);
      }
    }
    const out = new Uint8Array(cells.length);
    for (let i = 0; i < cells.length; i++) out[i] = dist[i] !== FAR ? 1 : 0;
    return out;
  };

  const before = stands(true);
  const after = stands(false);
  const failed: DetachedCell[] = [];
  for (let i = 1; i < cells.length; i++) {
    if (before[i] === 1 && after[i] === 0) failed.push(cells[i] as DetachedCell);
  }
  return failed;
}
