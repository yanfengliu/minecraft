import { describe, expect, it } from 'vitest';
import { Rng } from '../core/rng';
import {
  B, BLOCKS, FACE_NY, FACE_NZ, FACE_PY, FULL_FACES, SOLID, STATE_COUNT, WATER_LEVEL, bedState, doorIsOpen, doorState,
  isDoor, rotateBoxes, waterState,
} from './blocks';
import { ECONOMY_GOODS, ITEMS, dropOf, item } from './items';
import { LightEngine } from './light';
import { TILE_COUNT } from './tiles';
import { World, createFlatWorld } from './world';

describe('block registry', () => {
  it('keeps air at id 0 and every state well formed', () => {
    expect(B.air).toBe(0);
    expect(STATE_COUNT).toBeLessThan(65536);
    for (const s of BLOCKS) {
      expect(s.tiles).toHaveLength(6);
      for (const t of s.tiles) expect(t).toBeLessThan(TILE_COUNT);
      for (const b of s.boxes) for (const t of b.tiles ?? []) expect(t).toBeLessThan(TILE_COUNT);
      expect(BLOCKS[s.id]).toBe(s);
    }
  });

  it('lays variants out contiguously from the family base', () => {
    for (let f = 0; f < 4; f++) expect(BLOCKS[B.oak_stairs + f]?.family).toBe('oak_stairs');
    for (let a = 0; a < 3; a++) expect(BLOCKS[B.oak_log + a]?.family).toBe('oak_log');
    for (let level = 1; level <= 16; level++) expect(WATER_LEVEL[waterState(level)]).toBe(level);
    expect(waterState(0)).toBe(B.air);
    expect(WATER_LEVEL[B.water_source]).toBe(16);
    for (let d = 0; d < 8; d++) expect(BLOCKS[B.river + d]?.waterSource).toBe(true);
    const open = doorState(2, true, true);
    expect(isDoor(open)).toBe(true);
    expect(doorIsOpen(open)).toBe(true);
    expect(doorIsOpen(doorState(2, true, false))).toBe(false);
    expect(BLOCKS[bedState(3, true)]?.family).toBe('bed');
  });

  it('knows which faces partial blocks cover', () => {
    expect(FULL_FACES[B.stone]).toBe(0b111111);
    expect(FULL_FACES[B.oak_slab]).toBe(1 << FACE_NY);
    expect(FULL_FACES[B.oak_slab + 1]).toBe(1 << FACE_PY);
    expect(FULL_FACES[B.oak_stairs]).toBe((1 << FACE_NY) | (1 << FACE_NZ));
    expect(FULL_FACES[B.oak_leaves]).toBe(0);
    expect(FULL_FACES[B.window]).toBe(0);
  });

  it('rotates boxes a full turn back to where they started', () => {
    const boxes = BLOCKS[B.oak_stairs]!.boxes;
    expect(rotateBoxes(boxes, 4)).toEqual(boxes.map((b) => ({ ...b })));
    const east = rotateBoxes(boxes, 1)[1]!;
    expect([east.x0, east.x1, east.z0, east.z1]).toEqual([8, 16, 0, 16]);
  });

  it('resolves every drop and every economy good to an item', () => {
    expect(dropOf(B.grass)?.name).toBe('dirt');
    expect(dropOf(B.wheat + 3)?.name).toBe('wheat');
    expect(dropOf(B.wheat)).toBeUndefined();
    expect(dropOf(B.oak_leaves)).toBeUndefined();
    for (const g of ECONOMY_GOODS) expect(item(g).value).toBeGreaterThan(0);
    expect(ITEMS.length).toBeGreaterThan(80);
    expect(item('oak_stairs').block).toBe(B.oak_stairs);
  });
});

describe('world storage', () => {
  it('stores states, allocating sections only when they stop being uniform', () => {
    const w = new World(64, 64, 64, 0);
    expect(w.blocks.every((s) => s === null)).toBe(true);
    expect(w.set(5, 6, 7, B.stone)).toBe(true);
    expect(w.set(5, 6, 7, B.stone)).toBe(false);
    expect(w.get(5, 6, 7)).toBe(B.stone);
    expect(w.blocks.filter((s) => s !== null)).toHaveLength(1);
    expect(w.set(-1, 0, 0, B.stone)).toBe(false);
  });

  it('reads an endless sea beyond the edge and bedrock below', () => {
    const w = new World(64, 64, 64, 20);
    expect(w.get(-5, 10, 3)).toBe(B.water_source);
    expect(w.get(-5, 30, 3)).toBe(B.air);
    expect(w.get(3, -1, 3)).toBe(B.bedrock);
    expect(w.get(3, 64, 3)).toBe(B.air);
  });

  it('keeps the rain heightmap current through edits', () => {
    const w = createFlatWorld(64, 64, 31);
    expect(w.height(10, 10)).toBe(32);
    w.set(10, 40, 10, B.oak_planks);
    expect(w.height(10, 10)).toBe(41);
    expect(w.exposed(10, 35, 10)).toBe(false);
    w.set(10, 40, 10, B.air);
    expect(w.height(10, 10)).toBe(32);
    w.set(10, 32, 10, B.tall_grass);
    expect(w.height(10, 10)).toBe(32);
    expect(w.groundY(10, 10)).toBe(31);
  });

  it('marks every section that can see an edited cell and reports the change', () => {
    const w = createFlatWorld(64, 64, 31);
    const seen: number[] = [];
    w.changed.on((c) => seen.push(c.old, c.state));
    w.dirty.clear();
    w.set(32, 31, 31, B.stone);
    // On the corner between four columns and two layers: 8 sections.
    expect(w.dirty.size).toBe(8);
    expect(seen).toEqual([B.grass, B.stone]);
  });

  it('gives fences arms toward what they join', () => {
    const w = createFlatWorld(64, 64, 31);
    w.set(10, 32, 10, B.fence);
    const alone: number[] = [];
    w.collisionBoxes(10, 32, 10, alone);
    expect(alone).toHaveLength(6);
    w.set(11, 32, 10, B.fence);
    w.set(10, 32, 9, B.stone);
    const joined: number[] = [];
    w.collisionBoxes(10, 32, 10, joined);
    expect(joined).toHaveLength(18);
    expect(w.connectMask(10, 32, 10)).toBe(1 | 8);
  });
});

describe('light', () => {
  it('fills open air with sky and leaves rock dark', () => {
    const w = createFlatWorld(64, 64, 31);
    new LightEngine(w).computeAll();
    expect(w.skyLight(5, 32, 5)).toBe(15);
    expect(w.skyLight(5, 60, 5)).toBe(15);
    expect(w.skyLight(5, 31, 5)).toBe(0);
    expect(w.blockLight(5, 32, 5)).toBe(0);
  });

  it('fades sky sideways under a roof', () => {
    const w = createFlatWorld(64, 64, 31);
    for (let z = 20; z < 40; z++) for (let x = 20; x < 40; x++) w.set(x, 35, z, B.oak_planks);
    new LightEngine(w).computeAll();
    expect(w.skyLight(19, 33, 30)).toBe(15);
    expect(w.skyLight(20, 33, 30)).toBe(14);
    expect(w.skyLight(25, 33, 30)).toBe(9);
    expect(w.skyLight(30, 33, 30)).toBeLessThan(6);
  });

  it('spreads torch light and stops it at walls', () => {
    const w = createFlatWorld(64, 64, 31);
    const light = new LightEngine(w);
    light.computeAll();
    light.attach();
    for (let y = 32; y < 36; y++) for (let z = 28; z < 33; z++) w.set(33, y, z, B.stone);
    w.set(30, 32, 30, B.torch);
    expect(w.blockLight(30, 32, 30)).toBe(14);
    expect(w.blockLight(31, 32, 30)).toBe(13);
    expect(w.blockLight(32, 32, 30)).toBe(12);
    expect(w.blockLight(33, 32, 30)).toBe(0);
    expect(w.blockLight(34, 32, 30)).toBeLessThan(8);
    w.set(30, 32, 30, B.air);
    expect(w.blockLight(31, 32, 30)).toBe(0);
  });

  it('repairs light after edits exactly as a full recompute would', () => {
    const rng = new Rng(1234);
    const w = createFlatWorld(64, 64, 20);
    // Rough terrain so there are overhangs, pits and shaded hollows to get wrong.
    for (let i = 0; i < 400; i++) {
      const x = rng.int(64);
      const z = rng.int(64);
      const h = 21 + rng.int(12);
      for (let y = 21; y < h; y++) w.setRaw(x, y, z, rng.chance(0.2) ? B.oak_leaves : B.stone);
    }
    w.recomputeHeightmap();
    const light = new LightEngine(w);
    light.computeAll();
    light.attach();
    const palette = [B.air, B.air, B.stone, B.oak_leaves, B.torch, B.water_source, B.window, B.oak_slab, B.lantern + 1, B.tall_grass];
    for (let i = 0; i < 600; i++) {
      w.set(rng.int(64), 14 + rng.int(26), rng.int(64), rng.pick(palette));
    }
    const fresh = w.clone();
    new LightEngine(fresh).computeAll();
    let mismatches = 0;
    for (let y = 0; y < 64; y++) {
      for (let z = 0; z < 64; z++) {
        for (let x = 0; x < 64; x++) {
          // Light inside a solid opaque cell is never read; compare everything else.
          if (w.getLight(x, y, z) !== fresh.getLight(x, y, z)) mismatches++;
        }
      }
    }
    expect(mismatches).toBe(0);
    expect(SOLID[B.stone]).toBe(1);
  });
});
