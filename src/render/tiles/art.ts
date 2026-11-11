// A tiny pixel-art canvas for painting 16x16 tiles procedurally. Painters draw
// colour, alpha, height (for the normal map), roughness and emission; the
// builder turns the result into the albedo and material texture layers.
// DOM-free so the tile set can be checked in Node.

import { hash32 } from '../../core/rng';

export const TILE = 16;
const N = TILE * TILE;

export type Rgb = readonly [number, number, number];

/** Parse '#rrggbb' into 0..1 sRGB components. */
export function hex(s: string): Rgb {
  const v = parseInt(s.slice(1), 16);
  return [((v >> 16) & 255) / 255, ((v >> 8) & 255) / 255, (v & 255) / 255];
}

export const mixRgb = (a: Rgb, b: Rgb, t: number): Rgb => [a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t, a[2] + (b[2] - a[2]) * t];
export const scaleRgb = (a: Rgb, k: number): Rgb => [a[0] * k, a[1] * k, a[2] * k];

const wrap = (v: number): number => ((v % TILE) + TILE) % TILE;

export class Art {
  readonly rgb = new Float32Array(N * 3);
  readonly alpha = new Float32Array(N).fill(1);
  /** Height in 0..1, or NaN to derive it from brightness. */
  readonly height = new Float32Array(N).fill(NaN);
  readonly rough = new Float32Array(N).fill(0.9);
  readonly emit = new Float32Array(N);
  private readonly seed: number;

  constructor(seed: number) {
    this.seed = seed;
  }

  /** Stable random number in [0, 1) for a pixel and a channel; wraps so patterns tile. */
  r(x: number, y: number, k = 0): number {
    return hash32((wrap(x) + wrap(y) * 131 + k * 7919 + this.seed * 104729) >>> 0) / 4294967296;
  }

  /** Smooth value noise in [0, 1) with the given cell size, tiling at the tile edge. */
  n(x: number, y: number, cell: number, k = 0): number {
    const fx = x / cell;
    const fy = y / cell;
    const x0 = Math.floor(fx);
    const y0 = Math.floor(fy);
    const tx = fx - x0;
    const ty = fy - y0;
    const period = TILE / cell;
    const v = (ix: number, iy: number): number => hash32((((ix % period) + period) % period + (((iy % period) + period) % period) * 61 + k * 977 + this.seed * 31337) >>> 0) / 4294967296;
    const sx = tx * tx * (3 - 2 * tx);
    const sy = ty * ty * (3 - 2 * ty);
    const a = v(x0, y0) + (v(x0 + 1, y0) - v(x0, y0)) * sx;
    const b = v(x0, y0 + 1) + (v(x0 + 1, y0 + 1) - v(x0, y0 + 1)) * sx;
    return a + (b - a) * sy;
  }

  px(x: number, y: number, c: Rgb, a = 1): void {
    if (x < 0 || y < 0 || x >= TILE || y >= TILE) return;
    const i = y * TILE + x;
    this.rgb[i * 3] = c[0];
    this.rgb[i * 3 + 1] = c[1];
    this.rgb[i * 3 + 2] = c[2];
    this.alpha[i] = a;
  }

  get(x: number, y: number): Rgb {
    const i = wrap(y) * TILE + wrap(x);
    return [this.rgb[i * 3] as number, this.rgb[i * 3 + 1] as number, this.rgb[i * 3 + 2] as number];
  }

  /** Paint every pixel from a function of its position. */
  each(f: (x: number, y: number) => Rgb): void {
    for (let y = 0; y < TILE; y++) for (let x = 0; x < TILE; x++) this.px(x, y, f(x, y));
  }

  fill(c: Rgb): void {
    this.each(() => c);
  }

  /** Make the whole tile transparent; cutout painters then draw the opaque parts. */
  clear(): void {
    this.alpha.fill(0);
  }

  rect(x0: number, y0: number, x1: number, y1: number, c: Rgb, a = 1): void {
    for (let y = y0; y <= y1; y++) for (let x = x0; x <= x1; x++) this.px(x, y, c, a);
  }

  line(x0: number, y0: number, x1: number, y1: number, c: Rgb): void {
    const steps = Math.max(Math.abs(x1 - x0), Math.abs(y1 - y0), 1);
    for (let s = 0; s <= steps; s++) this.px(Math.round(x0 + ((x1 - x0) * s) / steps), Math.round(y0 + ((y1 - y0) * s) / steps), c);
  }

  /** Filled ellipse; `keep` in (0, 1] thins it out with random holes for foliage. */
  blob(cx: number, cy: number, rx: number, ry: number, c: Rgb, keep = 1, vary = 0): void {
    for (let y = Math.floor(cy - ry); y <= Math.ceil(cy + ry); y++) {
      for (let x = Math.floor(cx - rx); x <= Math.ceil(cx + rx); x++) {
        const d = ((x - cx) / rx) ** 2 + ((y - cy) / ry) ** 2;
        if (d > 1 || this.r(x, y, 11) > keep) continue;
        this.px(x, y, vary ? scaleRgb(c, 1 - vary + 2 * vary * this.r(x, y, 12)) : c);
      }
    }
  }

  /** Scale brightness per pixel by a random factor in [1 - amount, 1 + amount]. */
  grain(amount: number, k = 1): void {
    for (let y = 0; y < TILE; y++) {
      for (let x = 0; x < TILE; x++) {
        const i = (y * TILE + x) * 3;
        const f = 1 - amount + 2 * amount * this.r(x, y, k);
        this.rgb[i] = (this.rgb[i] as number) * f;
        this.rgb[i + 1] = (this.rgb[i + 1] as number) * f;
        this.rgb[i + 2] = (this.rgb[i + 2] as number) * f;
      }
    }
  }

  setRough(v: number): void {
    this.rough.fill(v);
  }

  roughAt(x: number, y: number, v: number): void {
    if (x >= 0 && y >= 0 && x < TILE && y < TILE) this.rough[y * TILE + x] = v;
  }

  glow(x: number, y: number, v: number): void {
    if (x >= 0 && y >= 0 && x < TILE && y < TILE) this.emit[y * TILE + x] = v;
  }

  glowAll(v: number): void {
    this.emit.fill(v);
  }

  heightAt(x: number, y: number, v: number): void {
    if (x >= 0 && y >= 0 && x < TILE && y < TILE) this.height[y * TILE + x] = v;
  }

  lum(x: number, y: number): number {
    const i = (wrap(y) * TILE + wrap(x)) * 3;
    return 0.299 * (this.rgb[i] as number) + 0.587 * (this.rgb[i + 1] as number) + 0.114 * (this.rgb[i + 2] as number);
  }

  /** Height used for the normal map: the painted height, else brightness. */
  h(x: number, y: number): number {
    const v = this.height[wrap(y) * TILE + wrap(x)] as number;
    return Number.isNaN(v) ? this.lum(x, y) : v;
  }
}
