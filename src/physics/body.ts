// The record kept for each rigid body, and what is derived from its cells
// once at creation: bounds, a dominant material, and the sample points that
// buoyancy integrates over.

import type { RigidBody } from '@dimforge/rapier3d-compat';
import { MATERIAL, MATERIALS, type Material } from '../world/blocks';
import { SOLID_VOLUME, VOXEL_MASK } from './shapes';
import { ITEM_SIZE, type BodyCell, type BodyKind, type BodyView } from './types';

export interface Body {
  view: BodyView;
  rb: RigidBody;
  kind: BodyKind;
  /** Body-local cells; empty for items. The view's `cells` is this array for compounds. */
  cells: BodyCell[];
  /** Index into `MATERIALS` of what most of the body is made of. */
  material: number;
  mass: number;
  /** Solid volume in cubic metres. */
  volume: number;
  /** Local bounding box, and its half diagonal about the origin for coarse tests. */
  min: [number, number, number];
  max: [number, number, number];
  radius: number;
  /** Centre of mass in body-local coordinates. */
  com: [number, number, number];
  /** Buoyancy samples: runs of (x, y, z, volume, height) in body-local coordinates. */
  samples: Float32Array;
  /** Fraction of the volume under water when last measured. */
  wet: number;
  inWater: boolean;
  /** Seconds since any of it was last under water. */
  dry: number;
  /** Angular damping currently set on the rigid body (raised under water). */
  angDamp: number;
  /** Velocity after the last step, with this step's own impulses added: what the next step should preserve but for collisions. */
  vx: number;
  vy: number;
  vz: number;
  /** Seconds since the last impact event, so a tumble does not report every bounce twice. */
  quiet: number;
  /** Seconds spent asleep in the current sleep. */
  asleep: number;
  /**
   * Seconds of the current sleep after which a return to the grid is next tried: 0 until one has been
   * refused, a little later than now when something was only in the way, and never (Infinity) when the
   * body lies wrong for it, which cannot change until it moves.
   */
  settleAt: number;
  /** Consecutive steps its centre has been inside a full block. */
  buried: number;
  /** Step in which the player's body last shoved it, so several of its colliders touching the player count once. */
  pushedAt: number;
  /** Seconds since creation. */
  age: number;
  /** Creation order, for oldest-first budgets. */
  born: number;
  /** A felled tree: sheds its leaves on its first hard impact. */
  tree: boolean;
  /** Chunk range last given terrain collision, so the terrain is asked again only when it changes. */
  range: Int32Array;
  dead: boolean;
}

export function dominantMaterial(cells: readonly BodyCell[]): number {
  const votes = new Map<number, number>();
  let best = 0;
  let bestMass = -1;
  for (const c of cells) {
    const m = MATERIAL[c.state] as number;
    const mass = (votes.get(m) ?? 0) + (MATERIALS[m] as Material).density * (SOLID_VOLUME[c.state] || 1);
    votes.set(m, mass);
    if (mass > bestMass) {
      bestMass = mass;
      best = m;
    }
  }
  return best;
}

/** Local bounds of a set of cells (each fills +-0.5 around its coordinates). */
export function cellBounds(cells: readonly BodyCell[]): { min: [number, number, number]; max: [number, number, number] } {
  const min: [number, number, number] = [Infinity, Infinity, Infinity];
  const max: [number, number, number] = [-Infinity, -Infinity, -Infinity];
  for (const c of cells) {
    min[0] = Math.min(min[0], c.dx - 0.5);
    min[1] = Math.min(min[1], c.dy - 0.5);
    min[2] = Math.min(min[2], c.dz - 0.5);
    max[0] = Math.max(max[0], c.dx + 0.5);
    max[1] = Math.max(max[1], c.dy + 0.5);
    max[2] = Math.max(max[2], c.dz + 0.5);
  }
  return { min, max };
}

/**
 * Buoyancy samples for a body. A lone full cube gets one per octant, so it
 * rights itself and bobs smoothly; a compound gets one per cell, which is
 * enough to make a trunk float level; an item gets one.
 */
export function buoyancySamples(kind: BodyKind, cells: readonly BodyCell[]): Float32Array {
  if (kind === 'item') return Float32Array.from([0, 0, 0, ITEM_SIZE ** 3, ITEM_SIZE]);
  const only = cells[0];
  if (cells.length === 1 && only && VOXEL_MASK[only.state] === 0xff) {
    const out = new Float32Array(8 * 5);
    for (let k = 0; k < 8; k++) {
      out.set([(k & 1) * 0.5 - 0.25, ((k >> 1) & 1) * 0.5 - 0.25, ((k >> 2) & 1) * 0.5 - 0.25, 0.125, 0.5], k * 5);
    }
    return out;
  }
  const out = new Float32Array(cells.length * 5);
  cells.forEach((c, i) => out.set([c.dx, c.dy, c.dz, SOLID_VOLUME[c.state] || 1, 1], i * 5));
  return out;
}
