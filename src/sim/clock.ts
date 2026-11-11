// The calendar every simulation system shares. One in-game minute is one
// simulated second, so a day is 1440 simulated seconds: 24 real minutes at 1x.
// A week has seven days and each season lasts one week, so a year is 28 days.
// Headless and deterministic: nothing here reads the wall clock.

import { mod } from '../core/math';

export const DAY_SECONDS = 1440;
export const HOUR_SECONDS = 60;
export const DAYS_PER_WEEK = 7;
export const DAYS_PER_SEASON = 7;
export const DAYS_PER_YEAR = DAYS_PER_SEASON * 4;
/** Fixed simulation step, in simulated seconds. Village, wildlife and weather all advance by this. */
export const SIM_DT = 0.1;

export const SEASONS = ['spring', 'summer', 'autumn', 'winter'] as const;
export type Season = (typeof SEASONS)[number];

export const WEEKDAYS = ['Moonday', 'Tillday', 'Midweek', 'Thatchday', 'Fairday', 'Hearthday', 'Restday'] as const;
/** Index of the weekly market fair and of the day of rest. */
export const FAIR_DAY = 4;
export const REST_DAY = 6;

export class Clock {
  /** Simulated seconds since midnight of day 0 (the first day of spring, year 1). */
  time: number;

  constructor(startHour = 6.5, startDay = 0) {
    this.time = startDay * DAY_SECONDS + startHour * HOUR_SECONDS;
  }

  advance(dt: number): void {
    this.time += dt;
  }

  get day(): number {
    return Math.floor(this.time / DAY_SECONDS);
  }

  /** Hour of day as a float in [0, 24). */
  get hour(): number {
    return mod(this.time, DAY_SECONDS) / HOUR_SECONDS;
  }

  get dayOfWeek(): number {
    return mod(this.day, DAYS_PER_WEEK);
  }

  get weekday(): string {
    return WEEKDAYS[this.dayOfWeek] as string;
  }

  get isRestDay(): boolean {
    return this.dayOfWeek === REST_DAY;
  }

  get isFairDay(): boolean {
    return this.dayOfWeek === FAIR_DAY;
  }

  get year(): number {
    return Math.floor(this.day / DAYS_PER_YEAR) + 1;
  }

  /** Progress through the year in [0, 1): 0 is the spring equinox, 0.25 the summer solstice. */
  get yearProgress(): number {
    return mod(this.time / DAY_SECONDS, DAYS_PER_YEAR) / DAYS_PER_YEAR;
  }

  get seasonIndex(): number {
    return Math.floor(this.yearProgress * 4);
  }

  get season(): Season {
    return SEASONS[this.seasonIndex] as Season;
  }

  /** Progress through the current season in [0, 1). */
  get seasonProgress(): number {
    return this.yearProgress * 4 - this.seasonIndex;
  }

  /** "Midweek, day 3 of spring, 14:35". */
  format(): string {
    const h = Math.floor(this.hour);
    const m = Math.floor((this.hour - h) * 60);
    const dayOfSeason = mod(this.day, DAYS_PER_SEASON) + 1;
    return `${this.weekday}, day ${dayOfSeason} of ${this.season}, ${String(h).padStart(2, '0')}:${String(m).padStart(2, '0')}`;
  }
}

/** True when `hour` lies in [from, to), handling ranges that wrap past midnight. */
export function hourIn(hour: number, from: number, to: number): boolean {
  return from <= to ? hour >= from && hour < to : hour >= from || hour < to;
}
