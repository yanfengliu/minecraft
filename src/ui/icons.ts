// Item icons for the interface, drawn once each into small canvases: a block
// as a little cube of its own tiles, a plant or fitting as its flat tile, and
// each trade good as a pixel sprite painted with the same tools as the tiles.

import { Art, type Rgb, TILE, hex, scaleRgb } from '../render/tiles/art';
import type { TileSet } from '../render/tiles';
import { BLOCKS, LAYER_CUTOUT, SHAPE_BOXES } from '../world/blocks';
import { ITEMS } from '../world/items';

const SIZE = 32;

type Sprite = (a: Art) => void;

const WOOD = hex('#8b6238');
const stalks = (a: Art, c: Rgb, heads: Rgb): void => {
  for (let i = 0; i < 5; i++) {
    const x = 4 + i * 2;
    a.line(x, 14, x + (i - 2), 4, c);
    a.rect(x + (i - 2) - 0, 2, x + (i - 2), 5, heads);
  }
  a.rect(5, 10, 11, 11, hex('#8a6b2f'));
};

/** One painter per trade good. */
const GOODS: Record<string, Sprite> = {
  wheat: (a) => stalks(a, hex('#c9a43a'), hex('#e2c456')),
  barley: (a) => stalks(a, hex('#b3a85a'), hex('#d6cc7a')),
  flour: (a) => {
    a.blob(8, 9, 5, 5.5, hex('#e9e2d0'), 1, 0.05);
    a.rect(6, 2, 10, 4, hex('#d6cdb6'));
    a.rect(5, 4, 11, 4, hex('#8a6b2f'));
  },
  bread: (a) => {
    a.blob(8, 9, 6.5, 4, hex('#c98a3e'), 1, 0.08);
    for (const x of [5, 8, 11]) a.line(x, 6, x + 1, 9, hex('#e9c98a'));
  },
  turnip: (a) => {
    a.blob(8, 10, 4, 4.5, hex('#e9dfe6'), 1, 0.04);
    a.blob(8, 8, 4, 2.5, hex('#a66aa8'), 1, 0.06);
    a.line(8, 5, 6, 1, hex('#5f9a45'));
    a.line(8, 5, 10, 1, hex('#5f9a45'));
    a.px(8, 15, hex('#e9dfe6'));
  },
  cabbage: (a) => {
    a.blob(8, 9, 6, 5.5, hex('#7fb05a'), 1, 0.1);
    a.blob(8, 8, 3.5, 3, hex('#a9cc74'), 1, 0.06);
  },
  fish: (a) => {
    a.blob(7, 8, 5.5, 3, hex('#8fa6b0'), 1, 0.08);
    a.rect(12, 6, 13, 10, hex('#6f8f9a'));
    a.px(14, 5, hex('#6f8f9a')); a.px(14, 11, hex('#6f8f9a'));
    a.px(4, 7, hex('#15120f'));
    a.rect(5, 10, 9, 10, hex('#d8dde0'));
  },
  meat: (a) => {
    a.blob(7, 8, 5, 4.5, hex('#b8473a'), 1, 0.08);
    a.blob(6, 7, 2, 1.6, hex('#e0a79a'), 1, 0);
    a.rect(11, 11, 14, 12, hex('#efe6d2'));
    a.rect(13, 10, 14, 13, hex('#efe6d2'));
  },
  egg: (a) => {
    a.blob(8, 8.5, 4, 5, hex('#efe6d2'), 1, 0.03);
    a.px(6, 6, hex('#ffffff'));
  },
  berries: (a) => {
    for (const [x, y] of [[5, 9], [9, 8], [7, 12], [11, 11]] as const) {
      a.blob(x, y, 2, 2, hex('#c22b3a'), 1, 0.08);
      a.px(x - 1, y - 1, hex('#e0566a'));
    }
    a.line(8, 6, 8, 2, hex('#5f9a45'));
    a.rect(8, 2, 11, 3, hex('#5f9a45'));
  },
  mushroom: (a) => {
    a.rect(7, 9, 8, 14, hex('#e2d7c0'));
    a.blob(7.5, 7, 5, 3, hex('#9a6b42'), 1, 0.08);
  },
  ale: (a) => {
    a.rect(4, 5, 10, 14, WOOD);
    a.rect(4, 7, 10, 7, hex('#43464b')); a.rect(4, 12, 10, 12, hex('#43464b'));
    a.rect(4, 3, 10, 4, hex('#efe6d2'));
    a.rect(11, 7, 12, 11, WOOD); a.px(13, 8, WOOD); a.px(13, 10, WOOD);
  },
  wool: (a) => {
    for (const [x, y] of [[6, 7], [10, 7], [5, 10], [8, 10], [11, 10], [8, 5]] as const) a.blob(x, y, 2.6, 2.4, hex('#ece8dc'), 1, 0.05);
  },
  cloth: (a) => {
    a.rect(3, 5, 12, 12, hex('#3e5fa8'));
    for (let y = 5; y <= 12; y += 2) a.rect(3, y, 12, y, hex('#5574ba'));
    a.rect(13, 5, 13, 12, hex('#2a437c'));
  },
  hide: (a) => {
    a.blob(8, 8, 5.5, 5, hex('#9a6b3f'), 1, 0.1);
    for (const [x, y] of [[2, 3], [13, 3], [2, 13], [13, 13]] as const) a.rect(x, y, x + 1, y + 1, hex('#9a6b3f'));
  },
  firewood: (a) => {
    for (const y of [5, 9, 12]) {
      a.rect(3, y, 12, y + 2, hex('#6d5536'));
      a.rect(12, y, 13, y + 2, hex('#b9985f'));
    }
  },
  coal: (a) => {
    a.blob(8, 9, 5.5, 4.5, hex('#24231f'), 1, 0.25);
    a.px(6, 7, hex('#5a5852')); a.px(10, 9, hex('#4a4944'));
  },
  iron: (a) => {
    a.rect(2, 8, 13, 11, hex('#7c8088'));
    a.rect(3, 6, 14, 7, hex('#a3a8b0'));
    a.rect(14, 8, 14, 11, hex('#5a5e66'));
  },
  tools: (a) => {
    a.line(4, 13, 11, 4, WOOD);
    a.rect(9, 2, 13, 5, hex('#7c8088'));
    a.line(4, 4, 12, 13, scaleRgb(WOOD, 0.8));
    a.rect(2, 2, 5, 4, hex('#a3a8b0'));
  },
};

function tileCanvas(set: TileSet, layer: number): HTMLCanvasElement {
  const c = document.createElement('canvas');
  c.width = c.height = TILE;
  const ctx = c.getContext('2d') as CanvasRenderingContext2D;
  const img = ctx.createImageData(TILE, TILE);
  img.data.set(set.albedo.subarray(layer * TILE * TILE * 4, (layer + 1) * TILE * TILE * 4));
  ctx.putImageData(img, 0, 0);
  return c;
}

function spriteCanvas(paint: Sprite): HTMLCanvasElement {
  const art = new Art(7);
  art.clear();
  paint(art);
  const c = document.createElement('canvas');
  c.width = c.height = TILE;
  const ctx = c.getContext('2d') as CanvasRenderingContext2D;
  const img = ctx.createImageData(TILE, TILE);
  for (let i = 0; i < TILE * TILE; i++) {
    img.data[i * 4] = Math.round(255 * Math.min(1, art.rgb[i * 3] as number));
    img.data[i * 4 + 1] = Math.round(255 * Math.min(1, art.rgb[i * 3 + 1] as number));
    img.data[i * 4 + 2] = Math.round(255 * Math.min(1, art.rgb[i * 3 + 2] as number));
    img.data[i * 4 + 3] = (art.alpha[i] as number) > 0.5 ? 255 : 0;
  }
  ctx.putImageData(img, 0, 0);
  return c;
}

export class Icons {
  private readonly set: TileSet;
  private readonly cache = new Map<number, string>();

  constructor(set: TileSet) {
    this.set = set;
  }

  /** A data URL for an item's icon. */
  url(itemId: number): string {
    let url = this.cache.get(itemId);
    if (url) return url;
    const def = ITEMS[itemId];
    const out = document.createElement('canvas');
    out.width = out.height = SIZE;
    const ctx = out.getContext('2d') as CanvasRenderingContext2D;
    ctx.imageSmoothingEnabled = false;
    if (!def) return '';
    if (def.kind === 'good') {
      const paint = GOODS[def.name];
      if (paint) ctx.drawImage(spriteCanvas(paint), 0, 0, SIZE, SIZE);
    } else {
      const state = BLOCKS[def.block] as (typeof BLOCKS)[number];
      const flat = def.icon === 'flat' || (state.shape === SHAPE_BOXES && state.layer === LAYER_CUTOUT);
      if (flat) {
        const tile = state.boxes.find((b) => b.tiles)?.tiles?.[4] ?? (state.tiles[4] as number);
        ctx.drawImage(tileCanvas(this.set, flat && def.icon === 'flat' ? (state.tiles[0] as number) : tile), 2, 2, SIZE - 4, SIZE - 4);
      } else {
        // A little cube: top, left and right faces, each a touch darker than the last.
        const top = tileCanvas(this.set, state.tiles[2] as number);
        const left = tileCanvas(this.set, state.tiles[4] as number);
        const right = tileCanvas(this.set, state.tiles[0] as number);
        const face = (img: HTMLCanvasElement, a: number, b: number, c: number, d: number, e: number, f: number, shade: number): void => {
          ctx.setTransform(a, b, c, d, e, f);
          ctx.globalCompositeOperation = 'source-over';
          ctx.drawImage(img, 0, 0);
          // Shade only what was drawn, so the gaps in foliage stay clear.
          ctx.globalCompositeOperation = 'source-atop';
          ctx.fillStyle = `rgba(0,0,0,${shade})`;
          ctx.fillRect(0, 0, TILE, TILE);
          ctx.globalCompositeOperation = 'source-over';
        };
        face(top, 1, 0.5, -1, 0.5, 16, 0, 0);
        face(left, 1, 0.5, 0, 1, 0, 8, 0.22);
        face(right, 1, -0.5, 0, 1, 16, 16, 0.42);
        ctx.setTransform(1, 0, 0, 1, 0, 0);
      }
    }
    url = out.toDataURL();
    this.cache.set(itemId, url);
    return url;
  }
}
