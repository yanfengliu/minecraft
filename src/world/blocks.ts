// Block state registry. A voxel stores one Uint16 state id; every property the
// engine needs (shape, light, collision, physics material) is a flat lookup by
// that id. Variants of one block (orientation, growth stage, lit/unlit, water
// level) are consecutive ids starting at the family's base id in `B`:
//
//   logs, beams      base + axis            (0 = y, 1 = x, 2 = z)
//   stairs           base + facing          (0 = N(-z), 1 = E(+x), 2 = S(+z), 3 = W(-x); the tall half is on that side)
//   slabs            base + (top ? 1 : 0)
//   doors            base + facing * 4 + (upper ? 2 : 0) + (open ? 1 : 0)
//   gates            base + axis * 2 + (open ? 1 : 0)   (axis 0 = spans x, 1 = spans z)
//   beds             base + facing * 2 + (head ? 1 : 0) (the head end points at `facing`)
//   wall torches, ladders, ovens   base + facing (+ lit for ovens: base + facing * 2 + lit)
//   crops            base + stage           (0..3, 3 = ripe)
//   lit fittings     base + (lit ? 1 : 0)
//   finite water     B.water + level - 1    (level 1..16 sixteenths of a block)
//   river            B.river + dir          (8 compass directions, 0 = +x, counter-clockwise toward -z)
//
// This module is headless and worker-safe: no DOM, no renderer imports.

import { tileIndex, type TileName } from './tiles';

// ---------------------------------------------------------------------------
// Enumerations (plain numbers so they index typed arrays)
// ---------------------------------------------------------------------------

export const SHAPE_NONE = 0;
export const SHAPE_CUBE = 1;
export const SHAPE_CROSS = 2;
export const SHAPE_BOXES = 3;
export const SHAPE_LIQUID = 4;
/** Fences and walls: a centre post plus arms toward connecting neighbours, built by the mesher. */
export const SHAPE_CONNECT = 5;
/** Crops: four upright quads in a # pattern. */
export const SHAPE_CROP = 6;

export const LAYER_OPAQUE = 0;
export const LAYER_CUTOUT = 1;
export const LAYER_TRANSLUCENT = 2;

/** Face order used everywhere: +x, -x, +y, -y, +z, -z. */
export const FACE_PX = 0;
export const FACE_NX = 1;
export const FACE_PY = 2;
export const FACE_NY = 3;
export const FACE_PZ = 4;
export const FACE_NZ = 5;
export const FACE_DIRS: readonly (readonly [number, number, number])[] = [
  [1, 0, 0], [-1, 0, 0], [0, 1, 0], [0, -1, 0], [0, 0, 1], [0, 0, -1],
];

export const FACING_N = 0;
export const FACING_E = 1;
export const FACING_S = 2;
export const FACING_W = 3;
/** Unit step for each facing, as [dx, dz]. */
export const FACING_STEP: readonly (readonly [number, number])[] = [[0, -1], [1, 0], [0, 1], [-1, 0]];

export const TINT_NONE = 0;
export const TINT_GRASS = 1;
export const TINT_FOLIAGE = 2;
export const TINT_BIRCH = 3;

export const WIND_NONE = 0;
export const WIND_LEAVES = 1;
export const WIND_PLANT = 2;
export const WIND_CROP = 3;

export const MAT = {
  air: 0, stone: 1, earth: 2, sand: 3, gravel: 4, wood: 5, leaves: 6, plant: 7, cloth: 8,
  glass: 9, metal: 10, thatch: 11, brick: 12, water: 13, snow: 14, clay: 15,
} as const;

export interface Material {
  name: string;
  /** kg per cubic metre; one block is one cubic metre. Drives rigid-body mass and buoyancy. */
  density: number;
  friction: number;
  restitution: number;
  /** How many blocks this material can cantilever sideways from a supported block before it fails. */
  span: number;
  /** Default seconds to break by hand. */
  hardness: number;
}

export const MATERIALS: readonly Material[] = [
  { name: 'air', density: 0, friction: 0, restitution: 0, span: 0, hardness: 0 },
  { name: 'stone', density: 2600, friction: 0.7, restitution: 0.1, span: 5, hardness: 1.5 },
  { name: 'earth', density: 1500, friction: 0.8, restitution: 0.02, span: 2, hardness: 0.5 },
  { name: 'sand', density: 1600, friction: 0.6, restitution: 0.0, span: 0, hardness: 0.4 },
  { name: 'gravel', density: 1700, friction: 0.7, restitution: 0.02, span: 0, hardness: 0.5 },
  { name: 'wood', density: 650, friction: 0.6, restitution: 0.15, span: 6, hardness: 1.0 },
  { name: 'leaves', density: 120, friction: 0.5, restitution: 0.0, span: 4, hardness: 0.2 },
  { name: 'plant', density: 80, friction: 0.5, restitution: 0.0, span: 0, hardness: 0.05 },
  { name: 'cloth', density: 300, friction: 0.8, restitution: 0.0, span: 3, hardness: 0.4 },
  { name: 'glass', density: 2500, friction: 0.4, restitution: 0.05, span: 2, hardness: 0.3 },
  { name: 'metal', density: 7800, friction: 0.5, restitution: 0.2, span: 8, hardness: 2.5 },
  { name: 'thatch', density: 220, friction: 0.9, restitution: 0.0, span: 3, hardness: 0.4 },
  { name: 'brick', density: 1900, friction: 0.7, restitution: 0.08, span: 4, hardness: 1.6 },
  { name: 'water', density: 1000, friction: 0, restitution: 0, span: 0, hardness: 0 },
  { name: 'snow', density: 300, friction: 0.3, restitution: 0.0, span: 1, hardness: 0.2 },
  { name: 'clay', density: 1750, friction: 0.8, restitution: 0.02, span: 2, hardness: 0.6 },
];

// ---------------------------------------------------------------------------
// State records
// ---------------------------------------------------------------------------

/** An axis-aligned box in sixteenths of a block, with optional per-face tiles. */
export interface Box {
  x0: number; y0: number; z0: number;
  x1: number; y1: number; z1: number;
  tiles?: readonly number[];
}

export interface BlockState {
  id: number;
  name: string;
  /** Shared by all variants of one block; also the name of the item that places it, if any. */
  family: string;
  variant: number;
  shape: number;
  layer: number;
  /** Tile index per face, in face order. */
  tiles: readonly number[];
  /** Bitmask per face: rotate that face's texture a quarter turn. */
  uvRot: number;
  boxes: readonly Box[];
  collision: readonly Box[];
  material: number;
  hardness: number;
  solid: boolean;
  opaque: boolean;
  lightOpacity: number;
  emit: number;
  replaceable: boolean;
  loose: boolean;
  natural: boolean;
  tint: number;
  wind: number;
  /** 0 = cannot stand on it; otherwise the path-cost multiplier for walking across its top. */
  walkCost: number;
  /** Item name dropped when broken, or null. */
  drop: string | null;
  /** True when an item of the family name places this block. */
  placeable: boolean;
  climbable: boolean;
  /** Water amount in sixteenths (0 for non-water; 16 for full and for sources). */
  waterLevel: number;
  /** Infinite water: sea, lake and river cells. */
  waterSource: boolean;
  /** Connect group for SHAPE_CONNECT blocks (fences join fences and gates, walls join walls). */
  connect: number;
}

interface Def {
  shape?: number;
  layer?: number;
  tiles?: readonly number[];
  uvRot?: number;
  boxes?: readonly Box[];
  /** 'full' | 'none' | 'boxes' (use render boxes) or explicit boxes. */
  collision?: 'full' | 'none' | 'boxes' | readonly Box[];
  mat: number;
  hardness?: number;
  opaque?: boolean;
  lightOpacity?: number;
  emit?: number;
  replaceable?: boolean;
  loose?: boolean;
  natural?: boolean;
  tint?: number;
  wind?: number;
  walkCost?: number;
  drop?: string | null;
  placeable?: boolean;
  climbable?: boolean;
  waterLevel?: number;
  waterSource?: boolean;
  connect?: number;
}

const FULL_BOX: Box = { x0: 0, y0: 0, z0: 0, x1: 16, y1: 16, z1: 16 };
const states: BlockState[] = [];
const families = new Map<string, number>();

function register(family: string, variant: number, d: Def): number {
  const id = states.length;
  const shape = d.shape ?? SHAPE_CUBE;
  const layer = d.layer ?? LAYER_OPAQUE;
  const opaque = d.opaque ?? (shape === SHAPE_CUBE && layer === LAYER_OPAQUE);
  const boxes = d.boxes ?? (shape === SHAPE_CUBE ? [FULL_BOX] : []);
  let collision: readonly Box[];
  const c = d.collision ?? (shape === SHAPE_CUBE ? 'full' : shape === SHAPE_BOXES ? 'boxes' : 'none');
  if (c === 'full') collision = [FULL_BOX];
  else if (c === 'none') collision = [];
  else if (c === 'boxes') collision = boxes;
  else collision = c;
  const solid = collision.length > 0;
  const mat = MATERIALS[d.mat] as Material;
  if (!families.has(family)) families.set(family, id);
  states.push({
    id,
    name: variant === 0 ? family : `${family}#${variant}`,
    family,
    variant,
    shape,
    layer,
    tiles: d.tiles ?? [0, 0, 0, 0, 0, 0],
    uvRot: d.uvRot ?? 0,
    boxes,
    collision,
    material: d.mat,
    hardness: d.hardness ?? mat.hardness,
    solid,
    opaque,
    lightOpacity: d.lightOpacity ?? (opaque ? 15 : 0),
    emit: d.emit ?? 0,
    replaceable: d.replaceable ?? false,
    loose: d.loose ?? false,
    natural: d.natural ?? false,
    tint: d.tint ?? TINT_NONE,
    wind: d.wind ?? WIND_NONE,
    walkCost: d.walkCost ?? (solid && shape !== SHAPE_CONNECT ? 1.3 : 0),
    drop: d.drop === undefined ? family : d.drop,
    placeable: d.placeable ?? true,
    climbable: d.climbable ?? false,
    waterLevel: d.waterLevel ?? 0,
    waterSource: d.waterSource ?? false,
    connect: d.connect ?? 0,
  });
  return id;
}

// --- tile helpers -----------------------------------------------------------

const T = tileIndex;
const all = (t: TileName): number[] => { const i = T(t); return [i, i, i, i, i, i]; };
const tbs = (top: TileName, bottom: TileName, side: TileName): number[] => {
  const s = T(side);
  return [s, s, T(top), T(bottom), s, s];
};
const box = (x0: number, y0: number, z0: number, x1: number, y1: number, z1: number, tiles?: readonly number[]): Box =>
  tiles ? { x0, y0, z0, x1, y1, z1, tiles } : { x0, y0, z0, x1, y1, z1 };

/** Rotate boxes clockwise (seen from above) by quarter turns: north -> east -> south -> west. */
export function rotateBoxes(boxes: readonly Box[], turns: number): Box[] {
  let out = boxes.map((b) => ({ ...b }));
  for (let t = 0; t < (turns & 3); t++) {
    out = out.map((b) => {
      const r: Box = { x0: 16 - b.z1, y0: b.y0, z0: b.x0, x1: 16 - b.z0, y1: b.y1, z1: b.x1 };
      if (b.tiles) {
        const o = b.tiles;
        // E <- N, W <- S, S <- E, N <- W
        r.tiles = [o[5] as number, o[4] as number, o[2] as number, o[3] as number, o[0] as number, o[1] as number];
      }
      return r;
    });
  }
  return out;
}

function rotateTiles(tiles: readonly number[], turns: number): number[] {
  let o = tiles.slice();
  for (let t = 0; t < (turns & 3); t++) o = [o[5] as number, o[4] as number, o[2] as number, o[3] as number, o[0] as number, o[1] as number];
  return o;
}

// --- family constructors ----------------------------------------------------

function cube(name: string, tiles: number[], mat: number, extra: Partial<Def> = {}): number {
  return register(name, 0, { tiles, mat, ...extra });
}

function log(name: string, side: TileName, end: TileName, extra: Partial<Def> = {}): number {
  const s = T(side);
  const e = T(end);
  const base = register(name, 0, { tiles: [s, s, e, e, s, s], mat: MAT.wood, ...extra });
  register(name, 1, { tiles: [e, e, s, s, s, s], uvRot: 0b111100, mat: MAT.wood, ...extra });
  register(name, 2, { tiles: [s, s, s, s, e, e], uvRot: 0b000011, mat: MAT.wood, ...extra });
  return base;
}

function stairs(name: string, tile: TileName, mat: number): number {
  const tiles = all(tile);
  const north = [box(0, 0, 0, 16, 8, 16), box(0, 8, 0, 16, 16, 8)];
  let base = -1;
  for (let f = 0; f < 4; f++) {
    const id = register(name, f, { shape: SHAPE_BOXES, tiles, boxes: rotateBoxes(north, f), mat, lightOpacity: 15, walkCost: 1.0 });
    if (f === 0) base = id;
  }
  return base;
}

function slab(name: string, tile: TileName, mat: number): number {
  const tiles = all(tile);
  const base = register(name, 0, { shape: SHAPE_BOXES, tiles, boxes: [box(0, 0, 0, 16, 8, 16)], mat, lightOpacity: 15, walkCost: 1.0 });
  register(name, 1, { shape: SHAPE_BOXES, tiles, boxes: [box(0, 8, 0, 16, 16, 16)], mat, lightOpacity: 15, walkCost: 1.0 });
  return base;
}

function plant(name: string, tile: TileName, extra: Partial<Def> = {}): number {
  return register(name, 0, {
    shape: SHAPE_CROSS, layer: LAYER_CUTOUT, tiles: all(tile), mat: MAT.plant, replaceable: true, natural: true,
    wind: WIND_PLANT, drop: null, ...extra,
  });
}

function crop(name: string, tilePrefix: 'wheat' | 'barley' | 'turnip' | 'cabbage', product: string): number {
  let base = -1;
  for (let stage = 0; stage < 4; stage++) {
    const id = register(name, stage, {
      shape: SHAPE_CROP, layer: LAYER_CUTOUT, tiles: all(`${tilePrefix}_${stage}` as TileName), mat: MAT.plant,
      wind: WIND_CROP, drop: stage === 3 ? product : null, placeable: false,
    });
    if (stage === 0) base = id;
  }
  return base;
}

function litPair(name: string, off: Def, on: Def): number {
  const base = register(name, 0, off);
  register(name, 1, { drop: name, ...on });
  return base;
}

function facing4(name: string, make: (f: number) => Def): number {
  let base = -1;
  for (let f = 0; f < 4; f++) {
    const id = register(name, f, make(f));
    if (f === 0) base = id;
  }
  return base;
}

// ---------------------------------------------------------------------------
// The block table. Property order is id order; `air` must stay first (id 0).
// ---------------------------------------------------------------------------

const planks = { oak: T('oak_planks'), pine: T('pine_planks'), birch: T('birch_planks') };
const doorTiles = (upper: boolean): number[] => {
  const t = T(upper ? 'door_upper' : 'door_lower');
  const edge = planks.oak;
  return [t, t, edge, edge, t, t];
};
const CONNECT_FENCE = 1;
const CONNECT_WALL = 2;

export const B = {
  air: register('air', 0, { shape: SHAPE_NONE, mat: MAT.air, replaceable: true, drop: null, placeable: false }),

  // --- terrain ---
  bedrock: cube('bedrock', all('bedrock'), MAT.stone, { natural: true, hardness: Infinity, drop: null, placeable: false }),
  stone: cube('stone', all('stone'), MAT.stone, { natural: true }),
  granite: cube('granite', all('granite'), MAT.stone, { natural: true, hardness: 1.8 }),
  cobble: cube('cobble', all('cobble'), MAT.stone, { walkCost: 1.0 }),
  mossy_cobble: cube('mossy_cobble', all('mossy_cobble'), MAT.stone, { walkCost: 1.0 }),
  gravel: cube('gravel', all('gravel'), MAT.gravel, { natural: true, loose: true, walkCost: 1.1 }),
  sand: cube('sand', all('sand'), MAT.sand, { natural: true, loose: true, walkCost: 1.6 }),
  clay: cube('clay', all('clay'), MAT.clay, { natural: true }),
  dirt: cube('dirt', all('dirt'), MAT.earth, { natural: true }),
  grass: cube('grass', tbs('grass_top', 'dirt', 'grass_side'), MAT.earth, { natural: true, tint: TINT_GRASS, drop: 'dirt' }),
  forest_floor: cube('forest_floor', tbs('forest_floor', 'dirt', 'forest_side'), MAT.earth, { natural: true, drop: 'dirt' }),
  snow: cube('snow', all('snow'), MAT.snow, { natural: true, loose: true }),
  coal_ore: cube('coal_ore', all('coal_ore'), MAT.stone, { natural: true, hardness: 2.0, drop: 'coal' }),
  iron_ore: cube('iron_ore', all('iron_ore'), MAT.stone, { natural: true, hardness: 2.4 }),
  path: register('path', 0, {
    shape: SHAPE_BOXES, tiles: tbs('path_top', 'dirt', 'dirt'), boxes: [box(0, 0, 0, 16, 15, 16)], mat: MAT.earth,
    lightOpacity: 15, walkCost: 0.8, drop: 'dirt', natural: true,
  }),
  farmland: litPair('farmland',
    { shape: SHAPE_BOXES, tiles: tbs('farmland_dry', 'dirt', 'dirt'), boxes: [box(0, 0, 0, 16, 15, 16)], mat: MAT.earth, lightOpacity: 15, walkCost: 4, drop: 'dirt', natural: true, placeable: false },
    { shape: SHAPE_BOXES, tiles: tbs('farmland_wet', 'dirt', 'dirt'), boxes: [box(0, 0, 0, 16, 15, 16)], mat: MAT.earth, lightOpacity: 15, walkCost: 4, drop: 'dirt', natural: true, placeable: false }),

  // --- water ---
  /** Infinite still water: the sea and lakes. */
  water_source: register('water_source', 0, {
    shape: SHAPE_LIQUID, layer: LAYER_TRANSLUCENT, mat: MAT.water, replaceable: true, lightOpacity: 2, drop: null,
    placeable: false, waterLevel: 16, waterSource: true, natural: true,
  }),
  /** Infinite flowing water with a baked direction: river channels. Eight variants. */
  river: (() => {
    let base = -1;
    for (let d = 0; d < 8; d++) {
      const id = register('river', d, {
        shape: SHAPE_LIQUID, layer: LAYER_TRANSLUCENT, mat: MAT.water, replaceable: true, lightOpacity: 2, drop: null,
        placeable: false, waterLevel: 16, waterSource: true, natural: true,
      });
      if (d === 0) base = id;
    }
    return base;
  })(),
  /** Finite, mass-conserving water: sixteen variants, level 1..16 sixteenths. */
  water: (() => {
    let base = -1;
    for (let level = 1; level <= 16; level++) {
      const id = register('water', level - 1, {
        shape: SHAPE_LIQUID, layer: LAYER_TRANSLUCENT, mat: MAT.water, replaceable: true, lightOpacity: 2, drop: null,
        placeable: false, waterLevel: level,
      });
      if (level === 1) base = id;
    }
    return base;
  })(),

  // --- wood ---
  oak_log: log('oak_log', 'oak_log', 'oak_log_top'),
  birch_log: log('birch_log', 'birch_log', 'birch_log_top'),
  pine_log: log('pine_log', 'pine_log', 'pine_log_top'),
  beam: log('beam', 'beam', 'beam_top'),
  oak_planks: cube('oak_planks', all('oak_planks'), MAT.wood, { walkCost: 1.0 }),
  birch_planks: cube('birch_planks', all('birch_planks'), MAT.wood, { walkCost: 1.0 }),
  pine_planks: cube('pine_planks', all('pine_planks'), MAT.wood, { walkCost: 1.0 }),
  oak_leaves: cube('oak_leaves', all('oak_leaves'), MAT.leaves, { layer: LAYER_CUTOUT, opaque: false, lightOpacity: 1, tint: TINT_FOLIAGE, wind: WIND_LEAVES, drop: null, walkCost: 0 }),
  birch_leaves: cube('birch_leaves', all('birch_leaves'), MAT.leaves, { layer: LAYER_CUTOUT, opaque: false, lightOpacity: 1, tint: TINT_BIRCH, wind: WIND_LEAVES, drop: null, walkCost: 0 }),
  pine_leaves: cube('pine_leaves', all('pine_leaves'), MAT.leaves, { layer: LAYER_CUTOUT, opaque: false, lightOpacity: 1, wind: WIND_LEAVES, drop: null, walkCost: 0 }),

  // --- plants ---
  tall_grass: plant('tall_grass', 'tall_grass', { tint: TINT_GRASS }),
  fern: plant('fern', 'fern', { tint: TINT_GRASS }),
  poppy: plant('poppy', 'poppy', { drop: 'poppy' }),
  daisy: plant('daisy', 'daisy', { drop: 'daisy' }),
  bluebell: plant('bluebell', 'bluebell', { drop: 'bluebell' }),
  buttercup: plant('buttercup', 'buttercup', { drop: 'buttercup' }),
  heather: plant('heather', 'heather'),
  mushroom_brown: plant('mushroom_brown', 'mushroom_brown', { wind: WIND_NONE, drop: 'mushroom' }),
  mushroom_red: plant('mushroom_red', 'mushroom_red', { wind: WIND_NONE }),
  reeds: plant('reeds', 'reeds'),
  /** Grows under water: the cell counts as source water for light, swimming and the fluid model. */
  seagrass: plant('seagrass', 'seagrass', { waterLevel: 16, waterSource: true, lightOpacity: 2, placeable: false }),
  berry_bush: litPair('berry_bush',
    { shape: SHAPE_CROSS, layer: LAYER_CUTOUT, tiles: all('berry_bush'), mat: MAT.plant, natural: true, wind: WIND_PLANT, collision: 'none' },
    { shape: SHAPE_CROSS, layer: LAYER_CUTOUT, tiles: all('berry_bush_ripe'), mat: MAT.plant, natural: true, wind: WIND_PLANT, collision: 'none' }),
  oak_sapling: plant('oak_sapling', 'sapling_oak', { drop: 'oak_sapling' }),
  birch_sapling: plant('birch_sapling', 'sapling_birch', { drop: 'birch_sapling' }),
  pine_sapling: plant('pine_sapling', 'sapling_pine', { drop: 'pine_sapling' }),
  lily_pad: register('lily_pad', 0, {
    shape: SHAPE_BOXES, layer: LAYER_CUTOUT, tiles: all('lily_pad'), boxes: [box(1, 0, 1, 15, 1, 15)], collision: 'none',
    mat: MAT.plant, natural: true, drop: null,
  }),
  wheat: crop('wheat', 'wheat', 'wheat'),
  barley: crop('barley', 'barley', 'barley'),
  turnip: crop('turnip', 'turnip', 'turnip'),
  cabbage: crop('cabbage', 'cabbage', 'cabbage'),

  // --- masonry, walls, roofs ---
  stone_bricks: cube('stone_bricks', all('stone_bricks'), MAT.stone, { walkCost: 1.0 }),
  bricks: cube('bricks', all('bricks'), MAT.brick, { walkCost: 1.0 }),
  plaster: cube('plaster', all('plaster'), MAT.clay),
  frame_box: cube('frame_box', tbs('beam_top', 'beam_top', 'frame_box'), MAT.wood),
  frame_x: cube('frame_x', tbs('beam_top', 'beam_top', 'frame_x'), MAT.wood),
  frame_slash: cube('frame_slash', tbs('beam_top', 'beam_top', 'frame_slash'), MAT.wood),
  frame_bslash: cube('frame_bslash', tbs('beam_top', 'beam_top', 'frame_bslash'), MAT.wood),
  thatch: cube('thatch', all('thatch'), MAT.thatch),
  clay_tiles: cube('clay_tiles', all('clay_tiles'), MAT.brick),
  slate_tiles: cube('slate_tiles', all('slate_tiles'), MAT.stone),
  window: cube('window', all('glass'), MAT.glass, { layer: LAYER_TRANSLUCENT, opaque: false, lightOpacity: 0 }),
  hay_bale: cube('hay_bale', tbs('hay_top', 'hay_top', 'hay_side'), MAT.thatch),
  wool_white: cube('wool_white', all('wool_white'), MAT.cloth),
  wool_red: cube('wool_red', all('wool_red'), MAT.cloth),
  wool_blue: cube('wool_blue', all('wool_blue'), MAT.cloth),
  wool_yellow: cube('wool_yellow', all('wool_yellow'), MAT.cloth),
  wool_green: cube('wool_green', all('wool_green'), MAT.cloth),
  awning_red: cube('awning_red', all('stripe_red'), MAT.cloth),
  awning_blue: cube('awning_blue', all('stripe_blue'), MAT.cloth),

  oak_stairs: stairs('oak_stairs', 'oak_planks', MAT.wood),
  pine_stairs: stairs('pine_stairs', 'pine_planks', MAT.wood),
  cobble_stairs: stairs('cobble_stairs', 'cobble', MAT.stone),
  brick_stairs: stairs('brick_stairs', 'stone_bricks', MAT.stone),
  thatch_stairs: stairs('thatch_stairs', 'thatch', MAT.thatch),
  tile_stairs: stairs('tile_stairs', 'clay_tiles', MAT.brick),
  slate_stairs: stairs('slate_stairs', 'slate_tiles', MAT.stone),
  oak_slab: slab('oak_slab', 'oak_planks', MAT.wood),
  pine_slab: slab('pine_slab', 'pine_planks', MAT.wood),
  cobble_slab: slab('cobble_slab', 'cobble', MAT.stone),
  brick_slab: slab('brick_slab', 'stone_bricks', MAT.stone),
  thatch_slab: slab('thatch_slab', 'thatch', MAT.thatch),
  tile_slab: slab('tile_slab', 'clay_tiles', MAT.brick),
  slate_slab: slab('slate_slab', 'slate_tiles', MAT.stone),

  // --- fittings ---
  fence: register('fence', 0, {
    shape: SHAPE_CONNECT, tiles: all('oak_planks'), boxes: [box(6, 0, 6, 10, 16, 10)],
    collision: [box(6, 0, 6, 10, 24, 10)], mat: MAT.wood, connect: CONNECT_FENCE,
  }),
  stone_wall: register('stone_wall', 0, {
    shape: SHAPE_CONNECT, tiles: all('cobble'), boxes: [box(4, 0, 4, 12, 16, 12)],
    collision: [box(4, 0, 4, 12, 24, 12)], mat: MAT.stone, connect: CONNECT_WALL,
  }),
  gate: (() => {
    const tiles = all('oak_planks');
    let base = -1;
    for (let axis = 0; axis < 2; axis++) {
      const closed = [box(0, 5, 7, 2, 16, 9), box(14, 5, 7, 16, 16, 9), box(2, 6, 7, 14, 9, 9), box(2, 12, 7, 14, 15, 9)];
      const open = [box(0, 5, 7, 2, 16, 9), box(14, 5, 7, 16, 16, 9), box(0, 6, 9, 2, 9, 16), box(0, 12, 9, 2, 15, 16), box(14, 6, 9, 16, 9, 16), box(14, 12, 9, 16, 15, 16)];
      // Like the fence it hangs in, a shut gate is not something to stand on: an animal that could step up onto
      // it would walk out of its pen.
      const c = register('gate', axis * 2, {
        shape: SHAPE_BOXES, tiles, boxes: rotateBoxes(closed, axis), collision: rotateBoxes([box(0, 0, 6, 16, 24, 10)], axis),
        mat: MAT.wood, connect: CONNECT_FENCE, walkCost: 0,
      });
      register('gate', axis * 2 + 1, {
        shape: SHAPE_BOXES, tiles, boxes: rotateBoxes(open, axis), collision: 'none', mat: MAT.wood, connect: CONNECT_FENCE, drop: 'gate',
      });
      if (axis === 0) base = c;
    }
    return base;
  })(),
  door: (() => {
    // Closed door slab for facing N sits on the north edge; an open door swings a quarter turn.
    const slabFor = (f: number): Box[] => rotateBoxes([box(0, 0, 0, 16, 16, 3)], f);
    let base = -1;
    for (let f = 0; f < 4; f++) {
      for (let upper = 0; upper < 2; upper++) {
        for (let open = 0; open < 2; open++) {
          const boxes = slabFor(open ? (f + 3) & 3 : f);
          const id = register('door', f * 4 + upper * 2 + open, {
            shape: SHAPE_BOXES, layer: LAYER_CUTOUT, tiles: doorTiles(upper === 1), boxes, mat: MAT.wood,
            drop: upper ? null : 'door', walkCost: 0,
          });
          if (base < 0) base = id;
        }
      }
    }
    return base;
  })(),
  ladder: facing4('ladder', (f) => ({
    shape: SHAPE_BOXES, layer: LAYER_CUTOUT, tiles: all('ladder'), boxes: rotateBoxes([box(0, 0, 0, 16, 16, 1)], f),
    collision: 'none', mat: MAT.wood, climbable: true, drop: 'ladder',
  })),
  torch: register('torch', 0, {
    shape: SHAPE_BOXES, layer: LAYER_CUTOUT, tiles: all('torch_stick'),
    boxes: [box(7, 0, 7, 9, 10, 9), box(6, 10, 6, 10, 13, 10, all('flame'))], collision: 'none', mat: MAT.wood, emit: 14,
  }),
  wall_torch: facing4('wall_torch', (f) => ({
    shape: SHAPE_BOXES, layer: LAYER_CUTOUT, tiles: all('torch_stick'),
    // facing N: mounted on the block to the south, pointing north.
    boxes: rotateBoxes([box(7, 3, 12, 9, 12, 14), box(6, 12, 11, 10, 15, 15, all('flame'))], f),
    collision: 'none', mat: MAT.wood, emit: 14, drop: 'torch',
  })),
  lantern: litPair('lantern',
    { shape: SHAPE_BOXES, layer: LAYER_CUTOUT, tiles: all('lantern_frame'), boxes: [box(5, 0, 5, 11, 1, 11), box(6, 1, 6, 10, 8, 10, all('lantern_off')), box(5, 8, 5, 11, 9, 11), box(7, 9, 7, 9, 11, 9)], collision: [box(5, 0, 5, 11, 9, 11)], mat: MAT.metal, hardness: 0.4, walkCost: 0 },
    { shape: SHAPE_BOXES, layer: LAYER_CUTOUT, tiles: all('lantern_frame'), boxes: [box(5, 0, 5, 11, 1, 11), box(6, 1, 6, 10, 8, 10, all('lantern_glow')), box(5, 8, 5, 11, 9, 11), box(7, 9, 7, 9, 11, 9)], collision: [box(5, 0, 5, 11, 9, 11)], mat: MAT.metal, hardness: 0.4, emit: 13, walkCost: 0 }),
  hanging_lantern: litPair('hanging_lantern',
    { shape: SHAPE_BOXES, layer: LAYER_CUTOUT, tiles: all('lantern_frame'), boxes: [box(6, 5, 6, 10, 12, 10, all('lantern_off')), box(5, 12, 5, 11, 13, 11), box(5, 4, 5, 11, 5, 11), box(7, 13, 7, 9, 16, 9)], collision: 'none', mat: MAT.metal, hardness: 0.4 },
    { shape: SHAPE_BOXES, layer: LAYER_CUTOUT, tiles: all('lantern_frame'), boxes: [box(6, 5, 6, 10, 12, 10, all('lantern_glow')), box(5, 12, 5, 11, 13, 11), box(5, 4, 5, 11, 5, 11), box(7, 13, 7, 9, 16, 9)], collision: 'none', mat: MAT.metal, hardness: 0.4, emit: 13 }),
  campfire: litPair('campfire',
    { shape: SHAPE_BOXES, layer: LAYER_CUTOUT, tiles: all('charred_log'), boxes: [box(1, 0, 5, 15, 3, 8), box(1, 0, 9, 15, 3, 12), box(5, 2, 1, 8, 5, 15), box(9, 2, 1, 12, 5, 15)], collision: [box(1, 0, 1, 15, 5, 15)], mat: MAT.wood, hardness: 0.6, walkCost: 0 },
    { shape: SHAPE_BOXES, layer: LAYER_CUTOUT, tiles: all('charred_log'), boxes: [box(1, 0, 5, 15, 3, 8), box(1, 0, 9, 15, 3, 12), box(5, 2, 1, 8, 5, 15), box(9, 2, 1, 12, 5, 15), box(5, 5, 5, 11, 13, 11, all('flame'))], collision: [box(1, 0, 1, 15, 5, 15)], mat: MAT.wood, hardness: 0.6, emit: 15, walkCost: 0 }),

  // --- furniture and workstations ---
  table: register('table', 0, {
    shape: SHAPE_BOXES, tiles: all('oak_planks'),
    boxes: [box(0, 13, 0, 16, 16, 16), box(1, 0, 1, 3, 13, 3), box(13, 0, 1, 15, 13, 3), box(1, 0, 13, 3, 13, 15), box(13, 0, 13, 15, 13, 15)],
    collision: [box(0, 0, 0, 16, 16, 16)], mat: MAT.wood, walkCost: 0,
  }),
  stool: register('stool', 0, {
    shape: SHAPE_BOXES, tiles: all('pine_planks'),
    boxes: [box(3, 6, 3, 13, 8, 13), box(4, 0, 4, 6, 6, 6), box(10, 0, 4, 12, 6, 6), box(4, 0, 10, 6, 6, 12), box(10, 0, 10, 12, 6, 12)],
    // Walkable on purpose: a stool is a low step, which is how someone comes to be sitting on it.
    collision: [box(3, 0, 3, 13, 8, 13)], mat: MAT.wood, walkCost: 2.5,
  }),
  bed: (() => {
    let base = -1;
    for (let f = 0; f < 4; f++) {
      for (let head = 0; head < 2; head++) {
        const top = T(head ? 'bed_head' : 'bed_foot');
        const side = T('bed_side');
        const tiles = [side, side, top, planks.oak, side, side];
        const boxes = head
          ? [box(0, 3, 0, 16, 9, 16), box(0, 0, 0, 16, 3, 2), box(0, 9, 0, 16, 14, 2, [planks.oak, planks.oak, planks.oak, planks.oak, planks.oak, planks.oak])]
          : [box(0, 3, 0, 16, 9, 16), box(0, 0, 14, 16, 3, 16)];
        const id = register('bed', f * 2 + head, {
          shape: SHAPE_BOXES, tiles: rotateTiles(tiles, f), boxes: rotateBoxes(boxes, f), collision: [box(0, 0, 0, 16, 9, 16)],
          mat: MAT.cloth, hardness: 0.5, drop: head ? null : 'bed', walkCost: 0,
        });
        if (base < 0) base = id;
      }
    }
    return base;
  })(),
  chest: register('chest', 0, {
    shape: SHAPE_BOXES, tiles: tbs('chest_top', 'chest_top', 'chest_side'), boxes: [box(1, 0, 1, 15, 14, 15)], mat: MAT.wood, walkCost: 0,
  }),
  barrel: cube('barrel', tbs('barrel_top', 'barrel_top', 'barrel_side'), MAT.wood, { walkCost: 0 }),
  crate: cube('crate', all('crate'), MAT.wood, { walkCost: 0 }),
  bookshelf: cube('bookshelf', tbs('oak_planks', 'oak_planks', 'bookshelf'), MAT.wood, { walkCost: 0 }),
  woodpile: cube('woodpile', [T('woodpile_end'), T('woodpile_end'), T('woodpile_side'), T('woodpile_side'), T('woodpile_side'), T('woodpile_side')], MAT.wood, { walkCost: 0 }),
  sack: register('sack', 0, { shape: SHAPE_BOXES, tiles: all('sack'), boxes: [box(3, 0, 3, 13, 11, 13)], mat: MAT.cloth, walkCost: 0 }),
  oven: (() => {
    let base = -1;
    for (let f = 0; f < 4; f++) {
      for (let lit = 0; lit < 2; lit++) {
        const sb = T('stone_bricks');
        // The mouth of the oven is on the `facing` side.
        const tiles = rotateTiles([sb, sb, sb, sb, sb, T(lit ? 'oven_front_lit' : 'oven_front')], f);
        const id = register('oven', f * 2 + lit, { tiles, mat: MAT.stone, emit: lit ? 9 : 0, drop: 'oven', walkCost: 0 });
        if (base < 0) base = id;
      }
    }
    return base;
  })(),
  forge: litPair('forge',
    { tiles: tbs('coals', 'stone_bricks', 'forge_side'), mat: MAT.stone, walkCost: 0 },
    { tiles: tbs('coals_lit', 'stone_bricks', 'forge_side'), mat: MAT.stone, emit: 12, walkCost: 0 }),
  anvil: (() => {
    const boxes = [box(2, 0, 3, 14, 4, 13), box(5, 4, 5, 11, 10, 11), box(0, 10, 3, 16, 16, 13)];
    const base = register('anvil', 0, { shape: SHAPE_BOXES, tiles: all('iron_dark'), boxes, mat: MAT.metal, walkCost: 0 });
    register('anvil', 1, { shape: SHAPE_BOXES, tiles: all('iron_dark'), boxes: rotateBoxes(boxes, 1), mat: MAT.metal, drop: 'anvil', walkCost: 0 });
    return base;
  })(),
  loom: register('loom', 0, {
    shape: SHAPE_BOXES, tiles: all('pine_planks'),
    boxes: [box(0, 0, 6, 2, 16, 10), box(14, 0, 6, 16, 16, 10), box(0, 14, 6, 16, 16, 10), box(2, 3, 7, 14, 14, 9, all('loom_cloth')), box(0, 0, 4, 16, 2, 12)],
    collision: [box(0, 0, 4, 16, 16, 12)], mat: MAT.wood, walkCost: 0,
  }),
  millstone: register('millstone', 0, {
    shape: SHAPE_BOXES, tiles: tbs('millstone_top', 'stone', 'millstone_side'), boxes: [box(0, 0, 0, 16, 8, 16), box(2, 8, 2, 14, 13, 14)],
    mat: MAT.stone, walkCost: 0,
  }),
  workbench: cube('workbench', tbs('workbench_top', 'oak_planks', 'workbench_side'), MAT.wood, { walkCost: 0 }),
  brew_vat: register('brew_vat', 0, {
    shape: SHAPE_BOXES, tiles: tbs('vat_top', 'barrel_top', 'vat_side'), boxes: [box(1, 0, 1, 15, 16, 15)], mat: MAT.wood, walkCost: 0,
  }),
  cauldron: register('cauldron', 0, {
    shape: SHAPE_BOXES, tiles: tbs('stew', 'iron_dark', 'iron_dark'),
    boxes: [box(2, 3, 2, 14, 13, 14), box(3, 0, 3, 5, 3, 5), box(11, 0, 3, 13, 3, 5), box(3, 0, 11, 5, 3, 13), box(11, 0, 11, 13, 3, 13)],
    collision: [box(2, 0, 2, 14, 13, 14)], mat: MAT.metal, walkCost: 0,
  }),
  bell: register('bell', 0, {
    shape: SHAPE_BOXES, tiles: all('brass'), boxes: [box(4, 3, 4, 12, 5, 12), box(5, 5, 5, 11, 12, 11), box(7, 12, 7, 9, 16, 9)],
    collision: [box(4, 3, 4, 12, 12, 12)], mat: MAT.metal, walkCost: 0,
  }),
  trough: register('trough', 0, {
    shape: SHAPE_BOXES, tiles: tbs('trough_water', 'pine_planks', 'pine_planks'), boxes: [box(0, 0, 3, 16, 7, 13)], mat: MAT.wood, walkCost: 0,
  }),
};

export type BlockName = keyof typeof B;

// ---------------------------------------------------------------------------
// Flat lookup tables
// ---------------------------------------------------------------------------

export const BLOCKS: readonly BlockState[] = states;
export const STATE_COUNT = states.length;

const u8 = (f: (s: BlockState) => number | boolean): Uint8Array => Uint8Array.from(states, (s) => Number(f(s)));

export const SHAPE = u8((s) => s.shape);
export const LAYER = u8((s) => s.layer);
export const SOLID = u8((s) => s.solid);
export const OPAQUE = u8((s) => s.opaque);
export const LIGHT_OPACITY = u8((s) => s.lightOpacity);
export const EMIT = u8((s) => s.emit);
export const REPLACEABLE = u8((s) => s.replaceable);
export const LOOSE = u8((s) => s.loose);
export const NATURAL = u8((s) => s.natural);
export const MATERIAL = u8((s) => s.material);
export const WATER_LEVEL = u8((s) => s.waterLevel);
export const WATER_SOURCE = u8((s) => s.waterSource);
export const CLIMBABLE = u8((s) => s.climbable);
export const TINT = u8((s) => s.tint);
export const WIND = u8((s) => s.wind);
export const CONNECT = u8((s) => s.connect);
export const WALK_COST = Float32Array.from(states, (s) => s.walkCost);
/** True for any state that blocks rain and counts as a roof or ground for weather exposure. */
export const BLOCKS_RAIN = u8((s) => s.shape !== SHAPE_NONE && s.shape !== SHAPE_CROSS && s.shape !== SHAPE_CROP && s.shape !== SHAPE_LIQUID && s.family !== 'ladder' && s.family !== 'torch' && s.family !== 'wall_torch');

/**
 * Bitmask per state of block faces this state fully covers with opaque
 * geometry, so a neighbour's face against it can be culled.
 */
export const FULL_FACES = Uint8Array.from(states, (s) => {
  if (s.layer !== LAYER_OPAQUE) return 0;
  if (s.shape === SHAPE_CUBE) return 0b111111;
  if (s.shape !== SHAPE_BOXES) return 0;
  // Rasterise what the boxes cover on each face of the cell; several boxes may tile one face (stairs).
  let mask = 0;
  for (let face = 0; face < 6; face++) {
    const axis = face >> 1;
    const positive = (face & 1) === 0;
    const covered = new Uint8Array(256);
    for (const b of s.boxes) {
      const lo = [b.x0, b.y0, b.z0];
      const hi = [b.x1, b.y1, b.z1];
      if (positive ? hi[axis] !== 16 : lo[axis] !== 0) continue;
      const u = (axis + 1) % 3;
      const v = (axis + 2) % 3;
      for (let j = lo[v] as number; j < (hi[v] as number); j++) {
        for (let i = lo[u] as number; i < (hi[u] as number); i++) covered[j * 16 + i] = 1;
      }
    }
    if (covered.every((c) => c === 1)) mask |= 1 << face;
  }
  return mask;
});

/** Collision boxes per state in block units: six floats per box (x0, y0, z0, x1, y1, z1). */
export const COLLISION: readonly Float32Array[] = states.map((s) => {
  const out = new Float32Array(s.collision.length * 6);
  s.collision.forEach((b, i) => out.set([b.x0 / 16, b.y0 / 16, b.z0 / 16, b.x1 / 16, b.y1 / 16, b.z1 / 16], i * 6));
  return out;
});

/** Height of the walkable top surface of a state within its cell, in blocks (0 when not solid). */
export const TOP_HEIGHT = Float32Array.from(states, (s) => s.collision.reduce((m, b) => Math.max(m, Math.min(b.y1, 16) / 16), 0));

export function isWater(state: number): boolean {
  return WATER_LEVEL[state] !== 0;
}

/** Base state id of a family, by name (the first variant registered). */
export function familyBase(name: string): number {
  const id = families.get(name);
  if (id === undefined) throw new Error(`unknown block family: ${name}`);
  return id;
}

export function hasFamily(name: string): boolean {
  return families.has(name);
}

export function allFamilies(): string[] {
  return [...families.keys()];
}

// --- variant helpers --------------------------------------------------------

export const waterState = (level: number): number => (level <= 0 ? B.air : B.water + Math.min(level, 16) - 1);
export const doorState = (facing: number, upper: boolean, open: boolean): number => B.door + facing * 4 + (upper ? 2 : 0) + (open ? 1 : 0);
export const isDoor = (state: number): boolean => state >= B.door && state < B.door + 16;
export const doorIsOpen = (state: number): boolean => ((state - B.door) & 1) === 1;
export const gateState = (axis: number, open: boolean): number => B.gate + axis * 2 + (open ? 1 : 0);
export const isGate = (state: number): boolean => state >= B.gate && state < B.gate + 4;
export const bedState = (facing: number, head: boolean): number => B.bed + facing * 2 + (head ? 1 : 0);
export const isBed = (state: number): boolean => state >= B.bed && state < B.bed + 8;
export const cropStage = (state: number): number => (SHAPE[state] === SHAPE_CROP ? (BLOCKS[state] as BlockState).variant : -1);
export const IS_LEAVES = u8((s) => s.material === MAT.leaves);
export const IS_LOG = u8((s) => s.family === 'oak_log' || s.family === 'birch_log' || s.family === 'pine_log');
export const isLeaves = (state: number): boolean => IS_LEAVES[state] === 1;
export const isLog = (state: number): boolean => IS_LOG[state] === 1;
