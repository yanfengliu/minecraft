// What the wind has done so far. Anything the wind carries (clouds, the gusts
// that run across grass) is where it is because of all the wind there has been,
// not because of the wind now: multiplying the current wind by the time elapsed
// moves everything again each time the wind changes, by more the longer the
// game has run. So the travel is added up frame by frame here, in double
// precision, and wrapped at lengths the shaders cannot tell from a full turn.

/** Clouds move faster than the wind near the ground. */
const CLOUD_SPEED = 2.2;
/**
 * The cloud noise repeats every 2300 m and its detail every 420 m (see
 * shaders/clouds.ts); their least common multiple, so a wrap shows in neither.
 */
export const CLOUD_WRAP = 48300;
/** The gust wave is a sine of this travel; it wraps after a thousand turns. */
const GUST_WRAP = Math.PI * 2000;
/**
 * Rain and snow fall at speeds stepped so that after this many seconds every
 * drop has fallen a multiple of six box heights (see shaders/precip.ts): rain
 * at 0.75 m/s times 12 to 16, snow at 0.125 m/s times 10 to 14, in a box 26 m
 * high. 156 / 0.125 = 1248.
 */
export const PRECIP_CLOCK_WRAP = 1248;

export class Drift {
  /** How far the clouds have been carried along x and z, in metres, wrapped at `CLOUD_WRAP`. */
  cloudX = 0;
  cloudZ = 0;
  /** How far the gusts have travelled, in radians of their wave. */
  gust = 0;
  /** A clock for rain and snow, in seconds, wrapped at `PRECIP_CLOCK_WRAP`. */
  clock = 0;

  private last = -1;

  /** Bring the totals up to `time` (seconds since the game started) with the wind as it is now, in m/s. */
  advance(time: number, windX: number, windZ: number): void {
    // A long gap (a hidden tab, a breakpoint) is not weather; let at most a quarter of a second pass.
    const dt = this.last < 0 ? 0 : Math.min(Math.max(time - this.last, 0), 0.25);
    this.last = time;
    const wrap = (v: number, at: number): number => v - Math.floor(v / at) * at;
    this.cloudX = wrap(this.cloudX + windX * CLOUD_SPEED * dt, CLOUD_WRAP);
    this.cloudZ = wrap(this.cloudZ + windZ * CLOUD_SPEED * dt, CLOUD_WRAP);
    this.gust = wrap(this.gust + (1.2 + 0.25 * Math.hypot(windX, windZ)) * dt, GUST_WRAP);
    this.clock = wrap(time, PRECIP_CLOCK_WRAP);
  }
}
