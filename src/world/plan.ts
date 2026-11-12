// The village plan: what world generation built, described for the simulation
// that will live in it, and the check that the description matches the blocks.
// It sits in the world layer because generation produces it; `src/sim/api.ts`
// re-exports it as part of the contract the simulations run on. Headless.

import { B, BLOCKS_RAIN, FACING_STEP, SOLID, isBed, isDoor, isGate } from './blocks';
import { isStandable } from './walk';
import type { World } from './world';

/** Integer block coordinates. For a standing spot, this is the cell the feet are in. */
export interface Cell {
  x: number;
  y: number;
  z: number;
}

export const BUILDING_KINDS = [
  'house', 'farm', 'mill', 'bakery', 'tavern', 'smithy', 'carpenter', 'weaver', 'store', 'chapel', 'hall',
  'fishery', 'hunter', 'woodcutter', 'mine', 'shepherd', 'guardhouse',
] as const;
export type BuildingKind = (typeof BUILDING_KINDS)[number];

export const CROPS = ['wheat', 'barley', 'turnip', 'cabbage'] as const;
export type CropName = (typeof CROPS)[number];

export interface WorkSpot {
  /** What is worked at: 'oven', 'forge', 'anvil', 'loom', 'millstone', 'workbench', 'vat', 'counter', 'cauldron', 'altar', 'desk', 'woodpile'. */
  kind: string;
  /** Where the worker stands. */
  stand: Cell;
  /** The block being worked, beside the stand, if there is one (lit while in use for ovens and forges). */
  block: Cell | null;
}

export interface Bed {
  /** Where the sleeper stands before lying down: beside the bed. */
  stand: Cell;
  /** The foot-end bed block; the sleeper lies here. */
  block: Cell;
}

export interface Building {
  id: number;
  kind: BuildingKind;
  /** "Baker's house", "The Gilded Gull". */
  name: string;
  /** Footprint, inclusive, in block coordinates. Every column of it is roofed. */
  x0: number;
  z0: number;
  x1: number;
  z1: number;
  /** y of the feet cell on the ground floor. */
  floorY: number;
  /** Standing cell just outside the door. */
  entry: Cell;
  /** The lower door block, or null for an open-fronted building. */
  door: Cell | null;
  beds: Bed[];
  work: WorkSpot[];
  /** Standing cells beside stools and benches, for eating, drinking and resting. */
  seats: Cell[];
  /** Standing cell beside the building's store chest, or null. */
  storage: Cell | null;
  /** Lantern blocks the occupants light at dusk and put out at bedtime. */
  lights: Cell[];
  /** Top of the chimney, where smoke rises while the hearth is in use, or null. */
  chimney: Cell | null;
}

export interface Field {
  id: number;
  /** Building id of the farm that works it. */
  owner: number;
  crop: CropName;
  /** Farmland rectangle, inclusive; `y` is the farmland block's cell and crops grow in `y + 1`. */
  x0: number;
  z0: number;
  x1: number;
  z1: number;
  y: number;
}

export interface Pen {
  id: number;
  owner: number;
  animal: 'sheep' | 'cow' | 'chicken';
  /** Fenced interior rectangle, inclusive; `y` is the feet cell. */
  x0: number;
  z0: number;
  x1: number;
  z1: number;
  y: number;
  /** The gate block, in the fence one step outside the rectangle, and the standing cell just beyond it. */
  gate: Cell;
  outside: Cell;
}

export interface Stall {
  id: number;
  /** Where the seller stands, and where a customer stands. */
  stand: Cell;
  customer: Cell;
}

export interface Area {
  x: number;
  z: number;
  radius: number;
}

export interface VillagePlan {
  name: string;
  /** A standing cell at the heart of the village square. */
  center: Cell;
  buildings: Building[];
  fields: Field[];
  pens: Pen[];
  /** Market stalls on the square. */
  stalls: Stall[];
  /** Standing cell beside the well. */
  well: Cell;
  /** Standing cells around the square where people gather and talk. */
  gathering: Cell[];
  /** Standing cells at the end of the pier, for fishing. */
  dock: Cell[];
  /** Mine entrance (standing cell) and the standing cells at the working faces. */
  mine: { entrance: Cell; faces: Cell[] } | null;
  /** Woodland the woodcutters fell and replant. */
  forest: Area;
  /** Open meadow where the shepherd grazes the flock. */
  pasture: Area;
  /** Wild country the hunter works. */
  hunting: Area;
  /** Street lantern blocks, lit at dusk. */
  lamps: Cell[];
  /** Standing cells the night watch walks between, in order. */
  patrol: Cell[];
}

/**
 * Check that a plan matches the blocks actually in the world. World generation
 * and every test fixture must pass this, so the simulation can trust the plan:
 * it does not look again before it stands someone at a counter, lays them on a
 * bed, lights a forge or drives a flock through a gate. Returns a list of
 * problems; empty means valid.
 */
export function validateVillagePlan(world: World, plan: VillagePlan): string[] {
  const problems: string[] = [];
  const opt = { opensGates: true };
  const at = (c: Cell): number => world.get(c.x, c.y, c.z);
  const where = (c: Cell): string => `${c.x},${c.y},${c.z}`;
  const stand = (c: Cell, what: string): void => {
    if (!isStandable(world, c.x, c.y, c.z, opt)) problems.push(`${what} at ${where(c)} is not standable`);
  };
  /** On one level and sharing a face. */
  const beside = (a: Cell, b: Cell): boolean => a.y === b.y && Math.abs(a.x - b.x) + Math.abs(a.z - b.z) === 1;
  const isLantern = (s: number): boolean => (s >= B.lantern && s < B.lantern + 2) || (s >= B.hanging_lantern && s < B.hanging_lantern + 2);

  stand(plan.center, 'centre');
  stand(plan.well, 'well');
  plan.gathering.forEach((c, i) => stand(c, `gathering[${i}]`));
  plan.dock.forEach((c, i) => stand(c, `dock[${i}]`));
  plan.patrol.forEach((c, i) => stand(c, `patrol[${i}]`));
  if (plan.mine) {
    stand(plan.mine.entrance, 'mine entrance');
    plan.mine.faces.forEach((c, i) => stand(c, `mine face[${i}]`));
  }

  const byId = new Map<number, Building>();
  for (const b of plan.buildings) {
    const tag = `${b.kind}#${b.id}`;
    if (byId.has(b.id)) problems.push(`${tag}: duplicate building id`);
    byId.set(b.id, b);
    if (b.x0 > b.x1 || b.z0 > b.z1) {
      problems.push(`${tag}: footprint ${b.x0},${b.z0}..${b.x1},${b.z1} is inside out`);
    } else {
      // People go indoors out of the rain, so a building has something overhead in every column.
      roof: for (let z = b.z0; z <= b.z1; z++) {
        for (let x = b.x0; x <= b.x1; x++) {
          if (world.inBounds(x, b.floorY, z) && world.topWhere(x, z, BLOCKS_RAIN) >= b.floorY + 2) continue;
          problems.push(`${tag}: no roof over ${x},${z}`);
          break roof;
        }
      }
    }
    stand(b.entry, `${tag} entry`);
    if (b.door) {
      const s = at(b.door);
      if (!isDoor(s)) problems.push(`${tag}: no door block at ${where(b.door)}`);
      else if ((s - B.door) & 2) problems.push(`${tag}: door at ${where(b.door)} is the upper half`);
      if (!beside(b.entry, b.door)) problems.push(`${tag}: entry at ${where(b.entry)} is not beside the door at ${where(b.door)}`);
    }
    b.beds.forEach((bed, i) => {
      stand(bed.stand, `${tag} bed[${i}] stand`);
      const s = at(bed.block);
      if (!isBed(s)) {
        problems.push(`${tag}: bed[${i}] is not a bed block`);
        return;
      }
      if ((s - B.bed) & 1) {
        problems.push(`${tag}: bed[${i}] at ${where(bed.block)} is the head of the bed, not the foot`);
        return;
      }
      // The sleeper is laid from the foot toward the pillow, and gets up onto the stand.
      const step = FACING_STEP[(s - B.bed) >> 1] as readonly [number, number];
      const head = { x: bed.block.x + step[0], y: bed.block.y, z: bed.block.z + step[1] };
      if (at(head) !== s + 1) problems.push(`${tag}: bed[${i}] at ${where(bed.block)} has no head end beyond its foot`);
      if (!beside(bed.stand, bed.block) && !beside(bed.stand, head)) {
        problems.push(`${tag}: bed[${i}] stand at ${where(bed.stand)} is not beside its bed at ${where(bed.block)}`);
      }
    });
    b.work.forEach((wk, i) => {
      const what = `${tag} work[${i}] (${wk.kind})`;
      stand(wk.stand, what);
      if (!wk.block) return;
      // The worker faces the block, its fire is lit, and a customer is stood across it from the stand.
      const s = at(wk.block);
      if (!SOLID[s]) problems.push(`${what}: nothing to work at ${where(wk.block)}`);
      else if (wk.kind === 'oven' && !(s >= B.oven && s < B.oven + 8)) problems.push(`${what}: the block at ${where(wk.block)} is not an oven`);
      else if (wk.kind === 'forge' && !(s >= B.forge && s < B.forge + 2)) problems.push(`${what}: the block at ${where(wk.block)} is not a forge`);
      if (!beside(wk.stand, wk.block)) problems.push(`${what}: stand at ${where(wk.stand)} is not beside its block at ${where(wk.block)}`);
    });
    b.seats.forEach((c, i) => stand(c, `${tag} seat[${i}]`));
    if (b.storage) {
      const c = b.storage;
      stand(c, `${tag} storage`);
      if (!FACING_STEP.some(([dx, dz]) => world.get(c.x + dx, c.y, c.z + dz) === B.chest)) problems.push(`${tag}: no chest beside storage at ${where(c)}`);
    }
    b.lights.forEach((c, i) => {
      if (!isLantern(at(c))) problems.push(`${tag}: light[${i}] at ${where(c)} is not a lantern`);
    });
  }

  for (const f of plan.fields) {
    const owner = byId.get(f.owner);
    if (!owner) problems.push(`field#${f.id}: unknown owner ${f.owner}`);
    else if (owner.kind !== 'farm') problems.push(`field#${f.id}: owner ${owner.kind}#${owner.id} is not a farm`);
    if (f.x0 > f.x1 || f.z0 > f.z1) {
      problems.push(`field#${f.id}: rectangle ${f.x0},${f.z0}..${f.x1},${f.z1} is inside out`);
      continue;
    }
    for (let z = f.z0; z <= f.z1; z++) {
      for (let x = f.x0; x <= f.x1; x++) {
        const s = world.get(x, f.y, z);
        if (s !== B.farmland && s !== B.farmland + 1) {
          problems.push(`field#${f.id}: ${x},${f.y},${z} is not farmland`);
          z = f.z1 + 1;
          break;
        }
      }
    }
  }

  for (const p of plan.pens) {
    const tag = `pen#${p.id}`;
    if (!byId.has(p.owner)) problems.push(`${tag}: unknown owner ${p.owner}`);
    stand(p.outside, `${tag} outside gate`);
    if (p.x0 > p.x1 || p.z0 > p.z1) {
      problems.push(`${tag}: rectangle ${p.x0},${p.z0}..${p.x1},${p.z1} is inside out`);
      continue;
    }
    stand({ x: p.x0, y: p.y, z: p.z0 }, `${tag} interior`);
    const g = p.gate;
    if (!isGate(at(g))) problems.push(`${tag}: no gate block at ${where(g)}`);
    // The gate stands in the fence, one step outside one side of the rectangle, and the flock is driven
    // straight through it between the cell inside and the cell `outside`.
    const dx = g.x === p.x0 - 1 ? -1 : g.x === p.x1 + 1 ? 1 : 0;
    const dz = g.z === p.z0 - 1 ? -1 : g.z === p.z1 + 1 ? 1 : 0;
    const along = dx !== 0 ? g.z >= p.z0 && g.z <= p.z1 : g.x >= p.x0 && g.x <= p.x1;
    if (g.y !== p.y || Math.abs(dx) + Math.abs(dz) !== 1 || !along) {
      problems.push(`${tag}: gate at ${where(g)} is not in the fence round ${p.x0},${p.z0}..${p.x1},${p.z1}`);
      continue;
    }
    if (p.outside.x !== g.x + dx || p.outside.y !== g.y || p.outside.z !== g.z + dz) {
      problems.push(`${tag}: outside at ${where(p.outside)} is not the cell beyond the gate at ${where(g)}`);
    }
    stand({ x: g.x - dx, y: g.y, z: g.z - dz }, `${tag} inside gate`);
  }

  for (const s of plan.stalls) {
    stand(s.stand, `stall#${s.id} seller`);
    stand(s.customer, `stall#${s.id} customer`);
  }
  for (const c of plan.lamps) {
    if (!isLantern(at(c))) problems.push(`lamp at ${where(c)} is not a lantern`);
  }
  return problems;
}
