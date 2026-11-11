// Painters for doors, lights, furniture and workstation tiles.

import { type Art, type Rgb, TILE, hex, mixRgb, scaleRgb } from './art';
import type { Painter } from './terrain';

const OAK = hex('#b08a55');
const OAK_SEAM = hex('#86683c');
const PINE = hex('#8b6238');
const IRON = hex('#43464b');
const STONE_BRICK = hex('#8f8e8a');
const MORTAR = hex('#6a6965');

/** Vertical boards, as on a door or a barrel. */
function boards(a: Art, base: Rgb, seam: Rgb, width: number): void {
  a.each((x, y) => {
    if (x % width === width - 1) return seam;
    return scaleRgb(base, 0.9 + 0.14 * a.r(Math.floor(x / width), 7, 3) + 0.08 * a.n(x * 4, y, 8, 4));
  });
}

function band(a: Art, y: number, c: Rgb): void {
  for (let x = 0; x < TILE; x++) {
    a.px(x, y, c);
    a.roughAt(x, y, 0.4);
    a.heightAt(x, y, 1);
  }
}

function stoneBricks(a: Art): void {
  a.each((x, y) => {
    const row = y >> 2;
    const sx = (x + (row % 2) * 4) % TILE;
    if (sx % 8 === 0 || (y & 3) === 0) return MORTAR;
    return scaleRgb(STONE_BRICK, 0.93 + 0.12 * a.r(Math.floor(sx / 8) * 5, row * 11, 60) + 0.05 * a.r(x, y, 61));
  });
}

function door(upper: boolean): Painter {
  return (a) => {
    boards(a, OAK, OAK_SEAM, 4);
    band(a, upper ? 3 : 4, IRON);
    band(a, upper ? 13 : 12, IRON);
    if (upper) {
      // A small barred window: the gaps are cut out.
      for (let y = 6; y <= 10; y++) for (let x = 5; x <= 10; x++) a.px(x, y, IRON, x % 2 === 1 ? 1 : 0);
    } else {
      a.rect(12, 1, 13, 2, hex('#c8a24a'));
    }
  };
}

function flame(a: Art): void {
  a.clear();
  for (let y = 0; y < TILE; y++) {
    for (let x = 0; x < TILE; x++) {
      const dx = (x - 7.5) / 6;
      const t = (15 - y) / 15;
      // A teardrop: wide at the base, licking to a point.
      const width = Math.sin(Math.min(1, t * 1.15) * Math.PI) * (1 - t * 0.55) + 0.12;
      if (Math.abs(dx) > width) continue;
      const heat = 1 - Math.abs(dx) / width;
      const c = mixRgb(mixRgb(hex('#e2531c'), hex('#ffb637'), heat), hex('#fff2b0'), Math.max(0, heat - 0.55) * 2 * (1 - t));
      a.px(x, y, c);
      a.glow(x, y, 0.6 + 0.4 * heat);
    }
  }
}

function lanternPane(lit: boolean): Painter {
  return (a) => {
    a.each((x, y) => {
      if (!lit) return scaleRgb(hex('#6b6f72'), 0.9 + 0.2 * a.r(x, y, 2));
      const d = Math.hypot(x - 7.5, y - 8) / 9;
      return mixRgb(hex('#fff3c4'), hex('#ffb44a'), Math.min(1, d * 1.3));
    });
    if (lit) a.glowAll(1);
    a.setRough(0.2);
    for (let i = 0; i < TILE; i++) for (const k of [0, 15]) { a.px(k, i, IRON); a.glow(k, i, 0); a.px(i, k, IRON); a.glow(i, k, 0); }
  };
}

function oven(lit: boolean): Painter {
  return (a) => {
    stoneBricks(a);
    for (let y = 5; y <= 13; y++) {
      for (let x = 3; x <= 12; x++) {
        const arch = y >= 8 || Math.hypot(x - 7.5, y - 8) <= 4.7;
        if (!arch) continue;
        if (lit) {
          const heat = 1 - (13 - y) / 9;
          a.px(x, y, mixRgb(hex('#7a1d0a'), hex('#ffb637'), heat * (0.7 + 0.3 * a.r(x, y, 5))));
          a.glow(x, y, 0.35 + 0.65 * heat);
        } else {
          a.px(x, y, scaleRgb(hex('#1c1a19'), 0.8 + 0.4 * a.r(x, y, 5)));
        }
        a.heightAt(x, y, 0);
      }
    }
  };
}

function coals(lit: boolean): Painter {
  return (a) => {
    a.each((x, y) => {
      const lump = a.n(x, y, 4, 3);
      const ember = a.n(x, y, 2, 9);
      if (lit && ember > 0.52) {
        a.glow(x, y, (ember - 0.52) * 2.2);
        return mixRgb(hex('#a8260c'), hex('#ffb637'), (ember - 0.52) * 2.4);
      }
      return scaleRgb(lump > 0.6 ? hex('#5a5652') : hex('#26221f'), 0.85 + 0.3 * a.r(x, y, 4));
    });
  };
}

export const fittingPainters = {
  door_lower: door(false),
  door_upper: door(true),
  ladder: ((a) => {
    a.clear();
    for (let y = 0; y < TILE; y++) {
      for (const x of [2, 3, 12, 13]) a.px(x, y, scaleRgb(PINE, (x === 2 || x === 12 ? 1.05 : 0.88) * (0.92 + 0.16 * a.r(x, y, 2))));
    }
    for (const y of [2, 6, 10, 14]) {
      for (let x = 2; x <= 13; x++) a.px(x, y, scaleRgb(PINE, 1.15 * (0.92 + 0.16 * a.r(x, y, 3))));
      for (let x = 4; x <= 11; x++) a.px(x, y + 1, scaleRgb(PINE, 0.7));
    }
  }) as Painter,
  torch_stick: ((a) => {
    a.each((x, y) => scaleRgb(hex('#7a5a36'), 0.85 + 0.3 * a.r(x, y, 2)));
  }) as Painter,
  flame,
  lantern_frame: ((a) => {
    a.each((x, y) => scaleRgb(IRON, 0.85 + 0.3 * a.n(x, y, 4)));
    a.setRough(0.4);
  }) as Painter,
  lantern_glow: lanternPane(true),
  lantern_off: lanternPane(false),
  charred_log: ((a) => {
    a.each((x, y) => scaleRgb(hex('#2e2824'), 0.75 + 0.5 * a.n(x * 2, y, 4) + 0.1 * a.r(x, y, 2)));
  }) as Painter,
  iron_dark: ((a) => {
    a.each((x, y) => scaleRgb(IRON, 0.88 + 0.2 * a.n(x, y, 8) + 0.06 * a.r(x, y, 2)));
    a.setRough(0.35);
  }) as Painter,
  brass: ((a) => {
    a.each((x, y) => scaleRgb(hex('#c8a24a'), 0.82 + 0.3 * a.n(x, y * 2, 8) + 0.05 * a.r(x, y, 2)));
    a.setRough(0.3);
  }) as Painter,

  barrel_side: ((a) => {
    boards(a, hex('#9a7446'), hex('#6f5230'), 4);
    band(a, 3, IRON);
    band(a, 12, IRON);
  }) as Painter,
  barrel_top: ((a) => {
    a.each((x, y) => {
      const d = Math.hypot(x - 7.5, y - 7.5);
      if (d > 7.6) return IRON;
      if (d > 6.4) return hex('#6f5230');
      return scaleRgb(hex('#9a7446'), (x % 4 === 3 ? 0.78 : 1) * (0.92 + 0.12 * a.r(x, y, 2)));
    });
  }) as Painter,
  crate: ((a) => {
    a.each((x, y) => {
      const frame = x < 2 || y < 2 || x > 13 || y > 13 || Math.abs(x - y) <= 1;
      return scaleRgb(frame ? hex('#7a5c34') : OAK, (frame ? 1 : (y & 3) === 3 ? 0.8 : 1) * (0.92 + 0.14 * a.r(x, y, 2)));
    });
  }) as Painter,
  chest_side: ((a) => {
    boards(a, hex('#8f6a3c'), hex('#664a28'), 4);
    band(a, 5, IRON);
    band(a, 14, IRON);
    a.rect(7, 4, 8, 7, hex('#c8a24a'));
  }) as Painter,
  chest_top: ((a) => {
    boards(a, hex('#8f6a3c'), hex('#664a28'), 4);
    for (let i = 0; i < TILE; i++) for (const k of [0, 15]) { a.px(k, i, IRON); a.px(i, k, IRON); }
  }) as Painter,
  bookshelf: ((a) => {
    const spines = [hex('#8c2f2a'), hex('#2f5a8c'), hex('#3d7a45'), hex('#b08a3a'), hex('#6a3f7a'), hex('#7a5a36')];
    a.each((x, y) => {
      const shelf = y % 8;
      if (shelf === 7 || shelf === 0) return scaleRgb(OAK, shelf === 7 ? 0.8 : 1);
      if (x === 0 || x === 15) return scaleRgb(OAK, 0.85);
      const book = spines[Math.floor(a.r(x >> 1, y >> 3, 6) * spines.length)] as Rgb;
      // Books stand at slightly different heights.
      if (shelf === 1 && a.r(x >> 1, y >> 3, 7) < 0.4) return hex('#2a1f16');
      return scaleRgb(book, (x & 1 ? 0.85 : 1) * (shelf === 4 ? 1.25 : 1));
    });
  }) as Painter,

  oven_front: oven(false),
  oven_front_lit: oven(true),
  forge_side: ((a) => {
    stoneBricks(a);
    a.each((x, y) => scaleRgb(a.get(x, y), 1 - 0.35 * Math.max(0, 1 - y / 6) * a.n(x, y, 4, 2)));
  }) as Painter,
  coals: coals(false),
  coals_lit: coals(true),
  loom_cloth: ((a) => {
    a.each((x, y) => {
      const warp = x % 2 === 0;
      const stripe = (y >> 2) % 3 === 1;
      return scaleRgb(stripe ? hex('#3e5fa8') : hex('#e8dfc8'), (warp ? 1.04 : 0.93) * (0.96 + 0.08 * a.r(x, y, 2)));
    });
    a.setRough(0.95);
  }) as Painter,
  millstone_top: ((a) => {
    a.each((x, y) => {
      const d = Math.hypot(x - 7.5, y - 7.5);
      const ang = Math.atan2(y - 7.5, x - 7.5);
      if (d < 1.3) return hex('#3a3a38');
      const groove = Math.abs(Math.sin(ang * 6 + d * 0.5)) < 0.22 && d < 7.2;
      return scaleRgb(hex('#a09f99'), (groove ? 0.72 : 1) * (0.92 + 0.14 * a.r(x, y, 2)));
    });
  }) as Painter,
  millstone_side: ((a) => {
    a.each((x, y) => scaleRgb(hex('#9a9993'), (y === 7 || y === 8 ? 0.7 : 1) * (0.9 + 0.18 * a.n(x, y, 4))));
  }) as Painter,
  workbench_top: ((a) => {
    boards(a, OAK, OAK_SEAM, 4);
    a.line(3, 4, 9, 6, scaleRgb(OAK, 0.7));
    a.line(10, 11, 13, 9, scaleRgb(OAK, 0.72));
    a.rect(2, 11, 4, 12, IRON);
  }) as Painter,
  workbench_side: ((a) => {
    a.each((x, y) => scaleRgb(OAK, ((y & 3) === 3 ? 0.78 : 1) * (0.92 + 0.14 * a.r(x, y, 2))));
    a.rect(4, 5, 11, 10, scaleRgb(OAK, 0.82));
    a.rect(7, 7, 8, 8, IRON);
    for (let i = 0; i < TILE; i++) { a.px(0, i, scaleRgb(PINE, 0.9)); a.px(15, i, scaleRgb(PINE, 0.9)); }
  }) as Painter,
  vat_side: ((a) => {
    boards(a, hex('#7d5a35'), hex('#553b21'), 4);
    band(a, 2, IRON);
    band(a, 8, IRON);
    band(a, 14, IRON);
  }) as Painter,
  vat_top: ((a) => {
    a.each((x, y) => {
      const d = Math.hypot(x - 7.5, y - 7.5);
      if (d > 6.6) return hex('#553b21');
      return mixRgb(hex('#e9dfc2'), hex('#c9a24e'), a.n(x, y, 4, 2) * 0.8);
    });
    a.setRough(0.3);
  }) as Painter,
  stew: ((a) => {
    a.each((x, y) => {
      const d = Math.hypot(x - 7.5, y - 7.5);
      if (d > 6.6) return IRON;
      if (a.r(x, y, 4) < 0.1) return hex('#d98b2e');
      if (a.r(x, y, 5) < 0.07) return hex('#6f8f3a');
      return scaleRgb(hex('#8a5a2c'), 0.88 + 0.24 * a.n(x, y, 4));
    });
    a.setRough(0.35);
  }) as Painter,
  trough_water: ((a) => {
    a.each((x, y) => {
      if (x < 2 || x > 13 || y < 4 || y > 11) return scaleRgb(PINE, 0.9 + 0.15 * a.r(x, y, 2));
      return scaleRgb(hex('#3f6f8f'), 0.9 + 0.2 * a.n(x, y, 4));
    });
  }) as Painter,
  woodpile_side: ((a) => {
    a.each((x, y) => {
      const row = y >> 2;
      const k = (y & 3) === 0 ? 1.15 : (y & 3) === 3 ? 0.62 : 1;
      return scaleRgb(hex('#6d5536'), k * (0.85 + 0.25 * a.r(x >> 1, row, 3)));
    });
  }) as Painter,
  woodpile_end: ((a) => {
    a.each((x, y) => {
      const cx = ((x + ((y >> 2) % 2) * 2) % 4) - 1.5;
      const cy = (y % 4) - 1.5;
      const d = Math.hypot(cx, cy);
      if (d > 2.0) return hex('#2c241a');
      if (d > 1.4) return hex('#6d5536');
      return scaleRgb(hex('#b9985f'), 0.9 + 0.15 * a.r(x, y, 2));
    });
  }) as Painter,
  sack: ((a) => {
    a.each((x, y) => scaleRgb(hex('#b79f6e'), ((x + y) & 1 ? 0.92 : 1.04) * (0.95 + 0.1 * a.r(x, y, 2))));
    for (let x = 4; x <= 11; x++) a.px(x, 3, hex('#7a6238'));
    a.setRough(0.95);
  }) as Painter,
  bed_head: ((a) => {
    a.each((x, y) => scaleRgb(hex('#a8433a'), ((x + y) & 1 ? 0.95 : 1.03)));
    a.rect(2, 2, 13, 8, hex('#efe9da'));
    a.rect(3, 3, 12, 7, hex('#f7f3e8'));
    a.setRough(0.95);
  }) as Painter,
  bed_foot: ((a) => {
    a.each((x, y) => scaleRgb((x >> 2) % 2 === (y >> 2) % 2 ? hex('#a8433a') : hex('#8c342d'), (x + y) & 1 ? 0.95 : 1.03));
    a.setRough(0.95);
  }) as Painter,
  bed_side: ((a) => {
    a.each((x, y) => (y < 9 ? scaleRgb(hex('#a8433a'), (x + y) & 1 ? 0.95 : 1.03) : scaleRgb(OAK, 0.9 + 0.14 * a.r(x, y, 2))));
    for (let x = 0; x < TILE; x++) a.px(x, 9, OAK_SEAM);
  }) as Painter,
} satisfies Record<string, Painter>;
