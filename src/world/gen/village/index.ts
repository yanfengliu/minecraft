// Lays out and builds the village on the shelf the terrain left for it: a
// cobbled square with a well and market stalls, four roads, buildings along
// them, fenced fields and pens, a pier and a quarry. Returns the plan the
// village simulation runs on; every cell it names exists in the world.

import { clamp } from '../../../core/math';
import { Rng } from '../../../core/rng';
import type { Area, Building, BuildingKind, Cell, CropName, Field, Pen, Stall, VillagePlan } from '../../../sim/api';
import { B, gateState } from '../../blocks';
import type { World } from '../../world';
import { BIOME_FOREST, BIOME_HIGHLAND, BIOME_MEADOW, BIOME_PINE, type Terrain } from '../terrain';
import { SPECS, buildShell, furnish } from './buildings';
import { Frame } from './frame';

const N = 0;
const E = 1;
const S = 2;
const W = 3;
const STEP: readonly (readonly [number, number])[] = [[0, -1], [1, 0], [0, 1], [-1, 0]];

interface Slot {
  /** Which road arm the lot is on, how far along it the door is, and which side (-1 or 1). */
  arm: number;
  along: number;
  side: number;
  kind: BuildingKind;
}

/** Where each building goes. Public buildings sit at the corners of the square, trades and homes along the roads. */
// Door positions leave at least four clear cells between neighbouring walls, so each lot keeps its own margin.
const SLOTS: Slot[] = [
  { arm: W, along: 15, side: -1, kind: 'tavern' }, { arm: W, along: 15, side: 1, kind: 'chapel' },
  { arm: E, along: 15, side: -1, kind: 'store' }, { arm: E, along: 15, side: 1, kind: 'hall' },
  { arm: E, along: 28, side: -1, kind: 'bakery' }, { arm: E, along: 40, side: -1, kind: 'weaver' }, { arm: E, along: 51, side: -1, kind: 'house' },
  { arm: E, along: 29, side: 1, kind: 'smithy' }, { arm: E, along: 41, side: 1, kind: 'house' }, { arm: E, along: 53, side: 1, kind: 'farm' },
  { arm: W, along: 29, side: -1, kind: 'carpenter' }, { arm: W, along: 41, side: -1, kind: 'house' }, { arm: W, along: 53, side: -1, kind: 'farm' },
  { arm: W, along: 29, side: 1, kind: 'mill' }, { arm: W, along: 40, side: 1, kind: 'house' }, { arm: W, along: 51, side: 1, kind: 'house' },
  { arm: N, along: 20, side: -1, kind: 'guardhouse' }, { arm: N, along: 31, side: -1, kind: 'house' }, { arm: N, along: 42, side: -1, kind: 'woodcutter' },
  { arm: N, along: 20, side: 1, kind: 'hunter' }, { arm: N, along: 31, side: 1, kind: 'house' }, { arm: N, along: 42, side: 1, kind: 'mine' },
  { arm: S, along: 22, side: -1, kind: 'fishery' }, { arm: S, along: 37, side: -1, kind: 'house' },
  { arm: S, along: 22, side: 1, kind: 'shepherd' }, { arm: S, along: 37, side: 1, kind: 'house' },
];

/** How far each road runs from the centre: north, east, south, west. */
const ARM_LENGTH = [52, 60, 46, 60];
const CROPS: CropName[] = ['wheat', 'barley', 'turnip', 'cabbage'];

export function buildVillage(world: World, t: Terrain, reserved: Uint8Array): VillagePlan | null {
  const { sx, sz, seaLevel, seed } = t.config;
  const rng = new Rng(seed ^ 0x7111a6e);
  const cx = t.village.x;
  const cz = t.village.z;
  const base = t.village.y;
  if (cx < 100 || cz < 100 || cx > sx - 100 || cz > sz - 100) return null; // no room to lay it out (tiny test worlds)

  const inside = (x: number, z: number): boolean => x >= 2 && z >= 2 && x < sx - 2 && z < sz - 2;
  const at = (x: number, z: number): number => z * sx + x;
  const wet = (x: number, z: number): boolean => !inside(x, z) || (t.water[at(x, z)] as number) >= 0;
  const ground = (x: number, z: number): number => (inside(x, z) ? (t.height[at(x, z)] as number) : seaLevel);
  /** Top-block height of every road cell, or -1. */
  const roadY = new Int16Array(sx * sz).fill(-1);

  /** Cut or fill one column so its top block is `top` at height y, with clear air above. Leaves water alone. */
  const level = (x: number, z: number, y: number, top: number): void => {
    if (!inside(x, z) || wet(x, z)) return;
    const i = at(x, z);
    const h = t.height[i] as number;
    for (let yy = Math.max(1, Math.min(h, y) - 1); yy < y; yy++) world.setRaw(x, yy, z, B.dirt);
    world.setRaw(x, y, z, top);
    for (let yy = y + 1; yy <= Math.max(h, y) + 16 && yy < world.sy; yy++) world.setRaw(x, yy, z, B.air);
    t.height[i] = y;
    reserved[i] = 1;
  };
  const put = (x: number, y: number, z: number, state: number): void => {
    if (inside(x, z)) world.setRaw(x, y, z, state);
  };

  /**
   * A straight, graded road: it follows the ground but never steps more than one block per cell, and
   * crosses water on a plank deck. Returns the height it ended at.
   */
  const road = (x0: number, z0: number, x1: number, z1: number, half: number, top: number, startY: number): number => {
    const steps = Math.max(Math.abs(x1 - x0), Math.abs(z1 - z0));
    const dx = Math.sign(x1 - x0);
    const dz = Math.sign(z1 - z0);
    let y = startY;
    for (let s = 0; s <= steps; s++) {
      const x = x0 + dx * s;
      const z = z0 + dz * s;
      if (!inside(x, z)) break;
      const target = wet(x, z) ? (t.water[at(x, z)] as number) + 1 : ground(x, z);
      y = clamp(target, y - 1, y + 1);
      if (wet(x, z)) y = Math.max(y, (t.water[at(x, z)] as number) + 1);
      for (let o = -half; o <= half; o++) {
        const px = x + (dz !== 0 ? o : 0);
        const pz = z + (dx !== 0 ? o : 0);
        if (!inside(px, pz)) continue;
        if (wet(px, pz)) {
          const deck = Math.max(y, (t.water[at(px, pz)] as number) + 1);
          put(px, deck, pz, B.oak_planks);
          for (let yy = deck + 1; yy < deck + 5; yy++) put(px, yy, pz, B.air);
          // A post under the deck every third cell, down to the bed.
          if ((px + pz) % 3 === 0 && o !== 0) for (let yy = deck - 1; yy > ground(px, pz); yy--) put(px, yy, pz, B.oak_log);
          roadY[at(px, pz)] = deck;
          reserved[at(px, pz)] = 1;
        } else {
          level(px, pz, y, top);
          roadY[at(px, pz)] = y;
        }
      }
    }
    return y;
  };

  // --- the square ---
  for (let dz = -8; dz <= 8; dz++) {
    for (let dx = -8; dx <= 8; dx++) level(cx + dx, cz + dz, base, rng.chance(0.08) ? B.mossy_cobble : B.cobble);
  }
  for (let dz = -8; dz <= 8; dz++) for (let dx = -8; dx <= 8; dx++) roadY[at(cx + dx, cz + dz)] = base;

  // --- the four roads ---
  const armEnd: Cell[] = [];
  for (let arm = 0; arm < 4; arm++) {
    const [ax, az] = STEP[arm] as readonly [number, number];
    const len = ARM_LENGTH[arm] as number;
    const endY = road(cx + ax * 9, cz + az * 9, cx + ax * len, cz + az * len, 1, B.path, base);
    armEnd.push({ x: cx + ax * len, y: endY + 1, z: cz + az * len });
  }

  // --- buildings ---
  const buildings: Building[] = [];
  for (const slot of SLOTS) {
    const spec = SPECS[slot.kind];
    const [ax, az] = STEP[slot.arm] as readonly [number, number];
    // The side of the road the lot is on, as a unit step away from the centre line.
    const ox = az !== 0 ? slot.side : 0;
    const oz = ax !== 0 ? slot.side : 0;
    const facing = ox === 1 ? W : ox === -1 ? E : oz === 1 ? N : S;
    const doorX = spec.w >> 1;
    for (const shift of [0, 3, -3, 6, -6]) {
      const along = slot.along + shift;
      const rx = cx + ax * along;
      const rz = cz + az * along;
      const g = roadY[at(rx + ox, rz + oz)] as number;
      if (g < 0) continue;
      const frame0 = new Frame(world, rx + ox * 3, g, rz + oz * 3, facing);
      const f = new Frame(world, frame0.x(-doorX, 0), g, frame0.z(-doorX, 0), facing);
      // The lot must be dry land that is not wildly off the road's level.
      let ok = true;
      for (let lz = -1; lz <= spec.d + 1 && ok; lz++) {
        for (let lx = -2; lx <= spec.w + 1; lx++) {
          const x = f.x(lx, lz);
          const z = f.z(lx, lz);
          if (wet(x, z) || Math.abs(ground(x, z) - g) > 5 || (lz >= 0 && reserved[at(x, z)] === 1 && roadY[at(x, z)] < 0)) {
            ok = false;
            break;
          }
        }
      }
      if (!ok) continue;
      for (let lz = -1; lz <= spec.d + 1; lz++) {
        for (let lx = -2; lx <= spec.w + 1; lx++) {
          const x = f.x(lx, lz);
          const z = f.z(lx, lz);
          if (roadY[at(x, z)] >= 0) continue;
          level(x, z, g, B.grass);
        }
      }
      const chimney = buildShell(f, spec.w, spec.d, spec.style, rng);
      const parts = furnish(f, spec);
      // Doorstep: a path block between the door and the road.
      const step = f.cell(doorX, 0, -1);
      put(step.x, step.y, step.z, B.path);
      const a = f.cell(0, 0, 0);
      const b = f.cell(spec.w - 1, 0, spec.d - 1);
      const id = buildings.length;
      const count = buildings.filter((q) => q.kind === slot.kind).length;
      buildings.push({
        id, kind: slot.kind,
        name: slot.kind === 'house' ? `Cottage ${count + 1}` : slot.kind === 'farm' ? `${count === 0 ? 'East' : 'West'} farm` : spec.label,
        x0: Math.min(a.x, b.x), z0: Math.min(a.z, b.z), x1: Math.max(a.x, b.x), z1: Math.max(a.z, b.z),
        floorY: g + 1, entry: f.cell(doorX, 1, -1), door: f.cell(doorX, 1, 0), chimney, ...parts,
      });
      break;
    }
  }
  const idOf = (kind: BuildingKind, nth = 0): number => buildings.filter((q) => q.kind === kind)[nth]?.id ?? buildings[0]?.id ?? 0;

  // --- well, stalls, lamps ---
  put(cx, base, cz, B.water_source);
  for (let dz = -1; dz <= 1; dz++) for (let dx = -1; dx <= 1; dx++) if (dx || dz) put(cx + dx, base + 1, cz + dz, B.stone_wall);
  for (const [dx, dz] of [[-1, -1], [1, -1], [-1, 1], [1, 1]] as const) {
    put(cx + dx, base + 2, cz + dz, B.fence);
    put(cx + dx, base + 3, cz + dz, B.fence);
  }
  for (let dz = -1; dz <= 1; dz++) for (let dx = -1; dx <= 1; dx++) put(cx + dx, base + 4, cz + dz, B.oak_slab);

  const stalls: Stall[] = [];
  for (const [dx, dz] of [[-5, -5], [5, -5], [-5, 5], [5, 5]] as const) {
    const out = Math.sign(dz); // sellers stand on the outer side, customers toward the well
    const x = cx + dx;
    const z = cz + dz;
    put(x, base + 1, z, B.table);
    put(x - 1, base + 1, z, stalls.length % 2 ? B.barrel : B.crate);
    for (const px of [x - 2, x + 2]) for (let yy = 1; yy <= 3; yy++) put(px, base + yy, z, B.fence);
    put(x + 1, base + 1, z, B.crate);
    for (let ax = -2; ax <= 2; ax++) {
      for (const az of [0, out]) put(x + ax, base + 4, z + az, stalls.length % 2 ? B.awning_blue : B.awning_red);
    }
    stalls.push({ id: stalls.length, stand: { x, y: base + 1, z: z + out }, customer: { x, y: base + 1, z: z - out } });
  }

  const lamps: Cell[] = [];
  const lamp = (x: number, z: number): void => {
    const y = roadY[at(x, z)] >= 0 ? (roadY[at(x, z)] as number) : ground(x, z);
    if (wet(x, z) || world.get(x, y + 1, z) !== B.air) return;
    put(x, y + 1, z, B.fence);
    put(x, y + 2, z, B.fence);
    put(x, y + 3, z, B.lantern);
    reserved[at(x, z)] = 1;
    lamps.push({ x, y: y + 3, z });
  };
  for (const [dx, dz] of [[-8, -8], [8, -8], [-8, 8], [8, 8]] as const) lamp(cx + dx, cz + dz);
  for (let arm = 0; arm < 4; arm++) {
    const [ax, az] = STEP[arm] as readonly [number, number];
    for (const along of [21, 34, 45]) {
      if (along >= (ARM_LENGTH[arm] as number)) continue;
      // Just off the road's edge, on alternating sides.
      const side = along === 34 ? -2 : 2;
      lamp(cx + ax * along + (az !== 0 ? side : 0), cz + az * along + (ax !== 0 ? side : 0));
    }
  }

  // --- fields: two arms are carried on past their last house, a field either side of each ---
  const fields: Field[] = [];
  /** Roughness of the ground a pair of fields would take, `from` cells out along an arm; Infinity if any of it is wet. */
  const zoneScore = (arm: number, from: number): number => {
    const [ax, az] = STEP[arm] as readonly [number, number];
    let lo = Infinity;
    let hi = -Infinity;
    for (let a = from + 1; a <= from + 20; a += 2) {
      for (let o = -16; o <= 16; o += 2) {
        const x = cx + ax * a + (az !== 0 ? o : 0);
        const z = cz + az * a + (ax !== 0 ? o : 0);
        if (wet(x, z)) return Infinity;
        lo = Math.min(lo, ground(x, z));
        hi = Math.max(hi, ground(x, z));
      }
    }
    return hi - lo;
  };
  // Take pairs of fields from the gentlest ground first, a second pair further out the same road if needed.
  const zones: { arm: number; len: number }[] = [];
  for (const arm of [E, W, N].sort((p, q) => zoneScore(p, ARM_LENGTH[p] as number) - zoneScore(q, ARM_LENGTH[q] as number))) {
    for (const extra of [0, 19]) {
      const len = (ARM_LENGTH[arm] as number) + extra;
      if (zones.length >= 2 || zoneScore(arm, len) >= 16) break;
      zones.push({ arm, len });
    }
  }
  for (const { arm, len } of zones) {
    const [ax, az] = STEP[arm] as readonly [number, number];
    const end = armEnd[arm] as Cell;
    const endY = road(cx + ax * (len + 1), cz + az * (len + 1), cx + ax * (len + 19), cz + az * (len + 19), 1, B.path, end.y - 1);
    armEnd[arm] = { x: cx + ax * (len + 19), y: endY + 1, z: cz + az * (len + 19) };
    for (const side of [-1, 1]) {
      // Field rectangle: 14 along the road, 10 deep, starting three cells off the centre line.
      const a0 = len + 3;
      const a1 = len + 16;
      const o0 = side * 4;
      const o1 = side * 13;
      const xs = [cx + ax * a0 + (az !== 0 ? o0 : 0), cx + ax * a1 + (az !== 0 ? o1 : 0)];
      const zs = [cz + az * a0 + (ax !== 0 ? o0 : 0), cz + az * a1 + (ax !== 0 ? o1 : 0)];
      const x0 = Math.min(...xs);
      const x1 = Math.max(...xs);
      const z0 = Math.min(...zs);
      const z1 = Math.max(...zs);
      // Fence ring, with a gate in the middle of the side that faces the road. The field is levelled to
      // the road where its gate is, so the way in is never a climb.
      const gateAlong = len + 9;
      const gx = cx + ax * gateAlong + (az !== 0 ? side * 3 : 0);
      const gz = cz + az * gateAlong + (ax !== 0 ? side * 3 : 0);
      const g = roadY[at(cx + ax * gateAlong, cz + az * gateAlong)] as number;
      for (let z = z0 - 1; z <= z1 + 1; z++) {
        for (let x = x0 - 1; x <= x1 + 1; x++) {
          const ring = x < x0 || x > x1 || z < z0 || z > z1;
          level(x, z, g, ring ? B.grass : B.farmland);
          if (ring) put(x, g + 1, z, x === gx && z === gz ? gateState(ax !== 0 ? 0 : 1, false) : B.fence);
        }
      }
      // The cell between the gate and the road's edge.
      level(gx - (az !== 0 ? side : 0), gz - (ax !== 0 ? side : 0), g, B.path);
      fields.push({ id: fields.length, owner: idOf('farm', fields.length % 2), crop: CROPS[fields.length % 4] as CropName, x0, z0, x1, z1, y: g });
    }
  }

  // --- pens beside the shepherd, on a lane off the south road ---
  const pens: Pen[] = [];
  const shepherd = buildings.find((q) => q.kind === 'shepherd');
  if (shepherd) {
    const laneZ = cz + 29;
    let dry = true;
    for (let x = cx + 2; x <= cx + 24 && dry; x++) for (let z = cz + 19; z <= cz + 36; z++) if (wet(x, z) || reserved[at(x, z)] === 1 && x > cx + 11) dry = false;
    if (dry && roadY[at(cx + 1, laneZ)] >= 0) {
      road(cx + 2, laneZ, cx + 23, laneZ, 0, B.path, roadY[at(cx + 1, laneZ)] as number);
      const pen = (animal: Pen['animal'], x0: number, z0: number, x1: number, z1: number, gateX: number, gateZ: number): void => {
        // Level with the lane at the gate, so animals and people walk straight in.
        const g = roadY[at(gateX, laneZ)] as number;
        for (let z = z0 - 1; z <= z1 + 1; z++) {
          for (let x = x0 - 1; x <= x1 + 1; x++) {
            if (roadY[at(x, z)] >= 0) continue;
            const ring = x < x0 || x > x1 || z < z0 || z > z1;
            level(x, z, g, B.grass);
            if (ring) put(x, g + 1, z, x === gateX && z === gateZ ? gateState(0, false) : B.fence);
          }
        }
        put(x1, g + 1, gateZ < laneZ ? z0 : z1, B.trough);
        pens.push({ id: pens.length, owner: shepherd.id, animal, x0, z0, x1, z1, y: g + 1, gate: { x: gateX, y: g + 1, z: gateZ }, outside: { x: gateX, y: g + 1, z: laneZ } });
      };
      pen('sheep', cx + 13, cz + 21, cx + 21, cz + 27, cx + 17, cz + 28);
      pen('chicken', cx + 13, cz + 31, cx + 17, cz + 34, cx + 15, cz + 30);
    }
  }

  // --- the pier: the south or east road is carried on to the nearest sea and out over it ---
  const dock: Cell[] = [];
  {
    let best: { arm: number; reach: number } | null = null;
    for (const arm of [S, E, W]) {
      const [ax, az] = STEP[arm] as readonly [number, number];
      for (let a = (ARM_LENGTH[arm] as number) + 1; a < (ARM_LENGTH[arm] as number) + 150; a++) {
        const x = cx + ax * a;
        const z = cz + az * a;
        if (!inside(x, z)) break;
        const i = at(x, z);
        const sea = (t.water[i] as number) === seaLevel - 1 && (t.flow[i] as number) < 0 && (t.land[i] as number) < 0;
        if (reserved[i] === 1 && roadY[i] < 0) break;
        if (sea) {
          if (!best || a < best.reach) best = { arm, reach: a };
          break;
        }
      }
    }
    if (best) {
      const [ax, az] = STEP[best.arm] as readonly [number, number];
      const end = armEnd[best.arm] as Cell;
      const from = Math.max(Math.abs(end.x - cx), Math.abs(end.z - cz)) + 1;
      const to = best.reach + 9;
      road(cx + ax * from, cz + az * from, cx + ax * to, cz + az * to, 1, B.path, end.y - 1);
      for (let o = -1; o <= 1; o++) {
        const x = cx + ax * to + (az !== 0 ? o : 0);
        const z = cz + az * to + (ax !== 0 ? o : 0);
        if (roadY[at(x, z)] >= 0) dock.push({ x, y: (roadY[at(x, z)] as number) + 1, z });
      }
      armEnd[best.arm] = { x: cx + ax * (best.reach - 2), y: end.y, z: cz + az * (best.reach - 2) };
    }
  }

  // --- the quarry at the end of the north road ---
  let mine: VillagePlan['mine'] = null;
  {
    const nEnd = armEnd[N] as Cell;
    const g = nEnd.y - 1;
    const z0 = nEnd.z - 12;
    let ok = true;
    for (let z = z0 - 2; z <= nEnd.z && ok; z++) for (let x = cx - 7; x <= cx + 7; x++) if (wet(x, z) || Math.abs(ground(x, z) - g) > 6 || (reserved[at(x, z)] === 1 && roadY[at(x, z)] < 0)) { ok = false; break; }
    if (ok && g > 8) {
      const floor = g - 5;
      for (let z = z0 - 1; z <= nEnd.z - 1; z++) {
        for (let x = cx - 6; x <= cx + 6; x++) {
          const rim = x === cx - 6 || x === cx + 6 || z === z0 - 1 || z === nEnd.z - 1;
          if (rim) {
            level(x, z, g, B.gravel);
            if (!(x === cx && z === nEnd.z - 1)) put(x, g + 1, z, B.fence);
            continue;
          }
          level(x, z, g, B.stone);
          for (let y = g; y > floor; y--) put(x, y, z, B.air);
          put(x, floor, z, rng.chance(0.25) ? B.gravel : B.stone);
          t.height[at(x, z)] = floor;
        }
      }
      // Steps down from the road, along the middle of the pit.
      for (let i = 0; i < 5; i++) {
        const z = nEnd.z - 1 - i;
        for (let y = floor + 1; y < g - i; y++) put(cx, y, z, B.cobble);
        put(cx, g - i, z, i === 0 ? B.gravel : B.cobble_stairs + S);
        if (i === 0) put(cx, g + 1, z, B.air);
        t.height[at(cx, z)] = g - i;
      }
      // Ore showing in the walls at the working level.
      const faces: Cell[] = [];
      for (const [x, z, wx, wz] of [[cx - 5, z0 + 3, cx - 6, z0 + 3], [cx + 5, z0 + 3, cx + 6, z0 + 3], [cx - 3, z0, cx - 3, z0 - 1], [cx + 3, z0, cx + 3, z0 - 1]] as const) {
        put(wx, floor + 1, wz, faces.length % 2 ? B.coal_ore : B.iron_ore);
        put(wx, floor + 2, wz, faces.length % 2 ? B.iron_ore : B.coal_ore);
        put(x, floor, z, B.stone);
        faces.push({ x, y: floor + 1, z });
      }
      mine = { entrance: { x: cx, y: g + 1, z: nEnd.z }, faces };
    }
  }

  // --- the country around: where the woodcutters, shepherd and hunter go ---
  const survey = (wanted: (biome: number) => boolean, rMin: number, rMax: number, radius: number, fallbackArm: number): Area => {
    let best: Area = { x: cx + (STEP[fallbackArm] as readonly [number, number])[0] * rMin, z: cz + (STEP[fallbackArm] as readonly [number, number])[1] * rMin, radius };
    // Below this nothing found is worth more than the fallback beside the road.
    let bestScore = 0.25;
    for (let r = rMin; r <= rMax; r += 14) {
      for (let k = 0; k < 24; k++) {
        const ang = (k / 24) * Math.PI * 2;
        const x = Math.round(cx + Math.cos(ang) * r);
        const z = Math.round(cz + Math.sin(ang) * r);
        if (!inside(x, z) || wet(x, z)) continue;
        let hits = 0;
        let samples = 0;
        for (let dz = -radius; dz <= radius; dz += 5) {
          for (let dx = -radius; dx <= radius; dx += 5) {
            const qx = x + dx;
            const qz = z + dz;
            samples++;
            if (inside(qx, qz) && !wet(qx, qz) && reserved[at(qx, qz)] === 0 && wanted(t.biome[at(qx, qz)] as number)) hits++;
          }
        }
        // How much of the place is the ground wanted, less a charge for the walk: it is walked there and
        // back every working day, so a wood twice as far has to be much the better wood. (Scored by
        // cover alone, the woodcutters were sent 180 blocks to the island's densest forest.)
        const score = hits / samples - 0.55 * ((r - rMin) / Math.max(1, rMax - rMin));
        if (score > bestScore) {
          bestScore = score;
          best = { x, z, radius };
        }
      }
    }
    return best;
  };
  const forest = survey((b) => b === BIOME_FOREST || b === BIOME_PINE, 70, 190, 34, N);
  const pasture = survey((b) => b === BIOME_MEADOW, 66, 150, 20, E);
  const hunting = survey((b) => b === BIOME_FOREST || b === BIOME_PINE || b === BIOME_HIGHLAND, 105, 260, 55, N);

  const standOnRoad = (x: number, z: number): Cell => ({ x, y: (roadY[at(x, z)] >= 0 ? (roadY[at(x, z)] as number) : ground(x, z)) + 1, z });
  const patrol: Cell[] = [];
  for (const arm of [W, N, E, S]) {
    const [ax, az] = STEP[arm] as readonly [number, number];
    patrol.push(standOnRoad(cx + ax * 7, cz + az * 7));
    const far = Math.min(ARM_LENGTH[arm] as number, 44);
    patrol.push(standOnRoad(cx + ax * far, cz + az * far));
  }
  const gathering: Cell[] = [[-4, -2], [4, -2], [-4, 2], [4, 2], [-2, 7], [2, 7], [-7, 0], [7, 0]].map(([dx, dz]) => ({ x: cx + (dx as number), y: base + 1, z: cz + (dz as number) }));

  return {
    name: 'Tidewick',
    center: { x: cx + 3, y: base + 1, z: cz + 3 },
    buildings, fields, pens, stalls,
    well: { x: cx, y: base + 1, z: cz + 2 },
    gathering, dock, mine, forest, pasture, hunting, lamps, patrol,
  };
}
