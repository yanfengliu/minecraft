// Builds the tile set: one albedo layer and one material layer per name in
// TILE_NAMES, in that order. DOM-free; the renderer uploads the result.
//
//   albedo    sRGB colour and alpha
//   material  r, g = tangent-space normal x, y (0.5 is flat)   b = roughness   a = emission

import { TILE_COUNT, TILE_NAMES, type TileName } from '../../world/tiles';
import { Art, TILE } from './art';
import { fittingPainters } from './fittings';
import { plantPainters } from './plants';
import { type Painter, terrainPainters } from './terrain';

/** Every tile name must have a painter; a missing one is a compile error here. */
export const PAINTERS: Record<TileName, Painter> = { ...terrainPainters, ...plantPainters, ...fittingPainters };

export interface TileSet {
  size: number;
  count: number;
  albedo: Uint8Array;
  material: Uint8Array;
  /** Mean opaque colour of each tile (linear 0..1 rgb), for particles and distant shading. */
  average: Float32Array;
}

const NORMAL_STRENGTH = 2.2;

export function buildTileSet(): TileSet {
  const px = TILE * TILE;
  const albedo = new Uint8Array(TILE_COUNT * px * 4);
  const material = new Uint8Array(TILE_COUNT * px * 4);
  const average = new Float32Array(TILE_COUNT * 3);
  const toLinear = (v: number): number => (v <= 0.04045 ? v / 12.92 : Math.pow((v + 0.055) / 1.055, 2.4));

  TILE_NAMES.forEach((name, layer) => {
    const art = new Art(layer + 1);
    PAINTERS[name](art);

    // Mean colour of the visible pixels; transparent ones take it too, so mipmaps do not darken cutout edges.
    let r = 0, g = 0, b = 0, n = 0;
    for (let i = 0; i < px; i++) {
      if ((art.alpha[i] as number) < 0.05) continue;
      r += art.rgb[i * 3] as number;
      g += art.rgb[i * 3 + 1] as number;
      b += art.rgb[i * 3 + 2] as number;
      n++;
    }
    if (n === 0) throw new Error(`tile ${name} painted nothing`);
    r /= n; g /= n; b /= n;
    average[layer * 3] = toLinear(r);
    average[layer * 3 + 1] = toLinear(g);
    average[layer * 3 + 2] = toLinear(b);

    const base = layer * px * 4;
    for (let y = 0; y < TILE; y++) {
      for (let x = 0; x < TILE; x++) {
        const i = y * TILE + x;
        const o = base + i * 4;
        const visible = (art.alpha[i] as number) >= 0.05;
        albedo[o] = Math.round(255 * Math.min(1, Math.max(0, visible ? (art.rgb[i * 3] as number) : r)));
        albedo[o + 1] = Math.round(255 * Math.min(1, Math.max(0, visible ? (art.rgb[i * 3 + 1] as number) : g)));
        albedo[o + 2] = Math.round(255 * Math.min(1, Math.max(0, visible ? (art.rgb[i * 3 + 2] as number) : b)));
        albedo[o + 3] = Math.round(255 * (art.alpha[i] as number));

        // Normal from the height field by central differences, wrapping so tiles join without a seam.
        const dx = (art.h(x + 1, y) - art.h(x - 1, y)) * NORMAL_STRENGTH;
        const dy = (art.h(x, y + 1) - art.h(x, y - 1)) * NORMAL_STRENGTH;
        const len = Math.hypot(dx, dy, 1);
        material[o] = Math.round(255 * (0.5 - (0.5 * dx) / len));
        material[o + 1] = Math.round(255 * (0.5 - (0.5 * dy) / len));
        material[o + 2] = Math.round(255 * Math.min(1, Math.max(0.03, art.rough[i] as number)));
        material[o + 3] = Math.round(255 * Math.min(1, art.emit[i] as number));
      }
    }
  });
  return { size: TILE, count: TILE_COUNT, albedo, material, average };
}
