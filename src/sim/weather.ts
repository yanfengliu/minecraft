// Weather: a small Markov chain of regimes whose targets the continuous state
// (cloud, rain, wind, fog, temperature) eases toward, so skies change over
// minutes, not frames. Season shifts the odds; temperature decides rain or
// snow. The renderer draws from this state and the simulations plan around it.
// Headless and deterministic.

import { Emitter } from '../core/events';
import { TAU, clamp, damp, saturate, smoothstep } from '../core/math';
import { type Rng, rand2 } from '../core/rng';
import { type Clock, HOUR_SECONDS } from './clock';
import { daylight, sunTimes } from './sky';

export const REGIMES = ['clear', 'fair', 'overcast', 'rain', 'storm', 'fog'] as const;
export type Regime = (typeof REGIMES)[number];

/** Read-only weather, as the simulations and the renderer see it. */
export interface WeatherView {
  readonly regime: Regime;
  /** 0 clear sky .. 1 fully overcast. */
  readonly cloudCover: number;
  /** 0 dry .. 1 downpour (or heavy snowfall when `snowing`). */
  readonly precipitation: number;
  readonly snowing: boolean;
  /** Wind velocity in metres per second along +x and +z. */
  readonly windX: number;
  readonly windZ: number;
  readonly windSpeed: number;
  /** 0 clear air .. 1 thick fog. */
  readonly fog: number;
  /** Degrees Celsius at sea level. */
  readonly temperature: number;
  /** 0 dry ground .. 1 soaked. */
  readonly wetness: number;
  /** 0 bare .. 1 deep snow lying on open ground. */
  readonly snowCover: number;
  /** 0 calm .. 1 violent thunderstorm. */
  readonly storminess: number;
  /** Raining hard enough that people and animals seek shelter. */
  readonly isRaining: boolean;
}

export interface LightningStrike {
  /** Position as a fraction of the world extent, 0..1 on each axis. */
  u: number;
  v: number;
  intensity: number;
}

interface Target {
  cloud: number;
  rain: number;
  wind: number;
  fog: number;
  temp: number;
}

const TARGETS: Record<Regime, Target> = {
  clear: { cloud: 0.06, rain: 0, wind: 2, fog: 0.02, temp: 1 },
  fair: { cloud: 0.36, rain: 0, wind: 4, fog: 0.03, temp: 0 },
  overcast: { cloud: 0.9, rain: 0, wind: 5, fog: 0.08, temp: -1 },
  rain: { cloud: 0.96, rain: 0.5, wind: 7, fog: 0.22, temp: -2 },
  storm: { cloud: 1, rain: 0.95, wind: 14, fog: 0.3, temp: -3 },
  fog: { cloud: 0.55, rain: 0, wind: 0.6, fog: 0.9, temp: -1 },
};

/** Transition odds from each regime; rows are rescaled by season wetness at runtime. */
const TRANSITIONS: Record<Regime, Partial<Record<Regime, number>>> = {
  clear: { clear: 0.58, fair: 0.32, overcast: 0.08, fog: 0.02 },
  fair: { clear: 0.3, fair: 0.36, overcast: 0.28, rain: 0.06 },
  overcast: { fair: 0.3, overcast: 0.3, rain: 0.3, storm: 0.05, fog: 0.05 },
  rain: { overcast: 0.35, rain: 0.4, storm: 0.15, fair: 0.1 },
  storm: { rain: 0.6, overcast: 0.25, storm: 0.15 },
  fog: { fair: 0.5, clear: 0.3, overcast: 0.2 },
};

/** How rainy each season is, relative to 1. */
const SEASON_WETNESS = [1.0, 0.7, 1.25, 1.0];
const WET: ReadonlySet<Regime> = new Set(['overcast', 'rain', 'storm']);

export class Weather implements WeatherView {
  regime: Regime = 'fair';
  cloudCover = 0.3;
  precipitation = 0;
  snowing = false;
  windX = 2;
  windZ = 1;
  windSpeed = 2.2;
  fog = 0.03;
  temperature = 10;
  wetness = 0;
  snowCover = 0;
  storminess = 0;

  /** Fired for each lightning strike during a storm. */
  readonly lightning = new Emitter<LightningStrike>();

  private readonly rng: Rng;
  private readonly clock: Clock;
  private nextChange: number;
  private rainTarget = 0;
  private windDir: number;
  private windDirTarget: number;
  private nextStrike = Infinity;
  private forced = false;
  private readonly mistSeed: number;
  private regimeFog = 0.03;
  private mist = 0;

  constructor(rng: Rng, clock: Clock) {
    this.rng = rng;
    this.clock = clock;
    this.mistSeed = rng.fork('mist').u32();
    this.windDir = rng.range(0, TAU);
    this.windDirTarget = this.windDir;
    this.nextChange = clock.time + rng.range(1, 3) * HOUR_SECONDS;
    this.temperature = this.baseTemperature();
  }

  get isRaining(): boolean {
    return this.precipitation > 0.15;
  }

  /** Seasonal mean plus the daily swing, before regime effects. */
  private baseTemperature(): number {
    // About 3 C as spring opens, 24 C at high summer, a little under freezing in the depth of winter.
    const seasonal = 11 + 13 * Math.sin(TAU * (this.clock.yearProgress - 0.1));
    const daily = -5 * Math.cos(((this.clock.hour - 3) / 24) * TAU) * (1 - 0.6 * this.cloudCover);
    return seasonal + daily;
  }

  /**
   * Mist that gathers on still, clear nights and burns off as the morning warms: 0 for none.
   * It is thin beside real fog, but it is what makes the low sun show as beams between the trees.
   */
  private dawnMist(): number {
    const rise = sunTimes(this.clock).rise;
    const h = this.clock.hour;
    const shape = smoothstep(rise - 2.5, rise - 0.3, h) * (1 - smoothstep(rise + 1.2, rise + 3.2, h));
    if (shape <= 0) return 0;
    const calm = 1 - saturate((this.windSpeed - 2.5) / 5);
    const clearNight = 1 - smoothstep(0.5, 0.9, this.cloudCover);
    // One morning in five has none; about half have all of it.
    const today = smoothstep(0.2, 0.5, rand2(this.clock.day, 0, this.mistSeed));
    const depth = 0.3 + 0.1 * rand2(this.clock.day, 1, this.mistSeed);
    return depth * shape * calm * clearNight * today;
  }

  /** Pin the weather to a regime (debugging and tests). Pass null to release it. */
  force(regime: Regime | null): void {
    this.forced = regime !== null;
    if (regime) this.enter(regime);
    else this.nextChange = this.clock.time + this.rng.range(0.5, 1.5) * HOUR_SECONDS;
  }

  private enter(regime: Regime): void {
    this.regime = regime;
    const t = TARGETS[regime];
    this.rainTarget = t.rain > 0 ? clamp(t.rain + this.rng.range(-0.2, 0.2), 0.2, 1) : 0;
    this.windDirTarget = this.windDir + this.rng.range(-1.2, 1.2);
    this.nextStrike = regime === 'storm' ? this.clock.time + this.rng.range(8, 30) : Infinity;
  }

  private pickNext(): Regime {
    const row = TRANSITIONS[this.regime];
    const wet = SEASON_WETNESS[this.clock.seasonIndex] as number;
    const dawn = this.clock.hour > 3 && this.clock.hour < 8;
    let total = 0;
    const weights: [Regime, number][] = [];
    for (const r of REGIMES) {
      let w = row[r] ?? 0;
      if (w === 0) continue;
      if (WET.has(r)) w *= wet;
      // Fog forms in the small hours and burns off by mid-morning.
      if (r === 'fog') w *= dawn ? 5 : 0.2;
      weights.push([r, w]);
      total += w;
    }
    let pick = this.rng.float() * total;
    for (const [r, w] of weights) {
      pick -= w;
      if (pick <= 0) return r;
    }
    return this.regime;
  }

  /** Advance by `dt` simulated seconds. */
  update(dt: number): void {
    const now = this.clock.time;
    if (!this.forced && now >= this.nextChange) {
      this.enter(this.pickNext());
      const hours = this.regime === 'storm' ? this.rng.range(0.4, 1.2) : this.regime === 'fog' ? this.rng.range(1, 2.5) : this.rng.range(1.2, 4);
      this.nextChange = now + hours * HOUR_SECONDS;
    }

    const t = TARGETS[this.regime];
    // Ease rates are per simulated second, which is a game minute: cloud turns over in about four game
    // hours (four minutes of play at normal speed), so a change of regime is watched, not switched.
    this.cloudCover = damp(this.cloudCover, t.cloud, 1 / 240, dt);
    this.precipitation = damp(this.precipitation, this.cloudCover > 0.7 ? this.rainTarget : 0, 1 / 90, dt);
    this.regimeFog = damp(this.regimeFog, t.fog, 1 / 300, dt);
    // Dawn mist comes and goes within the hour, much faster than the regime's own fog.
    this.mist = damp(this.mist, this.dawnMist(), 1 / 40, dt);
    this.fog = Math.max(this.regimeFog, this.mist);
    this.storminess = damp(this.storminess, this.regime === 'storm' ? 1 : 0, 1 / 120, dt);

    const gust = 1 + 0.35 * Math.sin(now * 0.11) * Math.sin(now * 0.037 + 1.3) + 0.15 * Math.sin(now * 0.53);
    this.windSpeed = damp(this.windSpeed, t.wind * gust, 1 / 20, dt);
    this.windDir = damp(this.windDir, this.windDirTarget, 1 / 600, dt);
    this.windX = Math.cos(this.windDir) * this.windSpeed;
    this.windZ = Math.sin(this.windDir) * this.windSpeed;

    const sun = daylight(this.clock);
    this.temperature = damp(this.temperature, this.baseTemperature() + t.temp * (0.5 + 0.5 * sun), 1 / 300, dt);
    this.snowing = this.precipitation > 0.02 && this.temperature < 0.8;

    // Ground state: rain soaks, sun and wind dry; snow settles while it falls and melts above freezing.
    if (this.snowing) {
      this.snowCover = saturate(this.snowCover + this.precipitation * dt / 900);
    } else {
      this.wetness = saturate(this.wetness + this.precipitation * dt / 120);
      if (this.temperature > 0.5) this.snowCover = saturate(this.snowCover - (this.temperature * 0.00006 + this.precipitation * 0.0004) * dt);
    }
    if (this.precipitation < 0.05) {
      const drying = (0.4 + sun * (1 - this.cloudCover) * 1.2 + this.windSpeed * 0.05) / 1500;
      this.wetness = saturate(this.wetness - drying * dt);
    }
    // Melting snow keeps the ground damp.
    if (this.snowCover > 0.02 && this.temperature > 1) this.wetness = Math.max(this.wetness, 0.35);

    if (now >= this.nextStrike && this.storminess > 0.35) {
      this.lightning.emit({ u: this.rng.float(), v: this.rng.float(), intensity: this.rng.range(0.6, 1) });
      this.nextStrike = now + this.rng.range(6, 28) / Math.max(0.4, this.storminess);
    }
  }
}
