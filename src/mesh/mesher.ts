// Section mesher: 32^3 cells (plus a one-cell border) in, packed quads out.
// Pure and headless; runs in mesh workers.
//
// Every quad is four vertices of two Uint32 words each, drawn with a shared
// index pattern (0 1 2, 2 3 0). Output is ordered opaque, cutout, translucent.
//
//   word 0   x:10 y:10 z:10 (sixteenths of a block within the section) | ao:2
//   word 1   normal:3 | tile:10 | sky:5 | block:5 | uvMode:1 | corner:2 | uvRot:1 | tint:2 | wind:2 | windFree:1
//   water    normal:3 | (unused):10 | sky:5 | block:5 | flowDir:3 | hasFlow:1 | spilt:1 | (unused):3 | isWater:1 (bit 31)
//
// Texture coordinates are derived from position in the shader (so partial
// boxes show the matching part of the tile); `uvMode` switches to the explicit
// corner for the diagonal quads of plants.

import {
  BLOCKS, CONNECT, FULL_FACES, IS_LEAVES, LAYER, LAYER_OPAQUE, LAYER_TRANSLUCENT, LIGHT_OPACITY, OPAQUE, SHAPE,
  SHAPE_BOXES, SHAPE_CONNECT, SHAPE_CROP, SHAPE_CROSS, SHAPE_CUBE, SHAPE_LIQUID, STATE_COUNT, TINT, WATER_LEVEL, WIND,
  B, isGate, type Box,
} from '../world/blocks';
import { hash3i } from '../core/rng';

export const PAD = 34;
export const PAD2 = PAD * PAD;
export const PAD3 = PAD2 * PAD;

export interface MeshInput {
  /** States for cells -1..32 on each axis, indexed (y + 1) * PAD2 + (z + 1) * PAD + (x + 1). */
  states: Uint16Array;
  /** Packed light (sky << 4 | block), same indexing. */
  light: Uint8Array;
  /** World coordinates of the section's origin cell, for position-stable variation. */
  ox: number;
  oy: number;
  oz: number;
}

export interface MeshOutput {
  data: Uint32Array;
  opaque: number;
  cutout: number;
  translucent: number;
  /** Vertical extent of the geometry within the section, in blocks. */
  minY: number;
  maxY: number;
}

// Per-state lookups the hot loop needs, flattened once.
const TILES = new Uint16Array(STATE_COUNT * 6);
const UVROT = new Uint8Array(STATE_COUNT);
const AO_SOLID = new Uint8Array(STATE_COUNT);
for (const s of BLOCKS) {
  for (let f = 0; f < 6; f++) TILES[s.id * 6 + f] = s.tiles[f] as number;
  UVROT[s.id] = s.uvRot;
  // Foliage darkens the corners it crowds, like any wall, so the inside of a canopy reads as shade.
  AO_SOLID[s.id] = s.opaque || IS_LEAVES[s.id] ? 1 : 0;
}

// Face geometry: for each face, the unit vectors along which the quad's corners run.
const FU = [[0, 0, -1], [0, 0, 1], [1, 0, 0], [1, 0, 0], [1, 0, 0], [-1, 0, 0]];
const FV = [[0, 1, 0], [0, 1, 0], [0, 0, -1], [0, 0, 1], [0, 1, 0], [0, 1, 0]];
const FN = [[1, 0, 0], [-1, 0, 0], [0, 1, 0], [0, -1, 0], [0, 0, 1], [0, 0, -1]];
const pOff = (v: readonly number[]): number => (v[0] as number) + (v[2] as number) * PAD + (v[1] as number) * PAD2;
const OFF_N = FN.map(pOff);
const OFF_U = FU.map(pOff);
const OFF_V = FV.map(pOff);

class QuadBuffer {
  data = new Uint32Array(4096);
  words = 0;

  reserve(): number {
    if (this.words + 8 > this.data.length) {
      const bigger = new Uint32Array(this.data.length * 2);
      bigger.set(this.data);
      this.data = bigger;
    }
    const at = this.words;
    this.words += 8;
    return at;
  }

  get quads(): number {
    return this.words >> 3;
  }
}

const bufs = [new QuadBuffer(), new QuadBuffer(), new QuadBuffer()];
const ao4 = new Uint8Array(4);
const sky4 = new Uint8Array(4);
const blk4 = new Uint8Array(4);
let minY = 0;
let maxY = 0;

/**
 * Append one axis-aligned rectangle. Coordinates are in sixteenths within the
 * section. `flip` rotates the vertex order so the triangle diagonal follows the
 * brighter pair of corners.
 */
function quad(
  buf: QuadBuffer, f: number,
  x0: number, y0: number, z0: number, x1: number, y1: number, z1: number,
  w1: number, flip: boolean,
): void {
  const at = buf.reserve();
  const d = buf.data;
  let ax: number, ay: number, az: number, bx: number, by: number, bz: number;
  let cx: number, cy: number, cz: number, dx: number, dy: number, dz: number;
  switch (f) {
    case 0: ax = x1; ay = y0; az = z1; bx = x1; by = y0; bz = z0; cx = x1; cy = y1; cz = z0; dx = x1; dy = y1; dz = z1; break;
    case 1: ax = x0; ay = y0; az = z0; bx = x0; by = y0; bz = z1; cx = x0; cy = y1; cz = z1; dx = x0; dy = y1; dz = z0; break;
    case 2: ax = x0; ay = y1; az = z1; bx = x1; by = y1; bz = z1; cx = x1; cy = y1; cz = z0; dx = x0; dy = y1; dz = z0; break;
    case 3: ax = x0; ay = y0; az = z0; bx = x1; by = y0; bz = z0; cx = x1; cy = y0; cz = z1; dx = x0; dy = y0; dz = z1; break;
    case 4: ax = x0; ay = y0; az = z1; bx = x1; by = y0; bz = z1; cx = x1; cy = y1; cz = z1; dx = x0; dy = y1; dz = z1; break;
    default: ax = x1; ay = y0; az = z0; bx = x0; by = y0; bz = z0; cx = x0; cy = y1; cz = z0; dx = x1; dy = y1; dz = z0; break;
  }
  const v0 = (ax | (ay << 10) | (az << 20) | (ao4[0]! << 30)) >>> 0;
  const v1 = (bx | (by << 10) | (bz << 20) | (ao4[1]! << 30)) >>> 0;
  const v2 = (cx | (cy << 10) | (cz << 20) | (ao4[2]! << 30)) >>> 0;
  const v3 = (dx | (dy << 10) | (dz << 20) | (ao4[3]! << 30)) >>> 0;
  const l0 = (w1 | (sky4[0]! << 13) | (blk4[0]! << 18)) >>> 0;
  const l1 = (w1 | (sky4[1]! << 13) | (blk4[1]! << 18)) >>> 0;
  const l2 = (w1 | (sky4[2]! << 13) | (blk4[2]! << 18)) >>> 0;
  const l3 = (w1 | (sky4[3]! << 13) | (blk4[3]! << 18)) >>> 0;
  if (flip) {
    d[at] = v1; d[at + 1] = l1; d[at + 2] = v2; d[at + 3] = l2; d[at + 4] = v3; d[at + 5] = l3; d[at + 6] = v0; d[at + 7] = l0;
  } else {
    d[at] = v0; d[at + 1] = l0; d[at + 2] = v1; d[at + 3] = l1; d[at + 4] = v2; d[at + 5] = l2; d[at + 6] = v3; d[at + 7] = l3;
  }
  if (y0 < minY) minY = y0;
  if (y1 > maxY) maxY = y1;
}

/** Append an arbitrary quad from four corners (plants, water surfaces). `w` holds the per-corner second words. */
function quadFree(buf: QuadBuffer, p: Int32Array, w: Uint32Array): void {
  const at = buf.reserve();
  const d = buf.data;
  for (let k = 0; k < 4; k++) {
    const x = p[k * 3] as number;
    const y = p[k * 3 + 1] as number;
    const z = p[k * 3 + 2] as number;
    d[at + k * 2] = (x | (y << 10) | (z << 20) | (ao4[k]! << 30)) >>> 0;
    d[at + k * 2 + 1] = w[k] as number;
    if (y < minY) minY = y;
    if (y > maxY) maxY = y;
  }
}

const P = new Int32Array(12);
const W = new Uint32Array(4);

function flatLight(light: Uint8Array, idx: number): void {
  const l = light[idx] as number;
  const s = (l >> 4) * 2;
  const b = (l & 15) * 2;
  sky4[0] = sky4[1] = sky4[2] = sky4[3] = s;
  blk4[0] = blk4[1] = blk4[2] = blk4[3] = b;
  ao4[0] = ao4[1] = ao4[2] = ao4[3] = 3;
}

/** Brightest light around a cell: what a block that is itself light-tight (a stair, a slab) shows on its inner faces. */
function ambientLight(states: Uint16Array, light: Uint8Array, idx: number): number {
  let sky = 0;
  let blk = 0;
  for (let f = 0; f < 6; f++) {
    const n = idx + (OFF_N[f] as number);
    if ((LIGHT_OPACITY[states[n] as number] as number) >= 15) continue;
    const l = light[n] as number;
    if (l >> 4 > sky) sky = l >> 4;
    if ((l & 15) > blk) blk = l & 15;
  }
  return (sky << 4) | blk;
}

function setFlat(l: number): void {
  sky4[0] = sky4[1] = sky4[2] = sky4[3] = (l >> 4) * 2;
  blk4[0] = blk4[1] = blk4[2] = blk4[3] = (l & 15) * 2;
  ao4[0] = ao4[1] = ao4[2] = ao4[3] = 3;
}

/** Smooth light and ambient occlusion for the four corners of a full cube face. Returns whether to flip the diagonal. */
function shadeFace(states: Uint16Array, light: Uint8Array, idx: number, f: number): boolean {
  const c = idx + (OFF_N[f] as number);
  const ou = OFF_U[f] as number;
  const ov = OFF_V[f] as number;
  const lc = light[c] as number;
  for (let k = 0; k < 4; k++) {
    const su = k === 1 || k === 2 ? ou : -ou;
    const sv = k >= 2 ? ov : -ov;
    const i1 = c + su;
    const i2 = c + sv;
    const i3 = c + su + sv;
    const s1 = states[i1] as number;
    const s2 = states[i2] as number;
    const s3 = states[i3] as number;
    const a1 = AO_SOLID[s1] as number;
    const a2 = AO_SOLID[s2] as number;
    const a3 = AO_SOLID[s3] as number;
    ao4[k] = a1 && a2 ? 0 : 3 - (a1 + a2 + a3);
    let sky = lc >> 4;
    let blk = lc & 15;
    let count = 1;
    if (!OPAQUE[s1]) { const l = light[i1] as number; sky += l >> 4; blk += l & 15; count++; }
    if (!OPAQUE[s2]) { const l = light[i2] as number; sky += l >> 4; blk += l & 15; count++; }
    // Light does not reach a corner cell walled off by both sides.
    if (!OPAQUE[s3] && !(OPAQUE[s1] && OPAQUE[s2])) { const l = light[i3] as number; sky += l >> 4; blk += l & 15; count++; }
    sky4[k] = Math.round((sky * 2) / count);
    blk4[k] = Math.round((blk * 2) / count);
  }
  return (ao4[0] as number) + (ao4[2] as number) < (ao4[1] as number) + (ao4[3] as number);
}

function emitBoxes(
  buf: QuadBuffer, states: Uint16Array, light: Uint8Array, idx: number, state: number,
  boxes: readonly Box[], bx: number, by: number, bz: number, w1Base: number,
): void {
  // A block that lets light through is lit by its own cell. One that does not (a stair, a slab) holds
  // no light itself, so each face borrows from the cell it looks into, or from the brightest side.
  const lightTight = (LIGHT_OPACITY[state] as number) >= 15;
  const own = light[idx] as number;
  const ambient = lightTight ? ambientLight(states, light, idx) : own;
  for (const b of boxes) {
    const x0 = bx + b.x0;
    const y0 = by + b.y0;
    const z0 = bz + b.z0;
    const x1 = bx + b.x1;
    const y1 = by + Math.min(b.y1, 16);
    const z1 = bz + b.z1;
    for (let f = 0; f < 6; f++) {
      const axis = f >> 1;
      const lo = axis === 0 ? b.x0 : axis === 1 ? b.y0 : b.z0;
      const hi = axis === 0 ? b.x1 : axis === 1 ? b.y1 : b.z1;
      const onEdge = (f & 1) === 0 ? hi >= 16 : lo === 0;
      let faceLight = ambient;
      if (onEdge) {
        const nIdx = idx + (OFF_N[f] as number);
        const n = states[nIdx] as number;
        // Hidden by a neighbour that covers that whole side...
        if ((FULL_FACES[n] as number) & (1 << (f ^ 1))) continue;
        // ...or by an identical neighbour, when this box runs right across the cell so both ends match.
        if (n === state && lo === 0 && hi >= 16) continue;
        if (lightTight && (LIGHT_OPACITY[n] as number) < 15) faceLight = light[nIdx] as number;
      }
      setFlat(faceLight);
      const tile = b.tiles ? (b.tiles[f] as number) : (TILES[state * 6 + f] as number);
      quad(buf, f, x0, y0, z0, x1, y1, z1, w1Base | f | (tile << 3) | ((((UVROT[state] as number) >> f) & 1) << 26), false);
    }
  }
}

const FENCE_ARMS: Box[][] = [
  [{ x0: 10, y0: 6, z0: 7, x1: 16, y1: 9, z1: 9 }, { x0: 10, y0: 12, z0: 7, x1: 16, y1: 15, z1: 9 }],
  [{ x0: 0, y0: 6, z0: 7, x1: 6, y1: 9, z1: 9 }, { x0: 0, y0: 12, z0: 7, x1: 6, y1: 15, z1: 9 }],
  [{ x0: 7, y0: 6, z0: 10, x1: 9, y1: 9, z1: 16 }, { x0: 7, y0: 12, z0: 10, x1: 9, y1: 15, z1: 16 }],
  [{ x0: 7, y0: 6, z0: 0, x1: 9, y1: 9, z1: 6 }, { x0: 7, y0: 12, z0: 0, x1: 9, y1: 15, z1: 6 }],
];
const WALL_ARMS: Box[][] = [
  [{ x0: 12, y0: 0, z0: 5, x1: 16, y1: 13, z1: 11 }],
  [{ x0: 0, y0: 0, z0: 5, x1: 4, y1: 13, z1: 11 }],
  [{ x0: 5, y0: 0, z0: 12, x1: 11, y1: 13, z1: 16 }],
  [{ x0: 5, y0: 0, z0: 0, x1: 11, y1: 13, z1: 4 }],
];
const ARM_OFFSETS = [1, -1, PAD, -PAD];

const surfaceOf = (level: number): number => Math.round((level * 15) / 16);

export function meshSection(input: MeshInput): MeshOutput {
  const { states, light, ox, oy, oz } = input;
  for (const b of bufs) b.words = 0;
  minY = 1024;
  maxY = 0;

  for (let y = 0; y < 32; y++) {
    for (let z = 0; z < 32; z++) {
      let idx = (y + 1) * PAD2 + (z + 1) * PAD + 1;
      for (let x = 0; x < 32; x++, idx++) {
        const state = states[idx] as number;
        if (state === 0) continue;
        const shape = SHAPE[state] as number;
        const layer = LAYER[state] as number;
        const buf = bufs[layer] as QuadBuffer;
        const bx = x << 4;
        const by = y << 4;
        const bz = z << 4;
        const w1Base = ((TINT[state] as number) << 27) | ((WIND[state] as number) << 29);

        if (shape === SHAPE_CUBE) {
          const leaves = IS_LEAVES[state] === 1;
          for (let f = 0; f < 6; f++) {
            const n = states[idx + (OFF_N[f] as number)] as number;
            if ((FULL_FACES[n] as number) & (1 << (f ^ 1))) continue;
            if (layer !== LAYER_OPAQUE && n === state) {
              // Two cutout or glass cubes share one plane; foliage keeps one side of it so a canopy reads as solid.
              if (!leaves || (f & 1) === 1) continue;
            }
            const flip = shadeFace(states, light, idx, f);
            const w1 = w1Base | f | ((TILES[state * 6 + f] as number) << 3) | ((((UVROT[state] as number) >> f) & 1) << 26) | (leaves ? 0x80000000 : 0);
            quad(buf, f, bx, by, bz, bx + 16, by + 16, bz + 16, w1 >>> 0, flip);
          }
        } else if (shape === SHAPE_BOXES) {
          emitBoxes(buf, states, light, idx, state, (BLOCKS[state] as (typeof BLOCKS)[number]).boxes, bx, by, bz, w1Base);
        } else if (shape === SHAPE_CONNECT) {
          const def = BLOCKS[state] as (typeof BLOCKS)[number];
          emitBoxes(buf, states, light, idx, state, def.boxes, bx, by, bz, w1Base);
          const group = CONNECT[state] as number;
          const arms = group === 2 ? WALL_ARMS : FENCE_ARMS;
          for (let a = 0; a < 4; a++) {
            const n = states[idx + (ARM_OFFSETS[a] as number)] as number;
            if (CONNECT[n] === group || isGate(n) || OPAQUE[n]) emitBoxes(buf, states, light, idx, state, arms[a] as Box[], bx, by, bz, w1Base);
          }
        } else if (shape === SHAPE_CROSS || shape === SHAPE_CROP) {
          flatLight(light, idx);
          const tile = TILES[state * 6] as number;
          const base = (w1Base | 2 | (tile << 3) | (1 << 23) | ((sky4[0] as number) << 13) | ((blk4[0] as number) << 18)) >>> 0;
          const top = (base | 0x80000000) >>> 0;
          // Corner codes: bit 24 = u, bit 25 = v (v = 0 is the top of the tile).
          W[0] = (base | (2 << 24)) >>> 0;
          W[1] = (base | (3 << 24)) >>> 0;
          W[2] = (top | (1 << 24)) >>> 0;
          W[3] = top;
          if (shape === SHAPE_CROSS) {
            const h = hash3i(ox + x, oy + y, oz + z, 77);
            const jx = (h % 5) - 2;
            const jz = ((h >>> 8) % 5) - 2;
            const hy = 13 + ((h >>> 16) % 4);
            const x0 = bx + 2 + jx;
            const x1 = bx + 14 + jx;
            const z0 = bz + 2 + jz;
            const z1 = bz + 14 + jz;
            P.set([x0, by, z0, x1, by, z1, x1, by + hy, z1, x0, by + hy, z0]);
            quadFree(buf, P, W);
            P.set([x0, by, z1, x1, by, z0, x1, by + hy, z0, x0, by + hy, z1]);
            quadFree(buf, P, W);
          } else {
            for (const c of [4, 12]) {
              P.set([bx + c, by, bz, bx + c, by, bz + 16, bx + c, by + 16, bz + 16, bx + c, by + 16, bz]);
              quadFree(buf, P, W);
              P.set([bx, by, bz + c, bx + 16, by, bz + c, bx + 16, by + 16, bz + c, bx, by + 16, bz + c]);
              quadFree(buf, P, W);
            }
          }
        } else if (shape === SHAPE_LIQUID) {
          emitLiquid(states, light, idx, state, bx, by, bz);
        }
        // A waterlogged plant also needs the water around it meshed as water.
        if (shape === SHAPE_CROSS && WATER_LEVEL[state]) emitLiquid(states, light, idx, state, bx, by, bz);
      }
    }
  }

  const [o, c, t] = bufs as [QuadBuffer, QuadBuffer, QuadBuffer];
  const data = new Uint32Array(o.words + c.words + t.words);
  data.set(o.data.subarray(0, o.words), 0);
  data.set(c.data.subarray(0, c.words), o.words);
  data.set(t.data.subarray(0, t.words), o.words + c.words);
  return {
    data,
    opaque: o.quads,
    cutout: c.quads,
    translucent: t.quads,
    minY: data.length ? minY / 16 : 0,
    maxY: data.length ? maxY / 16 : 0,
  };
}

/** Bytes per vertex and vertices per quad of the packed format, for whoever uploads it. */
export const VERTEX_BYTES = 8;
export const QUAD_VERTICES = 4;

const LIQ_SIDE = [1, -1, PAD, -PAD];
const LIQ_FACE = [0, 1, 4, 5];

function emitLiquid(states: Uint16Array, light: Uint8Array, idx: number, state: number, bx: number, by: number, bz: number): void {
  const buf = bufs[LAYER_TRANSLUCENT] as QuadBuffer;
  const above = states[idx + PAD2] as number;
  const full = (WATER_LEVEL[above] as number) > 0;
  const own = surfaceOf(WATER_LEVEL[state] as number);

  // Height of each corner: the mean surface of the water cells that meet there, pulled down by open air.
  const hgt = [0, 0, 0, 0]; // (0,0) (1,0) (0,1) (1,1) in x,z
  for (let c = 0; c < 4; c++) {
    if (full) { hgt[c] = 16; continue; }
    const cx = c & 1;
    const cz = c >> 1;
    let sum = 0;
    let n = 0;
    let filled = false;
    for (let j = 0; j < 2 && !filled; j++) {
      for (let i = 0; i < 2; i++) {
        const q = idx + (cx - 1 + i) + (cz - 1 + j) * PAD;
        const s = states[q] as number;
        const lv = WATER_LEVEL[s] as number;
        if (lv > 0) {
          if ((WATER_LEVEL[states[q + PAD2] as number] as number) > 0) { filled = true; break; }
          sum += surfaceOf(lv);
          n++;
        } else if (s === B.air) {
          n++;
        }
      }
    }
    hgt[c] = filled ? 16 : n > 0 ? Math.round(sum / n) : own;
    // Never let the corner of a wet cell sink flat to the floor.
    if ((hgt[c] as number) < 1) hgt[c] = 1;
  }

  // Flow: baked for rivers, down the level gradient for finite water.
  let flowBits = 0;
  if (state >= B.river && state < B.river + 8) flowBits = ((state - B.river) << 23) | (1 << 26);
  else if (state >= B.water && state < B.water + 16) {
    const lv = (s: number): number => { const w = WATER_LEVEL[s] as number; return w > 0 ? w : s === B.air ? 0 : -1; };
    const here = WATER_LEVEL[state] as number;
    const e = lv(states[idx + 1] as number);
    const w = lv(states[idx - 1] as number);
    const so = lv(states[idx + PAD] as number);
    const no = lv(states[idx - PAD] as number);
    const gx = (w < 0 ? here : w) - (e < 0 ? here : e);
    const gz = (no < 0 ? here : no) - (so < 0 ? here : so);
    if (gx !== 0 || gz !== 0) {
      const dir = ((Math.round(Math.atan2(-gz, gx) / (Math.PI / 4)) % 8) + 8) % 8;
      flowBits = (dir << 23) | (1 << 26);
    }
    // Spilt water is shallow everywhere; the shader must not take that for a shoreline.
    flowBits |= 1 << 27;
  }
  const waterBit = 0x80000000;
  ao4[0] = ao4[1] = ao4[2] = ao4[3] = 3;

  const lightWord = (li: number, f: number): number => {
    const l = light[li] as number;
    return (f | ((l >> 4) * 2 << 13) | ((l & 15) * 2 << 18) | flowBits | waterBit) >>> 0;
  };

  if (!full) {
    const w = lightWord(idx + PAD2, 2);
    W[0] = W[1] = W[2] = W[3] = w;
    P.set([bx, by + (hgt[2] as number), bz + 16, bx + 16, by + (hgt[3] as number), bz + 16, bx + 16, by + (hgt[1] as number), bz, bx, by + (hgt[0] as number), bz]);
    quadFree(buf, P, W);
  }
  for (let k = 0; k < 4; k++) {
    const nIdx = idx + (LIQ_SIDE[k] as number);
    const n = states[nIdx] as number;
    if ((WATER_LEVEL[n] as number) > 0 || OPAQUE[n]) continue;
    const f = LIQ_FACE[k] as number;
    const w = lightWord(nIdx, f);
    W[0] = W[1] = W[2] = W[3] = w;
    // Corners of this side, in the same winding as a cube face.
    let a: number, b: number;
    if (f === 0) { a = hgt[3] as number; b = hgt[1] as number; P.set([bx + 16, by, bz + 16, bx + 16, by, bz, bx + 16, by + b, bz, bx + 16, by + a, bz + 16]); }
    else if (f === 1) { a = hgt[0] as number; b = hgt[2] as number; P.set([bx, by, bz, bx, by, bz + 16, bx, by + b, bz + 16, bx, by + a, bz]); }
    else if (f === 4) { a = hgt[2] as number; b = hgt[3] as number; P.set([bx, by, bz + 16, bx + 16, by, bz + 16, bx + 16, by + b, bz + 16, bx, by + a, bz + 16]); }
    else { a = hgt[1] as number; b = hgt[0] as number; P.set([bx + 16, by, bz, bx, by, bz, bx, by + b, bz, bx + 16, by + a, bz]); }
    quadFree(buf, P, W);
  }
  const below = states[idx - PAD2] as number;
  if ((WATER_LEVEL[below] as number) === 0 && !((FULL_FACES[below] as number) & 4)) {
    const w = lightWord(idx - PAD2, 3);
    W[0] = W[1] = W[2] = W[3] = w;
    P.set([bx, by, bz, bx + 16, by, bz, bx + 16, by, bz + 16, bx, by, bz + 16]);
    quadFree(buf, P, W);
  }
}
