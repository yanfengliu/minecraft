// Wolves: one pack, kept together by its group logic. It rests at its den in
// the highland by day; when it is hungry enough it travels at dusk to where
// the deer and boar are, picks out the one in reach it can most easily take,
// and runs it down, which works because wolves tire more slowly than what they
// chase. Then the pack eats together. Now and then it takes a sheep at pasture.
// With no prey it starves.

import { alarm, fleeFrom, runSpeed, scare, vigour, wait } from './brain';
import { H_HIGH, H_MEADOW } from './habitat';
import { RAID_REACH, STRIKE, denRest, denYoung, mealOf } from './hunting';
import { footingOk, halt, unstick, walkTo } from './motion';
import { closeGroup, kill, pairUp } from './population';
import { ACT_FEED, ACT_SLEEP, BOAR, DEER, WOLF, bit } from './species';
import type { Eco } from './state';
import {
  type Animal, DIED_PREDATOR, GM_CHASE, GM_FEAST, GM_HUNT, GM_REST, type Group, MODE_STILL, MODE_WALK, ST_CHASE, ST_COURT,
  ST_FEED, ST_FLEE, ST_HUNT, ST_IDLE, ST_REST, ST_TRAVEL, WHY_BAND, WHY_DAY, WHY_FED, WHY_HUNGRY, WHY_PERSON, WHY_PREDATOR,
  WHY_RAIN, WHY_STARVING, WHY_TIRED,
} from './types';

/** Mean hunger above which the pack sets out. */
const PACK_HUNTS_ABOVE = 0.5;
/** The chance that a wolf which has closed with a fit, full-grown animal brings it down. */
const WOLF_KILLS = 0.5;
/** How far off the pack notices deer or boar. */
const PACK_SENSE = 30;
const BIG_GAME = bit(DEER) | bit(BOAR);
/** A pack member this near the kill when the eating is done has had its share. */
const FEAST_REACH = 40;

/** The first member old enough to hunt leads. */
function leader(g: Group): Animal {
  for (const m of g.members) if (!m.mother) return m;
  return g.members[0] as Animal;
}

function wake(e: Eco, g: Group): void {
  for (const m of g.members) if (m.nextThink > e.tick + 4) m.nextThink = e.tick + 1 + (m.id & 3);
}

export function updatePack(e: Eco, g: Group): void {
  const now = e.now;
  const n = g.members.length;
  g.nextUpdate = e.tick + 20 + (g.id & 7);
  if (n === 0) {
    closeGroup(e, g);
    return;
  }
  let mx = 0;
  let mz = 0;
  let hunger = 0;
  let hunters = 0;
  let spent = true;
  for (const m of g.members) {
    mx += m.x;
    mz += m.z;
    if (m.mother) continue;
    hunters++;
    hunger += m.hunger;
    if (m.energy > 0.1) spent = false;
  }
  g.mx = mx / n;
  g.mz = mz / n;
  g.hunger = hunters > 0 ? hunger / hunters : 0;
  const lead = leader(g);

  if (g.mode === GM_FEAST) {
    if (now < g.until) return;
    // Those who made it to the kill share it; the young ones trailing behind count if they are near.
    let present = 0;
    for (const m of g.members) if (!m.mother && (m.x - g.kx) * (m.x - g.kx) + (m.z - g.kz) * (m.z - g.kz) < FEAST_REACH * FEAST_REACH) present++;
    for (const m of g.members) {
      if (!m.mother && (m.x - g.kx) * (m.x - g.kx) + (m.z - g.kz) * (m.z - g.kz) < FEAST_REACH * FEAST_REACH) m.hunger = Math.max(0, m.hunger - g.meal / present);
    }
    g.mode = GM_REST;
    g.restUntil = now + 30;
    wake(e, g);
  }
  if (g.mode === GM_CHASE) {
    const t = g.target;
    const far = t ? (t.x - lead.x) * (t.x - lead.x) + (t.z - lead.z) * (t.z - lead.z) > 2500 : false;
    const lost = t ? !t.alive || far : !g.raid || g.raid.anim === 'dead';
    if (!lost && now <= g.chaseUntil && !spent) return;
    // It got away, or they ran themselves out. Rest before trying again.
    g.target = null;
    g.raid = null;
    g.mode = GM_REST;
    g.restUntil = now + e.rng.range(40, 80);
    wake(e, g);
  }

  const act = e.act[WOLF] as number;
  if (g.hunger > PACK_HUNTS_ABOVE && now >= g.restUntil && (act === ACT_FEED || g.hunger > 0.85)) {
    if (g.mode !== GM_HUNT) {
      g.mode = GM_HUNT;
      g.hasFeed = false;
      wake(e, g);
    }
    const q = pickQuarry(e, lead);
    if (q) {
      g.target = q;
      g.raid = null;
      g.mode = GM_CHASE;
      g.chaseUntil = now + 45;
      wake(e, g);
      return;
    }
    if (g.raid) {
      const dx = g.raid.x - lead.x;
      const dz = g.raid.z - lead.z;
      if (dx * dx + dz * dz < PACK_SENSE * PACK_SENSE) {
        g.mode = GM_CHASE;
        g.chaseUntil = now + 45;
        wake(e, g);
        return;
      }
    }
    const dx = g.ax - lead.x;
    const dz = g.az - lead.z;
    if (!g.hasFeed || now > g.feedUntil || dx * dx + dz * dz < 64) huntingCountry(e, g);
  } else if (g.mode !== GM_REST) {
    g.mode = GM_REST;
    g.target = null;
    g.raid = null;
    wake(e, g);
  }

  const pair = pairUp(e, g);
  if (pair) {
    wait(e, pair[0], 1);
    wait(e, pair[1], 1);
  }
}

/** The deer or boar in reach that the pack would most easily bring down: near, and young, old or starving. */
function pickQuarry(e: Eco, lead: Animal): Animal | null {
  const n = e.hash.collect(lead.x, lead.z, PACK_SENSE, BIG_GAME, e.found);
  let best: Animal | null = null;
  let bestScore = Infinity;
  for (let i = 0; i < n; i++) {
    const p = e.found[i] as Animal;
    const dx = p.x - lead.x;
    const dz = p.z - lead.z;
    const score = (dx * dx + dz * dz) * vigour(e, p);
    if (score < bestScore) {
      bestScore = score;
      best = p;
    }
  }
  return best;
}

/**
 * Choose where the pack goes to look for prey: toward a herd or sounder,
 * larger and nearer ones more often. Scarce prey is hard to find: the fewer
 * there are of a species, the more often the pack simply fails to pick up its
 * trail, which is what lets a thinned herd recover. Now and then, and when
 * there is nothing wild to follow, sheep out at pasture will do.
 */
function huntingCountry(e: Eco, g: Group): void {
  const h = e.habitat;
  const spot = e.spot;
  let best: Group | null = null;
  let bestW = 0;
  for (const other of e.groups) {
    const k = other.sp.index;
    if (other.gone || (k !== DEER && k !== BOAR) || other.members.length === 0) continue;
    const cap = e.cap[k] as number;
    if (cap > 0 && e.rng.float() > ((e.count[k] as number) / cap) * 2.5) continue;
    // No trail leads across water the pack cannot cross.
    if (h.crossesWater(g.mx, g.mz, other.mx, other.mz)) continue;
    const dx = other.mx - g.mx;
    const dz = other.mz - g.mz;
    const w = (other.members.length * e.rng.float()) / (60 + Math.sqrt(dx * dx + dz * dz));
    if (w > bestW) {
      bestW = w;
      best = other;
    }
  }
  g.raid = null;
  const farm = e.ctx.livestock;
  if (farm && (!best || e.rng.chance(0.12))) {
    const v = farm.findLivestock(g.mx, g.mz, RAID_REACH);
    if (v && v.kind === 'sheep' && v.anim !== 'dead' && !h.inAvoid(v.x, v.z)) {
      g.raid = v;
      g.ax = v.x;
      g.az = v.z;
      best = null;
    }
  }
  if (best) {
    g.ax = best.mx;
    g.az = best.mz;
  } else if (!g.raid) {
    // No trail: range the home country.
    if (h.pickNear(H_HIGH, g.hx, g.hz, 10, 90, e.rng, spot) || h.pickNear(H_MEADOW, g.hx, g.hz, 10, 120, e.rng, spot)) {
      g.ax = spot.x;
      g.az = spot.z;
    }
  }
  g.hasFeed = true;
  g.feedUntil = e.now + 150;
}

export function thinkWolf(e: Eco, a: Animal): void {
  const sp = a.sp;
  const g = a.group;
  const now = e.now;
  a.nextThink = e.tick + sp.think + (a.id & 3);

  if (e.personNear(a.x, a.y, a.z, sp.flight)) {
    fleeFrom(e, a, e.px, e.pz, WHY_PERSON);
    return;
  }
  if (a.state === ST_FLEE) {
    if (a.mode === MODE_WALK && now < a.until) {
      wait(e, a, 0.5);
      return;
    }
    halt(a);
    a.state = ST_IDLE;
  }
  if (a.mother && a.mother.alive) {
    denYoung(e, a);
    return;
  }
  if (a.mode === MODE_STILL && !footingOk(e, a)) unstick(e, a);
  if (a.state === ST_COURT) {
    if (now < a.until) {
      wait(e, a, Math.min(2, a.until - now));
      return;
    }
    a.state = ST_IDLE;
  }

  if (g.mode === GM_HUNT) {
    // Travel in a loose file behind the leader's line.
    a.why = g.hunger > 0.85 ? WHY_STARVING : WHY_HUNGRY;
    if (a.state !== ST_HUNT || a.mode !== MODE_WALK) {
      a.state = ST_HUNT;
      walkTo(e, a, g.ax + Math.sin(a.id * 2.4) * 3, g.az + Math.cos(a.id * 2.4) * 3, sp.walk * 1.65, 3);
    }
    wait(e, a, 1.5);
    return;
  }
  if (g.mode === GM_CHASE) {
    const t = g.target;
    const v = g.raid;
    const tx = t ? t.x : v ? v.x : a.x;
    const tz = t ? t.z : v ? v.z : a.z;
    const dx = tx - a.x;
    const dz = tz - a.z;
    a.why = WHY_HUNGRY;
    if (dx * dx + dz * dz < STRIKE * STRIKE && (t || v)) {
      bringDown(e, a, g);
      return;
    }
    if (a.energy < 0.08) {
      halt(a);
      a.state = ST_REST;
      a.anim = 'idle';
      a.why = WHY_TIRED;
      wait(e, a, 2);
      return;
    }
    a.state = ST_CHASE;
    walkTo(e, a, tx, tz, runSpeed(e, a), 0.5);
    scare(e, a, true);
    if (t) alarm(e, t, a.x, a.z, WHY_PREDATOR);
    wait(e, a, 0.3);
    return;
  }
  if (g.mode === GM_FEAST) {
    const dx = g.kx - a.x;
    const dz = g.kz - a.z;
    if (dx * dx + dz * dz > 6) {
      if (a.state !== ST_TRAVEL || a.mode !== MODE_WALK) {
        a.state = ST_TRAVEL;
        a.why = WHY_BAND;
        walkTo(e, a, g.kx + Math.sin(a.id * 2.4) * 1.2, g.kz + Math.cos(a.id * 2.4) * 1.2, sp.walk * 2, 1);
        if (!a.failed) {
          wait(e, a, 1);
          return;
        }
      } else {
        wait(e, a, 1);
        return;
      }
    }
    if (a.mode !== MODE_STILL) halt(a);
    a.state = ST_FEED;
    a.anim = 'eat';
    a.why = WHY_HUNGRY;
    wait(e, a, 3);
    return;
  }
  const sleepy = e.act[WOLF] === ACT_SLEEP;
  denRest(e, a, sleepy, sleepy ? WHY_DAY : e.raining ? WHY_RAIN : g.hunger > PACK_HUNTS_ABOVE ? WHY_TIRED : WHY_FED);
}

/** A wolf has closed with the quarry: it may bring it down, and then the pack eats where it fell. */
function bringDown(e: Eco, a: Animal, g: Group): void {
  const now = e.now;
  const t = g.target;
  const v = g.raid;
  halt(a);
  if (t) {
    if (!e.rng.chance(Math.min(0.95, WOLF_KILLS * (2 - vigour(e, t))))) {
      // Shaken off: this one loses a moment, the rest keep on.
      a.state = ST_REST;
      a.anim = 'idle';
      wait(e, a, 1.5);
      return;
    }
    g.meal = mealOf(a, t);
    g.kx = t.x;
    g.kz = t.z;
    kill(e, t, DIED_PREDATOR, a.sp.eatTime + 1);
    e.kills[a.sp.index] = (e.kills[a.sp.index] as number) + 1;
  } else if (v && e.ctx.livestock) {
    g.meal = a.sp.bite * 4;
    g.kx = v.x;
    g.kz = v.z;
    e.ctx.livestock.killLivestock(v.id);
    e.raids[a.sp.index] = (e.raids[a.sp.index] as number) + 1;
  }
  g.target = null;
  g.raid = null;
  g.mode = GM_FEAST;
  g.until = now + a.sp.eatTime;
  wake(e, g);
  a.state = ST_FEED;
  a.anim = 'eat';
  wait(e, a, 3);
}
