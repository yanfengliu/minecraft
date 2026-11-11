import { describe, expect, it } from 'vitest';
import { B } from '../world/blocks';
import { IRREGULAR, SOLID_VOLUME, VOXEL_MASK, mergeBoxes, mergeCells, nearestGridRotation, rotateState } from './shapes';

/** Quaternion for a turn of `angle` radians about an axis. */
function quat(ax: number, ay: number, az: number, angle: number): [number, number, number, number] {
  const s = Math.sin(angle / 2);
  return [ax * s, ay * s, az * s, Math.cos(angle / 2)];
}

function snap(q: [number, number, number, number]): { m: Int8Array; angle: number } {
  const m = new Int8Array(9);
  const angle = nearestGridRotation(q[0], q[1], q[2], q[3], m);
  return { m, angle };
}

describe('collision shapes', () => {
  it('fits full blocks, slabs and stairs to the half-block grid and leaves the rest to boxes', () => {
    expect(VOXEL_MASK[B.stone]).toBe(0xff);
    expect(VOXEL_MASK[B.air]).toBe(0);
    expect(VOXEL_MASK[B.tall_grass]).toBe(0);
    // Bottom slab: the four lower octants. Top slab: the four upper.
    expect(VOXEL_MASK[B.oak_slab]).toBe(0b00110011);
    expect(VOXEL_MASK[B.oak_slab + 1]).toBe(0b11001100);
    // Stairs facing east: the whole lower half and the upper half on the +x side.
    expect(VOXEL_MASK[B.oak_stairs + 1]).toBe(0b00110011 | 0b10001000);
    expect(SOLID_VOLUME[B.oak_stairs]).toBeCloseTo(0.75);
    expect(SOLID_VOLUME[B.oak_slab]).toBeCloseTo(0.5);
    for (const s of [B.path, B.farmland, B.fence, B.stone_wall, B.door, B.bed, B.chest, B.lantern]) {
      expect(IRREGULAR[s]).toBe(1);
      expect(VOXEL_MASK[s]).toBe(0);
    }
    expect(IRREGULAR[B.stone] | IRREGULAR[B.oak_slab] | IRREGULAR[B.torch]).toBe(0);
  });

  it('merges a body into few boxes and keeps materials apart', () => {
    // A trunk of five logs with a 3 x 3 x 2 crown of leaves on top.
    const cells = [];
    for (let y = 0; y < 5; y++) cells.push({ dx: 0, dy: y, dz: 0, state: B.oak_log });
    for (let y = 5; y < 7; y++) for (let z = -1; z <= 1; z++) for (let x = -1; x <= 1; x++) cells.push({ dx: x, dy: y, dz: z, state: B.oak_leaves });
    const boxes = mergeCells(cells);
    expect(boxes).toHaveLength(2);
    const volume = boxes.reduce((v, b) => v + 8 * b.hx * b.hy * b.hz, 0);
    expect(volume).toBe(5 + 18);
    const trunk = boxes.find((b) => b.hy === 2.5);
    expect(trunk).toMatchObject({ x: 0, y: 2, z: 0, hx: 0.5, hz: 0.5 });
    // A slab keeps its own half-height box.
    const mixed = mergeCells([{ dx: 0, dy: 0, dz: 0, state: B.stone }, { dx: 1, dy: 0, dz: 0, state: B.cobble_slab }]);
    expect(mixed).toHaveLength(2);
    expect(mixed.find((b) => b.hy === 0.25)).toMatchObject({ x: 1, y: -0.25, z: 0 });
  });

  it('merges a run of terrain boxes along x and then z', () => {
    const boxes: number[] = [];
    // A 4 x 3 patch of path (15/16 high), and one box of another material beside it.
    for (let z = 0; z < 3; z++) for (let x = 0; x < 4; x++) boxes.push(x, 0, z, x + 1, 0.9375, z + 1, 2);
    boxes.push(4, 0, 0, 5, 0.9375, 1, 5);
    const merged = mergeBoxes(boxes);
    expect(merged.length / 7).toBe(2);
    expect(merged.slice(0, 7)).toEqual([0, 0, 0, 4, 0.9375, 3, 2]);
  });

  it('snaps a pose to the nearest grid orientation and measures how far off it was', () => {
    expect(snap([0, 0, 0, 1])).toEqual({ m: Int8Array.from([1, 0, 0, 0, 1, 0, 0, 0, 1]), angle: 0 });
    const tilted = snap(quat(0, 1, 0, Math.PI / 2 + 0.1));
    expect(tilted.angle).toBeCloseTo(0.1, 5);
    // A quarter turn about +y takes +x to -z.
    expect(Array.from(tilted.m)).toEqual([0, 0, 1, 0, 1, 0, -1, 0, 0]);
    expect(snap(quat(1, 0, 0, Math.PI / 4)).angle).toBeCloseTo(Math.PI / 4, 5);
    // Always a proper rotation, whatever comes in.
    for (let i = 0; i < 50; i++) {
      const q = quat(Math.sin(i), Math.cos(i * 1.7), Math.sin(i * 0.3 + 1), i * 0.37);
      const n = Math.hypot(...q);
      const { m } = snap(q.map((v) => v / n) as [number, number, number, number]);
      const det = (m[0] as number) * ((m[4] as number) * (m[8] as number) - (m[5] as number) * (m[7] as number))
        - (m[1] as number) * ((m[3] as number) * (m[8] as number) - (m[5] as number) * (m[6] as number))
        + (m[2] as number) * ((m[3] as number) * (m[7] as number) - (m[4] as number) * (m[6] as number));
      expect(det).toBe(1);
    }
  });

  it('turns block states the way the body turned', () => {
    const about = (ax: number, ay: number, az: number, quarters: number): Int8Array => snap(quat(ax, ay, az, (quarters * Math.PI) / 2)).m;
    // An upright log (grain along y) tipped over about z lies along x; about x, along z.
    expect(rotateState(B.oak_log, about(0, 0, 1, 1))).toBe(B.oak_log + 1);
    expect(rotateState(B.oak_log, about(1, 0, 0, 1))).toBe(B.oak_log + 2);
    expect(rotateState(B.oak_log + 1, about(0, 1, 0, 1))).toBe(B.oak_log + 2);
    expect(rotateState(B.oak_log + 1, about(0, 0, 1, 1))).toBe(B.oak_log);
    expect(rotateState(B.beam + 2, about(1, 0, 0, 1))).toBe(B.beam);
    // Plain cubes do not care.
    expect(rotateState(B.stone, about(1, 0, 0, 1))).toBe(B.stone);
    // A slab flipped over swaps halves; on its edge it has no state.
    expect(rotateState(B.oak_slab, about(1, 0, 0, 2))).toBe(B.oak_slab + 1);
    expect(rotateState(B.oak_slab, about(0, 1, 0, 1))).toBe(B.oak_slab);
    expect(rotateState(B.oak_slab, about(1, 0, 0, 1))).toBe(-1);
    // Stairs facing north (-z), turned a quarter about +y (which takes -z to -x), face west; they cannot lie on their side.
    expect(rotateState(B.oak_stairs, about(0, 1, 0, 1))).toBe(B.oak_stairs + 3);
    expect(rotateState(B.oak_stairs + 3, about(0, 1, 0, -1))).toBe(B.oak_stairs);
    expect(rotateState(B.oak_stairs, about(0, 0, 1, 1))).toBe(-1);
    // Furniture only goes back exactly as it was.
    expect(rotateState(B.chest, about(0, 1, 0, 0))).toBe(B.chest);
    expect(rotateState(B.oven, about(0, 1, 0, 1))).toBe(-1);
  });
});
