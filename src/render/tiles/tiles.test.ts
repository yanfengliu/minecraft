import { describe, expect, it } from 'vitest';
import { BLOCKS, LAYER_CUTOUT, LAYER_OPAQUE, SHAPE_CUBE } from '../../world/blocks';
import { TILE_COUNT, TILE_NAMES } from '../../world/tiles';
import { buildTileSet } from './index';

describe('tile set', () => {
  const set = buildTileSet();
  const px = set.size * set.size;
  const alphaOf = (layer: number): number[] => Array.from({ length: px }, (_, i) => set.albedo[(layer * px + i) * 4 + 3]!);

  it('paints every tile with real variation', () => {
    expect(set.count).toBe(TILE_COUNT);
    for (let layer = 0; layer < TILE_COUNT; layer++) {
      const colours = new Set<number>();
      for (let i = 0; i < px; i++) {
        const o = (layer * px + i) * 4;
        if (set.albedo[o + 3]! < 13) continue;
        colours.add((set.albedo[o]! << 16) | (set.albedo[o + 1]! << 8) | set.albedo[o + 2]!);
      }
      expect(colours.size, `tile ${TILE_NAMES[layer]} is flat`).toBeGreaterThan(2);
    }
  });

  it('gives full cubes in the opaque layer fully opaque faces', () => {
    for (const s of BLOCKS) {
      if (s.shape !== SHAPE_CUBE || s.layer !== LAYER_OPAQUE) continue;
      for (const t of s.tiles) {
        expect(Math.min(...alphaOf(t)), `${s.name} uses see-through tile ${TILE_NAMES[t]}`).toBe(255);
      }
    }
  });

  it('cuts real holes in the tiles of plants and foliage, and leaves something to see', () => {
    for (const s of BLOCKS) {
      if (s.layer !== LAYER_CUTOUT || s.shape === 3) continue;
      const alpha = alphaOf(s.tiles[0]!);
      const solid = alpha.filter((a) => a > 127).length;
      // Seedlings are small, but a tile with only a handful of pixels would vanish at any distance.
      expect(solid, `${s.name} tile is nearly empty`).toBeGreaterThan(9);
      expect(solid, `${s.name} tile has no holes`).toBeLessThan(px);
    }
  });

  it('marks glowing tiles as emissive and nothing else', () => {
    const emits = (name: string): number => {
      const layer = TILE_NAMES.indexOf(name as (typeof TILE_NAMES)[number]);
      let m = 0;
      for (let i = 0; i < px; i++) m = Math.max(m, set.material[(layer * px + i) * 4 + 3]!);
      return m;
    };
    for (const name of ['flame', 'lantern_glow', 'coals_lit', 'oven_front_lit']) expect(emits(name), name).toBeGreaterThan(150);
    for (const name of ['stone', 'grass_top', 'lantern_off', 'coals', 'oven_front', 'oak_planks']) expect(emits(name), name).toBe(0);
  });

  it('keeps flat surfaces flat and gives relief to rough ones', () => {
    const relief = (name: string): number => {
      const layer = TILE_NAMES.indexOf(name as (typeof TILE_NAMES)[number]);
      let m = 0;
      for (let i = 0; i < px; i++) {
        const o = (layer * px + i) * 4;
        m = Math.max(m, Math.abs(set.material[o]! - 128), Math.abs(set.material[o + 1]! - 128));
      }
      return m;
    };
    expect(relief('cobble')).toBeGreaterThan(30);
    expect(relief('bricks')).toBeGreaterThan(30);
    expect(relief('wool_white')).toBeLessThan(30);
  });
});
