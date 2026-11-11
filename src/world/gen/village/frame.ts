// A local coordinate frame for constructing a building: templates are written
// once, front wall along local x at z = 0 with the interior behind it, and the
// frame turns them to face any of the four directions, including every block
// that has an orientation of its own (stairs, doors, beds, ovens, logs).

import type { Cell } from '../../../sim/api';
import { B, FACING_STEP, bedState, doorState } from '../../blocks';
import type { World } from '../../world';

/** Local directions: into the building, to its right seen from outside, out of its front, to its left. */
export const BACK = 0;
export const RIGHT = 1;
export const FRONT = 2;
export const LEFT = 3;

export class Frame {
  readonly world: World;
  /** World cell of local (0, 0, 0): the front-left corner at floor level, seen from outside. */
  readonly ox: number;
  readonly oy: number;
  readonly oz: number;
  /** World facing (0 N, 1 E, 2 S, 3 W) the front looks toward. */
  readonly facing: number;
  private readonly bx: number;
  private readonly bz: number;
  private readonly rx: number;
  private readonly rz: number;

  constructor(world: World, ox: number, oy: number, oz: number, facing: number) {
    this.world = world;
    this.ox = ox;
    this.oy = oy;
    this.oz = oz;
    this.facing = facing;
    const back = FACING_STEP[(facing + 2) & 3] as readonly [number, number];
    this.bx = back[0];
    this.bz = back[1];
    this.rx = -back[1];
    this.rz = back[0];
  }

  x(lx: number, lz: number): number {
    return this.ox + this.rx * lx + this.bx * lz;
  }

  z(lx: number, lz: number): number {
    return this.oz + this.rz * lx + this.bz * lz;
  }

  cell(lx: number, ly: number, lz: number): Cell {
    return { x: this.x(lx, lz), y: this.oy + ly, z: this.z(lx, lz) };
  }

  /** World facing index of a local direction. */
  dir(local: number): number {
    return [(this.facing + 2) & 3, (this.facing + 3) & 3, this.facing, (this.facing + 1) & 3][local & 3] as number;
  }

  get(lx: number, ly: number, lz: number): number {
    return this.world.get(this.x(lx, lz), this.oy + ly, this.z(lx, lz));
  }

  set(lx: number, ly: number, lz: number, state: number): void {
    const x = this.x(lx, lz);
    const y = this.oy + ly;
    const z = this.z(lx, lz);
    if (this.world.inBounds(x, y, z)) this.world.setRaw(x, y, z, state);
  }

  fill(x0: number, y0: number, z0: number, x1: number, y1: number, z1: number, state: number): void {
    for (let ly = y0; ly <= y1; ly++) for (let lz = z0; lz <= z1; lz++) for (let lx = x0; lx <= x1; lx++) this.set(lx, ly, lz, state);
  }

  /** Stairs whose tall half is toward a local direction. */
  stairs(lx: number, ly: number, lz: number, base: number, local: number): void {
    this.set(lx, ly, lz, base + this.dir(local));
  }

  /** A log or beam lying along a local axis. */
  log(lx: number, ly: number, lz: number, base: number, axis: 'x' | 'y' | 'z'): void {
    if (axis === 'y') return this.set(lx, ly, lz, base);
    const alongWorldX = axis === 'x' ? this.rx !== 0 : this.bx !== 0;
    this.set(lx, ly, lz, base + (alongWorldX ? 1 : 2));
  }

  /** A two-block door standing on the edge of its cell toward a local direction. */
  door(lx: number, ly: number, lz: number, edge = FRONT): void {
    const f = this.dir(edge);
    this.set(lx, ly, lz, doorState(f, false, false));
    this.set(lx, ly + 1, lz, doorState(f, true, false));
  }

  /** A bed with its foot at the given cell and its head one cell on in a local direction. Returns the foot cell. */
  bed(lx: number, ly: number, lz: number, head: number): Cell {
    const f = this.dir(head);
    const step = [[0, 1], [1, 0], [0, -1], [-1, 0]][head & 3] as [number, number];
    this.set(lx, ly, lz, bedState(f, false));
    this.set(lx + step[0], ly, lz + step[1], bedState(f, true));
    return this.cell(lx, ly, lz);
  }

  /** An oven with its mouth toward a local direction. */
  oven(lx: number, ly: number, lz: number, mouth: number): void {
    this.set(lx, ly, lz, B.oven + this.dir(mouth) * 2);
  }

  /** A ladder fixed to the wall on a local side. */
  ladder(lx: number, ly: number, lz: number, wall: number): void {
    this.set(lx, ly, lz, B.ladder + this.dir(wall));
  }
}
