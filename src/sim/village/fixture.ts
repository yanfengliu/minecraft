// A small but complete village on flat ground, for the headless tests and as
// the reference for what world generation must hand the simulation: every
// place the plan names exists as real blocks, and `validateVillagePlan`
// passes. Layout, with north up and the square at the centre:
//
//   forest (NW)        pasture (NE), sheep and chicken pens
//   farms and fields (W)   two streets of houses and workshops   fishery, pond (E)
//   mine in a stone hill (SW)                                    hunting ground (SE)

import { Rng } from '../../core/rng';
import { B } from '../../world/blocks';
import { growTree, type TreeSpecies } from '../../world/gen/trees';
import { type World, createFlatWorld } from '../../world/world';
import type { Building, BuildingKind, Cell, CropName, Field, Pen, Stall, VillagePlan } from '../api';
import { FEET, GROUND, type Style, fencedPen, lampPost, placeBuilding, road, rotateRows } from './fixture-build';

const COTTAGE: Style = { wall: B.plaster, corner: B.beam, roof: B.thatch, floor: B.oak_planks };
const TIMBER: Style = { wall: B.oak_planks, corner: B.oak_log, roof: B.thatch, floor: B.oak_planks };
const STONE: Style = { wall: B.cobble, corner: B.stone_bricks, roof: B.slate_tiles, floor: B.cobble };
const FINE: Style = { wall: B.stone_bricks, corner: B.stone_bricks, roof: B.clay_tiles, floor: B.oak_planks };

// The cell just inside each door is kept as bare floor, or nobody could get in.
const MAPS: Record<string, string[]> = {
  house3: ['#w###w#', '#B.B.B#', '#b.b.b#', '#.....#', '#cL.sT#', 'H....s#', '###D###'],
  house2: ['#w###w#', '#B...B#', '#b...b#', '#.....#', '#cL.sT#', 'H....s#', '###D###'],
  farm: ['#w###w#', '#B.B.B#', '#b.b.b#', '#.....#', '#cL..W#', 'Hs...T#', '###D###'],
  mill: ['#w###w#', '#B...B#', '#b...b#', '#.....#', '#cL.M.#', 'Hs...x#', '###D###'],
  bakery: ['#w###w#', '#B.c.B#', '#b...b#', '#.....#', 'HOL.C.#', '#s....#', '###D###'],
  tavern: ['#w#####w#', '#B.B..VK#', '#b.b....H', '#....CT.#', '#.L....L#', '#sT.sT.s#', '#.s..s..#', '#.......#', '####D####'],
  smithy: ['#w###w#', '#B.c.B#', '#b...b#', '#.....#', 'HFL.A.#', '#s....#', '###D###'],
  carpenter: ['#w###w#', '#B....#', '#b..W.#', '#.....#', '#cL...#', '#s...r#', '###D###'],
  weaver: ['#w###w#', '#B...B#', '#b...b#', '#.....#', '#cL.l.#', '#s....#', '###D###'],
  store: ['#w###w#', '#B.k.B#', '#b.r.b#', '#.....#', '#cL.C.#', '#s....#', '###D###'],
  chapel: ['#w###w#', '#B.a..#', '#b....#', '#.....#', '#.L.L.#', '#s.s.s#', '#.....#', '#s.s.s#', '#.....#', '#s...s#', '###D###'],
  hall: ['#w###w#', '#B..d.#', '#b....#', '#.....#', '#cL.sT#', '#....s#', '###D###'],
  fishery: ['#w###w#', '#B...B#', '#b...b#', '#.....#', '#cL.W.#', '#s...k#', '###D###'],
  hunter: ['#w###w#', '#B....#', '#b..W.#', '#.....#', '#cL...#', '#s...x#', '###D###'],
  woodcutter: ['#w###w#', '#B...B#', '#b...b#', '#.....#', '#cL.p.#', '#s...q#', '###D###'],
  mine: ['#w###w#', '#B...B#', '#b...b#', '#.....#', '#cL.W.#', '#s...r#', '###D###'],
  shepherd: ['#w###w#', '#B...B#', '#b...b#', '#.....#', '#cL.W.#', '#s...h#', '###D###'],
  guardhouse: ['#w###w#', '#B...B#', '#b...b#', '#.....#', '#cL.d.#', '#s....#', '###D###'],
};

/** Quarter turns that bring a map's south door round to face north. */
const NORTH = 2;

interface Lot {
  kind: BuildingKind;
  name: string;
  map: string;
  x: number;
  z: number;
  turns: number;
  style: Style;
}

const LOTS: Lot[] = [
  // North street, north side: doors face south onto the street at z = 48.
  { kind: 'woodcutter', name: "Woodcutter's hut", map: 'woodcutter', x: 27, z: 41, turns: 0, style: TIMBER },
  { kind: 'house', name: 'Rowan Cottage', map: 'house3', x: 36, z: 41, turns: 0, style: COTTAGE },
  { kind: 'house', name: 'Thrush Cottage', map: 'house3', x: 45, z: 41, turns: 0, style: COTTAGE },
  { kind: 'bakery', name: 'The Bakehouse', map: 'bakery', x: 54, z: 41, turns: 0, style: FINE },
  { kind: 'store', name: 'Tidewick Stores', map: 'store', x: 68, z: 41, turns: 0, style: FINE },
  { kind: 'house', name: 'Sorrel Cottage', map: 'house3', x: 77, z: 41, turns: 0, style: COTTAGE },
  { kind: 'weaver', name: "Weaver's house", map: 'weaver', x: 86, z: 41, turns: 0, style: COTTAGE },
  { kind: 'shepherd', name: "Shepherd's cottage", map: 'shepherd', x: 96, z: 41, turns: 0, style: TIMBER },
  // North street, south side.
  { kind: 'house', name: 'Quill Cottage', map: 'house3', x: 37, z: 49, turns: NORTH, style: COTTAGE },
  { kind: 'carpenter', name: "Carpenter's shop", map: 'carpenter', x: 46, z: 49, turns: NORTH, style: TIMBER },
  { kind: 'hall', name: 'Moot Hall', map: 'hall', x: 55, z: 49, turns: NORTH, style: FINE },
  { kind: 'guardhouse', name: 'Guardhouse', map: 'guardhouse', x: 69, z: 49, turns: NORTH, style: STONE },
  { kind: 'smithy', name: 'The Smithy', map: 'smithy', x: 78, z: 49, turns: NORTH, style: STONE },
  { kind: 'house', name: 'Marsh Cottage', map: 'house2', x: 87, z: 49, turns: NORTH, style: COTTAGE },
  // South street.
  { kind: 'house', name: 'Fern Cottage', map: 'house2', x: 36, z: 73, turns: 0, style: COTTAGE },
  { kind: 'mill', name: 'The Old Mill', map: 'mill', x: 45, z: 73, turns: 0, style: STONE },
  { kind: 'hunter', name: "Hunter's lodge", map: 'hunter', x: 86, z: 73, turns: 0, style: TIMBER },
  { kind: 'chapel', name: 'Chapel of the Tides', map: 'chapel', x: 54, z: 81, turns: NORTH, style: FINE },
  { kind: 'tavern', name: 'The Gilded Gull', map: 'tavern', x: 66, z: 81, turns: NORTH, style: FINE },
  // Out of town.
  { kind: 'farm', name: 'Northfield Farm', map: 'farm', x: 20, z: 56, turns: 0, style: TIMBER },
  { kind: 'farm', name: 'Southfield Farm', map: 'farm', x: 20, z: 66, turns: NORTH, style: TIMBER },
  { kind: 'fishery', name: 'The Fishery', map: 'fishery', x: 96, z: 66, turns: NORTH, style: TIMBER },
  { kind: 'mine', name: "Miners' lodge", map: 'mine', x: 38, z: 94, turns: 0, style: STONE },
];

const feet = (x: number, z: number): Cell => ({ x, y: FEET, z });

function field(world: World, id: number, owner: number, crop: CropName, x0: number, z0: number, x1: number, z1: number): Field {
  road(world, x0, z0, x1, z1, B.farmland);
  return { id, owner, crop, x0, z0, x1, z1, y: GROUND };
}

function plantTrees(world: World, rng: Rng, cx: number, cz: number, radius: number, spacing: number, species: readonly TreeSpecies[]): void {
  for (let z = cz - radius; z <= cz + radius; z += spacing) {
    for (let x = cx - radius; x <= cx + radius; x += spacing) {
      const tx = x + rng.intRange(-1, 1);
      const tz = z + rng.intRange(-1, 1);
      if (Math.hypot(tx - cx, tz - cz) > radius - 2) continue;
      if (world.get(tx, GROUND, tz) !== B.grass) continue;
      world.setRaw(tx, GROUND, tz, B.forest_floor);
      growTree(world, tx, FEET, tz, rng.pick(species), rng, true);
    }
  }
}

function digPond(world: World, cx: number, cz: number, rx: number, rz: number): void {
  for (let z = cz - rz; z <= cz + rz; z++) {
    for (let x = cx - rx; x <= cx + rx; x++) {
      if (((x - cx) / rx) ** 2 + ((z - cz) / rz) ** 2 > 1) continue;
      world.setRaw(x, GROUND, z, B.water_source);
      world.setRaw(x, GROUND - 1, z, B.water_source);
      world.setRaw(x, GROUND - 2, z, B.sand);
    }
  }
}

/** A stone hill with a roofed adit driven into it from the east. Returns the entrance and the working faces. */
function digMine(world: World): { entrance: Cell; faces: Cell[] } {
  for (let z = 96; z <= 110; z++) for (let x = 18; x <= 33; x++) for (let y = GROUND; y <= GROUND + 5; y++) world.setRaw(x, y, z, B.stone);
  const carve = (x: number, z: number): void => {
    world.setRaw(x, FEET, z, B.air);
    world.setRaw(x, FEET + 1, z, B.air);
  };
  for (let x = 23; x <= 33; x++) carve(x, 103);
  carve(25, 102);
  carve(25, 104);
  carve(29, 102);
  world.setRaw(22, FEET, 103, B.iron_ore);
  world.setRaw(22, FEET + 1, 103, B.coal_ore);
  world.setRaw(25, FEET, 101, B.coal_ore);
  world.setRaw(25, FEET + 1, 105, B.iron_ore);
  world.setRaw(29, FEET, 101, B.iron_ore);
  world.setRaw(30, FEET + 2, 103, B.hanging_lantern + 1);
  return { entrance: feet(34, 103), faces: [feet(23, 103), feet(25, 102), feet(25, 104), feet(29, 102)] };
}

function marketStall(world: World, id: number, x: number, tableZ: number, sellerZ: number): Stall {
  world.setRaw(x, FEET, tableZ, B.table);
  for (const px of [x - 1, x + 1]) {
    world.setRaw(px, FEET, sellerZ, B.fence);
    world.setRaw(px, FEET + 1, sellerZ, B.fence);
  }
  for (let ax = x - 1; ax <= x + 1; ax++) {
    world.setRaw(ax, FEET + 2, sellerZ, id % 2 ? B.awning_red : B.awning_blue);
    world.setRaw(ax, FEET + 2, tableZ, id % 2 ? B.awning_red : B.awning_blue);
  }
  return { id, stand: feet(x, sellerZ), customer: feet(x, tableZ + (tableZ - sellerZ)) };
}

/**
 * Build the fixture village. The seed only varies the trees; the layout is
 * fixed so tests can name places.
 */
export function createFixtureVillage(seed = 1): { world: World; plan: VillagePlan } {
  const world = createFlatWorld(128, 128, GROUND, 64);
  world.trackDirty = false;
  const rng = new Rng(seed).fork('fixture');

  // Streets first, so buildings and the square can overwrite them where they meet.
  road(world, 4, 64, 120, 64);
  road(world, 64, 8, 64, 120);
  road(world, 27, 48, 104, 48);
  road(world, 34, 80, 94, 80);
  road(world, 34, 48, 34, 80);
  road(world, 94, 48, 94, 80);
  road(world, 35, 103, 64, 103);
  road(world, 57, 57, 71, 71, B.cobble);

  // The well: a ring of cobble round a shaft of water.
  for (let dz = -1; dz <= 1; dz++) for (let dx = -1; dx <= 1; dx++) world.setRaw(64 + dx, FEET, 64 + dz, B.cobble);
  world.setRaw(64, FEET, 64, B.water_source);
  world.setRaw(64, GROUND, 64, B.water_source);

  const buildings: Building[] = LOTS.map((lot, i) =>
    placeBuilding(world, i + 1, lot.kind, lot.name, rotateRows(MAPS[lot.map] as string[], lot.turns), lot.x, lot.z, lot.style));
  const idOf = (name: string): number => (buildings.find((b) => b.name === name) as Building).id;
  const north = idOf('Northfield Farm');
  const south = idOf('Southfield Farm');
  const shepherd = idOf("Shepherd's cottage");

  const fields: Field[] = [
    field(world, 1, north, 'wheat', 6, 52, 15, 59),
    field(world, 2, north, 'turnip', 6, 42, 13, 49),
    field(world, 3, south, 'wheat', 6, 68, 15, 75),
    field(world, 4, south, 'barley', 6, 78, 13, 83),
    field(world, 5, south, 'cabbage', 16, 76, 23, 83),
  ];

  const pens: Pen[] = [
    fencedPen(world, 1, shepherd, 'sheep', 106, 38, 113, 44, 2, 109),
    fencedPen(world, 2, shepherd, 'chicken', 97, 34, 101, 37, 1, 36),
    fencedPen(world, 3, north, 'cow', 16, 44, 20, 48, 1, 46),
  ];
  world.setRaw(113, FEET, 38, B.trough);
  world.setRaw(20, FEET, 44, B.trough);
  world.setRaw(106, FEET, 44, B.hay_bale);

  const stalls: Stall[] = [
    marketStall(world, 1, 59, 58, 57),
    marketStall(world, 2, 62, 58, 57),
    marketStall(world, 3, 66, 58, 57),
    marketStall(world, 4, 69, 58, 57),
    marketStall(world, 5, 60, 70, 71),
    marketStall(world, 6, 68, 70, 71),
  ];

  const lamps: Cell[] = [[56, 56], [72, 56], [56, 72], [72, 72], [35, 47], [95, 47], [35, 81], [95, 81]].map(([x, z]) =>
    lampPost(world, x as number, z as number));

  digPond(world, 112, 78, 8, 6);
  // The pier: planks at the waterline, from the west bank out over the pond.
  for (let x = 103; x <= 108; x++) world.setRaw(x, GROUND, 78, B.oak_planks);

  const mine = digMine(world);

  const forest = { x: 28, z: 20, radius: 18 };
  const hunting = { x: 104, z: 106, radius: 16 };
  plantTrees(world, rng, forest.x, forest.z, forest.radius, 7, ['oak', 'oak', 'birch', 'pine']);
  plantTrees(world, rng, hunting.x, hunting.z, hunting.radius, 11, ['oak', 'birch']);

  world.recomputeHeightmap();
  world.trackDirty = true;

  const plan: VillagePlan = {
    name: 'Tidewick',
    center: feet(62, 62),
    buildings,
    fields,
    pens,
    stalls,
    well: feet(66, 64),
    gathering: [feet(61, 62), feet(67, 62), feet(61, 66), feet(67, 66), feet(64, 61), feet(64, 67)],
    dock: [feet(107, 78), feet(108, 78)],
    mine,
    forest,
    pasture: { x: 108, z: 20, radius: 12 },
    hunting,
    lamps,
    patrol: [feet(34, 48), feet(64, 48), feet(94, 48), feet(94, 64), feet(94, 80), feet(64, 80), feet(34, 80), feet(34, 64)],
  };
  return { world, plan };
}
