import { describe, expect, it } from 'vitest';
import { watchAttachments } from '../world/attach';
import { B, doorState } from '../world/blocks';
import { raycast, selectionBox } from '../world/raycast';
import { createFlatWorld } from '../world/world';
import { boxIsFree, moveBox } from './collide';

const HW = 0.3;
const H = 1.8;
const GROUND = 32; // top of the flat world's grass, where feet rest

describe('moving a body through blocks', () => {
  it('falls onto the ground and stops exactly on it', () => {
    const w = createFlatWorld();
    const r = moveBox(w, 10.5, GROUND + 0.4, 10.5, HW, H, 0, -1, 0, 0.6, false);
    expect(r.y).toBeCloseTo(GROUND, 6);
    expect(r.onGround).toBe(true);
    expect(r.hitY).toBe(true);
  });

  it('is stopped by a wall, flush against it', () => {
    const w = createFlatWorld();
    for (let y = GROUND; y < GROUND + 3; y++) w.set(13, y, 10, B.stone);
    const r = moveBox(w, 10.5, GROUND, 10.5, HW, H, 5, 0, 0, 0.6, true);
    expect(r.x).toBeCloseTo(13 - HW, 6);
    expect(r.hitX).toBe(true);
    expect(r.y).toBeCloseTo(GROUND, 6);
  });

  it('walks up a slab and a stair, but not a full block', () => {
    const w = createFlatWorld();
    w.set(12, GROUND, 10, B.oak_slab);
    const slab = moveBox(w, 11.5, GROUND, 10.5, HW, H, 0.6, 0, 0, 0.6, true);
    expect(slab.x).toBeCloseTo(12.1, 6);
    expect(slab.y).toBeCloseTo(GROUND + 0.5, 6);
    expect(slab.stepped).toBeCloseTo(0.5, 6);

    w.set(12, GROUND, 14, B.stone);
    const block = moveBox(w, 11.5, GROUND, 14.5, HW, H, 0.6, 0, 0, 0.6, true);
    expect(block.x).toBeCloseTo(12 - HW, 6);
    expect(block.y).toBeCloseTo(GROUND, 6);
  });

  it('does not step up in mid-air', () => {
    const w = createFlatWorld();
    w.set(12, GROUND, 10, B.oak_slab);
    const r = moveBox(w, 11.5, GROUND + 0.2, 10.5, HW, H, 0.6, 0, 0, 0.6, false);
    expect(r.x).toBeCloseTo(12 - HW, 6);
  });

  it('cannot be jumped over where a fence stands, and its rails block the gaps', () => {
    const w = createFlatWorld();
    w.set(12, GROUND, 10, B.fence);
    w.set(12, GROUND, 11, B.fence);
    // A jump apex of 1.15 m is still below the fence's 1.5 m of collision.
    const high = moveBox(w, 11.4, GROUND + 1.15, 10.5, HW, H, 1, 0, 0, 0, false);
    expect(high.hitX).toBe(true);
    // Between the two posts, where only the rail is.
    const between = moveBox(w, 11.4, GROUND, 11.0, 0.1, H, 1, 0, 0, 0, true);
    expect(between.hitX).toBe(true);
    expect(boxIsFree(w, 12.5, GROUND, 13.5, HW, H)).toBe(true);
    expect(boxIsFree(w, 12.5, GROUND, 10.5, HW, H)).toBe(false);
  });

  it('passes an open door and is stopped by a closed one', () => {
    const w = createFlatWorld();
    // A door on the west edge of its cell, blocking movement along x.
    w.set(12, GROUND, 10, doorState(3, false, false));
    w.set(12, GROUND + 1, 10, doorState(3, true, false));
    expect(moveBox(w, 11.5, GROUND, 10.5, HW, H, 1.2, 0, 0, 0.6, true).hitX).toBe(true);
    w.set(12, GROUND, 10, doorState(3, false, true));
    w.set(12, GROUND + 1, 10, doorState(3, true, true));
    expect(moveBox(w, 11.5, GROUND, 10.6, 0.2, H, 1.2, 0, 0, 0.6, true).hitX).toBe(false);
  });
});

describe('ray casting', () => {
  it('hits the near face of the first block and reports its normal', () => {
    const w = createFlatWorld();
    w.set(15, GROUND + 1, 10, B.stone);
    const hit = raycast(w, 10.5, GROUND + 1.5, 10.5, 1, 0, 0, 8);
    expect(hit).not.toBeNull();
    expect([hit!.x, hit!.y, hit!.z]).toEqual([15, GROUND + 1, 10]);
    expect([hit!.nx, hit!.ny, hit!.nz]).toEqual([-1, 0, 0]);
    expect(hit!.t).toBeCloseTo(4.5, 6);
    expect(raycast(w, 10.5, GROUND + 1.5, 10.5, 1, 0, 0, 4)).toBeNull();
  });

  it('hits partial blocks where they are, and looks through water unless asked', () => {
    const w = createFlatWorld();
    w.set(12, GROUND, 10, B.oak_slab);
    // Aimed over the slab: passes above it and reaches the ground beyond.
    const over = raycast(w, 10.5, GROUND + 0.75, 10.5, 1, 0, 0, 8);
    expect(over).toBeNull();
    const down = raycast(w, 12.5, GROUND + 2, 10.5, 0, -1, 0, 8);
    expect(down!.py).toBeCloseTo(GROUND + 0.5, 6);
    expect(down!.ny).toBe(1);
    w.set(14, GROUND, 12, B.water_source);
    expect(raycast(w, 14.5, GROUND + 2, 12.5, 0, -1, 0, 8)!.y).toBe(GROUND - 1);
    expect(raycast(w, 14.5, GROUND + 2, 12.5, 0, -1, 0, 8, true)!.state).toBe(B.water_source);
    expect(selectionBox(w, 12, GROUND, 10)).toEqual([12, GROUND, 10, 13, GROUND + 0.5, 11]);
  });
});

describe('attachments', () => {
  it('drops what loses its support, and a door goes as a pair', () => {
    const w = createFlatWorld();
    const lost: number[] = [];
    watchAttachments(w, (_x, _y, _z, s) => lost.push(s));
    // A stone with a torch on top, a wall torch on its east face and a ladder on its south face.
    w.set(10, GROUND, 10, B.stone);
    w.set(10, GROUND + 1, 10, B.torch);
    w.set(11, GROUND, 10, B.wall_torch + 1); // facing east: mounted on the block to its west
    w.set(10, GROUND, 11, B.ladder);         // facing north: against the block to its north
    expect(lost).toEqual([]);
    w.set(10, GROUND, 10, B.air);
    expect(lost.sort()).toEqual([B.torch, B.wall_torch + 1, B.ladder].sort());
    expect(w.get(10, GROUND + 1, 10)).toBe(B.air);
    expect(w.get(11, GROUND, 10)).toBe(B.air);
    expect(w.get(10, GROUND, 11)).toBe(B.air);

    lost.length = 0;
    w.set(20, GROUND, 20, doorState(0, false, false));
    w.set(20, GROUND + 1, 20, doorState(0, true, false));
    expect(lost).toEqual([]);
    w.set(20, GROUND - 1, 20, B.air);
    expect(w.get(20, GROUND, 20)).toBe(B.air);
    expect(w.get(20, GROUND + 1, 20)).toBe(B.air);

    lost.length = 0;
    w.set(30, GROUND, 30, B.poppy);
    w.set(30, GROUND - 1, 30, B.air);
    expect(lost).toEqual([B.poppy]);
  });
});
