import { describe, expect, it } from 'vitest';
import { Rng } from '../core/rng';
import { Clock, DAYS_PER_YEAR, DAY_SECONDS, SIM_DT } from './clock';
import { daylight, sunDirection, sunTimes } from './sky';
import { REGIMES, Weather } from './weather';

/** One simulated year of weather, sampled once a simulated minute. */
function runYear(seed: number, visit: (w: Weather, c: Clock) => void): void {
  const clock = new Clock(0, 0);
  const weather = new Weather(new Rng(seed), clock);
  const steps = Math.round((DAYS_PER_YEAR * DAY_SECONDS) / SIM_DT);
  for (let i = 0; i < steps; i++) {
    clock.advance(SIM_DT);
    weather.update(SIM_DT);
    if (i % 600 === 0) visit(weather, clock);
  }
}

describe('sky', () => {
  it('puts the sun up by day and down by night all year', () => {
    for (let day = 0; day < DAYS_PER_YEAR; day++) {
      expect(sunDirection(new Clock(12, day)).y).toBeGreaterThan(0.2);
      expect(sunDirection(new Clock(0, day)).y).toBeLessThan(-0.2);
      const { rise, set } = sunTimes(new Clock(12, day));
      expect(rise).toBeGreaterThan(3);
      expect(rise).toBeLessThan(9);
      expect(set).toBeGreaterThan(15);
      expect(set).toBeLessThan(21);
      expect(daylight(new Clock(rise + 1.5, day))).toBeGreaterThan(0.9);
    }
  });

  it('has longer days in summer than in winter', () => {
    const summer = sunTimes(new Clock(12, 10));
    const winter = sunTimes(new Clock(12, 24));
    expect(summer.set - summer.rise).toBeGreaterThan(winter.set - winter.rise + 4);
  });
});

describe('weather', () => {
  it('is the same for the same seed and differs for another', () => {
    const trace = (seed: number): string => {
      const out: string[] = [];
      runYear(seed, (w, c) => {
        if (Math.floor(c.hour) % 6 === 0) out.push(`${w.regime}:${w.cloudCover.toFixed(4)}:${w.temperature.toFixed(3)}:${w.fog.toFixed(4)}`);
      });
      return out.join('|');
    };
    const a = trace(7);
    expect(trace(7)).toBe(a);
    expect(trace(8)).not.toBe(a);
  });

  it('keeps every quantity in range through a year and visits every regime', () => {
    const seen = new Set<string>();
    let snowed = false;
    let rained = false;
    let hottest = -Infinity;
    let coldest = Infinity;
    runYear(20261111, (w) => {
      seen.add(w.regime);
      for (const v of [w.cloudCover, w.precipitation, w.fog, w.wetness, w.snowCover, w.storminess]) {
        expect(v).toBeGreaterThanOrEqual(0);
        expect(v).toBeLessThanOrEqual(1);
      }
      expect(Math.hypot(w.windX, w.windZ)).toBeCloseTo(w.windSpeed, 5);
      expect(w.windSpeed).toBeLessThan(30);
      // Snow needs frost; rain needs cloud.
      if (w.snowing) {
        snowed = true;
        expect(w.temperature).toBeLessThan(0.8);
      }
      if (w.isRaining) {
        rained = true;
        expect(w.cloudCover).toBeGreaterThan(0.5);
      }
      hottest = Math.max(hottest, w.temperature);
      coldest = Math.min(coldest, w.temperature);
    });
    for (const r of REGIMES) expect(seen.has(r), `regime ${r} never occurred`).toBe(true);
    expect(rained).toBe(true);
    expect(snowed).toBe(true);
    expect(hottest).toBeGreaterThan(22);
    expect(hottest).toBeLessThan(36);
    expect(coldest).toBeLessThan(-2);
    expect(coldest).toBeGreaterThan(-20);
  });

  it('lays mist on some clear, still dawns and clears it by midday', () => {
    const clock = new Clock(0, 0);
    const weather = new Weather(new Rng(3), clock);
    weather.force('clear');
    let mistyDawns = 0;
    let clearDawns = 0;
    for (let day = 0; day < 14; day++) {
      let dawnPeak = 0;
      for (let i = 0; i < DAY_SECONDS / SIM_DT; i++) {
        clock.advance(SIM_DT);
        weather.update(SIM_DT);
        const rise = sunTimes(clock).rise;
        if (Math.abs(clock.hour - rise) < 1) dawnPeak = Math.max(dawnPeak, weather.fog);
        if (clock.hour > 13 && clock.hour < 20) expect(weather.fog).toBeLessThan(0.06);
      }
      if (dawnPeak > 0.25) mistyDawns++;
      if (dawnPeak < 0.08) clearDawns++;
    }
    expect(mistyDawns).toBeGreaterThanOrEqual(3);
    expect(clearDawns).toBeGreaterThanOrEqual(1);
  });
});
