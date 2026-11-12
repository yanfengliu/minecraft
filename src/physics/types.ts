// Shared vocabulary of the physics layer: what the renderer sees of a body,
// the events particles and sound hang off, and the knobs of the facade.
// Headless: no DOM, no renderer imports.

/** One gravity for the player and every body, in m/s^2 (one block is one metre). */
export const GRAVITY = 9.81;
/** Rigid bodies and falling blocks advance in fixed substeps of this many seconds. */
export const RIGID_DT = 1 / 60;
/** The fluid ticks six times a second. */
export const FLUID_DT = 1 / 6;
/** Side of a dropped item's cube, in metres. */
export const ITEM_SIZE = 0.3;
/** Density of water, kg per cubic metre. */
export const WATER_DENSITY = 1000;

export type BodyKind = 'block' | 'compound' | 'item';

/** One block of a body, in body-local cell coordinates. */
export interface BodyCell {
  dx: number;
  dy: number;
  dz: number;
  state: number;
}

/**
 * What the renderer draws for one body. The object is stable for the life of
 * the body and mutated in place, so a renderer may keep per-body data keyed on
 * it. Every field is always present so the shape never changes:
 *
 * - `x, y, z` is the body origin and `q*` its rotation. A cell (dx, dy, dz)
 *   fills the local box from (dx - 0.5, dy - 0.5, dz - 0.5) to (dx + 0.5,
 *   dy + 0.5, dz + 0.5); a block is the single cell (0, 0, 0), so its origin
 *   is the centre of the block. An item is a cube of `ITEM_SIZE` centred on
 *   the origin.
 * - `state` is the block state of a 'block' (0 otherwise); `item` and `count`
 *   describe an 'item' (-1 and 0 otherwise); `cells` lists a 'compound'
 *   (empty otherwise) and `version` goes up whenever that list changes.
 */
export interface BodyView {
  readonly id: number;
  readonly kind: BodyKind;
  x: number;
  y: number;
  z: number;
  qx: number;
  qy: number;
  qz: number;
  qw: number;
  sleeping: boolean;
  state: number;
  item: number;
  count: number;
  cells: readonly BodyCell[];
  version: number;
}

export type PhysicsEvent =
  /** Something entered water. `strength` is roughly the entry speed in m/s scaled by the size of what fell in. */
  | { type: 'splash'; x: number; y: number; z: number; strength: number }
  /**
   * A body hit something hard. `energy` is half its mass times the square of
   * the speed the blow changed, in joules: about the kinetic energy it arrived
   * with, a little more for a rebound. `material` indexes `MATERIALS`.
   */
  | { type: 'impact'; x: number; y: number; z: number; energy: number; material: number }
  /** A structure lost its support and left the grid. `blocks` counts the cells that came away. */
  | { type: 'collapse'; x: number; y: number; z: number; blocks: number }
  /** A block broke into fragments instead of surviving: leaves, glass, a plant washed out by water. */
  | { type: 'burst'; x: number; y: number; z: number; state: number }
  /** A loose block came to rest in the grid. */
  | { type: 'land'; x: number; y: number; z: number; state: number };

export type EmitEvent = (event: PhysicsEvent) => void;

export interface PhysicsOptions {
  /** Salt for the position hashes that break ties (which way a tree falls, which neighbour gets the odd unit of water). */
  seed?: number;
  /**
   * Clock for the timings in `stats`, in milliseconds. Simulation results never
   * depend on it. The physics layer reads no wall clock of its own, so without
   * this the timings stay 0; the game passes `() => performance.now()`.
   */
  now?: () => number;
  /** Live block and compound bodies allowed before the oldest sleepers are turned into item drops. */
  maxBodies?: number;
  /** Item bodies allowed before the oldest are removed. */
  maxItems?: number;
  /** Seconds an item lies on the ground before it despawns. */
  itemLifetime?: number;
  /** Seconds a block or compound sleeps before it is offered back to the grid. */
  settleTime?: number;
  /** A resting body returns to the grid only if no block moves further than this (metres) when snapped. */
  snapDistance?: number;
  /** ...and only if it is turned less than this (radians) from a grid orientation. */
  snapAngle?: number;
  /** Leaves a felled tree keeps as part of its body; the rest burst at once. */
  maxLeavesPerTree?: number;
  /** Detached structures larger than this many blocks are split into pieces of about this size. */
  pieceSize?: number;
  /** Apply the cantilever rule (a block further than its material's span from a supported column fails). */
  cantilever?: boolean;
  /** Finite water given by a source to each open neighbour per fluid tick, in sixteenths. */
  sourceRate?: number;
  /** Fluid ticks a thin film survives before it evaporates. */
  evaporateTicks?: number;
  /** Fluid cells examined per tick before the rest are held over to the next one. */
  maxFluidCells?: number;
}

/**
 * The books physics keeps on what it conserves, since the instance was made.
 * Nothing leaves the world any other way, so a test (or a debug readout) can
 * hold the layer to its own invariants:
 *
 * - Finite water, in sixteenths of a block: what stands in the world is
 *   always `poured + created - absorbed - evaporated - lost` more than there
 *   was to begin with.
 * - Blocks and items: a block that leaves the grid is in a body, is an item,
 *   or was reported in a `burst` event; a body or item that is gone without
 *   any of those (and without being collected) is counted here.
 */
export interface PhysicsLedger {
  water: {
    /** Brought in from outside: `addWater`, or water written straight into the grid. */
    poured: number;
    /** Made by sources (sea, lake, river) spilling into open cells. */
    created: number;
    /** Swallowed by sources. */
    absorbed: number;
    /** Dried up as thin films. */
    evaporated: number;
    /** Destroyed: something was put where it stood and there was nowhere at all for it to go. */
    lost: number;
    /** Displaced by something put where it stood and still looking for room: not in the world, and not lost. */
    pending: number;
  };
  /** Blocks of bodies that fell off the world, or were entombed with no way out: a count per block state. */
  blocksGone: ReadonlyMap<number, number>;
  /** Items that lay past their lifetime, were the oldest when there were too many, or fell off the world: a count per item id. */
  itemsGone: ReadonlyMap<number, number>;
}

export interface PhysicsStats {
  /** Cells the fluid will examine on its next tick; 0 once all water has settled. */
  fluidActive: number;
  /** Loose blocks in flight. */
  falling: number;
  /** Rigid bodies of every kind, and how many of them are awake. */
  bodies: number;
  awakeBodies: number;
  /** Colliders alive in the rigid-body world, terrain included. */
  colliders: number;
  /** Chunks of terrain that currently have collision geometry. */
  terrainChunks: number;
  /** Milliseconds spent by the last `step` call, by system. All 0 unless `PhysicsOptions.now` is given. */
  fluidMs: number;
  looseMs: number;
  structureMs: number;
  rigidMs: number;
  stepMs: number;
}
