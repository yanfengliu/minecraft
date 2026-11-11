// The records the wildlife simulation is made of: one `Animal` per creature
// and one `Group` per herd, warren, pack, flock or school. An `Animal` is also
// the `EntityView` the renderer draws, so nothing is copied each tick and the
// object a caller holds stays the same for the animal's life.
//
// Codes are plain numbers (not enums) because they are compared in the hot
// loop and index small lookup tables.

import type { AnimState, EntityView } from '../api';
import type { WaterBody } from './habitat';
import type { Species, WildKind } from './species';

// --- how an animal is carried forward each tick ---------------------------------
export const MODE_STILL = 0;
export const MODE_WALK = 1;
export const MODE_FLY = 2;
/** Under water, in three dimensions: fish. */
export const MODE_SWIM = 3;
/** On the surface of water: ducks and resting gulls. */
export const MODE_PADDLE = 4;

// --- what an animal is doing -----------------------------------------------------
export const ST_IDLE = 0;
export const ST_WANDER = 1;
/** Looking for food, or walking to some it has found. */
export const ST_SEEK = 2;
export const ST_EAT = 3;
export const ST_REST = 4;
export const ST_SLEEP = 5;
export const ST_FLEE = 6;
/** Ranging for prey. */
export const ST_HUNT = 7;
export const ST_STALK = 8;
export const ST_CHASE = 9;
/** Eating a kill. */
export const ST_FEED = 10;
export const ST_COURT = 11;
/** A youngster keeping to its mother. */
export const ST_FOLLOW = 12;
/** Moving with the group to where it feeds or rests. */
export const ST_TRAVEL = 13;
export const ST_FLY = 14;
export const ST_PERCH = 15;
export const ST_ROOST = 16;
export const ST_SWIM = 17;
export const ST_DABBLE = 18;
/** A rabbit in its burrow. */
export const ST_HIDE = 19;
export const ST_DEAD = 20;

// --- why -----------------------------------------------------------------------
export const WHY_NONE = 0;
export const WHY_HUNGRY = 1;
export const WHY_HABIT = 2;
export const WHY_DAY = 3;
export const WHY_NIGHT = 4;
export const WHY_PERSON = 5;
export const WHY_PREDATOR = 6;
export const WHY_RAIN = 7;
export const WHY_BREED = 8;
export const WHY_MOTHER = 9;
export const WHY_BAND = 10;
export const WHY_TIRED = 11;
export const WHY_FED = 12;
export const WHY_STARVING = 13;
export const WHY_FLOCK = 14;
export const WHY_SEASON = 15;

// --- how an animal died -----------------------------------------------------------
export const DIED_AGE = 0;
export const DIED_HUNGER = 1;
export const DIED_PREDATOR = 2;
export const DIED_HUNTER = 3;
export const CAUSES = 4;

// --- what a group is doing ----------------------------------------------------------
export const GM_FEED = 1;
export const GM_REST = 2;
export const GM_SLEEP = 3;
export const GM_ALARM = 4;
export const GM_SHELTER = 5;
/** A pack on the move after prey, running it down, and eating it. */
export const GM_HUNT = 6;
export const GM_CHASE = 7;
export const GM_FEAST = 8;
/** A flock asleep, perched, feeding, flying somewhere, circling, and leaving for the winter. */
export const FM_ROOST = 10;
export const FM_PERCH = 11;
export const FM_FORAGE = 12;
export const FM_TRANSIT = 13;
export const FM_WHEEL = 14;
export const FM_DEPART = 15;
export const FM_AWAY = 16;

export class Animal implements EntityView {
  // --- EntityView: what the renderer and the inspector read ---
  id = 0;
  kind: WildKind;
  look = 0;
  role = 0;
  x = 0;
  y = 0;
  z = 0;
  yaw = 0;
  anim: AnimState = 'idle';
  animTime = 0;
  scale = 1;
  held = -1;
  bubble = '';
  /** Out of sight, down a burrow: the game neither draws nor picks it. */
  hidden = false;

  // --- identity ---
  sp: Species;
  group: Group;
  female = false;
  /** Clock time of birth, and seconds it will live if nothing else kills it. */
  born = 0;
  lifespan = 0;
  /** Full-grown scale; the young grow toward it. */
  size = 1;
  /** Constitution: how long it lasts once starving, relative to the average. */
  grit = 1;
  /** Starving and out of reach of where its group feeds: it is fending for itself until it has eaten. */
  astray = false;
  alive = true;
  /** Index in the simulation's animal list, or -1 when not in it (dead and removed, or away for the winter). */
  slot = -1;

  // --- needs, each 0..1 ---
  /** 0 sated, 1 starving. */
  hunger = 0;
  energy = 1;
  health = 1;
  /** Clock time of the last thought, for needs that advance between thoughts. */
  thought = 0;

  // --- mind ---
  state = ST_IDLE;
  why = WHY_NONE;
  /** Clock time the current state runs to. */
  until = 0;
  /** Tick at which it next thinks. */
  nextThink = 0;

  // --- motion ---
  mode = MODE_STILL;
  vx = 0;
  vy = 0;
  vz = 0;
  /** Velocity a flier is easing toward. */
  dvx = 0;
  dvy = 0;
  dvz = 0;
  speed = 0;
  /** Animation seconds per block moved, for the current gait. */
  gaitK = 1;
  yawT = 0;
  /** The cell it is in, and the height of what it stands on (fliers: the lowest they may be here). */
  cx = 0;
  cy = 0;
  cz = 0;
  gy = 0;
  /** Where it is walking to, how near counts as there, and blocks left on the current straight. */
  gx = 0;
  gz = 0;
  reach = 0.6;
  leg = 0;
  hasGoal = false;
  /** Set by the movement code when a goal is reached or given up; cleared when a new goal is set. */
  arrived = false;
  failed = false;
  /** Which way round an obstacle it has chosen to go, -1 or 1, or 0 when not detouring. */
  side = 0;
  stuck = 0;
  /** Ignores avoided areas: a fox slipping into the village at night. */
  bold = false;

  // --- spatial hash ---
  hcell = -1;
  hnext: Animal | null = null;
  hprev: Animal | null = null;

  // --- food ---
  foodX = 0;
  foodY = 0;
  foodZ = 0;
  hasFood = false;

  // --- danger ---
  /** Danger has been noticed: until when, where it was, and whether it was a hunter or a person (a WHY_ code). */
  alarmUntil = 0;
  alarmX = 0;
  alarmZ = 0;
  alarmWhy = 0;

  // --- family ---
  mother: Animal | null = null;
  /** Unweaned young depending on this animal. */
  young = 0;
  /** Clock time she gives birth, or 0. */
  dueAt = 0;
  nextBreed = 0;

  // --- hunting ---
  prey: Animal | null = null;
  /** A farm animal it is after, known only by its view. */
  quarry: EntityView | null = null;
  chaseUntil = 0;
  /** Clock times before which it will not start another hunt, or another raid on the village. */
  nextHunt = 0;
  nextRaid = 0;
  /** Hunger the kill it is eating will take off. */
  meal = 0;

  // --- flight ---
  /** Where it means to land. */
  px = 0;
  py = 0;
  pz = 0;
  landing = false;
  landTries = 0;
  /** Height it likes to keep over the ground when flying. */
  cruise = 6;
  /** `airFloor` of the column it is perched in, to notice the perch being cut away. */
  perchFloor = 0;

  // --- death ---
  /** Clock time the body is cleared away. */
  removeAt = 0;
  /** Brought down by a hunter's arrow and not yet fetched: the body is the hunter's to take. */
  shot = false;

  constructor(sp: Species, group: Group) {
    this.sp = sp;
    this.kind = sp.kind;
    this.group = group;
  }
}

export class Group {
  members: Animal[] = [];
  /** Home: the den, warren or roost. */
  hx = 0;
  hz = 0;
  /** Where the group is feeding, flying to or hunting toward. */
  ax = 0;
  az = 0;
  /** Where the group lies up. */
  bx = 0;
  bz = 0;
  hasFeed = false;
  hasCover = false;
  coverDay = -1;
  feedUntil = 0;
  /** Centre of the members, and for a flock the drift of those in the air. */
  mx = 0;
  my = 0;
  mz = 0;
  mvx = 0;
  mvz = 0;
  flying = 0;
  /** Mean hunger of the members. */
  hunger = 0;
  mode = 0;
  /** What a flock does when it lands. */
  then = 0;
  until = 0;
  nextUpdate = 0;
  alarmUntil = 0;
  alarmX = 0;
  alarmZ = 0;
  /** Failed searches for food since the feeding ground was chosen. */
  misses = 0;
  /** How far from the warren its rabbits graze; grows as the grass nearby is eaten down. */
  range = 10;
  rangeDay = -1;
  nextCourt = 0;
  /** Clock time before which the group will not try again to divide. */
  nextSplit = 0;
  /** Species (as a mask of species bits) whose trail a pack has picked up today; `rangeDay` is the day that was decided. */
  finds = 0;
  /** A pack's quarry: a wild animal, or a farm animal known only by its view. */
  target: Animal | null = null;
  raid: EntityView | null = null;
  chaseUntil = 0;
  restUntil = 0;
  /** Hunger the kill being eaten will take off the whole pack between them, and where it lies. */
  meal = 0;
  kx = 0;
  ky = 0;
  kz = 0;
  /** A flock feeding at a ripe bush, whose cell is (kx, ky, kz). */
  atBush = false;
  /** A flock told to land, the way it circles, and how wide. */
  landing = false;
  spin = 1;
  radius = 12;
  /** A flock that winters elsewhere, and its members while they are gone. */
  migratory = false;
  absent: Animal[] = [];
  /** The water a raft of ducks or a school of fish lives on. */
  body: WaterBody | null = null;
  gone = false;

  constructor(readonly id: number, readonly sp: Species) {}
}
