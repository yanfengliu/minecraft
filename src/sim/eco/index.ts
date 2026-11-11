// The wildlife simulation: plants that spread, ripen and seed, and animals
// that live off them and off each other. `EcoSim` is the one way in. It is
// headless and deterministic: it reads the world, the clock and the weather it
// is given, draws all its chance from a stream forked off the context's, and
// changes the world only through `world.set` and `growTree`.
//
// A tick is cheap by construction. Every animal that is going somewhere is
// moved every tick, but each one only thinks every second or two, at a tick of
// its own; groups think for their members less often still; and plants are
// tended by visiting a handful of random columns, never by scanning.

import type { Area, EntityKind, EntityView, InspectInfo, SimContext, WildlifeApi } from '../api';
import { tendMast, updateBand } from './bands';
import { thinkBird } from './birds';
import { needs, wait } from './brain';
import { updateFlock } from './flock';
import { thinkFox, updateDen } from './fox';
import type { PlantCover } from './flora';
import { thinkGrazer } from './grazers';
import { inspectAnimal } from './inspect';
import { advance } from './motion';
import { bury, kill } from './population';
import { type Populations, arrivals, seed } from './seeding';
import {
  BOAR, CROW, DEER, DUCK, FISH, FOX, GT_BAND, GT_FLOCK, GT_PACK, GT_SCHOOL, GT_SOLO, GT_WARREN, GULL, KIND_COUNT, RABBIT,
  SONGBIRD, WILD_KINDS, WOLF, type WildKind, kindIndex,
} from './species';
import { Eco } from './state';
import { type Animal, DIED_AGE, DIED_HUNGER, DIED_HUNTER, DIED_PREDATOR, type Group, ST_HIDE } from './types';
import { catchFish, fishAbundance, tendWaters, thinkFish, updateSchool } from './water';
import { thinkWolf, updatePack } from './wolf';

export type { PlantCover } from './flora';
export type { Populations } from './seeding';
export { WILD_KINDS, type WildKind } from './species';

export interface EcoOptions {
  /** Places wild animals keep out of, such as the village core. Foxes may slip in at night. */
  avoid?: Area[];
  /**
   * How many of each kind to start with, instead of what the habitat would
   * carry. Zero leaves a species out for good; a kind not named gets its
   * natural number. For fish the number is the most that are ever drawn.
   */
  populations?: Populations;
  /**
   * When a species has all but died out, let a few of its kind wander in from
   * beyond the map after some days. On by default: a sandbox should not lose
   * its deer for ever to one hard winter or one keen hunter.
   */
  immigration?: boolean;
}

export interface CensusRow {
  kind: EntityKind;
  /** Living animals of this kind in the world now. */
  count: number;
  /** Totals since the simulation began. */
  births: number;
  deaths: number;
  /** The same deaths, by cause. `hunted` includes fish landed. */
  oldAge: number;
  starved: number;
  killed: number;
  hunted: number;
  /** Arrived from beyond the map after the species had all but died out. */
  arrived: number;
  /** Gone south for the winter and expected back (songbirds). */
  away: number;
  /** The most there can ever be: breeding stops here. */
  cap: number;
}

/** Running totals of what has happened, for tests, tuning and anyone curious. Keyed by kind where that makes sense. */
export interface EcoStats {
  /** Mouthfuls of plants (and berries, and mast) eaten. */
  eaten: Record<string, number>;
  /** Wild animals killed by this kind of hunter. */
  kills: Record<string, number>;
  /** Farm animals taken by this kind of hunter. */
  raids: Record<string, number>;
  /** Plants that have sprouted, saplings that trees have seeded, and saplings that have become trees. */
  sprouted: number;
  saplingsSeeded: number;
  treesGrown: number;
  /** How full the forest floor's larder is, 0..1. */
  mast: number;
  /** Fish in all the waters together, drawn or not. */
  fishStock: number;
}

/** Days of population history kept: four years. */
const HISTORY_DAYS = 112;
/** Ticks between refreshes of the shared view of the hour, the weather and where people are. */
const REFRESH_TICKS = 10;
/** Ticks between re-surveys of one cell of the habitat map. */
const SURVEY_TICKS = 16;

export class EcoSim {
  /** Every wild animal to draw: the living, and the dead for the moments before they are cleared away. */
  readonly views: EntityView[];
  readonly wildlife: WildlifeApi;

  private readonly e: Eco;
  private readonly immigration: boolean;
  private readonly lowDays = new Int32Array(KIND_COUNT);
  private readonly ring = new Uint16Array(KIND_COUNT * HISTORY_DAYS);
  private ringHead = 0;
  private ringCount = 0;
  private lastHour = -1;
  private lastDay = -1;

  constructor(ctx: SimContext, opts: EcoOptions = {}) {
    const e = new Eco(ctx, opts.avoid ?? [], ctx.rng.fork('eco'));
    this.e = e;
    this.views = e.animals;
    this.immigration = opts.immigration ?? true;
    seed(e, opts.populations ?? {});
    this.lastHour = Math.floor(e.now / 60);
    this.lastDay = e.day;
    this.sample();

    this.wildlife = {
      findAnimal: (x, z, radius, kinds) => {
        let mask = 0;
        for (const kind of kinds) {
          const k = kindIndex(kind);
          if (k >= 0) mask |= 1 << k;
        }
        // Not a rabbit down its burrow: the hunter cannot reach what is underground.
        return mask === 0 ? null : e.hash.nearest(x, z, radius, mask, null, ST_HIDE);
      },
      harvest: (id) => {
        const a = e.byId.get(id);
        if (!a || !a.alive) return null;
        // The young yield less; the hunter carries the body off, so it lies only a moment.
        const share = a.scale / a.size;
        const out = { meat: Math.round(a.sp.meat * share), hide: Math.round(a.sp.hide * share) };
        kill(e, a, DIED_HUNTER, 4);
        return out;
      },
      fishAbundance: (x, z) => fishAbundance(e, x, z),
      catchFish: (x, z) => catchFish(e, x, z),
    };
  }

  /** Advance by one `SIM_DT`. The caller has already advanced the clock. */
  tick(): void {
    const e = this.e;
    e.tick++;
    e.now = e.clock.time;
    if (e.tick % REFRESH_TICKS === 1) e.refresh();
    e.flora.tick();
    if (e.tick % SURVEY_TICKS === 0) e.habitat.refreshNext();

    const groups = e.groups;
    const tick = e.tick;
    for (let i = 0; i < groups.length; i++) {
      const g = groups[i] as Group;
      if (tick >= g.nextUpdate && !g.gone) (GROUP_LOGIC[g.sp.groupType] as (e: Eco, g: Group) => void)(e, g);
    }

    advance(e, think);

    if (e.leaving.length > 0) {
      for (const a of e.leaving) bury(e, a);
      e.leaving.length = 0;
    }

    const hour = Math.floor(e.now / 60);
    if (hour !== this.lastHour) {
      this.lastHour = hour;
      this.hourly();
    }
  }

  private hourly(): void {
    const e = this.e;
    tendWaters(e);
    tendMast(e);

    // Groups that have emptied are dropped here rather than in the tick, where the list is being walked.
    const groups = e.groups;
    for (let i = groups.length - 1; i >= 0; i--) {
      if ((groups[i] as Group).gone) groups.splice(i, 1);
    }
    if (e.clock.day !== this.lastDay) {
      this.lastDay = e.clock.day;
      this.sample();
      if (this.immigration) arrivals(e, this.lowDays);
    }
  }

  /** Record today's numbers in the history ring. */
  private sample(): void {
    const e = this.e;
    for (let k = 0; k < KIND_COUNT; k++) this.ring[this.ringHead * KIND_COUNT + k] = e.count[k] as number;
    this.ringHead = (this.ringHead + 1) % HISTORY_DAYS;
    if (this.ringCount < HISTORY_DAYS) this.ringCount++;
  }

  inspect(id: number): InspectInfo | null {
    const a = this.e.byId.get(id);
    return a ? inspectAnimal(this.e, a) : null;
  }

  /** One row per species, in a fixed order. */
  census(): CensusRow[] {
    const e = this.e;
    return WILD_KINDS.map((kind, k) => ({
      kind,
      count: e.count[k] as number,
      births: e.births[k] as number,
      deaths: e.deaths[k] as number,
      oldAge: e.died(k, DIED_AGE),
      starved: e.died(k, DIED_HUNGER),
      killed: e.died(k, DIED_PREDATOR),
      hunted: e.died(k, DIED_HUNTER),
      arrived: e.arrivals[k] as number,
      away: e.awayCount[k] as number,
      cap: e.cap[k] as number,
    }));
  }

  /** Population of each species, one number per simulated day, oldest first; at most the last four years. */
  history(): Record<string, number[]> {
    const out: Record<string, number[]> = {};
    const start = (this.ringHead - this.ringCount + HISTORY_DAYS) % HISTORY_DAYS;
    for (let k = 0; k < KIND_COUNT; k++) {
      const series: number[] = [];
      for (let i = 0; i < this.ringCount; i++) series.push(this.ring[((start + i) % HISTORY_DAYS) * KIND_COUNT + k] as number);
      out[WILD_KINDS[k] as WildKind] = series;
    }
    return out;
  }

  /** How the plants are doing: cover of the open grass and estimates from the columns sampled over the last day. */
  plants(): PlantCover {
    return this.e.flora.cover();
  }

  /** What the animals have eaten and caught and what the plants have done, since the start. */
  stats(): EcoStats {
    const e = this.e;
    const by = (arr: Int32Array): Record<string, number> => Object.fromEntries(WILD_KINDS.map((kind, k) => [kind, arr[k] as number]));
    let stock = 0;
    for (const b of e.habitat.bodies) stock += b.stock;
    return {
      eaten: by(e.eaten),
      kills: by(e.kills),
      raids: by(e.raids),
      sprouted: e.flora.sprouted,
      saplingsSeeded: e.flora.seeded,
      treesGrown: e.flora.treesGrown,
      mast: e.mast / e.mastCap,
      fishStock: stock,
    };
  }
}

/** What a group of each kind does when its turn comes, by `Species.groupType`. */
const GROUP_LOGIC: ((e: Eco, g: Group) => void)[] = [];
GROUP_LOGIC[GT_BAND] = updateBand;
GROUP_LOGIC[GT_WARREN] = updateBand;
GROUP_LOGIC[GT_SOLO] = updateDen;
GROUP_LOGIC[GT_PACK] = updatePack;
GROUP_LOGIC[GT_FLOCK] = updateFlock;
GROUP_LOGIC[GT_SCHOOL] = updateSchool;

/** What an animal of each species does when it thinks, by species index. */
const MIND: ((e: Eco, a: Animal) => void)[] = [];
MIND[DEER] = thinkGrazer;
MIND[RABBIT] = thinkGrazer;
MIND[BOAR] = thinkGrazer;
MIND[FOX] = thinkFox;
MIND[WOLF] = thinkWolf;
MIND[SONGBIRD] = thinkBird;
MIND[CROW] = thinkBird;
MIND[GULL] = thinkBird;
MIND[DUCK] = thinkBird;
MIND[FISH] = thinkFish;

function think(e: Eco, a: Animal): void {
  if (!a.alive) {
    // A body lies where it fell until its time is up.
    if (e.now >= a.removeAt) e.leaving.push(a);
    else wait(e, a, Math.max(0.1, a.removeAt - e.now));
    return;
  }
  // Needs first: an animal that has starved or died of age since it last thought does nothing more.
  if (needs(e, a)) (MIND[a.sp.index] as (e: Eco, a: Animal) => void)(e, a);
}
