import { describe, expect, it } from 'vitest';
import { Clock, SIM_DT } from '../sim/clock';
import type { WeatherView } from '../sim/weather';
import { Environment } from './environment';

const FAIR: WeatherView = {
  regime: 'fair', cloudCover: 0.3, precipitation: 0, snowing: false, windX: 2, windZ: 1, windSpeed: 2.2, fog: 0.03,
  temperature: 10, wetness: 0, snowCover: 0, storminess: 0, isRaining: false,
};

describe('the environment', () => {
  it('integrates the sky when the clock moves the sun and moon, not once a frame', () => {
    // Both integrals used to run on every frame: some two thousand samples and three thousand short-lived
    // tuples, although the clock, and so the sun, moves only ten times a second and not at all in a pause.
    const clock = new Clock(15);
    const env = new Environment();
    env.update(clock, FAIR, 1, 0, 1 / 60);
    expect(env.skyIntegrations).toBe(2);
    for (let frame = 0; frame < 30; frame++) env.update(clock, FAIR, 1, 0, 1 / 60);
    expect(env.skyIntegrations).toBe(2);
    // One step of the simulation: the sun and the moon have each moved, and each is done once more.
    clock.advance(SIM_DT);
    for (let frame = 0; frame < 6; frame++) env.update(clock, FAIR, 1, 0, 1 / 60);
    expect(env.skyIntegrations).toBe(4);
  });

  it('lights the scene the same whether it had to integrate or not', () => {
    const clock = new Clock(17.5);
    const fresh = new Environment();
    fresh.update(clock, FAIR, 1, 0, 0);
    const kept = new Environment();
    for (let frame = 0; frame < 4; frame++) kept.update(clock, FAIR, 1, 0, 0);
    expect(kept.keyColor).toEqual(fresh.keyColor);
    expect(kept.ambientSky).toEqual(fresh.ambientSky);
    expect(kept.ambientGround).toEqual(fresh.ambientGround);
    expect(kept.exposure).toBe(fresh.exposure);
    // And it is light: a late-afternoon sun and a sky above it.
    expect(fresh.keyColor[0]).toBeGreaterThan(1);
    expect(fresh.ambientSky[2]).toBeGreaterThan(0.1);
  });

  it('follows the sun through a day without holding on to a stale sky', () => {
    const clock = new Clock(4);
    const env = new Environment();
    const blue: number[] = [];
    for (let hour = 4; hour <= 12; hour += 2) {
      clock.time = hour * 60;
      env.update(clock, FAIR, 1, 0, 0);
      blue.push(env.ambientSky[2]);
    }
    for (let i = 1; i < blue.length; i++) expect(blue[i]!, `sky at ${4 + i * 2} h`).toBeGreaterThan(blue[i - 1]!);
  });
});
