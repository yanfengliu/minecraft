// Astronomy for a northern-latitude island: where the sun and moon are for a
// given calendar time. The renderer lights the world from these; the
// simulations read daylight from them. East is +x, south is +z, up is +y.
// Headless and deterministic.

import { DEG, TAU, clamp, smoothstep, type Vec3 } from '../core/math';
import type { Clock } from './clock';

export const LATITUDE = 48 * DEG;
const AXIAL_TILT = 23.44 * DEG;
/** Days for the moon to run through its phases. */
export const MOON_PERIOD_DAYS = 8;

function celestial(hourAngle: number, declination: number): Vec3 {
  const sl = Math.sin(LATITUDE);
  const cl = Math.cos(LATITUDE);
  const sd = Math.sin(declination);
  const cd = Math.cos(declination);
  const ch = Math.cos(hourAngle);
  return {
    x: -cd * Math.sin(hourAngle),
    y: sl * sd + cl * cd * ch,
    z: sl * cd * ch - cl * sd,
  };
}

export function sunDeclination(clock: Clock): number {
  return AXIAL_TILT * Math.sin(TAU * clock.yearProgress);
}

/** Unit vector pointing from the ground toward the sun. Below the horizon when y < 0. */
export function sunDirection(clock: Clock): Vec3 {
  const hourAngle = ((clock.hour - 12) / 24) * TAU;
  return celestial(hourAngle, sunDeclination(clock));
}

/** Moon phase in [0, 1): 0 is full, 0.5 is new. */
export function moonPhase(clock: Clock): number {
  const p = (clock.time / 1440 / MOON_PERIOD_DAYS) % 1;
  return p < 0 ? p + 1 : p;
}

/** Fraction of the moon's disc that is lit, 0..1. */
export function moonIllumination(clock: Clock): number {
  return 0.5 + 0.5 * Math.cos(TAU * moonPhase(clock));
}

export function moonDirection(clock: Clock): Vec3 {
  // A full moon stands opposite the sun; the moon slips a full turn behind it over one phase cycle.
  const hourAngle = ((clock.hour - 12) / 24) * TAU + Math.PI - TAU * moonPhase(clock);
  return celestial(hourAngle, -sunDeclination(clock) * 0.8 + 5 * DEG * Math.sin(TAU * moonPhase(clock) * 2));
}

/** 0 at night, 1 in full day, with a smooth dawn and dusk. */
export function daylight(clock: Clock): number {
  return smoothstep(-0.1, 0.12, sunDirection(clock).y);
}

export function isDay(clock: Clock): boolean {
  return sunDirection(clock).y > -0.02;
}

/** Hours of sunrise and sunset for the clock's date. */
export function sunTimes(clock: Clock): { rise: number; set: number } {
  const c = clamp(-Math.tan(LATITUDE) * Math.tan(sunDeclination(clock)), -1, 1);
  const half = (Math.acos(c) / TAU) * 24;
  return { rise: 12 - half, set: 12 + half };
}
