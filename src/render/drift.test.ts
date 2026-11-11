import { describe, expect, it } from 'vitest';
import { CLOUD_WRAP, Drift, PRECIP_CLOCK_WRAP } from './drift';

describe('what the wind has carried', () => {
  it('moves the clouds by the wind there was, not by the wind there is', () => {
    const drift = new Drift();
    let t = 0;
    // An hour of steady wind along x...
    for (let i = 0; i <= 3600 * 60; i++) drift.advance((t = i / 60), 4, 0);
    const after = drift.cloudX;
    expect(after).toBeCloseTo((4 * 2.2 * 3600) % CLOUD_WRAP, 3);
    // ...then the wind swings round. In the next frame the clouds have moved by one frame of the new
    // wind, a few centimetres, not by an hour of it.
    drift.advance(t + 1 / 60, -3, 5);
    expect(Math.abs(drift.cloudX - after)).toBeLessThan(0.2);
    expect(Math.abs(drift.cloudZ)).toBeLessThan(0.2);
  });

  it('wraps so that nothing the shaders make of it jumps', () => {
    const drift = new Drift();
    let t = 0;
    const wind = 14;
    let wraps = 0;
    let last = 0;
    for (let i = 0; i < 200000; i++) {
      t += 0.1;
      drift.advance(t, wind, 0);
      if (drift.cloudX < last) wraps++;
      last = drift.cloudX;
      expect(drift.cloudX).toBeGreaterThanOrEqual(0);
      expect(drift.cloudX).toBeLessThan(CLOUD_WRAP);
      expect(drift.clock).toBeLessThan(PRECIP_CLOCK_WRAP);
    }
    expect(wraps).toBeGreaterThan(5);
    // The cloud noise repeats every 2300 m and its detail every 420 m: the wrap is a whole number of both.
    expect(CLOUD_WRAP % 2300).toBe(0);
    expect(CLOUD_WRAP % 420).toBe(0);
    // Every fall speed covers a multiple of six 26 m boxes in one turn of the clock, so each drop keeps its place in its round of six.
    for (let k = 0; k < 5; k++) {
      for (const speed of [0.75 * (12 + k), 0.125 * (10 + k)]) {
        const boxes = (speed * PRECIP_CLOCK_WRAP) / 26;
        expect(boxes).toBeCloseTo(Math.round(boxes), 9);
        expect(Math.round(boxes) % 6).toBe(0);
      }
    }
  });

  it('does not count a long pause as weather', () => {
    const drift = new Drift();
    drift.advance(10, 5, 0);
    drift.advance(10.016, 5, 0);
    const before = drift.cloudX;
    // The tab was hidden for an hour.
    drift.advance(3610, 5, 0);
    expect(drift.cloudX - before).toBeLessThan(5 * 2.2 * 0.26);
  });
});
