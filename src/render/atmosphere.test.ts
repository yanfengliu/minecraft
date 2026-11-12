import { describe, expect, it } from 'vitest';
import type { Vec3 } from '../core/math';
import { AirLight, domeRadiance, skyRadiance, transmittanceTo } from './atmosphere';

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

  it('gives the numbers it gave before its integrals were rewritten to allocate nothing', () => {
    // Recorded from the earlier code, which built a tuple at every step: for a light at each elevation
    // and azimuth (degrees), the dome radiance, the transmittance, and the sky 33 degrees up at azimuth 120.
    const recorded: Record<string, number[]> = {
      '60,0': [0.00933442803827606, 0.018892936727347397, 0.037872573475111165, 0.9369193532728901, 0.8569064591874164, 0.7440953723113441, 0.007659953455334225, 0.01580870400402202, 0.03238713575222182],
      '25,40': [0.009329452285453508, 0.01769519735873211, 0.03360334860794217, 0.8755506513161413, 0.7300487633497204, 0.5471357296577775, 0.007658712321793137, 0.015027867112615346, 0.02949127114142911],
      '5,170': [0.007373124703637742, 0.010520089003959582, 0.015730697672367032, 0.5665831271027826, 0.26698716717489523, 0.07266980826357619, 0.006895106759963978, 0.010078472931609352, 0.015627662211983834],
      '0.4,10': [0.004565396523290011, 0.004075593341628643, 0.005072781661831267, 0.1766346916188501, 0.02308671245826249, 0.0003250018751970702, 0.003748127185276659, 0.003399758837543479, 0.004378014420770872],
      '-3,200': [0.0008077141375111982, 0.0004706332023059291, 0.0007442229983286573, 0, 0, 0, 0.0006818174832837667, 0.00040771871022110675, 0.0006720091404879311],
      '-12,77': [0, 0, 0, 0, 0, 0, 0, 0, 0],
    };
    const toward = (deg: number, az: number): Vec3 => {
      const r = (deg * Math.PI) / 180;
      const a = (az * Math.PI) / 180;
      return { x: Math.cos(r) * Math.sin(a), y: Math.sin(r), z: Math.cos(r) * Math.cos(a) };
    };
    for (const [key, want] of Object.entries(recorded)) {
      const [deg, az] = key.split(',').map(Number) as [number, number];
      const light = toward(deg, az);
      const dome = domeRadiance(light);
      const through = transmittanceTo(light);
      const sky = skyRadiance(toward(33, 120), light);
      const got = [dome.x, dome.y, dome.z, through.x, through.y, through.z, sky.x, sky.y, sky.z];
      got.forEach((v, i) => expect(Math.abs(v - want[i]!), `light at ${key}, value ${i}`).toBeLessThanOrEqual(Math.abs(want[i]!) * 1e-12));
    }
  });

  it('fills the vector it is handed and leaves no trace of one call in the next', () => {
    const light = at(20);
    const out = { x: 9, y: 9, z: 9 };
    expect(domeRadiance(light, out)).toBe(out);
    expect(out).toEqual(domeRadiance(light));
    // The helpers share scratch state; a call in between must not disturb a later one.
    const first = skyRadiance(at(40), light);
    transmittanceTo(at(3));
    domeRadiance(at(-5));
    expect(skyRadiance(at(40), light)).toEqual(first);
  });

  it('works the air out again only when the light has moved', () => {
    const air = new AirLight();
    const sun = at(35);
    air.toward(sun);
    expect(air.integrations).toBe(1);
    expect(air.through).toEqual(transmittanceTo(sun));
    expect(air.dome).toEqual(domeRadiance(sun));
    // The same place, as a new vector each frame: nothing to do.
    for (let frame = 0; frame < 5; frame++) air.toward({ ...sun });
    expect(air.integrations).toBe(1);
    const later = at(35.02);
    air.toward(later);
    expect(air.integrations).toBe(2);
    expect(air.dome).toEqual(domeRadiance(later));
  });
});
