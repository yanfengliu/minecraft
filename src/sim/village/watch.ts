// Light and the watch. Households' lanterns follow whoever is home and awake
// after dark; ovens and forges go out when the work stops; chimneys smoke while
// a hearth is in use. The street lamps are lit at dusk and put out at dawn by
// the guards walking from one to the next, and the guards walk the patrol at
// night in two watches, so that each of them still sleeps most of the night.

import { B } from '../../world/blocks';
import { isStandable } from '../../world/walk';
import type { Cell } from '../api';
import { VILLAGER_WALK } from '../nav';
import { act, face, gaveUp, go } from './agent';
import type { Core } from './core';
import { TRADE } from './goods';
import type { Resident } from './model';
import { spotOf } from './work';

/** The first watch runs from dusk to just before midnight, the dawn watch from three until after sunrise. */
export const DUTY_FIRST = 0;
export const DUTY_DAY = 1;
export const DUTY_DAWN = 2;
export const FIRST_WATCH_ENDS = 23.4;
export const DAWN_WATCH_STARTS = 3;
/** The lamp round starts this long before sunset, so the streets are lit by the time it is dark, and the lamps burn a little past sunrise. */
export const LAMPS_BEFORE_SUNSET = 1.25;
const LAMPS_AFTER_SUNRISE = 0.2;
/** Hours after the lamps were due to change at which any nobody has reached are simply switched. */
const LAMP_GRACE = 3;

interface Lamp {
  cell: Cell;
  stand: Cell | null;
  lit: boolean;
  skipUntil: number;
}

export class Lights {
  readonly lamps: Lamp[];
  private readonly core: Core;
  private readonly awake: Int16Array;
  private sweeps = 0;
  /** Clock time the lamps were last due to change, to know how overdue they are. */
  private turnedAt = 0;
  private wasWanted: boolean;
  readonly guards: number;

  constructor(core: Core) {
    this.core = core;
    this.awake = new Int16Array(core.sites.length);
    this.lamps = core.plan.lamps.map((cell) => ({ cell, stand: this.standBy(cell), lit: this.isLit(cell), skipUntil: 0 }));
    this.wasWanted = this.lampsWanted();
    this.turnedAt = core.env.now - LAMP_GRACE * 60;
    this.guards = core.residents.filter((r) => r.trade === TRADE.guard).length;
  }

  private isLit(c: Cell): boolean {
    const s = this.core.world.get(c.x, c.y, c.z);
    return s === B.lantern + 1 || s === B.hanging_lantern + 1;
  }

  /** Ground beside a lamp to stand on while tending it: a lamp sits on a post or hangs from an arm, a few blocks up. */
  private standBy(lamp: Cell): Cell | null {
    const world = this.core.world;
    for (let ring = 1; ring <= 2; ring++) {
      for (let dz = -ring; dz <= ring; dz++) {
        for (let dx = -ring; dx <= ring; dx++) {
          if (Math.max(Math.abs(dx), Math.abs(dz)) !== ring) continue;
          for (let y = lamp.y; y >= lamp.y - 5; y--) {
            if (isStandable(world, lamp.x + dx, y, lamp.z + dz, VILLAGER_WALK)) return { x: lamp.x + dx, y, z: lamp.z + dz };
          }
        }
      }
    }
    return null;
  }

  /** Should the street lamps be burning at this hour? */
  lampsWanted(): boolean {
    const env = this.core.env;
    return env.hour >= env.sunset - LAMPS_BEFORE_SUNSET || env.hour < env.sunrise + LAMPS_AFTER_SUNRISE;
  }

  /** True when some lamp is not in the state the hour calls for. */
  lampsPending(): boolean {
    const want = this.lampsWanted();
    for (const lamp of this.lamps) if (lamp.lit !== want) return true;
    return false;
  }

  /** Once a simulated second. */
  sweep(): void {
    const core = this.core;
    const env = core.env;
    const now = env.now;
    this.sweeps++;

    // Who is indoors and awake, building by building.
    this.awake.fill(0);
    for (const r of core.residents) {
      const at = core.siteIndexAt(r.view.x, r.view.z);
      r.inside = at;
      if (at >= 0 && !r.asleep) this.awake[at] = (this.awake[at] as number) + 1;
    }
    for (let i = 0; i < core.sites.length; i++) {
      const site = core.sites[i] as (typeof core.sites)[number];
      site.awake = this.awake[i] as number;
      const want = env.dark && site.awake > 0;
      if (want !== site.lit) {
        site.lit = want;
        for (const c of site.b.lights) core.setLit(c, want);
      }
      for (const spot of site.spots) {
        if (spot.lit && now > spot.fireUntil && spot.spot.block) {
          core.setLit(spot.spot.block, false);
          spot.lit = false;
        }
      }
      if (site.hearthUntil > now && site.b.chimney && this.sweeps % 3 === 0) core.effect('smoke', site.b.chimney);
    }

    const wanted = this.lampsWanted();
    if (wanted !== this.wasWanted) {
      this.wasWanted = wanted;
      this.turnedAt = now;
    }
    // The player may have lit or snuffed a lamp; believe the block.
    for (const lamp of this.lamps) lamp.lit = this.isLit(lamp.cell);
    // No watch, or a lamp nobody could reach: it is seen to all the same, a good while late.
    if (this.guards === 0 || now - this.turnedAt > LAMP_GRACE * 60) {
      for (const lamp of this.lamps) {
        if (lamp.lit === wanted) continue;
        core.setLit(lamp.cell, wanted);
        lamp.lit = wanted;
      }
    }
  }

  /**
   * Walk to the nearest lamp that needs lighting or putting out and see to it.
   * Returns false when there is none left for this guard. Uses `r.targetId`
   * (lamp index + 1) and `r.target`.
   */
  lampRound(r: Resident): boolean {
    const core = this.core;
    const want = this.lampsWanted();
    const now = core.env.now;
    let lamp = r.targetId > 0 ? this.lamps[r.targetId - 1] ?? null : null;
    if (lamp && r.target && gaveUp(r, r.target)) {
      lamp.skipUntil = now + 600;
      lamp = null;
    }
    if (lamp && lamp.lit === want) lamp = null;
    if (!lamp) {
      r.targetId = 0;
      let bestD = Infinity;
      for (let i = 0; i < this.lamps.length; i++) {
        const l = this.lamps[i] as Lamp;
        if (l.lit === want || l.skipUntil > now || !l.stand) continue;
        // Leave to a mate the lamp they are already walking to.
        const taken = core.residents.some((o) => o !== r && o.trade === TRADE.guard && o.targetId === i + 1 && o.goal === r.goal);
        if (taken) continue;
        const d = (l.cell.x - r.view.x) ** 2 + (l.cell.z - r.view.z) ** 2;
        if (d < bestD) {
          bestD = d;
          lamp = l;
          r.targetId = i + 1;
        }
      }
      if (!lamp) return false;
    }
    const stand = lamp.stand as Cell;
    const chosen = lamp;
    r.target = stand;
    r.activity = want ? 'Lighting the street lamps' : 'Putting out the street lamps';
    if (!go(core, r, stand, true)) return true;
    face(r, chosen.cell);
    act(core, r, 'work', 2, -1, () => {
      if (chosen.lit !== want) {
        core.setLit(chosen.cell, want);
        chosen.lit = want;
        if (want) core.stats.lampsLit++;
      }
      r.targetId = 0;
      r.target = null;
    });
    return true;
  }
}

/** Which duty a guard has on a given day: first watch, day duty, dawn watch, in that order round the rota. */
export function dutyOf(guards: number, r: Resident, day: number): number {
  if (guards >= 3) return (((day + r.rota) % 3) + 3) % 3;
  if (guards === 2) return r.rota === 0 ? DUTY_FIRST : DUTY_DAWN;
  return DUTY_FIRST;
}

/** Walk the patrol loop, pausing at each post. Uses `r.step` for the next post (-1 to start at the nearest). */
export function patrol(core: Core, r: Resident): void {
  const posts = core.plan.patrol;
  if (posts.length === 0) {
    guardPost(core, r);
    return;
  }
  if (r.step < 0 || r.step >= posts.length) {
    let best = 0;
    let bestD = Infinity;
    posts.forEach((p, i) => {
      const d = (p.x - r.view.x) ** 2 + (p.z - r.view.z) ** 2;
      if (d < bestD) {
        bestD = d;
        best = i;
      }
    });
    r.step = best;
  }
  const post = posts[r.step] as Cell;
  r.activity = 'Walking the night patrol';
  if (!go(core, r, post)) return;
  // Look about before moving on.
  r.view.yaw += core.rng.range(-1.5, 1.5);
  r.step = (r.step + 1) % posts.length;
  act(core, r, 'idle', 3 + core.rng.float() * 3);
}

/** Day duty: at the guardhouse, with a turn round the square now and then. Uses `r.step` (1 while out on a turn). */
export function guardPost(core: Core, r: Resident): void {
  const site = r.job?.site ?? r.home.site;
  if (r.step !== 1 && core.rng.chance(0.3) && !core.env.bad && core.env.daylight > 0.3) r.step = 1;
  if (r.step === 1) {
    const spot = core.claim(r, core.squareSpots, core.rng.int(1 << 16));
    if (spot) {
      r.activity = 'Keeping an eye on the square';
      r.outdoor = true;
      if (!go(core, r, spot)) return;
      act(core, r, 'idle', 8 + core.rng.float() * 6, -1, () => {
        r.step = 0;
        core.release(r);
      });
      return;
    }
    r.step = 0;
  }
  const desk = spotOf(site, 'desk');
  const cell = core.claim(r, desk ? [desk.spot.stand, ...site.floor] : site.floor) ?? site.b.entry;
  r.activity = `On duty at ${site.b.name}`;
  if (!go(core, r, cell)) return;
  if (desk?.spot.block) face(r, desk.spot.block);
  act(core, r, 'idle', 15 + core.rng.float() * 10);
}
