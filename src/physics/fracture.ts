// Breaking on impact. A felled tree sheds its leaves the first time it hits
// something hard; a compound hit harder still splits into smaller bodies; a
// lone pane of glass or block of leaves bursts.

import { IS_LEAVES, IS_LOG, MAT } from '../world/blocks';
import type { Body } from './body';
import type { RigidBodies } from './rigid';
import type { BodyCell } from './types';

const LEAF = IS_LEAVES;
const LOG = IS_LOG;

/** Change of speed in one step (m/s) at which leaves are shaken off, brittle blocks shatter, and compounds start to split. */
const SHED_SPEED = 3;
const SHATTER_SPEED = 5;
const BREAK_SPEED = 6;
/** A tree counts as down once its trunk is further than this from upright (cosine of the tilt: about 50 degrees). */
const TREE_DOWN = 0.64;

const FACES: readonly (readonly [number, number, number])[] = [[1, 0, 0], [-1, 0, 0], [0, 1, 0], [0, -1, 0], [0, 0, 1], [0, 0, -1]];

/** React to a body having its velocity changed by `speed` m/s in one step. May remove or reshape the body. */
export function breakOnImpact(sys: RigidBodies, b: Body, speed: number): void {
  if (b.kind === 'item') return;
  if (b.kind === 'block') {
    const cell = b.cells[0] as BodyCell;
    if ((b.material === MAT.glass || b.material === MAT.leaves) && speed > SHATTER_SPEED) {
      sys.host.emit({ type: 'burst', x: b.view.x, y: b.view.y, z: b.view.z, state: cell.state });
      sys.remove(b);
    }
    return;
  }
  let cells = b.cells;
  // A felled tree first drops a block onto its stump; the leaves come off when it has gone over and the crown hits.
  const { qx, qz } = b.view;
  const down = !b.tree || 1 - 2 * (qx * qx + qz * qz) < TREE_DOWN;
  if (down && speed > SHED_SPEED && cells.some((c) => LEAF[c.state])) {
    const kept = cells.filter((c) => !LEAF[c.state]);
    for (const c of cells) {
      if (!LEAF[c.state]) continue;
      const p = worldPoint(b, c.dx, c.dy, c.dz);
      sys.host.emit({ type: 'burst', x: p[0], y: p[1], z: p[2], state: c.state });
    }
    if (kept.length === 0) {
      sys.remove(b);
      return;
    }
    cells = kept;
  }
  // Small pieces are tougher: the threshold rises as the body gets smaller.
  const pieces = speed > BREAK_SPEED * (1 + 6 / cells.length) && cells.length >= 2 ? split(cells) : connected(cells);
  if (pieces.length === 1 && cells === b.cells) return;
  // The largest piece stays this body; the rest become bodies of their own, moving as they were.
  pieces.sort((a, c) => c.length - a.length);
  const spin = b.rb.angvel();
  const v = b.view;
  for (let i = 1; i < pieces.length; i++) {
    const piece = pieces[i] as BodyCell[];
    const o = piece[0] as BodyCell;
    const p = worldPoint(b, o.dx, o.dy, o.dz);
    const rx = p[0] - v.x;
    const ry = p[1] - v.y;
    const rz = p[2] - v.z;
    sys.create(
      piece.map((c) => ({ dx: c.dx - o.dx, dy: c.dy - o.dy, dz: c.dz - o.dz, state: c.state })),
      p[0], p[1], p[2],
      {
        rotation: { x: v.qx, y: v.qy, z: v.qz, w: v.qw },
        // Velocity of that point of the old body: v + w x r.
        velocity: { x: b.vx + spin.y * rz - spin.z * ry, y: b.vy + spin.z * rx - spin.x * rz, z: b.vz + spin.x * ry - spin.y * rx },
        spin,
      },
    );
  }
  b.cells = pieces[0] as BodyCell[];
  b.view.cells = b.cells;
  b.view.version++;
  b.tree = false;
  sys.fit(b);
}

/** Position in the world of a body-local point. */
function worldPoint(b: Body, lx: number, ly: number, lz: number): [number, number, number] {
  const { x, y, z, qx, qy, qz, qw } = b.view;
  return [
    x + (1 - 2 * (qy * qy + qz * qz)) * lx + 2 * (qx * qy - qz * qw) * ly + 2 * (qx * qz + qy * qw) * lz,
    y + 2 * (qx * qy + qz * qw) * lx + (1 - 2 * (qx * qx + qz * qz)) * ly + 2 * (qy * qz - qx * qw) * lz,
    z + 2 * (qx * qz - qy * qw) * lx + 2 * (qy * qz + qx * qw) * ly + (1 - 2 * (qx * qx + qy * qy)) * lz,
  ];
}

/** Cut the cells in two across their longest extent, then into whatever stays joined. */
function split(cells: BodyCell[]): BodyCell[][] {
  const lo = [Infinity, Infinity, Infinity];
  const hi = [-Infinity, -Infinity, -Infinity];
  for (const c of cells) {
    const p = [c.dx, c.dy, c.dz];
    for (let a = 0; a < 3; a++) {
      lo[a] = Math.min(lo[a] as number, p[a] as number);
      hi[a] = Math.max(hi[a] as number, p[a] as number);
    }
  }
  let axis = 0;
  for (let a = 1; a < 3; a++) if ((hi[a] as number) - (lo[a] as number) > (hi[axis] as number) - (lo[axis] as number)) axis = a;
  const cut = ((lo[axis] as number) + (hi[axis] as number)) / 2;
  const coord = (c: BodyCell): number => (axis === 0 ? c.dx : axis === 1 ? c.dy : c.dz);
  const a = cells.filter((c) => coord(c) <= cut);
  const b = cells.filter((c) => coord(c) > cut);
  if (a.length === 0 || b.length === 0) return connected(cells);
  return connected(a).concat(connected(b));
}

/**
 * Group cells into pieces that hold together. Blocks hold by faces; logs also
 * hold each other across edges and corners, as a tree's limbs do.
 */
function connected(cells: BodyCell[]): BodyCell[][] {
  const key = (x: number, y: number, z: number): string => `${x},${y},${z}`;
  const index = new Map<string, number>();
  cells.forEach((c, i) => index.set(key(c.dx, c.dy, c.dz), i));
  const seen = new Uint8Array(cells.length);
  const out: BodyCell[][] = [];
  for (let i = 0; i < cells.length; i++) {
    if (seen[i]) continue;
    seen[i] = 1;
    const piece: BodyCell[] = [cells[i] as BodyCell];
    for (let head = 0; head < piece.length; head++) {
      const c = piece[head] as BodyCell;
      const visit = (dx: number, dy: number, dz: number, logsOnly: boolean): void => {
        const j = index.get(key(c.dx + dx, c.dy + dy, c.dz + dz));
        if (j === undefined || seen[j]) return;
        const o = cells[j] as BodyCell;
        if (logsOnly && !(LOG[c.state] && LOG[o.state])) return;
        seen[j] = 1;
        piece.push(o);
      };
      for (const f of FACES) visit(f[0], f[1], f[2], false);
      for (let dy = -1; dy <= 1; dy++) for (let dz = -1; dz <= 1; dz++) for (let dx = -1; dx <= 1; dx++) {
        if (Math.abs(dx) + Math.abs(dy) + Math.abs(dz) >= 2) visit(dx, dy, dz, true);
      }
    }
    out.push(piece);
  }
  return out;
}
