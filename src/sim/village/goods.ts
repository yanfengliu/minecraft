// The economy's fixed tables: the goods, the trades, and for each kind of
// building what it makes, what it keeps in stock, and whom it supplies. The
// simulation code is generic over these tables; tuning the village's economy
// means editing numbers here.

import { ECONOMY_GOODS, type GoodName, item } from '../../world/items';
import type { BuildingKind } from '../api';

export const GOODS: readonly GoodName[] = ECONOMY_GOODS;
/** Number of economy goods; every stock array has this length. */
export const NG = GOODS.length;
/** Index of each good in stock arrays. */
export const G = Object.fromEntries(GOODS.map((g, i) => [g, i])) as Record<GoodName, number>;
export const VALUE: readonly number[] = GOODS.map((g) => item(g).value);
/** Meals in one unit of each good; 0 when it is not food. */
export const FOOD: readonly number[] = GOODS.map((g) => item(g).food);
export const ITEM_ID: readonly number[] = GOODS.map((g) => item(g).id);
export const LABEL: readonly string[] = GOODS.map((g) => item(g).label.toLowerCase());
export const FOOD_GOODS: readonly number[] = GOODS.map((_, i) => i).filter((i) => (FOOD[i] as number) > 0);
/** The item a worker holds when using a tool rather than carrying goods. */
export const TOOLS_ITEM = item('tools').id;

export function goodIndex(name: string): number {
  const i = (G as Record<string, number | undefined>)[name];
  return i === undefined ? -1 : i;
}

/** `EntityView.role` indexes this list. */
export const PROFESSIONS = [
  'farmer', 'miller', 'baker', 'innkeeper', 'smith', 'carpenter', 'weaver', 'storekeeper', 'priest', 'reeve', 'fisher',
  'hunter', 'woodcutter', 'miner', 'shepherd', 'guard', 'labourer', 'child',
] as const;
export type Profession = (typeof PROFESSIONS)[number];
export const TRADE = Object.fromEntries(PROFESSIONS.map((p, i) => [p, i])) as Record<Profession, number>;

export interface Recipe {
  /** Kind of work spot it is made at. */
  spot: string;
  /** Simulated seconds for one batch. */
  seconds: number;
  input: readonly (readonly [number, number])[];
  output: readonly (readonly [number, number])[];
  /** The work block burns while the batch is made: it is switched to its lit variant and the chimney smokes. */
  fire: boolean;
  /** Cue emitted at the work block while working, or ''. */
  fx: string;
  /** Item shown in the worker's hands. */
  held: number;
  /** What the inspector calls it. */
  verb: string;
}

export interface KindSpec {
  trade: Profession;
  /** Workers the building wants. */
  slots: number;
  /** Order in which unfilled places are offered to commuters: food and fuel first. */
  staffing: number;
  /** Coin the business keeps back when it pays out, as working capital. */
  float: number;
  /** Goods held: [good, opening stock, target stock]. The posted price equals the item's value when stock is at target. */
  goods: readonly (readonly [GoodName, number, number])[];
  sells: readonly GoodName[];
  recipes: readonly Recipe[];
  /** Whom the business carries each of its goods to, in order of preference. */
  deliver: readonly (readonly [GoodName, readonly BuildingKind[]])[];
  /** Units of a good never delivered away, because the business works them up itself. */
  keep: Partial<Record<GoodName, number>>;
  /** Stands at a market stall on Fairday; lower is offered a stall first, 0 never. */
  stall: number;
  /** Opening price multiplier for the trade; see `Business.markup`. */
  markup: number;
}

const recipe = (
  spot: string, seconds: number, input: [GoodName, number][], output: [GoodName, number][], verb: string,
  opt: { fire?: boolean; fx?: string; held?: GoodName } = {},
): Recipe => ({
  spot,
  seconds,
  input: input.map(([g, n]) => [G[g], n] as const),
  output: output.map(([g, n]) => [G[g], n] as const),
  fire: opt.fire ?? false,
  fx: opt.fx ?? '',
  held: opt.held ? item(opt.held).id : TOOLS_ITEM,
  verb,
});

const NONE: KindSpec = {
  trade: 'labourer', slots: 0, staffing: 99, float: 0, goods: [], sells: [], recipes: [], deliver: [], keep: {}, stall: 0, markup: 1,
};

export const KIND_SPEC: Record<BuildingKind, KindSpec> = {
  house: NONE,
  farm: {
    // A farm's crops come from its fields, so its goods are filled in from the plan when the village is built.
    trade: 'farmer', slots: 4, staffing: 1, float: 30, goods: [['egg', 0, 10]], sells: ['wheat', 'barley', 'turnip', 'cabbage', 'egg'], recipes: [],
    deliver: [['wheat', ['mill', 'store']], ['barley', ['tavern', 'store']], ['turnip', ['store']], ['cabbage', ['store']], ['egg', ['store']]],
    keep: {}, stall: 1, markup: 1,
  },
  mill: {
    trade: 'miller', slots: 2, staffing: 3, float: 90, goods: [['wheat', 40, 40], ['flour', 30, 30]], sells: ['flour'],
    recipes: [recipe('millstone', 45, [['wheat', 4]], [['flour', 4]], 'Milling flour', { held: 'wheat' })],
    deliver: [['flour', ['bakery', 'store']]], keep: {}, stall: 0, markup: 1,
  },
  bakery: {
    // Flour and bread enough to carry the village over Restday, when nothing is milled, baked or delivered.
    trade: 'baker', slots: 2, staffing: 2, float: 90, goods: [['flour', 40, 48], ['firewood', 16, 16], ['bread', 40, 50]], sells: ['bread'],
    recipes: [recipe('oven', 45, [['flour', 3], ['firewood', 1]], [['bread', 6]], 'Baking bread', { fire: true, held: 'bread' })],
    deliver: [['bread', ['store']]], keep: { bread: 30 }, stall: 4, markup: 1,
  },
  tavern: {
    trade: 'innkeeper', slots: 2, staffing: 6, float: 80, goods: [['barley', 24, 24], ['firewood', 10, 8], ['ale', 40, 40]], sells: ['ale'],
    recipes: [recipe('vat', 75, [['barley', 2], ['firewood', 1]], [['ale', 6]], 'Brewing ale', { fire: true, held: 'barley' })],
    deliver: [['ale', ['store']]], keep: { ale: 30 }, stall: 0, markup: 1,
  },
  smithy: {
    trade: 'smith', slots: 2, staffing: 8, float: 110,
    goods: [['iron_ore', 6, 8], ['coal', 6, 8], ['oak_planks', 4, 6], ['iron', 3, 4], ['tools', 5, 6]], sells: ['tools', 'iron'],
    recipes: [
      recipe('anvil', 110, [['iron', 1], ['oak_planks', 1]], [['tools', 1]], 'Forging tools', { fx: 'sparks' }),
      recipe('forge', 70, [['iron_ore', 1], ['coal', 1]], [['iron', 1]], 'Smelting iron', { fire: true, held: 'iron_ore' }),
    ],
    deliver: [['tools', ['store']], ['iron', ['store']]], keep: { iron: 3, tools: 2 }, stall: 6, markup: 1,
  },
  carpenter: {
    trade: 'carpenter', slots: 2, staffing: 11, float: 60, goods: [['oak_log', 8, 10], ['oak_planks', 14, 16]], sells: ['oak_planks'],
    recipes: [recipe('workbench', 90, [['oak_log', 1]], [['oak_planks', 3]], 'Sawing planks', { fx: 'hammer' })],
    deliver: [['oak_planks', ['smithy', 'store']]], keep: {}, stall: 0, markup: 1,
  },
  weaver: {
    trade: 'weaver', slots: 2, staffing: 10, float: 80, goods: [['wool', 10, 12], ['hide', 4, 8], ['cloth', 8, 10]], sells: ['cloth'],
    recipes: [
      recipe('loom', 110, [['wool', 2]], [['cloth', 1]], 'Weaving cloth', { held: 'wool' }),
      recipe('loom', 110, [['hide', 2]], [['cloth', 1]], 'Cutting leather', { held: 'hide' }),
    ],
    deliver: [['cloth', ['store']]], keep: { cloth: 2 }, stall: 5, markup: 1,
  },
  store: {
    // The general merchant handles every good, which also makes it the counterparty of last resort for the player.
    trade: 'storekeeper', slots: 2, staffing: 5, float: 220,
    goods: [
      ['turnip', 40, 40], ['cabbage', 40, 40], ['fish', 10, 16], ['meat', 6, 12], ['egg', 10, 16], ['berries', 0, 6],
      ['firewood', 60, 60], ['cloth', 6, 8], ['tools', 4, 5], ['oak_planks', 6, 10], ['stone', 10, 16], ['coal', 4, 8],
      ['iron', 1, 3], ['hide', 0, 4], ['wool', 0, 4], ['wheat', 0, 8], ['barley', 0, 6], ['flour', 0, 6], ['bread', 0, 8],
      ['ale', 0, 6], ['oak_log', 0, 6], ['iron_ore', 0, 4],
    ],
    sells: GOODS, recipes: [], deliver: [], keep: {}, stall: 0, markup: 1,
  },
  chapel: { ...NONE, trade: 'priest', slots: 1, staffing: 20 },
  hall: { ...NONE, trade: 'reeve', slots: 1, staffing: 21 },
  fishery: {
    trade: 'fisher', slots: 2, staffing: 7, float: 30, goods: [['fish', 10, 14]], sells: ['fish'], recipes: [],
    deliver: [['fish', ['store']]], keep: {}, stall: 2, markup: 1,
  },
  hunter: {
    trade: 'hunter', slots: 1, staffing: 13, float: 30, goods: [['meat', 6, 8], ['hide', 4, 6]], sells: ['meat', 'hide'], recipes: [],
    deliver: [['meat', ['store']], ['hide', ['weaver', 'store']]], keep: {}, stall: 0, markup: 1,
  },
  woodcutter: {
    trade: 'woodcutter', slots: 3, staffing: 4, float: 30, goods: [['oak_log', 16, 16], ['firewood', 50, 50]], sells: ['oak_log', 'firewood'],
    recipes: [recipe('woodpile', 40, [['oak_log', 1]], [['firewood', 4]], 'Splitting firewood', { fx: 'chop' })],
    deliver: [['oak_log', ['carpenter', 'store']], ['firewood', ['bakery', 'tavern', 'store']]], keep: { oak_log: 4 }, stall: 0, markup: 1,
  },
  mine: {
    trade: 'miner', slots: 3, staffing: 9, float: 30, goods: [['stone', 10, 14], ['coal', 8, 10], ['iron_ore', 8, 10]],
    sells: ['stone', 'coal', 'iron_ore'], recipes: [],
    deliver: [['iron_ore', ['smithy', 'store']], ['coal', ['smithy', 'store']], ['stone', ['store']]], keep: {}, stall: 0, markup: 1,
  },
  shepherd: {
    trade: 'shepherd', slots: 2, staffing: 12, float: 30, goods: [['wool', 12, 14], ['egg', 6, 10], ['meat', 0, 6], ['hide', 0, 4]],
    sells: ['wool', 'egg', 'meat', 'hide'], recipes: [],
    deliver: [['wool', ['weaver', 'store']], ['egg', ['store']], ['meat', ['store']], ['hide', ['weaver', 'store']]], keep: {}, stall: 3, markup: 1,
  },
  guardhouse: { ...NONE, trade: 'guard', slots: 3, staffing: 5 },
};

/**
 * Opening stock and target of a crop for a farm that has this many cells of it.
 * A farm is also the granary: its target is what it holds through a typical
 * year, so the price is low after harvest and climbs as the barn empties.
 */
export const cropStock = (cells: number): readonly [number, number] => [Math.round(cells * 1.6), cells * 2];

/** Units a person carries on one delivery or shopping trip. */
export const CARRY = 24;
