// The cost of a simulated day. The game runs the village at up to 60 times
// real time, which is ten ticks a frame: a day of 14400 ticks has to fit well
// inside a second and a half for that to leave the frame anything to spare.

import { describe, expect, it } from 'vitest';
import { TICKS_PER_DAY, createHeadlessVillage } from './headless';

describe('village performance', () => {
  it('simulates a day in well under 1.5 seconds', () => {
    const h = createHeadlessVillage(11);
    // The first day pays for compiling the code and filling the route cache; it is timed, but the budget is judged on the days after.
    const days: number[] = [];
    for (let d = 0; d < 4; d++) {
      const t0 = performance.now();
      h.step(TICKS_PER_DAY);
      days.push(performance.now() - t0);
    }
    const steady = days.slice(1);
    const worst = Math.max(...steady);
    const mean = steady.reduce((a, b) => a + b, 0) / steady.length;
    const nav = h.sim.core.nav.stats;
    console.log(
      `performance: ${h.sim.core.residents.length} residents, ${h.sim.core.animals.length} animals; first day ${days[0]!.toFixed(0)} ms, then ${steady.map((d) => d.toFixed(0)).join(', ')} ms `
      + `(mean ${mean.toFixed(0)} ms/day, ${(mean / TICKS_PER_DAY * 1000).toFixed(1)} us/tick); `
      + `routes: ${nav.requests} asked, ${nav.cacheHits} from cache, ${nav.searches} searched, ${nav.expansions} cells expanded`,
    );
    expect(days[0]).toBeLessThan(1500);
    expect(worst).toBeLessThan(1500);
    expect(h.sim.stats.teleports).toBe(0);
  });
});
