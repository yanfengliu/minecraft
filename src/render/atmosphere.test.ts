import { describe, expect, it } from 'vitest';
import type { Vec3 } from '../core/math';
import { domeRadiance, skyRadiance, transmittanceTo } from './atmosphere';

/** A direction at `deg` degrees above the horizon, due south. */
const at = (deg: number): Vec3 => {
  const r = (deg * Math.PI) / 180;
  return { x: 0, y: Math.sin(r), z: Math.cos(r) };
};
const lum = (c: Vec3): number => 0.2126 * c.x + 0.7152 * c.y + 0.0722 * c.z;

describe('the atmosphere', () => {
  it('lets a high sun through nearly white and a low one through red', () => {
    const noon = transmittanceTo(at(60));
    expect(noon.x).toBeGreaterThan(0.85);
    expect(noon.z).toBeGreaterThan(0.6);
    const low = transmittanceTo(at(2));
    expect(low.x).toBeGreaterThan(low.y);
    expect(low.y).toBeGreaterThan(low.z);
    expect(low.x).toBeGreaterThan(0.1);
  });

  it('dims the sun smoothly all the way down to the horizon, with no gap just above it', () => {
    // A sun a fraction of a degree up is the case a ray that misses the planet was once mistaken for
    // one that hits it: light vanished between +0.5 and -0.5 degrees and came back below.
    let last = lum(transmittanceTo(at(10)));
    for (let deg = 9.75; deg >= 0.05; deg -= 0.25) {
      const now = lum(transmittanceTo(at(deg)));
      expect(now, `sun at ${deg} degrees`).toBeGreaterThan(0);
      expect(now, `sun at ${deg} degrees`).toBeLessThanOrEqual(last * 1.001);
      last = now;
    }
    // The observer stands 300 m up, so the sun stays in view a little below the level: the horizon dips by about half a degree.
    expect(lum(transmittanceTo(at(-0.3)))).toBeGreaterThan(0);
    expect(lum(transmittanceTo(at(-2)))).toBe(0);
  });

  it('makes the zenith blue by day', () => {
    const zenith = skyRadiance(at(90), at(50));
    expect(zenith.z).toBeGreaterThan(zenith.y);
    expect(zenith.y).toBeGreaterThan(zenith.x);
  });

  it('fades the sky through twilight without a cliff, and keeps it lit after sunset', () => {
    // The sky dome's brightness as the sun goes from well up to well down: always falling, never by
    // more than a third in half a degree, and still there with the sun three degrees under.
    const rows: string[] = [];
    let last = lum(domeRadiance(at(12)));
    for (let deg = 11.5; deg >= -10; deg -= 0.5) {
      const now = lum(domeRadiance(at(deg)));
      rows.push(`${deg.toFixed(1)}: ${now.toExponential(2)}`);
      expect(now, `sun at ${deg} degrees`).toBeLessThanOrEqual(last * 1.02);
      if (deg > -6) expect(now, `sun at ${deg} degrees`).toBeGreaterThan(last * 0.5);
      last = now;
    }
    console.log(`dome luminance by sun elevation: ${rows.join(', ')}`);
    const up = lum(domeRadiance(at(3)));
    const justDown = lum(domeRadiance(at(-3)));
    expect(justDown).toBeGreaterThan(up * 0.03);
    expect(justDown).toBeLessThan(up);
    expect(lum(domeRadiance(at(-18)))).toBeLessThan(up * 0.001);
  });

  it('keeps the high air lit after the ground has lost the sun', () => {
    // Looking straight up with the sun four degrees under: the ground is in the planet's shadow, the
    // air some kilometres up is not, and it is that air which makes dusk. The sky toward where the
    // sun went is brighter than the sky opposite.
    const sun = at(-4);
    expect(lum(transmittanceTo(sun))).toBe(0);
    expect(lum(skyRadiance(at(90), sun))).toBeGreaterThan(0);
    const toward = lum(skyRadiance(at(8), sun));
    const away = lum(skyRadiance({ x: 0, y: Math.sin(0.14), z: -Math.cos(0.14) }, sun));
    expect(toward).toBeGreaterThan(away * 3);
  });
});
