// The species table: one record of numbers per kind of wild animal. Behaviour
// code is shared between species of a guild (grazers, hunters, birds, water
// life) and reads its differences from here, so tuning the ecosystem is a
// matter of editing this file.
//
// Units: speeds in blocks per simulated second, distances in blocks, lifespans
// and other long spans in simulated days (a year is 28 days), short spans in
// simulated seconds.

import type { EntityKind } from '../api';

export const WILD_KINDS = ['deer', 'rabbit', 'boar', 'fox', 'wolf', 'songbird', 'crow', 'gull', 'duck', 'fish'] as const satisfies readonly EntityKind[];
export type WildKind = (typeof WILD_KINDS)[number];
export const KIND_COUNT = WILD_KINDS.length;

// Indices into WILD_KINDS and SPECIES, as plain numbers so they index typed arrays.
export const DEER = 0;
export const RABBIT = 1;
export const BOAR = 2;
export const FOX = 3;
export const WOLF = 4;
export const SONGBIRD = 5;
export const CROW = 6;
export const GULL = 7;
export const DUCK = 8;
export const FISH = 9;

/** What a species is doing at this hour, by its daily habit. */
export const ACT_FEED = 0;
export const ACT_REST = 1;
export const ACT_SLEEP = 2;

/** How a group of this species lives together; picks the group logic. */
export const GT_BAND = 0;
export const GT_WARREN = 1;
export const GT_SOLO = 2;
export const GT_PACK = 3;
export const GT_FLOCK = 4;
export const GT_SCHOOL = 5;

// What a mouthful can be. A species' `diet` is a mask of these.
export const FOOD_GRASS = 1;
export const FOOD_FLOWER = 2;
export const FOOD_BERRY = 4;
export const FOOD_MUSHROOM = 8;

export interface Species {
  index: number;
  kind: WildKind;
  label: string;
  male: string;
  female: string;
  young: string;
  /** What a group is called: "herd", "warren", "pack". */
  band: string;
  groupType: number;
  /** Fewest and most animals in one group. */
  groupMin: number;
  groupMax: number;
  /** Unhurried speed on the ground or on the water. */
  walk: number;
  /** Flat-out speed on the ground or on the water. */
  run: number;
  /** Cruising speed in the air; 0 for animals that do not fly. */
  fly: number;
  /** Seconds of flat-out effort from fresh to spent. */
  stamina: number;
  /** How close a person may come before it leaves. */
  flight: number;
  /** How close a hunting animal may come before it is noticed: creeping, and at a run. */
  wary: readonly [number, number];
  lifespan: number;
  /** Age in days at which it is full grown and can breed. */
  mature: number;
  /** Age in days at which the young stop depending on their mother. */
  wean: number;
  /** Hunger gained per day: 1 takes a sated animal to starving in one day. */
  hungerPerDay: number;
  /** Hunger one mouthful removes (for hunters: what a share of a kill removes, per unit of meat). */
  bite: number;
  /** Seconds one mouthful takes. */
  eatTime: number;
  diet: number;
  /** Breeds in spring, summer, autumn, winter. */
  breed: readonly [boolean, boolean, boolean, boolean];
  litter: readonly [number, number];
  /** Days from courtship to birth. */
  gestation: number;
  /** Days after a birth before the mother breeds again. */
  rebreed: number;
  /** Chance that a courtship takes, each time a ready pair is given one. */
  fertility: number;
  /** Size of the newborn relative to an adult. */
  birthScale: number;
  /** What the hunter takes from a full-grown animal. */
  meat: number;
  hide: number;
  /**
   * Daily habit: feeding hours relative to sunrise (from, to) and to sunset
   * (from, to), then what it does through the middle of the day and in the
   * dead of night.
   */
  habit: readonly [number, number, number, number, number, number];
  /** Ticks between thoughts when awake and unhurried. */
  think: number;
  /** The population may grow to this multiple of its starting number, and at least to `capMin`. */
  capFactor: number;
  capMin: number;
  /** How many arrive together when the species has died out and comes back. */
  arrive: number;
}

const SPRING = [true, false, false, false] as const;
const SPRING_SUMMER = [true, true, false, false] as const;

export const SPECIES: readonly Species[] = [
  {
    index: DEER, kind: 'deer', label: 'Deer', male: 'Stag', female: 'Doe', young: 'Fawn', band: 'herd',
    groupType: GT_BAND, groupMin: 3, groupMax: 7,
    walk: 1.2, run: 8.8, fly: 0, stamina: 40, flight: 16, wary: [14, 22],
    lifespan: 150, mature: 20, wean: 6, hungerPerDay: 0.5, bite: 0.05, eatTime: 2.4,
    diet: FOOD_GRASS | FOOD_FLOWER | FOOD_BERRY,
    breed: SPRING, litter: [1, 2], gestation: 2.5, rebreed: 18, fertility: 0.4, birthScale: 0.5, meat: 5, hide: 2,
    habit: [-1.5, 2, -2, 1.5, ACT_REST, ACT_SLEEP], think: 14, capFactor: 2, capMin: 10, arrive: 3,
  },
  {
    index: RABBIT, kind: 'rabbit', label: 'Rabbit', male: 'Buck', female: 'Doe', young: 'Kit', band: 'warren',
    groupType: GT_WARREN, groupMin: 2, groupMax: 12,
    walk: 0.9, run: 7.8, fly: 0, stamina: 25, flight: 7, wary: [5, 12],
    lifespan: 44, mature: 6, wean: 2.5, hungerPerDay: 0.7, bite: 0.2, eatTime: 1.8,
    diet: FOOD_GRASS | FOOD_FLOWER,
    breed: SPRING_SUMMER, litter: [3, 5], gestation: 2, rebreed: 4, fertility: 0.25, birthScale: 0.45, meat: 1, hide: 1,
    habit: [-1, 3.5, -3.5, 2, ACT_REST, ACT_SLEEP], think: 12, capFactor: 1.8, capMin: 16, arrive: 4,
  },
  {
    index: BOAR, kind: 'boar', label: 'Wild boar', male: 'Boar', female: 'Sow', young: 'Piglet', band: 'sounder',
    groupType: GT_BAND, groupMin: 2, groupMax: 6,
    walk: 1.1, run: 7.2, fly: 0, stamina: 35, flight: 12, wary: [11, 18],
    lifespan: 120, mature: 16, wean: 5, hungerPerDay: 0.5, bite: 0.05, eatTime: 2.5,
    diet: FOOD_GRASS | FOOD_BERRY | FOOD_MUSHROOM,
    breed: SPRING, litter: [1, 3], gestation: 3, rebreed: 18, fertility: 0.3, birthScale: 0.4, meat: 4, hide: 1,
    habit: [-3, 1, -1.5, 4, ACT_SLEEP, ACT_REST], think: 14, capFactor: 2, capMin: 8, arrive: 2,
  },
  {
    index: FOX, kind: 'fox', label: 'Fox', male: 'Dog fox', female: 'Vixen', young: 'Cub', band: 'den',
    groupType: GT_SOLO, groupMin: 1, groupMax: 4,
    walk: 1.5, run: 8.4, fly: 0, stamina: 45, flight: 14, wary: [0, 0],
    lifespan: 90, mature: 14, wean: 5, hungerPerDay: 0.34, bite: 0.75, eatTime: 22,
    diet: FOOD_BERRY,
    breed: SPRING, litter: [2, 3], gestation: 3, rebreed: 20, fertility: 0.5, birthScale: 0.45, meat: 0, hide: 1,
    habit: [-3, 0.5, -1, 4, ACT_SLEEP, ACT_FEED], think: 10, capFactor: 1.5, capMin: 4, arrive: 2,
  },
  {
    index: WOLF, kind: 'wolf', label: 'Wolf', male: 'Wolf', female: 'She-wolf', young: 'Pup', band: 'pack',
    groupType: GT_PACK, groupMin: 2, groupMax: 5,
    walk: 1.6, run: 8.6, fly: 0, stamina: 75, flight: 20, wary: [0, 0],
    lifespan: 150, mature: 20, wean: 6, hungerPerDay: 0.18, bite: 0.6, eatTime: 55,
    diet: 0,
    breed: SPRING, litter: [1, 3], gestation: 3, rebreed: 22, fertility: 0.5, birthScale: 0.45, meat: 0, hide: 2,
    habit: [-3, 1, -1.5, 4, ACT_SLEEP, ACT_FEED], think: 10, capFactor: 1.25, capMin: 5, arrive: 3,
  },
  {
    index: SONGBIRD, kind: 'songbird', label: 'Songbird', male: 'Cock', female: 'Hen', young: 'Fledgling', band: 'flock',
    groupType: GT_FLOCK, groupMin: 3, groupMax: 12,
    walk: 0, run: 0, fly: 6, stamina: 200, flight: 6, wary: [0, 0],
    lifespan: 60, mature: 7, wean: 2, hungerPerDay: 0.6, bite: 0.3, eatTime: 2,
    diet: FOOD_BERRY,
    breed: SPRING_SUMMER, litter: [1, 2], gestation: 2, rebreed: 8, fertility: 0.15, birthScale: 0.6, meat: 0, hide: 0,
    habit: [-0.7, 4, -4, 0.3, ACT_FEED, ACT_SLEEP], think: 20, capFactor: 1.5, capMin: 10, arrive: 5,
  },
  {
    index: CROW, kind: 'crow', label: 'Crow', male: 'Cock', female: 'Hen', young: 'Fledgling', band: 'murder',
    groupType: GT_FLOCK, groupMin: 2, groupMax: 10,
    walk: 0, run: 0, fly: 7, stamina: 200, flight: 10, wary: [0, 0],
    lifespan: 110, mature: 14, wean: 3, hungerPerDay: 0.5, bite: 0.3, eatTime: 2,
    diet: 0,
    breed: SPRING, litter: [1, 2], gestation: 3, rebreed: 20, fertility: 0.3, birthScale: 0.6, meat: 0, hide: 0,
    habit: [-0.3, 5, -5, 0.3, ACT_FEED, ACT_SLEEP], think: 20, capFactor: 1.75, capMin: 6, arrive: 3,
  },
  {
    index: GULL, kind: 'gull', label: 'Gull', male: 'Cock', female: 'Hen', young: 'Fledgling', band: 'colony',
    groupType: GT_FLOCK, groupMin: 2, groupMax: 14,
    walk: 0.4, run: 0.4, fly: 8, stamina: 200, flight: 9, wary: [0, 0],
    lifespan: 130, mature: 14, wean: 3, hungerPerDay: 0.5, bite: 0.3, eatTime: 2,
    diet: 0,
    breed: SPRING, litter: [1, 2], gestation: 3, rebreed: 20, fertility: 0.3, birthScale: 0.6, meat: 0, hide: 0,
    habit: [-0.5, 6, -6, 0.5, ACT_FEED, ACT_SLEEP], think: 20, capFactor: 1.5, capMin: 6, arrive: 4,
  },
  {
    index: DUCK, kind: 'duck', label: 'Duck', male: 'Drake', female: 'Hen', young: 'Duckling', band: 'raft',
    groupType: GT_FLOCK, groupMin: 2, groupMax: 14,
    walk: 0.7, run: 1.9, fly: 9, stamina: 200, flight: 8, wary: [0, 0],
    lifespan: 80, mature: 10, wean: 4, hungerPerDay: 0.5, bite: 0.3, eatTime: 4,
    diet: 0,
    breed: SPRING, litter: [2, 4], gestation: 3, rebreed: 20, fertility: 0.4, birthScale: 0.4, meat: 1, hide: 0,
    habit: [-0.5, 5, -5, 1, ACT_FEED, ACT_SLEEP], think: 16, capFactor: 1.8, capMin: 6, arrive: 3,
  },
  {
    index: FISH, kind: 'fish', label: 'Fish', male: 'Fish', female: 'Fish', young: 'Fry', band: 'school',
    groupType: GT_SCHOOL, groupMin: 1, groupMax: 8,
    walk: 0.7, run: 2.6, fly: 0, stamina: 200, flight: 3.5, wary: [0, 0],
    lifespan: 40, mature: 3, wean: 0, hungerPerDay: 0, bite: 0, eatTime: 0,
    diet: 0,
    breed: [false, false, false, false], litter: [0, 0], gestation: 0, rebreed: 0, fertility: 0, birthScale: 0.5, meat: 1, hide: 0,
    habit: [-12, 12, -12, 12, ACT_FEED, ACT_FEED], think: 16, capFactor: 1, capMin: 0, arrive: 0,
  },
];

/** Bit of one species in a kind mask. */
export const bit = (index: number): number => 1 << index;
export const ALL_KINDS = (1 << KIND_COUNT) - 1;

export function kindIndex(kind: EntityKind): number {
  return (WILD_KINDS as readonly string[]).indexOf(kind);
}
