// Painters for ground, rock, wood, masonry, roofing and cloth tiles.

import { type Art, type Rgb, TILE, hex, mixRgb, scaleRgb } from './art';

export type Painter = (a: Art) => void;

const DIRT = hex('#7b5a3c');
const STONE = hex('#8b8b87');
const BEAM = hex('#4b3524');
const GRASS = hex('#5c8a3b');

/** Blotchy base colour with scattered flecks: the workhorse for natural surfaces. */
function mottled(base: Rgb, blotch: number, flecks: readonly (readonly [Rgb, number])[] = [], cell = 4): Painter {
  return (a) => {
    a.each((x, y) => {
      let c = scaleRgb(base, 1 - blotch + 2 * blotch * a.n(x, y, cell));
      flecks.forEach(([col, p], i) => {
        if (a.r(x, y, 20 + i) < p) c = col;
      });
      return c;
    });
    a.grain(blotch * 0.4);
  };
}

const dirt = mottled(DIRT, 0.1, [[hex('#9a7550'), 0.06], [hex('#5d4129'), 0.08], [hex('#8a8377'), 0.02]]);
const grassTop = mottled(GRASS, 0.12, [[hex('#6d9d46'), 0.12], [hex('#49722f'), 0.14]]);
const stone: Painter = (a) => {
  // Broad soft blotches with a little grit; one faint seam, so a wall of it reads as rock and not as a pattern.
  a.each((x, y) => {
    const broad = a.n(x, y, 8, 1);
    const fine = a.n(x, y, 4, 2);
    let c = scaleRgb(STONE, 0.88 + 0.16 * broad + 0.08 * fine);
    if (a.r(x, y, 21) < 0.05) c = scaleRgb(STONE, 0.78);
    else if (a.r(x, y, 22) < 0.04) c = scaleRgb(STONE, 1.1);
    return c;
  });
  for (let x = 0; x < TILE; x++) {
    const y = 9 + Math.round((a.n(x, 0, 8, 5) - 0.5) * 5);
    if (a.r(x, 3, 23) < 0.7) a.px(x, ((y % TILE) + TILE) % TILE, scaleRgb(STONE, 0.8));
  }
};

/** A top fringe of `top` hanging over a body painted by `body`. */
function fringed(body: Painter, shades: readonly Rgb[], minDepth: number, extra: number): Painter {
  return (a) => {
    body(a);
    for (let x = 0; x < TILE; x++) {
      const depth = minDepth + Math.floor(a.r(x, 0, 5) * (extra + 1));
      for (let y = 0; y < depth; y++) a.px(x, y, shades[Math.floor(a.r(x, y, 6) * shades.length)] as Rgb);
      a.px(x, depth, scaleRgb(shades[0] as Rgb, 0.72));
    }
  };
}

/** Rounded stones in mortar, from a jittered-grid Voronoi that tiles. */
function cobbled(stones: readonly Rgb[], mortar: Rgb, cells: number, moss: Rgb | null = null): Painter {
  return (a) => {
    const size = TILE / cells;
    a.each((x, y) => {
      let d1 = 99;
      let d2 = 99;
      let id = 0;
      let ox = 0;
      let oy = 0;
      for (let cy = -1; cy <= cells; cy++) {
        for (let cx = -1; cx <= cells; cx++) {
          const px = (cx + 0.5 + (a.r(cx * 3, cy * 3, 31) - 0.5) * 0.7) * size;
          const py = (cy + 0.5 + (a.r(cx * 3, cy * 3, 32) - 0.5) * 0.7) * size;
          const d = Math.hypot(x + 0.5 - px, y + 0.5 - py);
          if (d < d1) { d2 = d1; d1 = d; id = Math.floor(a.r(cx * 3, cy * 3, 33) * stones.length); ox = x + 0.5 - px; oy = y + 0.5 - py; }
          else if (d < d2) d2 = d;
        }
      }
      if (d2 - d1 < 0.85) {
        a.heightAt(x, y, 0.15);
        return mortar;
      }
      a.heightAt(x, y, 0.55 + 0.45 * Math.max(0, 1 - d1 / (size * 0.6)));
      // Light falls from the upper left of each stone.
      let c = scaleRgb(stones[id] as Rgb, 1 - 0.07 * (ox + oy) / size + 0.06 * (a.r(x, y, 34) - 0.5));
      if (moss && a.n(x, y, 4, 9) > 0.56) c = mixRgb(c, moss, 0.75);
      return c;
    });
  };
}

function ore(blob: Rgb, shine: Rgb): Painter {
  return (a) => {
    stone(a);
    for (const [cx, cy, r] of [[3, 3, 1.6], [11, 4, 1.3], [6, 9, 1.7], [12, 12, 1.5], [2, 13, 1.1]] as const) {
      a.blob(cx, cy, r, r * 0.85, blob, 0.92, 0.12);
      a.px(cx, cy - 1, shine);
    }
  };
}

/** Bark: vertical ridges and grooves that wander a little. */
function bark(base: Rgb, groove: Rgb, ridge: Rgb): Painter {
  return (a) => {
    a.each((x, y) => {
      const wander = Math.round((a.n(x, y, 8, 3) - 0.5) * 2.4);
      const k = a.r(x + wander, 0, 41);
      const c = k < 0.3 ? groove : k > 0.78 ? ridge : base;
      return scaleRgb(c, 0.92 + 0.16 * a.r(x, y, 42));
    });
  };
}

/** End grain: growth rings inside a rim of bark. */
function rings(light: Rgb, dark: Rgb, rim: Rgb): Painter {
  return (a) => {
    a.each((x, y) => {
      const d = Math.hypot(x - 7.5, y - 7.5) + (a.n(x, y, 4, 5) - 0.5) * 0.9;
      if (d > 6.9) return scaleRgb(rim, 0.9 + 0.2 * a.r(x, y, 43));
      if (d < 0.9) return scaleRgb(dark, 0.8);
      return Math.floor(d * 1.15) % 2 === 0 ? light : dark;
    });
  };
}

/** Four boards across the tile with staggered butt joints and a nail by each. */
function planks(base: Rgb, seam: Rgb): Painter {
  return (a) => {
    a.each((x, y) => {
      const board = y >> 2;
      const joint = (board * 5 + 3) % TILE;
      const shade = 0.93 + 0.14 * a.r(board, 99, 50);
      const grainLine = a.n(x, y * 4, 8, board) * 0.12;
      let c = scaleRgb(base, shade - grainLine + 0.05);
      if ((y & 3) === 3 || x === joint) c = seam;
      else if ((y & 3) === 0) c = scaleRgb(c, 1.06);
      if (x === (joint + 1) % TILE && (y & 3) === 1) c = scaleRgb(seam, 0.7);
      return c;
    });
  };
}

function bricks(shades: readonly Rgb[], mortar: Rgb, w: number, h: number): Painter {
  return (a) => {
    a.each((x, y) => {
      const row = Math.floor(y / h);
      const sx = (x + (row % 2) * (w >> 1)) % TILE;
      const col = Math.floor(sx / w);
      const lx = sx % w;
      const ly = y % h;
      if (lx === 0 || ly === 0) {
        a.heightAt(x, y, 0.2);
        return mortar;
      }
      a.heightAt(x, y, 0.8);
      const c = shades[Math.floor(a.r(col * 7, row * 13, 60) * shades.length)] as Rgb;
      const bevel = (lx === 1 || ly === 1 ? 1.07 : 1) * (lx === w - 1 || ly === h - 1 ? 0.92 : 1);
      return scaleRgb(c, bevel * (0.95 + 0.1 * a.r(x, y, 61)));
    });
  };
}

function framed(extra: (x: number, y: number) => boolean): Painter {
  return (a) => {
    plaster(a);
    a.each((x, y) => {
      const border = x < 2 || y < 2 || x > 13 || y > 13;
      if (border || extra(x, y)) {
        a.heightAt(x, y, 0.9);
        return scaleRgb(BEAM, 0.88 + 0.24 * a.n(x * 4, y, 8, 2));
      }
      a.heightAt(x, y, 0.5);
      return a.get(x, y);
    });
  };
}

const plaster: Painter = (a) => {
  mottled(hex('#e7ddc5'), 0.035, [[hex('#d6cab0'), 0.03]], 8)(a);
  a.line(4, 9, 7, 11, hex('#cfc3a8'));
};

function rowsOf(shades: readonly Rgb[], rowH: number, tileW: number, round: boolean): Painter {
  return (a) => {
    a.each((x, y) => {
      const row = Math.floor(y / rowH);
      const sx = (x + (row % 2) * (tileW >> 1)) % TILE;
      const lx = sx % tileW;
      const ly = y % rowH;
      const c = shades[Math.floor(a.r(Math.floor(sx / tileW) * 5, row * 11, 70) * shades.length)] as Rgb;
      // Each course overlaps the one below, so its lower edge casts a line of shadow.
      let k = ly === rowH - 1 ? 0.62 : ly === 0 ? 1.1 : 1;
      if (lx === 0) k *= 0.78;
      if (round && (lx === 1 || lx === tileW - 1) && ly === rowH - 2) k *= 0.85;
      a.heightAt(x, y, ly === rowH - 1 ? 0.1 : 0.4 + 0.6 * (ly / rowH));
      return scaleRgb(c, k * (0.95 + 0.1 * a.r(x, y, 71)));
    });
  };
}

function woven(base: Rgb): Painter {
  return (a) => {
    a.each((x, y) => scaleRgb(base, ((x + y) & 1 ? 0.95 : 1.03) * (0.96 + 0.08 * a.r(x, y, 80))));
    a.setRough(0.95);
  };
}

function striped(c1: Rgb, c2: Rgb): Painter {
  return (a) => {
    a.each((x, y) => scaleRgb((x >> 2) & 1 ? c1 : c2, ((x + y) & 1 ? 0.96 : 1.02) * (0.97 + 0.06 * a.r(x, y, 81))));
    a.setRough(0.95);
  };
}

const thatch: Painter = (a) => {
  const straw = hex('#c9ab57');
  a.each((x, y) => {
    const row = Math.floor((y + 1) / 5);
    const k = 0.84 + 0.3 * a.r(x, row, 90);
    if ((y + 1) % 5 === 0) return scaleRgb(hex('#9c8339'), 0.85);
    return scaleRgb(straw, k * (1 - 0.05 * ((y + 1) % 5)));
  });
  a.setRough(0.97);
};

export const terrainPainters = {
  grass_top: grassTop,
  grass_side: fringed(dirt, [GRASS, hex('#6d9d46'), hex('#49722f')], 2, 2),
  dirt,
  forest_floor: mottled(hex('#5b4a33'), 0.12, [[hex('#7c6238'), 0.1], [hex('#3f3220'), 0.12], [hex('#586430'), 0.06]]),
  forest_side: fringed(dirt, [hex('#4e3f2b'), hex('#5b4a33'), hex('#3f3220')], 2, 1),
  stone,
  granite: mottled(hex('#81766f'), 0.05, [[hex('#a3938b'), 0.18], [hex('#4e4844'), 0.12], [hex('#c0b6ae'), 0.06]], 8),
  cobble: cobbled([hex('#908e89'), hex('#7f7d78'), hex('#a19f99')], hex('#56544f'), 4),
  mossy_cobble: cobbled([hex('#908e89'), hex('#7f7d78'), hex('#a19f99')], hex('#56544f'), 4, hex('#5d7a3a')),
  gravel: cobbled([hex('#8d8880'), hex('#6f6a63'), hex('#a39e95'), hex('#7c766e')], hex('#5c5852'), 8),
  sand: mottled(hex('#dccf9c'), 0.03, [[hex('#cdbf8a'), 0.05], [hex('#e9ddb0'), 0.05]], 8),
  clay: ((a) => {
    mottled(hex('#9aa2ab'), 0.03, [], 8)(a);
    for (let x = 0; x < TILE; x++) for (const y of [4, 10]) a.px(x, y + Math.round(a.n(x, 0, 8, y) * 1.5), hex('#8a929b'));
  }) as Painter,
  snow: ((a) => {
    a.each((x, y) => mixRgb(hex('#f2f6fa'), hex('#dbe6f1'), a.n(x, y, 8) * 0.8));
    a.each((x, y) => (a.r(x, y, 3) < 0.03 ? hex('#ffffff') : a.get(x, y)));
    a.setRough(0.55);
  }) as Painter,
  bedrock: mottled(hex('#3b3b3f'), 0.25, [[hex('#27272a'), 0.12], [hex('#4d4d52'), 0.08]]),
  coal_ore: ore(hex('#24231f'), hex('#4a4944')),
  iron_ore: ore(hex('#b38a66'), hex('#dcb891')),
  path_top: mottled(hex('#a1865b'), 0.07, [[hex('#8f8a80'), 0.04], [hex('#b79a6a'), 0.06], [hex('#86704a'), 0.06]]),
  farmland_dry: ((a) => {
    a.each((x, y) => scaleRgb((y & 3) < 2 ? hex('#7c5c3b') : hex('#654a2f'), 0.92 + 0.16 * a.r(x, y, 2)));
  }) as Painter,
  farmland_wet: ((a) => {
    a.each((x, y) => scaleRgb((y & 3) < 2 ? hex('#523a25') : hex('#3f2c1c'), 0.92 + 0.16 * a.r(x, y, 2)));
    a.setRough(0.45);
  }) as Painter,

  oak_log: bark(hex('#6d5536'), hex('#4b3a23'), hex('#806744')),
  oak_log_top: rings(hex('#b9985f'), hex('#a3824c'), hex('#6d5536')),
  birch_log: ((a) => {
    mottled(hex('#dedbd1'), 0.04, [[hex('#c9c6bb'), 0.06]], 8)(a);
    for (let i = 0; i < 11; i++) {
      const x = Math.floor(a.r(i, 1, 44) * TILE);
      const y = Math.floor(a.r(i, 2, 45) * TILE);
      const len = 1 + Math.floor(a.r(i, 3, 46) * 4);
      for (let k = 0; k < len; k++) a.px((x + k) % TILE, y, hex('#2f2d29'));
    }
  }) as Painter,
  birch_log_top: rings(hex('#dbcb9f'), hex('#c9b888'), hex('#dedbd1')),
  pine_log: bark(hex('#5c412b'), hex('#3f2c1d'), hex('#70513a')),
  pine_log_top: rings(hex('#ad8652'), hex('#96713f'), hex('#5c412b')),
  oak_planks: planks(hex('#b08a55'), hex('#86683c')),
  birch_planks: planks(hex('#d6c08b'), hex('#ab9665')),
  pine_planks: planks(hex('#8b6238'), hex('#654526')),
  beam: ((a) => {
    a.each((x, y) => scaleRgb(BEAM, 0.84 + 0.3 * a.n(x * 4, y, 8, 1) + 0.06 * a.r(x, y, 2)));
  }) as Painter,
  beam_top: rings(hex('#5d432e'), hex('#4b3524'), hex('#3a2819')),

  stone_bricks: bricks([hex('#8f8e8a'), hex('#858480'), hex('#999893')], hex('#6a6965'), 8, 4),
  bricks: bricks([hex('#a8553f'), hex('#9a4a35'), hex('#b46248')], hex('#cbc1b0'), 8, 4),
  plaster,
  frame_box: framed(() => false),
  frame_x: framed((x, y) => Math.abs(x - y) <= 1 || Math.abs(x + y - 15) <= 1),
  frame_slash: framed((x, y) => Math.abs(x + y - 15) <= 1),
  frame_bslash: framed((x, y) => Math.abs(x - y) <= 1),
  thatch,
  clay_tiles: ((a) => {
    rowsOf([hex('#b8593c'), hex('#a54d33'), hex('#c76a4a')], 4, 4, true)(a);
    a.setRough(0.6);
  }) as Painter,
  slate_tiles: ((a) => {
    rowsOf([hex('#5a6470'), hex('#4d5661'), hex('#67727e')], 4, 8, false)(a);
    a.setRough(0.5);
  }) as Painter,
  glass: ((a) => {
    a.each(() => hex('#cfe6ea'));
    a.alpha.fill(0.2);
    a.setRough(0.06);
    for (let y = 0; y < TILE; y++) {
      for (let x = 0; x < TILE; x++) {
        const lead = (x + y) % 8 === 0 || (((x - y) % 8) + 8) % 8 === 0;
        const frame = x === 0 || y === 0 || x === 15 || y === 15;
        if (lead || frame) {
          a.px(x, y, frame ? BEAM : hex('#3e4245'));
          a.roughAt(x, y, 0.6);
        }
      }
    }
  }) as Painter,

  hay_side: ((a) => {
    a.each((x, y) => scaleRgb(hex('#d4b958'), 0.86 + 0.26 * a.n(x * 4, y, 8, 1)));
    for (let y = 0; y < TILE; y++) for (const x of [4, 11]) a.px(x, y, hex('#8a6b2f'));
    a.setRough(0.97);
  }) as Painter,
  hay_top: ((a) => {
    a.each((x, y) => {
      const d = Math.hypot(x - 7.5, y - 7.5);
      return scaleRgb(hex('#d4b958'), 0.86 + 0.2 * (Math.floor(d * 1.3) % 2) + 0.06 * a.r(x, y, 2));
    });
    a.setRough(0.97);
  }) as Painter,
  wool_white: woven(hex('#ece8dc')),
  wool_red: woven(hex('#b23a32')),
  wool_blue: woven(hex('#3e5fa8')),
  wool_yellow: woven(hex('#d9b33a')),
  wool_green: woven(hex('#4f8a45')),
  stripe_red: striped(hex('#b23a32'), hex('#ece4cf')),
  stripe_blue: striped(hex('#3e5fa8'), hex('#ece4cf')),
} satisfies Record<string, Painter>;
