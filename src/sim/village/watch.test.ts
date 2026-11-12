// The watch and the street lamps when a lamp cannot be seen to: its lantern
// broken off the post, or the post walled in. Either way the rest of the round
// is done on foot, and nobody of the watch is kept from supper or the patrol by
// a lamp there is nothing to be done about.

import { describe, expect, it } from 'vitest';
import { B } from '../../world/blocks';
import type { Cell } from '../api';
import { sunTimes } from '../sky';
import { FEET } from './fixture-build';
import { TRADE } from './goods';
import { type Headless, createHeadlessVillage } from './headless';
import { MEAL_SUPPER, type Resident } from './model';
import { DUTY_FIRST, dutyOf } from './watch';

const ROUND = 'Lighting the street lamps';
const PATROL = 'Walking the night patrol';

interface Evening {
  /** Hour at which every lamp in `lamps` was first seen burning, or -1. */
  allLitAt: number;
  /** Last hour at which anyone of the watch was on the lamp round. */
  lastRound: number;
  /** Whether the guards off watch had eaten supper by a quarter past seven. */
  supperByQuarterPast: boolean;
  /** Share of the hour from half an hour after sunset that the first watch spent on patrol. */
  patrolShare: number;
  sunset: number;
}

/** Run the fixture village from noon to half past ten at night and note what the watch does about `lamps`. */
function evening(h: Headless, guards: Resident[], lamps: Cell[]): Evening {
  const { world, clock } = h;
  const first = guards.find((g) => dutyOf(guards.length, g, clock.day) === DUTY_FIRST) as Resident;
  const sunset = sunTimes(clock).set;
  const out: Evening = { allLitAt: -1, lastRound: -1, supperByQuarterPast: false, patrolShare: 0, sunset };
  let supperSeen = false;
  let dark = 0;
  let onPatrol = 0;
  while (clock.hour < 22.5) {
    h.step(10);
    const hour = clock.hour;
    if (out.allLitAt < 0 && lamps.every((c) => world.get(c.x, c.y, c.z) === B.lantern + 1)) out.allLitAt = hour;
    if (guards.some((g) => !g.asleep && g.activity === ROUND)) out.lastRound = hour;
    if (!supperSeen && hour >= 19.25) {
      supperSeen = true;
      out.supperByQuarterPast = guards.every((g) => g === first || (g.meals & MEAL_SUPPER) !== 0);
    }
    if (hour >= sunset + 0.5 && hour < sunset + 1.5) {
      dark++;
      if (first.activity === PATROL) onPatrol++;
    }
  }
  out.patrolShare = onPatrol / dark;
  return out;
}

function watchOf(h: Headless): Resident[] {
  const guards = h.sim.core.residents.filter((r) => r.trade === TRADE.guard);
  expect(guards.length).toBe(3);
  return guards;
}

describe('the watch and a street lamp that cannot be seen to', () => {
  it('lets a lamp with no lantern be: the others are lit, and then it is supper and the patrol', () => {
    const h = createHeadlessVillage(3);
    const { sim, world, plan } = h;
    const guards = watchOf(h);
    h.runTo(0, 12);
    const gone = plan.lamps[3] as Cell;
    world.set(gone.x, gone.y, gone.z, B.air);
    const there = plan.lamps.filter((c) => c !== gone);
    const e = evening(h, guards, there);

    // The round is walked as on any evening, and is over when the last lamp that is there burns.
    expect(e.allLitAt).toBeGreaterThan(e.sunset - 1.25);
    expect(e.allLitAt).toBeLessThan(e.sunset + 0.5);
    expect(e.lastRound).toBeLessThanOrEqual(e.allLitAt + 0.05);
    // One lighting to a lamp: nobody went back to the empty post, again and again, to light nothing.
    expect(sim.stats.lampsLit).toBe(there.length);
    expect(world.get(gone.x, gone.y, gone.z)).toBe(B.air);
    // The watch got on with the evening.
    expect(e.supperByQuarterPast).toBe(true);
    expect(e.patrolShare).toBeGreaterThan(0.9);
    expect(sim.stats.teleports).toBe(0);

    // A lantern hung on the post again is a lamp again.
    world.set(gone.x, gone.y, gone.z, B.lantern);
    h.step(600);
    expect(world.get(gone.x, gone.y, gone.z)).toBe(B.lantern + 1);
  });

  it('does not wait on a lamp that is walled in: it is lit late, and the watch is not held up', () => {
    const h = createHeadlessVillage(3);
    const { sim, world, plan } = h;
    const guards = watchOf(h);
    h.runTo(0, 12);
    // A wall round the post, two blocks off: there is ground beside the lamp, and no way to it.
    const shut = plan.lamps[3] as Cell;
    for (let dz = -2; dz <= 2; dz++) {
      for (let dx = -2; dx <= 2; dx++) {
        if (Math.max(Math.abs(dx), Math.abs(dz)) !== 2) continue;
        for (let y = FEET; y < FEET + 3; y++) world.set(shut.x + dx, y, shut.z + dz, B.stone);
      }
    }
    const reachable = plan.lamps.filter((c) => c !== shut);
    const fails = sim.stats.pathFails;
    const e = evening(h, guards, reachable);

    expect(e.allLitAt).toBeGreaterThan(e.sunset - 1.25);
    expect(e.allLitAt).toBeLessThan(e.sunset + 0.5);
    expect(e.supperByQuarterPast).toBe(true);
    expect(e.patrolShare).toBeGreaterThan(0.9);
    // It was tried, found out of reach, and left for the night: not tried again by each of the watch in turn.
    expect(sim.stats.pathFails - fails).toBeGreaterThan(0);
    expect(sim.stats.pathFails - fails).toBeLessThanOrEqual(2);
    // Lit all the same once it was three hours overdue, without anybody being carried to it.
    expect(world.get(shut.x, shut.y, shut.z)).toBe(B.lantern + 1);
    expect(sim.stats.lampsLit).toBe(reachable.length);
    expect(sim.stats.teleports).toBe(0);
  });
});
