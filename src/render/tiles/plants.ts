// Painters for foliage, ground plants and crops. All of these are cutout
// tiles: the painter clears the tile and draws only the plant.

import { type Art, type Rgb, TILE, hex, mixRgb, scaleRgb } from './art';
import type { Painter } from './terrain';

const LEAF = hex('#5f8f3d');
const LEAF_DARK = hex('#46702c');
const STEM = hex('#527f38');

function canopy(light: Rgb, dark: Rgb, holes: number, needles = false): Painter {
  return (a) => {
    const mid = mixRgb(light, dark, 0.5);
    a.each((x, y) => {
      // Clumps at two scales under per-pixel grain: no single blob is big enough to be picked out
      // again in the next block, which is what makes a repeated tile read as a pattern.
      const v = 0.36 * a.n(x, y, 8, 1) + 0.24 * a.n(x, y, 4, 3) + 0.4 * a.r(x, y, 2);
      const streak = needles ? 0.12 * (((x + y * 2) % 4) < 2 ? 1 : -1) : 0;
      const c = v > 0.57 ? light : v < 0.43 ? dark : mid;
      return scaleRgb(c, 0.9 + 0.2 * a.r(x, y, 5) + streak);
    });
    // Gaps are mostly single pixels, loosely gathered, and every tile gets some.
    const gap = (x: number, y: number): boolean => a.n(x, y, 8, 7) * 0.4 + a.r(x, y, 8) * 0.6 < holes;
    for (let y = 0; y < TILE; y++) {
      for (let x = 0; x < TILE; x++) {
        if (gap(x, y)) a.alpha[y * TILE + x] = 0;
        // The leaf below a gap is in the shade of the ones around it, which gives the canopy depth.
        else if (gap(x, y - 1)) a.px(x, y, scaleRgb(a.get(x, y), 0.7));
      }
    }
    a.setRough(0.7);
  };
}

/** Upright blades or stalks rising from the bottom edge. */
function blades(count: number, minH: number, maxH: number, shades: readonly Rgb[], lean = 1, head?: (a: Art, x: number, y: number, i: number) => void): Painter {
  return (a) => {
    a.clear();
    for (let i = 0; i < count; i++) {
      const x0 = Math.round(1 + ((i + a.r(i, 0, 3) * 0.8) * (TILE - 2)) / count);
      const h = Math.round(minH + a.r(i, 1, 4) * (maxH - minH));
      const bend = Math.round((a.r(i, 2, 5) - 0.5) * 2 * lean);
      const c = shades[i % shades.length] as Rgb;
      for (let k = 0; k < h; k++) {
        const x = x0 + Math.round((bend * k * k) / Math.max(1, h * h));
        a.px(x, 15 - k, scaleRgb(c, 0.85 + 0.3 * (k / h)));
      }
      if (head) head(a, x0 + bend, 15 - h, i);
    }
    a.setRough(0.75);
  };
}

/** A single flower on a stem with a pair of leaves. */
function flower(draw: (a: Art) => void, stemTop = 7): Painter {
  return (a) => {
    a.clear();
    for (let y = 15; y >= stemTop; y--) a.px(y > 11 ? 8 : 7, y, STEM);
    a.px(6, 12, LEAF); a.px(5, 11, LEAF); a.px(9, 13, LEAF_DARK); a.px(10, 12, LEAF_DARK);
    draw(a);
    a.setRough(0.7);
  };
}

function mushroom(cap: Rgb, spots: Rgb | null): Painter {
  return (a) => {
    a.clear();
    const stalk = hex('#e2d7c0');
    a.rect(7, 11, 8, 15, stalk);
    for (let y = 7; y <= 10; y++) {
      const half = y === 7 ? 2 : y === 8 ? 4 : 5;
      for (let x = 8 - half; x < 8 + half; x++) a.px(x, y, scaleRgb(cap, y === 7 ? 1.15 : y === 10 ? 0.8 : 1));
    }
    a.rect(12, 13, 12, 15, stalk);
    a.rect(11, 12, 13, 12, scaleRgb(cap, 0.95));
    if (spots) for (const [x, y] of [[5, 9], [8, 8], [10, 9], [7, 10]] as const) a.px(x, y, spots);
  };
}

function bush(berries: boolean): Painter {
  return (a) => {
    a.clear();
    a.rect(7, 12, 8, 15, hex('#5c4630'));
    a.blob(7.5, 8, 7, 5.5, hex('#3f7a34'), 0.93, 0.16);
    a.blob(5, 6, 2.5, 2, hex('#55933f'), 0.8, 0.1);
    if (berries) {
      for (const [x, y] of [[3, 8], [5, 10], [7, 6], [9, 9], [11, 7], [12, 10], [8, 11], [10, 5]] as const) {
        a.px(x, y, hex('#c22b3a'));
        a.px(x, y - 1 < 0 ? 0 : y - 1, a.r(x, y, 9) < 0.5 ? hex('#e0566a') : a.get(x, y - 1));
      }
    }
    a.setRough(0.7);
  };
}

function sapling(leaf: Rgb, cone: boolean): Painter {
  return (a) => {
    a.clear();
    a.rect(8, 9, 8, 15, hex('#6d5536'));
    if (cone) {
      for (let y = 2; y <= 11; y++) {
        const half = Math.floor((y - 1) / 2.4) + (y % 2);
        for (let x = 8 - half; x <= 8 + half; x++) a.px(x, y, scaleRgb(leaf, 0.85 + 0.3 * a.r(x, y, 2)));
      }
    } else {
      a.blob(8, 5.5, 4, 3.6, leaf, 0.88, 0.15);
      a.px(6, 10, leaf); a.px(10, 11, leaf);
    }
    a.setRough(0.7);
  };
}

const grainHead = (ripe: Rgb, awns: boolean) => (a: Art, x: number, y: number): void => {
  a.rect(x, y, x, y + 2, ripe);
  a.px(x + 1, y + 1, scaleRgb(ripe, 0.85));
  if (awns) { a.px(x - 1, y - 1, scaleRgb(ripe, 1.1)); a.px(x + 1, y - 1, scaleRgb(ripe, 1.1)); a.px(x, y - 2, scaleRgb(ripe, 1.1)); }
};

function grain(stage: number, green: Rgb, gold: Rgb, awns: boolean): Painter {
  const shades = stage < 2 ? [green, scaleRgb(green, 0.85)] : stage === 2 ? [scaleRgb(green, 1.05), hex('#a9b24a')] : [gold, scaleRgb(gold, 0.88)];
  const h = [3, 7, 11, 12][stage] as number;
  return blades(stage === 0 ? 5 : 7, h - 1, h + 1, shades, stage === 3 ? 2 : 1, stage >= 2 ? grainHead(stage === 3 ? scaleRgb(gold, 0.9) : hex('#b9b757'), awns) : undefined);
}

function rosette(stage: number, leaf: Rgb, heart: Rgb | null, root: Rgb | null): Painter {
  return (a) => {
    a.clear();
    const r = [2.4, 3.4, 4.8, 6][stage] as number;
    a.blob(7.5, 15 - r * 0.75, r, r * 0.8, leaf, 0.92, 0.18);
    // Leaf ribs.
    for (let k = 0; k < stage + 1; k++) a.line(7, 15, 7 + Math.round((k - stage / 2) * 2.2), 15 - Math.round(r), scaleRgb(leaf, 1.25));
    if (heart && stage === 3) a.blob(7.5, 11, 3.6, 3, heart, 1, 0.08);
    if (root && stage === 3) { a.rect(5, 14, 9, 15, root); a.rect(6, 13, 8, 13, hex('#e9dfe6')); }
    a.setRough(0.7);
  };
}

export const plantPainters = {
  oak_leaves: canopy(hex('#5c8c39'), hex('#436b2a'), 0.3),
  birch_leaves: canopy(hex('#6d9a42'), hex('#527c34'), 0.36),
  pine_leaves: canopy(hex('#35633f'), hex('#264b31'), 0.22, true),

  tall_grass: blades(9, 6, 13, [LEAF, hex('#4d7a31'), hex('#6f9f46')], 2),
  fern: ((a) => {
    a.clear();
    const c1 = hex('#5b9a41');
    const c2 = hex('#447a33');
    for (let y = 15; y >= 5; y--) a.px(8, y, c2);
    for (let k = 0; k < 5; k++) {
      const y = 14 - k * 2;
      const reach = 6 - k;
      a.line(8, y, 8 - reach, y - 2, k % 2 ? c1 : c2);
      a.line(8, y, 8 + reach, y - 2, k % 2 ? c2 : c1);
      // Frond tips catch the light.
      a.px(8 - reach, y - 2, hex('#7fb856'));
      a.px(8 + reach, y - 2, hex('#7fb856'));
    }
    a.setRough(0.7);
  }) as Painter,
  poppy: flower((a) => {
    a.blob(7.5, 4.5, 3, 2.6, hex('#d5392e'), 1, 0.1);
    a.px(7, 5, hex('#2a1a1a')); a.px(8, 5, hex('#2a1a1a'));
    a.px(6, 3, hex('#e8584c'));
  }),
  daisy: flower((a) => {
    const w = hex('#f4f1e4');
    a.rect(7, 2, 8, 7, w);
    a.rect(5, 4, 10, 5, w);
    a.px(6, 3, w); a.px(9, 3, w); a.px(6, 6, w); a.px(9, 6, w);
    a.rect(7, 4, 8, 5, hex('#e8c43a'));
  }, 8),
  bluebell: ((a) => {
    a.clear();
    const bell = hex('#5b6fd0');
    for (let y = 15; y >= 6; y--) a.px(7, y, STEM);
    a.line(7, 6, 10, 3, STEM);
    for (const [x, y] of [[9, 5], [11, 4], [10, 8]] as const) {
      a.rect(x, y, x + 1, y + 1, bell);
      a.px(x, y + 2, hex('#8a99e6'));
    }
    a.px(5, 12, LEAF); a.px(6, 11, LEAF); a.px(9, 13, LEAF_DARK);
    a.setRough(0.7);
  }) as Painter,
  buttercup: ((a) => {
    a.clear();
    const y1 = hex('#f2d02c');
    for (const [x, top] of [[5, 7], [10, 5]] as const) {
      for (let y = 15; y > top; y--) a.px(x, y, STEM);
      a.rect(x - 1, top - 1, x + 1, top + 1, y1);
      a.px(x, top, hex('#c98f1c'));
    }
    a.px(7, 12, LEAF); a.px(8, 13, LEAF_DARK); a.px(3, 13, LEAF);
    a.setRough(0.7);
  }) as Painter,
  heather: ((a) => {
    a.clear();
    a.blob(7.5, 12.5, 7, 3.5, hex('#55783c'), 0.85, 0.15);
    for (let i = 0; i < 7; i++) {
      const x = 1 + i * 2 + Math.round(a.r(i, 0, 6));
      const top = 4 + Math.round(a.r(i, 1, 7) * 4);
      for (let y = top; y < 11; y++) a.px(x, y, a.r(x, y, 8) < 0.7 ? hex('#a8589a') : hex('#c684b8'));
    }
    a.setRough(0.75);
  }) as Painter,
  mushroom_brown: mushroom(hex('#9a6b42'), null),
  mushroom_red: mushroom(hex('#c8342b'), hex('#f4efe6')),
  reeds: blades(5, 11, 15, [hex('#7b9a4a'), hex('#647f3a')], 1, (a, x, y, i) => {
    if (i % 2 === 0) a.rect(x, Math.max(0, y), x, Math.max(0, y) + 3, hex('#5b4024'));
  }),
  seagrass: ((a) => {
    a.clear();
    for (let i = 0; i < 5; i++) {
      const base = 2 + i * 3;
      const h = 9 + Math.round(a.r(i, 0, 4) * 6);
      // Blades lighten toward their tips, where they reach the light.
      for (let k = 0; k < h; k++) {
        a.px(base + Math.round(Math.sin(k * 0.8 + i * 1.7) * 1.2), 15 - k, scaleRgb(i % 2 ? hex('#3f8a5a') : hex('#2f7049'), 0.8 + 0.5 * (k / h)));
      }
    }
    a.setRough(0.5);
  }) as Painter,
  berry_bush: bush(false),
  berry_bush_ripe: bush(true),
  sapling_oak: sapling(hex('#6c9c40'), false),
  sapling_birch: sapling(hex('#86b450'), false),
  sapling_pine: sapling(hex('#3a6b45'), true),
  lily_pad: ((a) => {
    a.clear();
    for (let y = 0; y < TILE; y++) {
      for (let x = 0; x < TILE; x++) {
        const dx = x - 7.5;
        const dy = y - 7.5;
        const d = Math.hypot(dx, dy);
        // A wedge cut out toward one edge gives the pad its notch.
        if (d > 6.6 || (dx > 0 && Math.abs(dy) < dx * 0.32)) continue;
        const vein = Math.abs(Math.sin(Math.atan2(dy, dx) * 4)) < 0.2 && d > 1.5;
        a.px(x, y, scaleRgb(hex('#4f8f45'), (vein ? 1.2 : 1) * (0.92 + 0.14 * a.r(x, y, 2))));
      }
    }
    a.setRough(0.4);
  }) as Painter,

  wheat_0: grain(0, hex('#6fa044'), hex('#d9b64a'), false),
  wheat_1: grain(1, hex('#6fa044'), hex('#d9b64a'), false),
  wheat_2: grain(2, hex('#7fa648'), hex('#d9b64a'), false),
  wheat_3: grain(3, hex('#7fa648'), hex('#d9b64a'), false),
  barley_0: grain(0, hex('#74a850'), hex('#cdbf6a'), true),
  barley_1: grain(1, hex('#74a850'), hex('#cdbf6a'), true),
  barley_2: grain(2, hex('#86ac56'), hex('#cdbf6a'), true),
  barley_3: grain(3, hex('#86ac56'), hex('#cdbf6a'), true),
  turnip_0: rosette(0, hex('#5f9a45'), null, hex('#a66aa8')),
  turnip_1: rosette(1, hex('#5f9a45'), null, hex('#a66aa8')),
  turnip_2: rosette(2, hex('#5f9a45'), null, hex('#a66aa8')),
  turnip_3: rosette(3, hex('#5f9a45'), null, hex('#a66aa8')),
  cabbage_0: rosette(0, hex('#5a8f55'), hex('#a9cc74'), null),
  cabbage_1: rosette(1, hex('#5a8f55'), hex('#a9cc74'), null),
  cabbage_2: rosette(2, hex('#5a8f55'), hex('#a9cc74'), null),
  cabbage_3: rosette(3, hex('#5a8f55'), hex('#a9cc74'), null),
} satisfies Record<string, Painter>;
