// Building templates: a timber-framed, stone or brick shell under a gabled
// roof, then the furniture and fittings each trade needs. Everything is written
// in the building's own frame and reported in world cells for the village plan.
//
// Interior conventions (local cells, floor layer at y = 0, room at y = 1..3):
//   left wall, z = 1..3      the trade's work pieces
//   right wall, z = 1 and 2  store chest and hearth (chimney above)
//   back wall                beds, lying along it; a third bed up the right wall
//   the row in front of the beds is always kept clear to stand in

import type { Rng } from '../../../core/rng';
import type { Bed, BuildingKind, Cell, WorkSpot } from '../../../sim/api';
import { B } from '../../blocks';
import { BACK, FRONT, type Frame, LEFT, RIGHT } from './frame';

export interface Style {
  walls: 'timber' | 'stone' | 'brick';
  roof: 'thatch' | 'tile' | 'slate';
}

export interface Parts {
  beds: Bed[];
  work: WorkSpot[];
  seats: Cell[];
  storage: Cell | null;
  lights: Cell[];
}

export interface Spec {
  kind: BuildingKind;
  w: number;
  d: number;
  beds: number;
  style: Style;
  label: string;
}

const T: Style = { walls: 'timber', roof: 'thatch' };
const TT: Style = { walls: 'timber', roof: 'tile' };
const S: Style = { walls: 'stone', roof: 'slate' };

/** What each kind of building is: footprint, beds, look. Every depth is at least 7, which the bed layout relies on. */
export const SPECS: Record<BuildingKind, Spec> = {
  house: { kind: 'house', w: 7, d: 7, beds: 3, style: T, label: 'Cottage' },
  farm: { kind: 'farm', w: 9, d: 7, beds: 3, style: T, label: 'Farmhouse' },
  mill: { kind: 'mill', w: 7, d: 7, beds: 2, style: S, label: 'Mill' },
  bakery: { kind: 'bakery', w: 8, d: 7, beds: 2, style: TT, label: 'Bakery' },
  tavern: { kind: 'tavern', w: 11, d: 9, beds: 2, style: TT, label: 'The Gilded Gull' },
  smithy: { kind: 'smithy', w: 9, d: 7, beds: 2, style: S, label: 'Smithy' },
  carpenter: { kind: 'carpenter', w: 8, d: 7, beds: 2, style: T, label: "Carpenter's shop" },
  weaver: { kind: 'weaver', w: 7, d: 7, beds: 2, style: TT, label: "Weaver's house" },
  store: { kind: 'store', w: 8, d: 7, beds: 2, style: TT, label: 'General store' },
  chapel: { kind: 'chapel', w: 7, d: 11, beds: 1, style: S, label: 'Chapel' },
  hall: { kind: 'hall', w: 10, d: 8, beds: 2, style: S, label: 'Moot hall' },
  fishery: { kind: 'fishery', w: 7, d: 7, beds: 2, style: T, label: "Fisher's hut" },
  hunter: { kind: 'hunter', w: 7, d: 7, beds: 2, style: T, label: "Hunter's lodge" },
  woodcutter: { kind: 'woodcutter', w: 7, d: 7, beds: 3, style: T, label: "Woodcutters' hut" },
  mine: { kind: 'mine', w: 7, d: 7, beds: 3, style: S, label: "Miners' hut" },
  shepherd: { kind: 'shepherd', w: 7, d: 7, beds: 2, style: T, label: "Shepherd's cottage" },
  guardhouse: { kind: 'guardhouse', w: 7, d: 7, beds: 3, style: S, label: 'Watch house' },
};

const ROOFS = {
  thatch: { stairs: B.thatch_stairs, block: B.thatch },
  tile: { stairs: B.tile_stairs, block: B.clay_tiles },
  slate: { stairs: B.slate_stairs, block: B.slate_tiles },
};

/** Wall height in blocks above the floor; the top course is the wall plate. */
export const WALL = 4;

/** The shell: floor, walls with windows and a door, tie beam, gabled roof, chimney. Returns the chimney's mouth. */
export function buildShell(f: Frame, w: number, d: number, style: Style, rng: Rng): Cell {
  const h = WALL;
  const doorX = w >> 1;
  const stone = style.walls !== 'timber';
  const wallBlock = style.walls === 'brick' ? B.bricks : B.stone_bricks;

  // Floor, with a stone sill under the walls.
  for (let lz = 0; lz < d; lz++) {
    for (let lx = 0; lx < w; lx++) {
      const edge = lx === 0 || lz === 0 || lx === w - 1 || lz === d - 1;
      f.set(lx, 0, lz, edge ? B.cobble : stone ? B.pine_planks : B.oak_planks);
    }
  }

  // One column of wall. `along` counts bays along its wall so posts, panels and windows fall in a rhythm.
  const column = (lx: number, lz: number, along: number, len: number, axis: 'x' | 'z'): void => {
    const corner = along === 0 || along === len - 1;
    const doorway = lz === 0 && lx === doorX;
    for (let ly = 1; ly <= h; ly++) {
      if (doorway && ly <= 2) continue;
      const window = !corner && ly === 2 && along % 4 === 2 && !(lz === 0 && Math.abs(lx - doorX) < 2);
      if (window) f.set(lx, ly, lz, B.window);
      else if (stone) f.set(lx, ly, lz, ly === 1 ? B.cobble : !corner && rng.chance(0.07) ? B.mossy_cobble : wallBlock);
      else if (corner) f.set(lx, ly, lz, B.beam);
      else if (ly === 1) f.set(lx, ly, lz, B.cobble);
      else if (ly === h) f.log(lx, ly, lz, B.beam, axis);
      else {
        const bay = along % 4;
        f.set(lx, ly, lz, bay === 0 ? B.beam : ly === 2 && bay === 1 ? B.frame_slash : ly === 2 && bay === 3 ? B.frame_bslash : B.plaster);
      }
    }
  };
  for (let lx = 0; lx < w; lx++) {
    column(lx, 0, lx, w, 'x');
    column(lx, d - 1, lx, w, 'x');
  }
  for (let lz = 1; lz < d - 1; lz++) {
    column(0, lz, lz, d, 'z');
    column(w - 1, lz, lz, d, 'z');
  }
  f.door(doorX, 1, 0, FRONT);

  // A tie beam across the room, front to back: the lanterns hang from it.
  for (let lz = 1; lz < d - 1; lz++) f.log(doorX, h, lz, B.beam, 'z');

  // Gabled roof. The eaves hang a block past the front and back walls, level with the wall plate, and
  // each course steps up and in; the gable walls are closed under the slope.
  const roof = ROOFS[style.roof];
  let ridge = h;
  for (let k = 0; ; k++) {
    const zf = -1 + k;
    const zb = d - k;
    if (zf > zb) break;
    const y = h + k;
    ridge = y;
    for (let lx = -1; lx <= w; lx++) {
      if (zf === zb) f.set(lx, y, zf, roof.block);
      else {
        f.stairs(lx, y, zf, roof.stairs, BACK);
        f.stairs(lx, y, zb, roof.stairs, FRONT);
      }
    }
    if (k > 0) {
      for (let lz = zf + 1; lz < zb; lz++) {
        for (const lx of [0, w - 1]) f.set(lx, y, lz, stone ? wallBlock : lz % 3 === 1 ? B.frame_x : B.plaster);
      }
    }
    if (zf === zb) break;
  }

  // Chimney up the right-hand gable wall, with a stone hearth inside against it.
  const cz = 2;
  const through = h + cz + 1;
  for (let ly = 1; ly <= through + 2; ly++) f.set(w - 1, ly, cz, B.stone_bricks);
  f.set(w - 2, 0, cz, B.cobble);
  return f.cell(w - 1, Math.max(through + 3, ridge + 1), cz);
}

/** Furniture and fittings for a building of this kind; returns the plan's cells for it. */
export function furnish(f: Frame, spec: Spec): Parts {
  const { w, d, kind } = spec;
  const doorX = w >> 1;
  const parts: Parts = { beds: [], work: [], seats: [], storage: null, lights: [] };
  /** Put a work piece at a cell (or none) and record where its worker stands, by default to its right. */
  const work = (name: string, lx: number, lz: number, block: number | null, dx = 1): void => {
    if (block !== null) f.set(lx, 1, lz, block);
    parts.work.push({ kind: name, stand: f.cell(lx + dx, 1, lz), block: block !== null ? f.cell(lx, 1, lz) : null });
  };
  const seat = (lx: number, lz: number): void => {
    f.set(lx, 1, lz, B.stool);
    parts.seats.push(f.cell(lx, 1, lz));
  };
  const light = (lx: number, ly: number, lz: number): void => {
    f.set(lx, ly, lz, B.hanging_lantern);
    parts.lights.push(f.cell(lx, ly, lz));
  };

  // Beds: two lying along the back wall, a third up the right wall.
  const back = d - 2;
  const bedAt = (footX: number, footZ: number, head: number, standX: number, standZ: number): void => {
    parts.beds.push({ stand: f.cell(standX, 1, standZ), block: f.bed(footX, 1, footZ, head) });
  };
  if (spec.beds >= 1) bedAt(1, back, RIGHT, 1, back - 1);
  if (spec.beds >= 2) bedAt(w - 3, back, RIGHT, w - 3, back - 1);
  if (spec.beds >= 3) bedAt(w - 2, back - 2, BACK, w - 3, back - 2);

  // Store chest in the front right corner, hearth beside it under the chimney.
  f.set(w - 2, 1, 1, B.chest);
  parts.storage = f.cell(w - 3, 1, 1);
  if (kind === 'bakery') {
    f.oven(w - 2, 1, 2, LEFT);
    parts.work.push({ kind: 'oven', stand: f.cell(w - 3, 1, 2), block: f.cell(w - 2, 1, 2) });
  } else if (kind === 'smithy') {
    f.set(w - 2, 1, 2, B.forge);
    parts.work.push({ kind: 'forge', stand: f.cell(w - 3, 1, 2), block: f.cell(w - 2, 1, 2) });
  } else {
    f.set(w - 2, 1, 2, B.campfire);
    if (spec.beds > 0 && kind !== 'chapel') work('cauldron', w - 2, 2, null, -1);
  }

  // Light: a lantern over the room, another at the back of a long one, and one under the eave by the door.
  light(doorX, WALL - 1, 3);
  if (d >= 9) light(doorX, WALL - 1, d - 4);
  light(doorX + 1, WALL - 1, -1);

  switch (kind) {
    case 'house':
    case 'shepherd':
    case 'guardhouse':
    case 'farm':
      f.set(1, 1, 1, B.table);
      seat(2, 1);
      seat(1, 2);
      if (kind === 'shepherd') f.set(1, 1, 3, B.hay_bale);
      if (kind === 'farm') work('counter', 1, 3, B.hay_bale);
      break;
    case 'mill':
      work('millstone', 1, 2, B.millstone);
      f.set(1, 1, 1, B.sack);
      f.set(1, 1, 3, B.sack);
      break;
    case 'bakery':
      work('counter', 1, 2, B.table);
      f.set(1, 1, 1, B.sack);
      f.set(1, 1, 3, B.barrel);
      break;
    case 'smithy':
      work('anvil', 1, 2, B.anvil + (f.facing & 1 ? 0 : 1));
      f.set(1, 1, 1, B.trough);
      f.set(1, 1, 3, B.crate);
      break;
    case 'tavern':
      work('vat', 1, 1, B.brew_vat);
      f.set(1, 1, 2, B.brew_vat);
      work('counter', 1, 3, B.table);
      f.set(1, 1, 4, B.barrel);
      // Tables out in the room, each with a stool either side.
      for (const [tx, tz] of [[4, 4], [7, 4], [5, 6]] as const) {
        f.set(tx, 1, tz, B.table);
        seat(tx - 1, tz);
        seat(tx + 1, tz);
      }
      seat(7, 3);
      seat(7, 5);
      break;
    case 'carpenter':
      work('workbench', 1, 1, B.workbench);
      work('woodpile', 1, 2, B.woodpile);
      f.set(1, 1, 3, B.woodpile);
      break;
    case 'weaver':
      work('loom', 1, 1, B.loom);
      work('loom', 1, 3, B.loom);
      f.set(1, 1, 2, B.wool_white);
      break;
    case 'store':
      work('counter', 1, 2, B.table);
      f.set(1, 1, 1, B.crate);
      f.set(1, 1, 3, B.barrel);
      break;
    case 'chapel':
      // Altar toward the back, stools in rows either side of the aisle.
      f.set(doorX, 1, d - 5, B.table);
      parts.work.push({ kind: 'altar', stand: f.cell(doorX, 1, d - 6), block: f.cell(doorX, 1, d - 5) });
      for (const lz of [3, 5]) for (const lx of [1, 2, 4, 5]) seat(lx, lz);
      break;
    case 'hall':
      work('desk', 1, 2, B.table);
      f.set(1, 1, 1, B.bookshelf);
      f.set(1, 1, 3, B.bookshelf);
      f.set(doorX + 1, 1, 4, B.table);
      seat(doorX + 2, 4);
      seat(doorX + 1, 3);
      seat(doorX, 4);
      break;
    case 'fishery':
      work('counter', 1, 2, B.table);
      f.set(1, 1, 1, B.barrel);
      f.set(1, 1, 3, B.barrel);
      break;
    case 'hunter':
      work('workbench', 1, 2, B.workbench);
      f.set(1, 1, 1, B.crate);
      break;
    case 'woodcutter':
      work('woodpile', 1, 1, B.woodpile);
      work('workbench', 1, 3, B.workbench);
      f.set(1, 1, 2, B.woodpile);
      break;
    case 'mine':
      work('counter', 1, 2, B.crate);
      f.set(1, 1, 1, B.crate);
      break;
  }
  return parts;
}
