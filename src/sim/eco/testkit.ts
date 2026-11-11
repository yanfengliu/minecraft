// Scaffolding for the wildlife tests: a fixture world, a clock, real weather
// and an `EcoSim` wired together, with helpers to run simulated time and to
// measure what is in the world. Not used by the game.

import { Rng } from '../../core/rng';
import { SOLID, WATER_SOURCE } from '../../world/blocks';
import type { World } from '../../world/world';
import { type EntityView, type LivestockApi, type PlayerView, type SimContext, createBasicActions } from '../api';
import { Clock, DAY_SECONDS, SIM_DT } from '../clock';
import { type Regime, Weather } from '../weather';
import { createFixtureLandscape } from './fixture';
import { type CensusRow, type EcoOptions, EcoSim } from './index';
import type { Populations } from './seeding';
import { FOOD_FLOWER, FOOD_GRASS } from './species';
import { FOOD, countFloor } from './terrain';

export const TICKS_PER_DAY = Math.round(DAY_SECONDS / SIM_DT);

/** No animals at all: for tests of the plants alone, which then run very fast. */
export const NO_ANIMALS: Populations = { deer: 0, rabbit: 0, boar: 0, fox: 0, wolf: 0, songbird: 0, crow: 0, gull: 0, duck: 0, fish: 0 };

/**
 * A number from the environment, for runs longer than the default. The source
 * tree is type-checked without Node's types, so the lookup goes through
 * `globalThis` rather than naming `process`.
 */
export function envNumber(name: string, fallback: number): number {
  const env = (globalThis as { process?: { env?: Record<string, string | undefined> } }).process?.env;
  const raw = env ? env[name] : undefined;
  const n = raw === undefined || raw === '' ? NaN : Number(raw);
  return Number.isFinite(n) ? n : fallback;
}

const fixtures = new Map<number, World>();

/** A fresh copy of the fixture landscape. Building it is the slow part, so each seed is built once and cloned. */
export function fixtureWorld(seed = 1): World {
  let base = fixtures.get(seed);
  if (!base) {
    base = createFixtureLandscape(seed);
    fixtures.set(seed, base);
  }
  return base.clone();
}

export interface RigOptions {
  seed?: number;
  world?: World;
  startDay?: number;
  startHour?: number;
  eco?: EcoOptions;
  /** Pin the weather to one regime instead of letting it run. */
  weather?: Regime;
  people?: EntityView[];
  player?: PlayerView | null;
  livestock?: LivestockApi;
}

export interface Rig {
  world: World;
  clock: Clock;
  weather: Weather;
  ctx: SimContext;
  eco: EcoSim;
  /** Run this many ticks; `each` is called after every one. */
  ticks(n: number, each?: (tick: number) => void): void;
  /** Run this many simulated days (fractions allowed). */
  days(n: number, each?: (tick: number) => void): void;
  count(kind: string): number;
  row(kind: string): CensusRow;
  living(kind?: string): EntityView[];
}

export function makeRig(opts: RigOptions = {}): Rig {
  const seed = opts.seed ?? 1;
  const world = opts.world ?? fixtureWorld(seed);
  const rng = new Rng(seed);
  const clock = new Clock(opts.startHour ?? 6.5, opts.startDay ?? 0);
  const weather = new Weather(rng.fork('weather'), clock);
  if (opts.weather) weather.force(opts.weather);
  const ctx: SimContext = { world, clock, weather, rng, actions: createBasicActions(world), player: opts.player ?? null };
  if (opts.people) {
    const people = opts.people;
    ctx.people = () => people;
  }
  if (opts.livestock) ctx.livestock = opts.livestock;
  const eco = new EcoSim(ctx, opts.eco);
  let done = 0;
  const ticks = (n: number, each?: (tick: number) => void): void => {
    for (let i = 0; i < n; i++) {
      clock.advance(SIM_DT);
      weather.update(SIM_DT);
      eco.tick();
      done++;
      if (each) each(done);
    }
  };
  const row = (kind: string): CensusRow => {
    const r = eco.census().find((c) => c.kind === kind);
    if (!r) throw new Error(`no census row for ${kind}`);
    return r;
  };
  return {
    world, clock, weather, ctx, eco, ticks, row,
    days: (n, each) => ticks(Math.round(n * TICKS_PER_DAY), each),
    count: (kind) => row(kind).count,
    living: (kind) => eco.views.filter((v) => v.anim !== 'dead' && (kind === undefined || v.kind === kind)),
  };
}

/** A stand-in person or farm animal for the simulation to react to. */
export function makeView(id: number, kind: EntityView['kind'], x: number, y: number, z: number): EntityView {
  return { id, kind, look: 0, role: 0, x, y, z, yaw: 0, anim: 'idle', animTime: 0, scale: 1, held: -1, bubble: '' };
}

/** Blocks of forage standing in the world: tall grass, ferns and flowers. */
export function countForage(world: World): number {
  return countFloor(world, (s) => ((FOOD[s] as number) & (FOOD_GRASS | FOOD_FLOWER)) !== 0);
}

export function countState(world: World, lo: number, hi = lo): number {
  return countFloor(world, (s) => s >= lo && s <= hi);
}

/** One line of census: "deer 15 rabbit 56 ...". */
export function censusLine(eco: EcoSim): string {
  return eco.census().map((r) => `${r.kind} ${r.count}${r.away ? `(+${r.away})` : ''}`).join('  ');
}

/** The census as a table, for printing at the end of a season. */
export function censusTable(eco: EcoSim): string {
  const head = 'kind       count  cap  born  died  (age hunger killed hunted)  arrived  away';
  const rows = eco.census().map((r) =>
    `${r.kind.padEnd(9)} ${String(r.count).padStart(6)} ${String(r.cap).padStart(4)} ${String(r.births).padStart(5)} ${String(r.deaths).padStart(5)}  (${String(r.oldAge).padStart(3)} ${String(r.starved).padStart(6)} ${String(r.killed).padStart(6)} ${String(r.hunted).padStart(6)})  ${String(r.arrived).padStart(7)} ${String(r.away).padStart(5)}`);
  return [head, ...rows].join('\n');
}

/**
 * Problems with where an animal is: outside the world, inside a solid block,
 * a fish out of water. Empty when all is well.
 */
export function misplaced(world: World, views: readonly EntityView[]): string[] {
  const out: string[] = [];
  for (const v of views) {
    if (!(v.x >= 0 && v.z >= 0 && v.x < world.sx && v.z < world.sz && v.y >= 0 && v.y < world.sy + 64)) {
      out.push(`${v.kind}#${v.id} is outside the world at ${v.x.toFixed(1)},${v.y.toFixed(1)},${v.z.toFixed(1)}`);
      continue;
    }
    const x = Math.floor(v.x);
    const z = Math.floor(v.z);
    if (SOLID[world.get(x, Math.floor(v.y + 0.4), z)]) out.push(`${v.kind}#${v.id} (${v.anim}) is inside a solid block at ${x},${v.y.toFixed(2)},${z}`);
    if (v.kind === 'fish' && v.anim !== 'dead' && !WATER_SOURCE[world.get(x, Math.floor(v.y), z)]) out.push(`fish#${v.id} is out of the water at ${x},${v.y.toFixed(2)},${z}`);
  }
  return out;
}

