// Item registry: everything that can sit in an inventory, a stockpile or a
// market stall. Block items are derived from the block table (one per placeable
// family); goods are the non-block commodities the village economy runs on.
// Headless and worker-safe.

import { BLOCKS, MAT, SHAPE, SHAPE_CROP, SHAPE_CROSS, allFamilies, familyBase } from './blocks';

export interface ItemDef {
  id: number;
  name: string;
  label: string;
  kind: 'block' | 'good';
  /** Base state id placed by this item, or -1 for goods. */
  block: number;
  /** Reference price in coins; markets move around it with supply and demand. */
  value: number;
  /** Food value in meals, 0 if inedible. */
  food: number;
  stack: number;
  /** How the UI draws it: a little cube, a flat tile, or a named pixel sprite. */
  icon: 'cube' | 'flat' | 'sprite';
}

const items: ItemDef[] = [];
const byName = new Map<string, ItemDef>();

function add(def: Omit<ItemDef, 'id'>): ItemDef {
  if (byName.has(def.name)) throw new Error(`duplicate item: ${def.name}`);
  const item: ItemDef = { id: items.length, ...def };
  items.push(item);
  byName.set(item.name, item);
  return item;
}

const pretty = (name: string): string => name.replace(/_/g, ' ').replace(/^\w/, (c) => c.toUpperCase());

const MATERIAL_VALUE: Record<number, number> = {
  [MAT.stone]: 1, [MAT.earth]: 1, [MAT.sand]: 1, [MAT.gravel]: 1, [MAT.wood]: 2, [MAT.leaves]: 1, [MAT.plant]: 1,
  [MAT.cloth]: 8, [MAT.glass]: 6, [MAT.metal]: 20, [MAT.thatch]: 2, [MAT.brick]: 4, [MAT.snow]: 1, [MAT.clay]: 2,
};

const VALUE_OVERRIDE: Record<string, number> = {
  oak_log: 3, birch_log: 3, pine_log: 3, oak_planks: 2, birch_planks: 2, pine_planks: 2, stone: 1, cobble: 1,
  iron_ore: 5, coal_ore: 4, torch: 2, lantern: 12, hanging_lantern: 12, door: 8, bed: 20, window: 6, chest: 10,
  anvil: 60, oven: 15, forge: 25, loom: 25, bell: 80, hay_bale: 3, bricks: 4, stone_bricks: 3, ladder: 2, fence: 2, gate: 4,
};

// --- block items: one per placeable family, in block-table order -----------

for (const family of allFamilies()) {
  const base = familyBase(family);
  const state = BLOCKS[base];
  if (!state || !state.placeable) continue;
  const flat = SHAPE[base] === SHAPE_CROSS || SHAPE[base] === SHAPE_CROP;
  add({
    name: family,
    label: pretty(family),
    kind: 'block',
    block: base,
    value: VALUE_OVERRIDE[family] ?? MATERIAL_VALUE[state.material] ?? 1,
    food: 0,
    stack: 99,
    icon: flat ? 'flat' : 'cube',
  });
}

// --- goods -------------------------------------------------------------------

const good = (name: string, value: number, food = 0, label = pretty(name)): ItemDef =>
  add({ name, label, kind: 'good', block: -1, value, food, stack: 99, icon: 'sprite' });

good('wheat', 2);
good('barley', 2);
good('flour', 4);
good('bread', 6, 1);
good('turnip', 2, 0.5);
good('cabbage', 3, 0.5);
good('fish', 5, 1);
good('meat', 8, 1.5);
good('egg', 2, 0.35);
good('berries', 2, 0.25);
good('mushroom', 2, 0.25);
good('ale', 5);
good('wool', 6);
good('cloth', 14);
good('hide', 7);
good('firewood', 1);
good('coal', 3);
good('iron', 14, 0, 'Iron bar');
good('tools', 30);

export const ITEMS: readonly ItemDef[] = items;
export const ITEM_COUNT = items.length;

export function item(name: string): ItemDef {
  const it = byName.get(name);
  if (!it) throw new Error(`unknown item: ${name}`);
  return it;
}

export function findItem(name: string): ItemDef | undefined {
  return byName.get(name);
}

/** The item a state drops when broken, or undefined. */
export function dropOf(state: number): ItemDef | undefined {
  const drop = BLOCKS[state]?.drop;
  return drop ? byName.get(drop) : undefined;
}

/** A stack of one kind of item. */
export interface ItemStack {
  item: number;
  count: number;
}

/** The goods the village economy produces, consumes and prices. */
export const ECONOMY_GOODS = [
  'wheat', 'barley', 'flour', 'bread', 'turnip', 'cabbage', 'fish', 'meat', 'egg', 'berries', 'ale',
  'wool', 'cloth', 'hide', 'oak_log', 'oak_planks', 'firewood', 'stone', 'coal', 'iron_ore', 'iron', 'tools',
] as const;
export type GoodName = (typeof ECONOMY_GOODS)[number];

// Every drop named in the block table must resolve, or breaking that block would silently yield nothing.
for (const s of BLOCKS) {
  if (s.drop && !byName.has(s.drop)) throw new Error(`block ${s.name} drops unknown item ${s.drop}`);
}
for (const g of ECONOMY_GOODS) {
  if (!byName.has(g)) throw new Error(`economy good ${g} is not an item`);
}
