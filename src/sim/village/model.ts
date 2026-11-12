// The village's data model: residents, households, businesses, livestock and
// the derived view of each building. Plain objects with no behaviour, so every
// module of the simulation can read them without importing the others.

import type { Bed, Building, Cell, EntityView, Field, Pen, Stall, WorkSpot } from '../api';
import type { Mover, PathRequest } from '../nav';
import type { KindSpec, Recipe } from './goods';

// --- what a resident is doing right now -------------------------------------

export const PHASE_IDLE = 0;
/** Waiting for the path service to answer. */
export const PHASE_SEEK = 1;
export const PHASE_WALK = 2;
/** In a timed action: working, eating, sleeping, sitting. */
export const PHASE_ACT = 3;

/** Whose goods a resident is carrying, which decides where they are put down. */
export const PACK_NONE = 0;
export const PACK_HOME = 1;
export const PACK_JOB = 2;
/** Sold goods on their way to a customer; payment is taken on arrival. */
export const PACK_DELIVERY = 3;

export const MEAL_BREAKFAST = 1;
export const MEAL_LUNCH = 2;
export const MEAL_SUPPER = 4;

/** Runtime state of one work spot of a building. */
export interface SpotState {
  readonly spot: WorkSpot;
  /** Resident using it, and until when the claim holds. */
  user: number;
  until: number;
  /** The block is burning (oven, forge) until this time; a sweep puts it out afterwards. */
  fireUntil: number;
  lit: boolean;
}

/** A building of the plan with what the simulation derives from it. */
export interface Site {
  readonly b: Building;
  /** Standable floor inside the footprint. */
  readonly interior: Cell[];
  /** The part of it nobody has a set use for, where visitors, pupils and people sheltering stand. */
  readonly floor: Cell[];
  /** Open ground just outside the door, where a queue or an overflowing congregation stands. */
  readonly forecourt: Cell[];
  /** Where goods are handed over: beside the store chest, or else at the door. */
  readonly drop: Cell;
  /** Where a customer stands to be served. */
  readonly customer: Cell;
  readonly spots: SpotState[];
  /** Residents inside and awake at the last count; lanterns follow this. */
  awake: number;
  lit: boolean;
  /** The hearth is in use until this time: smoke rises from the chimney. */
  hearthUntil: number;
}

export interface Household {
  readonly id: number;
  readonly site: Site;
  readonly name: string;
  readonly members: Resident[];
  /** Goods at home, per economy good. */
  readonly larder: Int32Array;
  /** Meals already cut from an opened loaf or joint, so a half-eaten item is not lost. */
  plate: number;
  /** Wear accumulated toward the next unit of cloth and of tools used up. */
  clothWear: number;
  toolWear: number;
  /** Day the household last fetched water, burned its firewood, and sent someone shopping. */
  waterDay: number;
  fuelDay: number;
  shopDay: number;
  /** Resident on a household errand right now, or 0. */
  errand: number;
}

export interface Business {
  readonly id: number;
  readonly site: Site;
  readonly spec: KindSpec;
  readonly trade: number;
  coin: number;
  readonly stock: Int32Array;
  readonly target: Float32Array;
  /** Posted asking price per good. */
  readonly price: Float64Array;
  /** What the business last paid per unit of each good it bought, for pricing what it makes from them. */
  readonly paid: Float64Array;
  readonly sells: Uint8Array;
  /** Units on their way here in someone's hands. */
  readonly incoming: Int32Array;
  readonly workers: Resident[];
  /** Resident making a delivery for the business right now, or 0. */
  hauler: number;
  /** Market stall the business takes on Fairday, or null. */
  stall: Stall | null;
  /** Fields and pens it owns. */
  readonly fields: FieldState[];
  readonly pens: PenState[];
  /** Coin paid to each worker at the last pay time, and its running average over recent days. */
  lastWage: number;
  income: number;
  /**
   * Multiplier on every price the business posts. It drifts down while the
   * trade earns more than the village average and up while it earns less, which
   * is what keeps one trade from ending up with all the coin.
   */
  markup: number;
}

export interface Haul {
  good: number;
  qty: number;
  to: Business;
  loaded: boolean;
}

export interface Resident {
  readonly id: number;
  readonly view: EntityView;
  readonly mover: Mover;
  readonly name: string;
  readonly age: number;
  readonly child: boolean;
  readonly home: Household;
  readonly bed: Bed;
  /** Index into PROFESSIONS. */
  trade: number;
  job: Business | null;
  coin: number;
  /** 0 fed .. 1 starving. */
  hunger: number;
  /** 1 rested .. 0 exhausted. */
  energy: number;
  /** 1 content with company .. 0 lonely. */
  social: number;
  /** 0 miserable .. 1 cheerful; eased toward what the other needs imply. */
  mood: number;
  /** Clock time the needs were last brought up to date. */
  needsAt: number;
  /** Hours this resident runs ahead of or behind the common timetable, so the village does not move as one. */
  readonly jitter: number;
  /** For the watch: place in the duty rotation. */
  rota: number;

  asleep: boolean;
  /** Cell stood in before sitting or lying down, to return to on rising; null when standing. */
  perch: Cell | null;
  /** Packed cell of the stool sat on, or -1. */
  stool: number;

  phase: number;
  /** Clock time at which an action next needs attention (its end, or its next cue). */
  wakeAt: number;
  actEnd: number;
  onDone: (() => void) | null;
  req: PathRequest | null;
  dest: Cell | null;
  /** A destination that may be given up (a tree, a field cell) rather than forced. */
  goSoft: boolean;
  goCache: boolean;
  /** Failed route requests in a row for the destination `failKey`. */
  tries: number;
  failKey: number;
  /** Walking speed in blocks per simulated second, before weather. */
  readonly pace: number;
  /** Packed cell most recently asked for, and the one a soft request gave up on (-1 when none); see `gaveUp`. */
  askKey: number;
  badKey: number;
  fxKind: string;
  fxEvery: number;
  fxNext: number;
  fxX: number;
  fxY: number;
  fxZ: number;
  /** The current activity is out in the weather and stops when it turns bad. */
  outdoor: boolean;
  /** Moves at a run on the next walk (children at play). */
  running: boolean;
  /** Standing at a counter or stall ready to trade. */
  selling: boolean;
  /** What the inspector shows. */
  activity: string;
  /** Building the resident is inside, as an index into the site list, or -1. */
  inside: number;
  /** Packed cell of the seat or standing place the resident holds, or -1. */
  place: number;

  /** Goods in hand, per economy good, and whose they are. */
  readonly pack: Int32Array;
  packKind: number;
  packCount: number;
  haul: Haul | null;

  /** Day the per-day fields below belong to. */
  day: number;
  /** MEAL_* bits eaten today. */
  meals: number;
  /** Time-of-day scratch for the task in hand; each task documents its own use. */
  step: number;
  target: Cell | null;
  targetId: number;
  /** Clock time before which the resident will not speak again. */
  quietUntil: number;
  bubbleUntil: number;
  // Waits. Each belongs to one task: two tasks sharing a wait would hold each other up.
  /** Clock time before which someone hungry with a bare larder does not go to the shops again: they have just been, or nobody had anything their purse would cover. */
  shopAgainAt: number;
  /** Clock time before which a farmer does not go out for firewood again: the last load is just in, or there was no way to the wood. */
  firewoodAt: number;
  /** Clock time before which an outdoor trade leaves its ground alone (fished-out water, a fruitless chase). */
  restUntil: number;
  /** Day the resident last drank at the tavern, and what they chose to do this evening. */
  evening: number;
  /**
   * Sittings left on the mug of ale in hand, 0 with none. Not task scratch,
   * which is wiped whenever the goal changes: the mug is still in hand after
   * an errand that came to nothing, and is not paid for twice.
   */
  mug: number;
  /** Water carried for the fields, in cells' worth, and trips to the well for it today. */
  water: number;
  waterTrips: number;
  /** The field cell being worked: its field, cell index and operation. */
  field: FieldState | null;
  plot: number;
  op: number;
  /** Clock time before which the farmer will not try the fields again after finding a cell cut off. */
  plotRetryAt: number;
  /** What the routine last set the resident to; task scratch is cleared when it changes. */
  goal: number;
}

// --- fields and livestock -----------------------------------------------------

export interface FieldState {
  readonly f: Field;
  readonly owner: Business | null;
  readonly w: number;
  readonly d: number;
  /** Progress of each cell toward its next growth stage, 0..1. */
  readonly growth: Float32Array;
  /** Clock time each cell was last visited by the growth pass. */
  readonly seen: Float64Array;
  /** Clock time until which each cell counts as watered by hand. */
  readonly watered: Float64Array;
  /** Resident working each cell, or 0. */
  readonly claim: Int32Array;
  /** 1 once a cell has been tilled since its last harvest; sowing waits for it. */
  readonly tilled: Uint8Array;
}

export const FLOCK_PENNED = 0;
export const FLOCK_GOING_OUT = 1;
export const FLOCK_AT_PASTURE = 2;
export const FLOCK_COMING_HOME = 3;

export interface PenState {
  readonly pen: Pen;
  readonly owner: Business | null;
  readonly animals: Animal[];
  /** Head count the pen is stocked to; breeding stops there. */
  readonly capacity: number;
  /** Eggs laid and not yet collected. */
  eggs: number;
  flock: number;
  /** Clock time the current drive began, to give up on stragglers. */
  driveAt: number;
  /** Day the keeper last looked in. */
  tendedDay: number;
}

export interface Animal {
  readonly id: number;
  readonly view: EntityView;
  readonly mover: Mover;
  readonly pen: PenState;
  /** Day of birth; young animals are drawn smaller. */
  readonly born: number;
  shornYear: number;
  alive: boolean;
  moving: boolean;
  /** Following a drive route rather than wandering. */
  driven: boolean;
  wakeAt: number;
}

// --- counters -------------------------------------------------------------------

export interface VillageStats {
  /**
   * Times a resident was put somewhere instead of walking there: carried to a
   * destination no route was found to after repeated tries, or lifted out of a
   * cell that could no longer be stood in. Nothing else moves a resident who
   * has not walked, so a count of zero means everybody walked everywhere.
   */
  teleports: number;
  /** Route requests that failed. */
  pathFails: number;
  meals: number;
  /** Meals given free to someone who could not buy one. */
  almsMeals: number;
  foraged: number;
  breadBaked: number;
  breadEaten: number;
  cellsTilled: number;
  cellsSown: number;
  cellsHarvested: number;
  cellsWatered: number;
  /** Crop blocks advanced a growth stage. */
  cropStages: number;
  treesFelled: number;
  saplingsPlanted: number;
  fishCaught: number;
  animalsHunted: number;
  deliveries: number;
  purchases: number;
  lampsLit: number;
  eggsLaid: number;
  woolShorn: number;
  livestockBorn: number;
  livestockLost: number;
  greetings: number;
  /** Farm animals moved without a route (a drive that could not finish on foot). */
  strays: number;
}

export function emptyStats(): VillageStats {
  return {
    teleports: 0, pathFails: 0, meals: 0, almsMeals: 0, foraged: 0, breadBaked: 0, breadEaten: 0, cellsTilled: 0, cellsSown: 0,
    cellsHarvested: 0, cellsWatered: 0, cropStages: 0, treesFelled: 0, saplingsPlanted: 0, fishCaught: 0, animalsHunted: 0,
    deliveries: 0, purchases: 0, lampsLit: 0, eggsLaid: 0, woolShorn: 0, livestockBorn: 0, livestockLost: 0, greetings: 0, strays: 0,
  };
}

/** The moment, as every module reads it; refreshed once a simulated second. */
export interface Env {
  now: number;
  day: number;
  hour: number;
  weekday: number;
  season: number;
  seasonProgress: number;
  year: number;
  /** 0 night .. 1 full day. */
  daylight: number;
  /** Dark enough for lanterns. */
  dark: boolean;
  /** Raining or snowing hard enough that outdoor work stops and people shelter. */
  bad: boolean;
  sunrise: number;
  sunset: number;
  temperature: number;
}

export type { Recipe };
