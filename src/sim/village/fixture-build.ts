// Block-level helpers for the fixture village: a building is drawn as a small
// character map (walls, door, beds, work blocks, stools) and stamped into the
// world, and the plan entries the simulation needs (bed stands, work stands,
// seats, storage, lights, chimney) are derived from the same map, so the plan
// can never disagree with the blocks.
//
// Map legend, drawn with the door on the south (last) row:
//   #  wall            w  wall with a window     D  door           H  chimney (in a wall)
//   .  floor           L  floor under a hanging lantern
//   b  bed foot        B  bed head (next to its foot)
//   s  stool           T  table                  c  chest (storage)
//   O  oven   F  forge   A  anvil   M  millstone   W  workbench   V  brew vat   l  loom
//   C  counter   K  cauldron   a  altar   d  desk   p  woodpile
//   k  barrel   r  crate   x  sack   h  hay bale   q  woodpile (decoration)

import { B, bedState, doorState, gateState } from '../../world/blocks';
import type { World } from '../../world/world';
import type { Bed, Building, BuildingKind, Cell, Pen, WorkSpot } from '../api';

/** y of the surface block of the flat fixture world, and of a walker's feet on it. */
export const GROUND = 31;
export const FEET = 32;
const WALL_TOP = FEET + 2;
const ROOF = FEET + 3;

export interface Style {
  wall: number;
  corner: number;
  roof: number;
  floor: number;
}

const WORK: Record<string, { kind: string; block: number }> = {
  O: { kind: 'oven', block: B.oven },
  F: { kind: 'forge', block: B.forge },
  A: { kind: 'anvil', block: B.anvil },
  M: { kind: 'millstone', block: B.millstone },
  W: { kind: 'workbench', block: B.workbench },
  V: { kind: 'vat', block: B.brew_vat },
  l: { kind: 'loom', block: B.loom },
  C: { kind: 'counter', block: B.table },
  K: { kind: 'cauldron', block: B.cauldron },
  a: { kind: 'altar', block: B.table },
  d: { kind: 'desk', block: B.bookshelf },
  p: { kind: 'woodpile', block: B.woodpile },
};

const DECOR: Record<string, number> = { T: B.table, k: B.barrel, r: B.crate, x: B.sack, h: B.hay_bale, q: B.woodpile };

/** Neighbour order used when choosing where someone stands beside a block: south, north, east, west. */
const SIDES: readonly (readonly [number, number])[] = [[0, 1], [0, -1], [1, 0], [-1, 0]];
/** Facing index (0 N, 1 E, 2 S, 3 W) for a unit step. */
const facingOf = (dx: number, dz: number): number => (dz < 0 ? 0 : dx > 0 ? 1 : dz > 0 ? 2 : 3);

/** Turn a character map clockwise by quarter turns. A south door ends up west, north, then east. */
export function rotateRows(rows: readonly string[], turns: number): string[] {
  let cur = rows.slice();
  for (let t = 0; t < (turns & 3); t++) {
    const depth = cur.length;
    const width = (cur[0] as string).length;
    const next: string[] = [];
    for (let i = 0; i < width; i++) {
      let s = '';
      for (let j = 0; j < depth; j++) s += (cur[depth - 1 - j] as string)[i];
      next.push(s);
    }
    cur = next;
  }
  return cur;
}

/**
 * Stamp a building into the world with its north-west corner at (x0, z0) and
 * return its plan entry. `rows` must already be rotated to the wanted facing.
 */
export function placeBuilding(
  world: World, id: number, kind: BuildingKind, name: string, rows: readonly string[], x0: number, z0: number, style: Style,
): Building {
  const depth = rows.length;
  const width = (rows[0] as string).length;
  const at = (c: number, r: number): string => (r < 0 || r >= depth || c < 0 || c >= width ? ' ' : ((rows[r] as string)[c] as string));
  const isFloor = (c: number, r: number): boolean => at(c, r) === '.' || at(c, r) === 'L';
  const cell = (c: number, r: number, y = FEET): Cell => ({ x: x0 + c, y, z: z0 + r });
  const used = new Set<number>();
  let doorCol = 0;
  let doorRow = 0;
  for (let r = 0; r < depth; r++) for (let c = 0; c < width; c++) if (at(c, r) === 'D') [doorCol, doorRow] = [c, r];

  // Floor that can be walked to from the door without squeezing past furniture; only this is offered as a place to stand.
  const reachable = new Set<number>();
  const frontier: [number, number][] = [[doorCol, doorRow]];
  while (frontier.length > 0) {
    const [c, r] = frontier.pop() as [number, number];
    for (const [dx, dz] of SIDES) {
      const key = (r + dz) * width + c + dx;
      if (!isFloor(c + dx, r + dz) || reachable.has(key)) continue;
      reachable.add(key);
      frontier.push([c + dx, r + dz]);
    }
  }

  /** A floor cell beside (c, r) for someone to stand in: unused ones first, and for a counter the side away from the door. */
  const standBeside = (c: number, r: number, awayFromDoor = false): Cell => {
    let best: [number, number] | null = null;
    let bestScore = -Infinity;
    for (const [dx, dz] of SIDES) {
      if (!reachable.has((r + dz) * width + c + dx)) continue;
      const far = Math.abs(c + dx - doorCol) + Math.abs(r + dz - doorRow);
      const score = (used.has((r + dz) * width + c + dx) ? -100 : 0) + (awayFromDoor ? far : -far * 0.01);
      if (score > bestScore) {
        bestScore = score;
        best = [c + dx, r + dz];
      }
    }
    if (!best) throw new Error(`${name}: nothing to stand on beside ${at(c, r)} at ${c},${r}`);
    used.add(best[1] * width + best[0]);
    return cell(best[0], best[1]);
  };

  const beds: Bed[] = [];
  const work: WorkSpot[] = [];
  const seats: Cell[] = [];
  const lights: Cell[] = [];
  let storage: Cell | null = null;
  let chimney: Cell | null = null;
  let door: Cell | null = null;
  let entry: Cell | null = null;

  // Shell first: floor, walls, roof. Furniture goes in afterwards.
  for (let r = 0; r < depth; r++) {
    for (let c = 0; c < width; c++) {
      const ch = at(c, r);
      const x = x0 + c;
      const z = z0 + r;
      const edge = r === 0 || c === 0 || r === depth - 1 || c === width - 1;
      const corner = (r === 0 || r === depth - 1) && (c === 0 || c === width - 1);
      world.setRaw(x, GROUND, z, edge ? B.cobble : style.floor);
      world.setRaw(x, ROOF, z, style.roof);
      if (!edge) world.setRaw(x, ROOF + 1, z, style.roof);
      if (ch === '#' || ch === 'w') {
        for (let y = FEET; y <= WALL_TOP; y++) world.setRaw(x, y, z, corner ? style.corner : style.wall);
        if (ch === 'w') world.setRaw(x, FEET + 1, z, B.window);
      } else if (ch === 'H') {
        for (let y = FEET; y <= ROOF + 2; y++) world.setRaw(x, y, z, B.bricks);
        chimney = { x, y: ROOF + 2, z };
      } else if (ch === 'D') {
        const dx = c === 0 ? -1 : c === width - 1 ? 1 : 0;
        const dz = r === 0 ? -1 : r === depth - 1 ? 1 : 0;
        const facing = facingOf(dx, dz);
        world.setRaw(x, FEET, z, doorState(facing, false, false));
        world.setRaw(x, FEET + 1, z, doorState(facing, true, false));
        world.setRaw(x, WALL_TOP, z, style.wall);
        door = { x, y: FEET, z };
        entry = { x: x + dx, y: FEET, z: z + dz };
      }
    }
  }

  // Beds before anything else claims the floor beside them.
  for (let r = 0; r < depth; r++) {
    for (let c = 0; c < width; c++) {
      if (at(c, r) !== 'b') continue;
      const head = SIDES.find(([dx, dz]) => at(c + dx, r + dz) === 'B');
      if (!head) throw new Error(`${name}: bed foot at ${c},${r} has no head`);
      const facing = facingOf(head[0], head[1]);
      world.setRaw(x0 + c, FEET, z0 + r, bedState(facing, false));
      world.setRaw(x0 + c + head[0], FEET, z0 + r + head[1], bedState(facing, true));
      beds.push({ stand: standBeside(c, r), block: cell(c, r) });
    }
  }
  for (let r = 0; r < depth; r++) {
    for (let c = 0; c < width; c++) {
      const ch = at(c, r);
      const x = x0 + c;
      const z = z0 + r;
      const spot = WORK[ch];
      if (spot) {
        const stand = standBeside(c, r, ch === 'C');
        // An oven's mouth faces whoever works it.
        const state = ch === 'O' ? B.oven + facingOf(stand.x - x, stand.z - z) * 2 : spot.block;
        world.setRaw(x, FEET, z, state);
        work.push({ kind: spot.kind, stand, block: { x, y: FEET, z } });
      } else if (ch === 's') {
        world.setRaw(x, FEET, z, B.stool);
        seats.push(standBeside(c, r));
      } else if (ch === 'c') {
        world.setRaw(x, FEET, z, B.chest);
        storage = standBeside(c, r);
      } else if (ch === 'L') {
        world.setRaw(x, WALL_TOP, z, B.hanging_lantern);
        lights.push({ x, y: WALL_TOP, z });
      } else if (DECOR[ch] !== undefined) {
        world.setRaw(x, FEET, z, DECOR[ch] as number);
      }
    }
  }
  if (!entry) throw new Error(`${name}: no door in the map`);
  return {
    id, kind, name, x0, z0, x1: x0 + width - 1, z1: z0 + depth - 1, floorY: FEET, entry, door, beds, work, seats, storage, lights, chimney,
  };
}

/** A strip of made path, one block wide, replacing the surface. */
export function road(world: World, x0: number, z0: number, x1: number, z1: number, state: number = B.path): void {
  for (let z = Math.min(z0, z1); z <= Math.max(z0, z1); z++) {
    for (let x = Math.min(x0, x1); x <= Math.max(x0, x1); x++) world.setRaw(x, GROUND, z, state);
  }
}

/** A lantern on a fence post, two blocks up. Returns the lantern cell. */
export function lampPost(world: World, x: number, z: number): Cell {
  world.setRaw(x, FEET, z, B.fence);
  world.setRaw(x, FEET + 1, z, B.fence);
  world.setRaw(x, FEET + 2, z, B.lantern);
  return { x, y: FEET + 2, z };
}

/**
 * A fenced pen around the interior rectangle, with a gate on one side.
 * `side` is where the gate goes: 0 north, 1 east, 2 south, 3 west; `along` is
 * the gate's position on that side, as a world x (north, south) or z (east, west).
 */
export function fencedPen(
  world: World, id: number, owner: number, animal: Pen['animal'], x0: number, z0: number, x1: number, z1: number, side: number, along: number,
): Pen {
  for (let z = z0 - 1; z <= z1 + 1; z++) {
    for (let x = x0 - 1; x <= x1 + 1; x++) {
      if (x >= x0 && x <= x1 && z >= z0 && z <= z1) continue;
      world.setRaw(x, FEET, z, B.fence);
    }
  }
  let gate: Cell;
  let outside: Cell;
  if (side === 0 || side === 2) {
    const z = side === 0 ? z0 - 1 : z1 + 1;
    gate = { x: along, y: FEET, z };
    outside = { x: along, y: FEET, z: z + (side === 0 ? -1 : 1) };
    world.setRaw(gate.x, FEET, gate.z, gateState(0, false));
  } else {
    const x = side === 3 ? x0 - 1 : x1 + 1;
    gate = { x, y: FEET, z: along };
    outside = { x: x + (side === 3 ? -1 : 1), y: FEET, z: along };
    world.setRaw(gate.x, FEET, gate.z, gateState(1, false));
  }
  return { id, owner, animal, x0, z0, x1, z1, y: FEET, gate, outside };
}
