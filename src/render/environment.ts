// Turns the calendar and the weather into the numbers the shaders light with:
// which body is the key light and how strong, what the sky dome contributes,
// how thick the air is, how the foliage is tinted, and the camera exposure.

import { type Vec3, damp, lerp, saturate, smoothstep } from '../core/math';
import type { Clock } from '../sim/clock';
import { moonDirection, moonIllumination, sunDirection } from '../sim/sky';
import type { WeatherView } from '../sim/weather';
import { MOON_RATIO, SUN_INTENSITY, domeRadiance, transmittanceTo } from './atmosphere';

type Rgb3 = [number, number, number];

/** Sky-dome light is boosted over bare single scattering to stand in for haze and inter-reflection. */
const AMBIENT_BOOST = 2.6;

// Tint multipliers at the middle of each season; values between are interpolated around the year.
const GRASS: Rgb3[] = [[0.94, 1.03, 0.84], [1.0, 0.98, 0.84], [1.22, 0.96, 0.68], [1.06, 0.92, 0.84]];
const FOLIAGE: Rgb3[] = [[0.94, 1.09, 0.84], [0.9, 1.0, 0.84], [1.95, 1.0, 0.42], [1.35, 0.86, 0.58]];
const BIRCH: Rgb3[] = [[0.98, 1.08, 0.82], [0.94, 1.0, 0.84], [2.0, 1.45, 0.38], [1.4, 1.0, 0.55]];

function seasonal(table: Rgb3[], yearProgress: number): Rgb3 {
  // Season i is centred at (i + 0.5) / 4 of the year.
  const p = yearProgress * 4 - 0.5;
  const i0 = ((Math.floor(p) % 4) + 4) % 4;
  const i1 = (i0 + 1) % 4;
  const t = smoothstep(0.15, 0.85, p - Math.floor(p));
  const a = table[i0] as Rgb3;
  const b = table[i1] as Rgb3;
  return [lerp(a[0], b[0], t), lerp(a[1], b[1], t), lerp(a[2], b[2], t)];
}

export class Environment {
  sunDir: Vec3 = { x: 0, y: 1, z: 0 };
  moonDir: Vec3 = { x: 0, y: -1, z: 0 };
  /** Direction toward whichever body is lighting the scene. */
  keyDir: Vec3 = { x: 0, y: 1, z: 0 };
  /** Key light irradiance over pi at the ground. */
  keyColor: Rgb3 = [0, 0, 0];
  shadowStrength = 1;
  ambientSky: Rgb3 = [0, 0, 0];
  ambientGround: Rgb3 = [0, 0, 0];
  fogDensity = 0.0001;
  sunVisible = 1;
  moonLit = 1;
  /** 0 by day, 1 in full night. */
  night = 0;
  sunIntensity = SUN_INTENSITY;
  moonIntensity = 0;
  exposure = 0.55;
  grassTint: Rgb3 = [1, 1, 1];
  foliageTint: Rgb3 = [1, 1, 1];
  birchTint: Rgb3 = [1, 1, 1];
  /** How strongly autumn colour varies from tree to tree, 0..1. */
  autumn = 0;
  /** Brightness of a lightning flash right now, decaying. */
  flash = 0;

  /**
   * `eyeSky` and `eyeBlock` are the voxel light levels (0..1) where the camera
   * is, which stand in for the eye adapting to a cave or to firelight.
   */
  update(clock: Clock, weather: WeatherView, eyeSky: number, eyeBlock: number, dt: number): void {
    const sun = sunDirection(clock);
    const moon = moonDirection(clock);
    this.sunDir = sun;
    this.moonDir = moon;
    const cover = weather.cloudCover;
    // Cloud dims direct light much more than it dims the sky as a whole.
    const directThrough = 1 - 0.9 * Math.pow(cover, 1.6);

    const sunT = transmittanceTo(sun);
    const sunUp = smoothstep(-0.03, 0.02, sun.y);
    this.sunVisible = sunUp * (1 - smoothstep(0.75, 1, cover));
    this.moonLit = moonIllumination(clock);
    this.moonIntensity = SUN_INTENSITY * MOON_RATIO * this.moonLit;
    const moonT = transmittanceTo(moon);
    const moonUp = smoothstep(-0.03, 0.04, moon.y);

    // The sun is the key light until it is all but gone; then the moon, if it is up.
    const useSun = sun.y > -0.035;
    const body = useSun ? sun : moon;
    const T = useSun ? sunT : moonT;
    const strength = (useSun ? SUN_INTENSITY * sunUp : this.moonIntensity * moonUp) * directThrough;
    this.keyDir = body.y > 0.02 ? body : normalizeUp(body);
    this.keyColor = [(strength * T.x) / Math.PI, (strength * T.y) / Math.PI, (strength * T.z) / Math.PI];
    // Shadows fade out as their light grazes the horizon, which also hides the hand-over between sun and moon.
    this.shadowStrength = smoothstep(0.015, 0.1, body.y);

    const domeSun = domeRadiance(sun);
    const domeMoon = domeRadiance(moon);
    let ar = (domeSun.x * SUN_INTENSITY + domeMoon.x * this.moonIntensity) * AMBIENT_BOOST;
    let ag = (domeSun.y * SUN_INTENSITY + domeMoon.y * this.moonIntensity) * AMBIENT_BOOST;
    let ab = (domeSun.z * SUN_INTENSITY + domeMoon.z * this.moonIntensity) * AMBIENT_BOOST;
    // Under cloud the dome turns grey, and the light the cloud deck took from the sun comes back as soft fill.
    const grey = 0.2126 * ar + 0.7152 * ag + 0.0722 * ab;
    const lost = (SUN_INTENSITY * sunUp * (sunT.x + sunT.y + sunT.z)) / 3 / Math.PI * Math.max(sun.y, 0) * (1 - directThrough);
    const overcast = grey * 1.15 + lost * 0.3 * (1 - 0.45 * weather.storminess);
    ar = lerp(ar, overcast * 0.95, cover * cover);
    ag = lerp(ag, overcast * 0.99, cover * cover);
    ab = lerp(ab, overcast * 1.06, cover * cover);
    this.ambientSky = [ar + 0.0012, ag + 0.0016, ab + 0.0026];

    const bounce = Math.max(this.keyDir.y, 0) * 0.14;
    this.ambientGround = [
      (ar * 0.34 + this.keyColor[0] * bounce) * 0.95,
      (ag * 0.34 + this.keyColor[1] * bounce) * 0.9,
      (ab * 0.34 + this.keyColor[2] * bounce) * 0.72,
    ];

    this.night = 1 - smoothstep(-0.14, 0.06, sun.y);
    this.fogDensity = 0.00009 + weather.fog * weather.fog * 0.03 + weather.precipitation * 0.0035;

    // Exposure: bright day to dark night, opened further under heavy cloud, in caves and indoors,
    // and stopped down beside a fire so its light does not burn out.
    const day = smoothstep(-0.12, 0.2, sun.y);
    let target = lerp(3.2, 0.5, day);
    target *= 1 + 0.5 * cover * day;
    target *= lerp(1, 2.4, (1 - eyeSky) * day * (1 - eyeBlock));
    target *= lerp(1, 0.62, eyeBlock * (1 - day));
    this.exposure = dt > 0 ? damp(this.exposure, target, 1.6, dt) : target;

    this.grassTint = seasonal(GRASS, clock.yearProgress);
    this.foliageTint = seasonal(FOLIAGE, clock.yearProgress);
    this.birchTint = seasonal(BIRCH, clock.yearProgress);
    const p = clock.yearProgress;
    this.autumn = saturate(1 - Math.abs(p - 0.625) / 0.16);
    this.flash = Math.max(0, this.flash - dt * 5);
  }

  /** A lightning stroke: a bright instant that decays over a fraction of a second. */
  strike(intensity: number): void {
    this.flash = Math.max(this.flash, intensity);
  }
}

/** A light just below the horizon still needs a usable direction for shading; lift it to the horizon. */
function normalizeUp(d: Vec3): Vec3 {
  const y = 0.02;
  const h = Math.hypot(d.x, d.z) || 1;
  const s = Math.sqrt(1 - y * y) / h;
  return { x: d.x * s, y, z: d.z * s };
}
