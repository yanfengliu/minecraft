// Runs the village with nothing else attached: a clock, the weather model and
// the fixture world. Used by the soak tests, and a worked example of the three
// calls the game makes each step (advance the clock, update the weather, tick).

import { Rng } from '../../core/rng';
import type { World } from '../../world/world';
import { type SimContext, type VillagePlan, type WildlifeApi, createBasicActions } from '../api';
import { Clock, DAY_SECONDS, SIM_DT } from '../clock';
import { Weather } from '../weather';
import { createFixtureVillage } from './fixture';
import { VillageSim } from './index';

export interface HeadlessOptions {
  startHour?: number;
  startDay?: number;
  wildlife?: WildlifeApi;
  /** Called for every cue the simulation emits (smoke, sparks, chop, ...). */
  onEffect?: (kind: string, x: number, y: number, z: number) => void;
}

export interface Headless {
  world: World;
  plan: VillagePlan;
  clock: Clock;
  weather: Weather;
  ctx: SimContext;
  sim: VillageSim;
  /** Advance the clock, the weather and the village by this many ticks. */
  step(ticks: number): void;
  /** Step until the clock reaches the given day and hour. */
  runTo(day: number, hour: number): void;
}

export const TICKS_PER_DAY = Math.round(DAY_SECONDS / SIM_DT);

export function createHeadlessVillage(seed = 1, options: HeadlessOptions = {}): Headless {
  const { world, plan } = createFixtureVillage(seed);
  const rng = new Rng(seed);
  const clock = new Clock(options.startHour ?? 6.5, options.startDay ?? 0);
  const weather = new Weather(rng.fork('weather'), clock);
  const actions = createBasicActions(world);
  if (options.onEffect) actions.effect = options.onEffect;
  const ctx: SimContext = { world, clock, weather, rng, actions, player: null };
  if (options.wildlife) ctx.wildlife = options.wildlife;
  const sim = new VillageSim(ctx, plan);
  const step = (ticks: number): void => {
    for (let i = 0; i < ticks; i++) {
      clock.advance(SIM_DT);
      weather.update(SIM_DT);
      sim.tick();
    }
  };
  const runTo = (day: number, hour: number): void => {
    const target = day * DAY_SECONDS + hour * 60;
    while (clock.time < target - 1e-6) step(1);
  };
  return { world, plan, clock, weather, ctx, sim, step, runTo };
}
