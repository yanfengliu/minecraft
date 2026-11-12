// How water finds its level. Three pieces the fluid tick is built from: the
// split of a cell's water with its four neighbours, the search through
// connected water for somewhere lower (pressure), and the current a body
// feels in a cell.

import { B, REPLACEABLE, WATER_LEVEL, WATER_SOURCE } from '../world/blocks';
import type { World } from '../world/world';

// Local aliases keep table reads cheap under any module loader (see fluid.ts).
const LEVEL = WATER_LEVEL;
const SOURCE = WATER_SOURCE;
const OPEN = REPLACEABLE;
const WATER = B.water;
const RIVER = B.river;
const FULL = B.water + 15;

/** The four sideways neighbours, in the order used throughout the fluid. */
export const DX = [1, 0, -1, 0];
export const DZ = [0, 1, 0, -1];

/** Metres per second of flow per sixteenth of level difference with a neighbour, and the cap. */
const FLOW_PER_UNIT = 0.25;
const FLOW_MAX = 3;
/** Speed of the baked current in river cells. */
export const RIVER_SPEED = 1.5;

/** Six neighbours for the pressure search: below, the four sides, above. */
const SDX = [0, 1, 0, -1, 0, 0];
const SDY = [-1, 0, 0, 0, 0, 1];
const SDZ = [0, 0, 1, 0, -1, 0];
/** The search window: 64 x 64 cells around the searching cell, 32 layers from its own downward. */
const WIN = 64;
const WIN_Y = 32;

/**
 * Level a cell holding `level` units with its open neighbours: the result of
 * handing units one at a time to whichever neighbour is lowest for as long as
 * that neighbour is at least two below. `nLevel` holds the neighbours' levels
 * and is updated; `nGive` receives what each was given. `r` rotates which
 * neighbour comes first, and so who gets the odd unit. Returns the units
 * given. Nobody ends above the giver, so nothing sloshes back.
 */
export function share(level: number, r: number, nLevel: Int32Array, nGive: Int32Array, nOpen: Uint8Array, ord: Int32Array): number {
  // Receivers in rising order of level; equal levels keep the rotated order.
  let n = 0;
  for (let k = 0; k < 4; k++) {
    const i = (r + k) & 3;
    const a = nLevel[i] as number;
    if (nOpen[i] !== 1 || a > level - 2) continue;
    let j = n++;
    while (j > 0 && (nLevel[ord[j - 1] as number] as number) > a) {
      ord[j] = ord[j - 1] as number;
      j--;
    }
    ord[j] = i;
  }
  if (n === 0) return 0;
  // Bring in receivers from the lowest up while each is still below the common level it would join.
  let sum = level;
  let count = 0;
  let common = level;
  for (let j = 0; j < n; j++) {
    const a = nLevel[ord[j] as number] as number;
    const c = Math.floor((sum + a) / (j + 2));
    if (a >= c) break;
    sum += a;
    count = j + 1;
    common = c;
  }
  // The giver keeps one unit of any remainder; the rest go one each to the first receivers.
  const rem = sum - common * (count + 1);
  const keep = common + (rem > 0 ? 1 : 0);
  for (let j = 0; j < count; j++) {
    const i = ord[j] as number;
    const to = common + (j < rem - 1 ? 1 : 0);
    nGive[i] = to - (nLevel[i] as number);
    nLevel[i] = to;
  }
  return level - keep;
}

/**
 * Pressure. A surface cell that cannot shed a unit to a neighbour looks
 * through the water it is connected to for a cell whose surface is at least
 * two units lower. Water conducts through full cells in any direction, and
 * along the searching cell's own layer through cells exactly one unit lower (a
 * level stretch of pool). This is what lets a pool level across its whole
 * width and two basins joined below the surface find a common level. A move
 * to such a cell always lowers the water's potential, so it cannot go on for ever.
 */
export class PressureSearch {
  /** Where the last successful search ended, and the state found there. */
  tx = 0;
  ty = 0;
  tz = 0;
  tState = 0;

  /** Visited marks, valid where they equal `stamp`. */
  private readonly seen = new Uint16Array(WIN_Y * WIN * WIN);
  private stamp = 0;
  private readonly queue: Int32Array;
  private readonly limit: number;

  constructor(private readonly world: World, searchCells: number) {
    this.limit = searchCells * 4;
    this.queue = new Int32Array((searchCells + 8) * 4);
  }

  /** True when the cell touches water a unit could pass through: a full cell under it, or a neighbour that is full or one unit lower. */
  static canStart(level: number, below: number, nState: Int32Array, nOpen: Uint8Array): boolean {
    if (below === FULL) return true;
    const plateau = level >= 2 ? WATER + level - 2 : -1;
    for (let i = 0; i < 4; i++) {
      const ns = nState[i] as number;
      if (nOpen[i] === 1 && (ns === FULL || ns === plateau)) return true;
    }
    return false;
  }

  /**
   * Search from the surface cell (x, y, z) holding `level` units. Returns true
   * and sets `tx, ty, tz, tState` when it finds a cell that can take water and
   * would still be lower afterwards. With `accept`, a cell it refuses is
   * passed over as if it were a wall.
   */
  find(
    x: number, y: number, z: number, level: number, below: number, nState: Int32Array, nOpen: Uint8Array,
    accept: ((x: number, y: number, z: number) => boolean) | null = null,
  ): boolean {
    const w = this.world;
    const q = this.queue;
    const seen = this.seen;
    if (++this.stamp > 0xffff) {
      seen.fill(0);
      this.stamp = 1;
    }
    const stamp = this.stamp;
    const plateau = level >= 2 ? WATER + level - 2 : -1;
    // Window origin: the cell sits at the centre in x and z and on the top layer.
    const ox = x - (WIN >> 1);
    const oz = z - (WIN >> 1);
    const oy = y - (WIN_Y - 1);
    seen[((y - oy) * WIN + (z - oz)) * WIN + (x - ox)] = stamp;
    let tail = 0;
    if (below === FULL) {
      seen[((y - 1 - oy) * WIN + (z - oz)) * WIN + (x - ox)] = stamp;
      q[tail++] = x;
      q[tail++] = y - 1;
      q[tail++] = z;
      q[tail++] = 1;
    }
    for (let i = 0; i < 4; i++) {
      const ns = nState[i] as number;
      if (nOpen[i] !== 1 || (ns !== FULL && ns !== plateau)) continue;
      const nx = x + (DX[i] as number);
      const nz = z + (DZ[i] as number);
      seen[((y - oy) * WIN + (nz - oz)) * WIN + (nx - ox)] = stamp;
      q[tail++] = nx;
      q[tail++] = y;
      q[tail++] = nz;
      q[tail++] = ns === FULL ? 1 : 0;
    }
    for (let head = 0; head < tail; head += 4) {
      const fx = q[head] as number;
      const fy = q[head + 1] as number;
      const fz = q[head + 2] as number;
      // A level stretch conducts sideways only; full water also pushes down and up.
      const full = q[head + 3] === 1;
      for (let d = full ? 0 : 1; d <= (full ? 5 : 4); d++) {
        const gx = fx + (SDX[d] as number);
        const gy = fy + (SDY[d] as number);
        const gz = fz + (SDZ[d] as number);
        const wx = gx - ox;
        const wy = gy - oy;
        const wz = gz - oz;
        if (wx < 0 || wx >= WIN || wz < 0 || wz >= WIN || wy < 0 || gy > y) continue;
        const wi = (wy * WIN + wz) * WIN + wx;
        if (seen[wi] === stamp) continue;
        seen[wi] = stamp;
        if (!w.inBounds(gx, gy, gz)) continue;
        const gs = w.get(gx, gy, gz);
        if (gs === FULL || (gy === y && gs === plateau)) {
          if (tail < this.limit) {
            q[tail++] = gx;
            q[tail++] = gy;
            q[tail++] = gz;
            q[tail++] = gs === FULL ? 1 : 0;
          }
          continue;
        }
        // Never a source, never anything but air, plants or unfilled water, and never straight down (that cell drains by itself).
        if (SOURCE[gs] || !OPEN[gs] || d === 0) continue;
        // On our own layer only if it ends up lower than us: strictly downhill in potential.
        if (gy === y && (LEVEL[gs] as number) > level - 2) continue;
        if (accept && !accept(gx, gy, gz)) continue;
        this.tx = gx;
        this.ty = gy;
        this.tz = gz;
        this.tState = gs;
        return true;
      }
    }
    return false;
  }
}

/**
 * Horizontal water velocity at a cell, in metres per second, written into
 * `out`: the baked current of a river cell, the pull toward lower neighbours
 * in finite water, nothing in a still source or out of water.
 */
export function waterFlow(world: World, x: number, y: number, z: number, out: { x: number; z: number }): void {
  out.x = 0;
  out.z = 0;
  const s = world.get(x, y, z);
  const level = LEVEL[s] as number;
  if (level === 0) return;
  if (SOURCE[s]) {
    if (s >= RIVER && s < RIVER + 8) {
      // Variant d points d * 45 degrees from +x, turning counter-clockwise toward -z.
      const a = (s - RIVER) * (Math.PI / 4);
      out.x = Math.cos(a) * RIVER_SPEED;
      out.z = -Math.sin(a) * RIVER_SPEED;
    }
    return;
  }
  let fx = 0;
  let fz = 0;
  for (let i = 0; i < 4; i++) {
    const n = world.get(x + (DX[i] as number), y, z + (DZ[i] as number));
    const nl = LEVEL[n] as number;
    // A wall neither pulls nor pushes; open air pulls like an empty cell.
    if (nl === 0 && !OPEN[n]) continue;
    fx += (DX[i] as number) * (level - nl);
    fz += (DZ[i] as number) * (level - nl);
  }
  fx *= FLOW_PER_UNIT;
  fz *= FLOW_PER_UNIT;
  const speed = Math.hypot(fx, fz);
  const k = speed > FLOW_MAX ? FLOW_MAX / speed : 1;
  out.x = fx * k;
  out.z = fz * k;
}
