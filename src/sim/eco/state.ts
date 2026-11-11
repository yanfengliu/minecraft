// Everything the wildlife simulation shares between its parts: the world and
// clock it reads, the animals and their groups, the tallies behind the census,
// and a snapshot of the hour, season and weather that is refreshed once a
// simulated second so no animal has to work them out for itself.

import { clamp, mod } from '../../core/math';
import type { Rng } from '../../core/rng';
import type { World } from '../../world/world';
import type { Area, EntityView, SimContext } from '../api';
import { type Clock, hourIn } from '../clock';
import { daylight, sunTimes } from '../sky';
import type { WeatherView } from '../weather';
import { Flora } from './flora';
import { Habitat, type Spot } from './habitat';
import { HASH_CELL, SpatialHash } from './spatial';
import { ACT_FEED, ALL_KINDS, KIND_COUNT, SPECIES, type Species } from './species';
import { type Animal, CAUSES, type Group } from './types';

const NOBODY: readonly EntityView[] = [];
/** People are noticed from at most this far, in hash cells and in blocks: both must cover the longest flight distance. */
const PEOPLE_REACH = 2;
const ROUSE = 22;

export class Eco {
  readonly world: World;
  readonly clock: Clock;
  readonly weather: WeatherView;
  readonly rng: Rng;
  readonly habitat: Habitat;
  readonly hash: SpatialHash;
  readonly flora: Flora;
  readonly avoid: readonly Area[];

  /** Every animal the renderer should draw: the living, and the dead not yet cleared away. */
  readonly animals: Animal[] = [];
  readonly groups: Group[] = [];
  readonly byId = new Map<number, Animal>();
  /** Animals to drop from `animals` at the end of this tick. */
  readonly leaving: Animal[] = [];
  nextId = 100000;
  nextGroup = 1;

  // --- the moment, refreshed once a second ---
  tick = 0;
  now = 0;
  day = 0;
  hour = 0;
  /** 0 spring .. 3 winter, and progress through it. */
  season = 0;
  seasonT = 0;
  /** 0 night .. 1 full day. */
  light = 1;
  night = false;
  raining = false;
  wetness = 0;
  /** What each species does at this hour: ACT_FEED, ACT_REST or ACT_SLEEP. */
  readonly act = new Uint8Array(KIND_COUNT);

  // --- people ---
  people: readonly EntityView[] = NOBODY;
  private readonly peopleStamp: Uint32Array;
  private peopleEpoch = 0;
  private readonly hashNx: number;
  private readonly hashNz: number;
  /** Where the person found by the last `personNear` call stands. */
  px = 0;
  pz = 0;

  // --- census ---
  readonly count = new Int32Array(KIND_COUNT);
  readonly births = new Int32Array(KIND_COUNT);
  readonly deaths = new Int32Array(KIND_COUNT);
  readonly deathsBy = new Int32Array(KIND_COUNT * CAUSES);
  readonly arrivals = new Int32Array(KIND_COUNT);
  /** Songbirds that have flown south and are expected back. */
  readonly awayCount = new Int32Array(KIND_COUNT);
  readonly cap = new Int32Array(KIND_COUNT);
  readonly maxGroups = new Int32Array(KIND_COUNT);
  readonly groupCount = new Int32Array(KIND_COUNT);
  /** Mouthfuls of plants eaten, and kills made, by each species. */
  readonly eaten = new Int32Array(KIND_COUNT);
  readonly kills = new Int32Array(KIND_COUNT);
  /** Farm animals taken by each species. */
  readonly raids = new Int32Array(KIND_COUNT);

  // --- the forest floor's larder, which the boar root through ---
  mast = 0;
  mastCap = 0;

  /** Scratch space, so that queries on the hot path allocate nothing. */
  readonly spot: Spot = { x: 0, y: 0, z: 0 };
  readonly found: Animal[] = [];

  constructor(readonly ctx: SimContext, avoid: readonly Area[], rng: Rng) {
    this.world = ctx.world;
    this.clock = ctx.clock;
    this.weather = ctx.weather;
    this.rng = rng;
    this.avoid = avoid;
    this.habitat = new Habitat(ctx.world, avoid);
    this.hash = new SpatialHash(ctx.world.sx, ctx.world.sz);
    this.hashNx = Math.ceil(ctx.world.sx / HASH_CELL);
    this.hashNz = Math.ceil(ctx.world.sz / HASH_CELL);
    this.peopleStamp = new Uint32Array(this.hashNx * this.hashNz);
    this.refresh();
    // Plants draw from their own stream, so what the animals do never reorders what grows where.
    this.flora = new Flora(this, rng.fork('flora'));
  }

  /** Re-read the clock, the sky, the weather and where the people are. */
  refresh(): void {
    const clock = this.clock;
    this.now = clock.time;
    this.day = clock.day;
    this.hour = clock.hour;
    this.season = clock.seasonIndex;
    this.seasonT = clock.seasonProgress;
    this.light = daylight(clock);
    this.night = this.light < 0.25;
    this.raining = this.weather.isRaining;
    this.wetness = this.weather.wetness;

    const { rise, set } = sunTimes(clock);
    const h = this.hour;
    for (let k = 0; k < KIND_COUNT; k++) {
      const habit = (SPECIES[k] as Species).habit;
      const a0 = rise + habit[0];
      const a1 = rise + habit[1];
      const b0 = set + habit[2];
      const b1 = set + habit[3];
      let act = ACT_FEED;
      if (!hourIn(h, mod(a0, 24), mod(a1, 24)) && !hourIn(h, mod(b0, 24), mod(b1, 24))) {
        // Between the morning and evening feeds it is midday; otherwise the dead of night.
        act = a1 < b0 && h >= a1 && h < b0 ? habit[4] : habit[5];
      }
      this.act[k] = act;
    }

    // Stamp the hash cells people are near, so an animal far from anyone learns that from one read.
    const people = this.ctx.people ? this.ctx.people() : NOBODY;
    this.people = people;
    this.peopleEpoch++;
    for (let p = 0; p < people.length; p++) {
      const q = people[p] as EntityView;
      this.stampNear(q.x, q.z);
      this.rouse(q.x, q.y, q.z);
    }
    const player = this.ctx.player;
    if (player) {
      this.stampNear(player.x, player.z);
      this.rouse(player.x, player.y, player.z);
    }
  }

  /**
   * Wake every animal that a person at this point is too close to. This is
   * what lets an animal that is asleep, or walking somewhere, go many seconds
   * without a thought: it does not have to keep looking up to see who is coming.
   */
  private rouse(x: number, y: number, z: number): void {
    const n = this.hash.collect(x, z, ROUSE, ALL_KINDS, this.found);
    const soon = this.tick + 1;
    for (let i = 0; i < n; i++) {
      const a = this.found[i] as Animal;
      if (a.nextThink <= soon) continue;
      const dx = a.x - x;
      const dy = a.y - y;
      const dz = a.z - z;
      if (dx * dx + dy * dy + dz * dz < a.sp.flight * a.sp.flight) a.nextThink = soon;
    }
  }

  private stampNear(x: number, z: number): void {
    const ci = Math.floor(x / HASH_CELL);
    const cj = Math.floor(z / HASH_CELL);
    const i0 = Math.max(0, ci - PEOPLE_REACH);
    const i1 = Math.min(this.hashNx - 1, ci + PEOPLE_REACH);
    const j0 = Math.max(0, cj - PEOPLE_REACH);
    const j1 = Math.min(this.hashNz - 1, cj + PEOPLE_REACH);
    for (let j = j0; j <= j1; j++) {
      for (let i = i0; i <= i1; i++) this.peopleStamp[j * this.hashNx + i] = this.peopleEpoch;
    }
  }

  /**
   * Is a person (a villager or the player) within `dist` blocks of this point?
   * Height counts, so a bird high in a tree ignores someone walking beneath.
   * Leaves the nearest one's position in `px`, `pz`.
   */
  personNear(x: number, y: number, z: number, dist: number): boolean {
    const ci = clamp(Math.floor(x / HASH_CELL), 0, this.hashNx - 1);
    const cj = clamp(Math.floor(z / HASH_CELL), 0, this.hashNz - 1);
    if (this.peopleStamp[cj * this.hashNx + ci] !== this.peopleEpoch) return false;
    let best = dist * dist;
    let found = false;
    const people = this.people;
    for (let p = 0; p < people.length; p++) {
      const q = people[p] as EntityView;
      const dx = q.x - x;
      const dy = q.y - y;
      const dz = q.z - z;
      const d = dx * dx + dy * dy + dz * dz;
      if (d < best) {
        best = d;
        this.px = q.x;
        this.pz = q.z;
        found = true;
      }
    }
    const player = this.ctx.player;
    if (player) {
      const dx = player.x - x;
      const dy = player.y - y;
      const dz = player.z - z;
      if (dx * dx + dy * dy + dz * dz < best) {
        this.px = player.x;
        this.pz = player.z;
        found = true;
      }
    }
    return found;
  }

  /** Death tally of one species by one cause. */
  died(kind: number, cause: number): number {
    return this.deathsBy[kind * CAUSES + cause] as number;
  }
}
