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
const AMBIENT_BOOST = 3.3;
/** The exposure that authored light (torches, stars) was tuned against. */
const EXPOSURE_REF = 3.2;
/** Metres of sea-level fog a vertical beam crosses on its way to the ground (the fog thins with height). */
const FOG_DEPTH = 45;

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
  /**
   * Scale for light that is authored, not simulated (torches, glowing tiles, stars, the moon's disc):
   * it cancels whatever exposure has risen beyond the reference, so those look the same on a moonless
   * night as on a moonlit one instead of burning out.
   */
  preExposure = 1;
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
    // Cloud dims direct light much more than it dims the sky as a whole. Most of that is done per pixel
    // by the cloud shadows themselves; this is the part thin high cloud takes everywhere.
    const directThrough = 1 - 0.5 * cover * cover;

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
    this.fogDensity = 0.00009 + weather.fog * weather.fog * 0.03 + weather.precipitation * 0.0035;
    // Fog takes light out of the beam on its way down, more the lower the light, and hands it back
    // from every side: thick fog has no shadows, thin mist only softens them.
    const fogThrough = Math.exp((-(this.fogDensity - 0.00009) * FOG_DEPTH) / Math.max(body.y, 0.12));
    const above = (useSun ? SUN_INTENSITY * sunUp : this.moonIntensity * moonUp) * directThrough;
    // In its last moments on the horizon a light is dimmer than clear air alone makes it: the haze lies thickest there.
    const strength = above * fogThrough * Math.pow(smoothstep(-0.02, 0.06, body.y), 0.7);
    this.keyDir = body.y > 0.02 ? body : normalizeUp(body);
    // Extinction alone leaves a setting sun pure red. What reaches the ground is orange, because the
    // bright sky round the sun lights it too; keep at least that much green and blue.
    const kr = (strength * T.x) / Math.PI;
    this.keyColor = [kr, Math.max((strength * T.y) / Math.PI, kr * 0.42), Math.max((strength * T.z) / Math.PI, kr * 0.16)];
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
    const overcast = grey * 1.05 + lost * 0.07 * (1 - 0.45 * weather.storminess);
    ar = lerp(ar, overcast * 0.95, cover * cover);
    ag = lerp(ag, overcast * 0.99, cover * cover);
    ab = lerp(ab, overcast * 1.06, cover * cover);
    // Shade is blue, but not as blue as the zenith: light reaching it has also bounced off cloud and ground.
    const mean = (ar + ag + ab) / 3;
    ar = lerp(ar, mean, 0.35);
    ag = lerp(ag, mean, 0.35);
    ab = lerp(ab, mean, 0.35);
    const fogFill = (above * Math.max(body.y, 0) * (1 - fogThrough) * 0.3) / Math.PI;
    ar += fogFill * T.x;
    ag += fogFill * T.y;
    ab += fogFill * T.z;
    this.ambientSky = [ar + 0.0012, ag + 0.0016, ab + 0.0026];

    // Sunlit ground throws warm light back up under eaves and onto shaded walls.
    const bounce = Math.max(this.keyDir.y, 0) * 0.24 * directThrough;
    this.ambientGround = [
      (ar * 0.4 + this.keyColor[0] * bounce) * 0.95,
      (ag * 0.4 + this.keyColor[1] * bounce) * 0.88,
      (ab * 0.4 + this.keyColor[2] * bounce) * 0.7,
    ];

    this.night = 1 - smoothstep(-0.14, 0.06, sun.y);

    // Exposure follows the light actually in the scene, the way an eye or a camera does: twilight is a
    // thousand times dimmer than noon and still has to be seen. `scene` estimates the radiance of lit
    // ground per unit albedo; `aim` is how bright that should end up on screen at this time of day, so
    // night stays darker than day by design, not by accident.
    const lum = (c: Rgb3): number => 0.2126 * c[0] + 0.7152 * c[1] + 0.0722 * c[2];
    // Direct light counts only as far as the cloud deck lets it through (its shadow is applied per pixel).
    const underCloud = 1 - 0.9 * Math.pow(cover, 1.5);
    const scene = lum(this.ambientSky) + 0.6 * lum(this.keyColor) * Math.max(this.keyDir.y, 0.15) * underCloud;
    // Brightness falls quickly once the sun is down: dusk at -6 degrees is already a fifth of day.
    const day = smoothstep(-0.22, 0.14, sun.y);
    const moonGlow = this.moonLit * moonUp * (1 - 0.7 * cover);
    const aim = lerp(0.1 + 0.3 * moonGlow, 1.43, Math.pow(day, 1.8)) * (1 - 0.3 * cover * day);
    let target = Math.min(Math.max(aim / Math.max(scene, 1e-5), 0.3), 300);
    // Out of the daylight (under trees, in a room, down a cave) the eye opens up, and it starts to as
    // soon as the sky is partly hidden: a forest floor at noon should not read as night.
    target *= lerp(1, 2.6, (1 - eyeSky * eyeSky) * day * (1 - eyeBlock));
    // Ease in stops, not in linear light, so a jump of a hundredfold is as smooth as one of two.
    this.exposure = dt > 0 ? Math.exp(damp(Math.log(this.exposure), Math.log(target), 1.8, dt)) : target;
    this.preExposure = Math.min(1, EXPOSURE_REF / this.exposure);

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
