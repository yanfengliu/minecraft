// The tile set: every 16x16 surface texture a block face can show, by name.
// The order here IS the layer order of the GPU texture array, so the world
// layer (headless, worker-safe) and the renderer agree without sharing code.
// `src/render/textures.ts` must paint every name; a unit test holds it to that.

export const TILE_NAMES = [
  // terrain
  'grass_top', 'grass_side', 'dirt', 'forest_floor', 'forest_side', 'stone', 'granite', 'cobble', 'mossy_cobble',
  'gravel', 'sand', 'clay', 'snow', 'bedrock', 'coal_ore', 'iron_ore', 'path_top', 'farmland_dry', 'farmland_wet',
  // wood
  'oak_log', 'oak_log_top', 'birch_log', 'birch_log_top', 'pine_log', 'pine_log_top',
  'oak_planks', 'birch_planks', 'pine_planks', 'beam', 'beam_top',
  // foliage (cutout)
  'oak_leaves', 'birch_leaves', 'pine_leaves',
  'tall_grass', 'fern', 'poppy', 'daisy', 'bluebell', 'buttercup', 'heather', 'mushroom_brown', 'mushroom_red',
  'reeds', 'seagrass', 'berry_bush', 'berry_bush_ripe', 'sapling_oak', 'sapling_birch', 'sapling_pine', 'lily_pad',
  // crops (cutout)
  'wheat_0', 'wheat_1', 'wheat_2', 'wheat_3', 'barley_0', 'barley_1', 'barley_2', 'barley_3',
  'turnip_0', 'turnip_1', 'turnip_2', 'turnip_3', 'cabbage_0', 'cabbage_1', 'cabbage_2', 'cabbage_3',
  // masonry and walls
  'stone_bricks', 'bricks', 'plaster', 'frame_box', 'frame_x', 'frame_slash', 'frame_bslash',
  'thatch', 'clay_tiles', 'slate_tiles', 'glass',
  // cloth
  'hay_side', 'hay_top', 'wool_white', 'wool_red', 'wool_blue', 'wool_yellow', 'wool_green', 'stripe_red', 'stripe_blue',
  // fittings
  'door_lower', 'door_upper', 'ladder', 'torch_stick', 'flame', 'lantern_frame', 'lantern_glow', 'lantern_off',
  'charred_log', 'iron_dark', 'brass',
  // furniture and workstations
  'barrel_side', 'barrel_top', 'crate', 'chest_side', 'chest_top', 'bookshelf',
  'oven_front', 'oven_front_lit', 'forge_side', 'coals', 'coals_lit', 'loom_cloth',
  'millstone_top', 'millstone_side', 'workbench_top', 'workbench_side', 'vat_side', 'vat_top', 'stew',
  'trough_water', 'woodpile_side', 'woodpile_end', 'sack', 'bed_head', 'bed_foot', 'bed_side',
] as const;

export type TileName = (typeof TILE_NAMES)[number];

export const TILE_COUNT = TILE_NAMES.length;

const INDEX = new Map<string, number>(TILE_NAMES.map((name, i) => [name, i]));

export function tileIndex(name: TileName): number {
  const i = INDEX.get(name);
  if (i === undefined) throw new Error(`unknown tile: ${name}`);
  return i;
}
