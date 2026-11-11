// What the fox and the wolf have in common: how close a hunter must get, what
// a kill is worth, and the den they sleep at and leave their young in.

import { followMother, wait } from './brain';
import { halt, walkTo } from './motion';
import { ACT_SLEEP } from './species';
import type { Eco } from './state';
import {
  type Animal, MODE_STILL, MODE_WALK, ST_CHASE, ST_FEED, ST_HUNT, ST_REST, ST_SLEEP, ST_STALK, ST_TRAVEL, WHY_DAY,
} from './types';

/** How close a hunter must get to strike. */
export const STRIKE = 1.4;
/** A hunter will go this far for the village's animals. */
export const RAID_REACH = 120;

/** A random point within `r` of (x, z), left in `e.spot`. */
export function scatter(e: Eco, x: number, z: number, r: number): void {
  const ang = e.rng.range(0, Math.PI * 2);
  const d = r * Math.sqrt(e.rng.float());
  e.spot.x = x + Math.sin(ang) * d;
  e.spot.z = z + Math.cos(ang) * d;
}

/** What a kill is worth to its eaters, in hunger taken off between them. */
export function mealOf(hunter: Animal, prey: Animal): number {
  return hunter.sp.bite * prey.sp.meat * (prey.scale / prey.size);
}

/** Sleep or idle at the den. */
export function denRest(e: Eco, a: Animal, sleepy: boolean, why: number): void {
  const g = a.group;
  // Each has its own place by the den.
  const tx = g.hx + Math.sin(a.id * 2.4) * (1 + (a.id % 3));
  const tz = g.hz + Math.cos(a.id * 2.4) * (1 + (a.id % 3));
  const dx = tx - a.x;
  const dz = tz - a.z;
  if (dx * dx + dz * dz > 9 && !(a.failed && a.state === ST_TRAVEL)) {
    if (a.state !== ST_TRAVEL || a.mode !== MODE_WALK) {
      a.state = ST_TRAVEL;
      a.why = why;
      walkTo(e, a, tx, tz, a.sp.walk * 1.6, 1.5);
    }
    wait(e, a, 4);
    return;
  }
  if (a.mode !== MODE_STILL) halt(a);
  a.state = sleepy ? ST_SLEEP : ST_REST;
  a.anim = sleepy ? 'sleep' : 'idle';
  a.why = why;
  // Long between thoughts: the pack wakes its own when it stirs, and a person coming near wakes anything.
  wait(e, a, sleepy ? 10 : 6);
}

/** A cub or pup too young to hunt waits at the den, and keeps to its mother when she is there. */
export function denYoung(e: Eco, a: Animal): void {
  const m = a.mother as Animal;
  const out = m.state === ST_HUNT || m.state === ST_STALK || m.state === ST_CHASE || m.state === ST_FEED;
  if (!out && followMother(e, a)) return;
  denRest(e, a, e.act[a.sp.index] === ACT_SLEEP, WHY_DAY);
}
