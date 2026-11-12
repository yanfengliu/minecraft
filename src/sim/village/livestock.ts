// Farm animals: sheep, cows and hens in their pens, the flock's daily walk to
// pasture and back behind the shepherd, eggs, wool, and a modest spring
// increase so that what the foxes and wolves take is made good. Implements the
// `LivestockApi` the wildlife simulation hunts through.

import { isStandable } from '../../world/walk';
import type { Cell, EntityKind, EntityView, LivestockApi } from '../api';
import { SIM_DT } from '../clock';
import {
  ANIMAL_WALK, MOVE_WALKING, type Path, VILLAGER_WALK, createMover, groundLevel, joinPaths, makePath, packCell, placeMover, startPath,
  stepMover, stopMover,
} from '../nav';
import { act, face, feetY, gaveUp, go } from './agent';
import type { Core } from './core';
import type { Economy } from './economy';
import { G, ITEM_ID, TOOLS_ITEM } from './goods';
import {
  type Animal, type Business, FLOCK_AT_PASTURE, FLOCK_COMING_HOME, FLOCK_GOING_OUT, FLOCK_PENNED, PACK_JOB, type PenState, type Resident,
} from './model';
import { gather, unloadAtJob, workshop } from './work';

/** Ids for farm animals start here and count up; village ids must stay below 100000. */
const FIRST_ID = 20000;
const ID_LIMIT = 100000;
const SPEED = { sheep: 0.9, cow: 0.7, chicken: 0.8 } as const;
const DRIVE_SPEED = 1.35;
/** Days for a young animal to reach full size. */
const GROWN = 6;
const WOOL_PER_SHEEP = 10;
/** Seconds after which a drive is finished by hand: whatever has not arrived is put where it was going. */
const DRIVE_TIMEOUT = 300;

export class Livestock implements LivestockApi {
  private readonly core: Core;
  private readonly econ: Economy;
  private nextId = FIRST_ID;
  private pastureCell: Cell | null = null;

  constructor(core: Core, econ: Economy) {
    this.core = core;
    this.econ = econ;
    for (const pen of core.pens) {
      const n = Math.max(2, Math.round(pen.capacity * 0.75));
      for (let i = 0; i < n; i++) this.spawn(pen, core.clock.day - GROWN - 1);
    }
  }

  // --- LivestockApi ------------------------------------------------------------

  /** Nearest living farm animal within `radius` blocks, or null. With `kinds`, only animals of those kinds count. */
  findLivestock(x: number, z: number, radius: number, kinds?: readonly EntityKind[]): EntityView | null {
    let best: EntityView | null = null;
    let bestD = radius * radius;
    for (const a of this.core.animals) {
      if (kinds && !kinds.includes(a.view.kind)) continue;
      const d = (a.view.x - x) ** 2 + (a.view.z - z) ** 2;
      if (d <= bestD) {
        bestD = d;
        best = a.view;
      }
    }
    return best;
  }

  /**
   * A farm animal dies and is taken out of the village. Its view is marked
   * dead as well as dropped: whoever else was after it holds that view, not
   * the list, and has to see that it is gone. Whoever killed it shows the kill;
   * no cue is raised here, or every fox's hen would shed its feathers twice.
   */
  killLivestock(id: number): void {
    const core = this.core;
    const a = core.animals.find((an) => an.id === id);
    if (!a) return;
    a.alive = false;
    a.view.anim = 'dead';
    this.routes.delete(a);
    stopMover(a.mover, core.doors);
    core.animals.splice(core.animals.indexOf(a), 1);
    a.pen.animals.splice(a.pen.animals.indexOf(a), 1);
    const at = core.views.indexOf(a.view);
    if (at >= 0) core.views.splice(at, 1);
    core.stats.livestockLost++;
  }

  // --- life in the pen -----------------------------------------------------------

  private spawn(pen: PenState, born: number): Animal | null {
    const core = this.core;
    if (this.nextId >= ID_LIMIT) return null;
    const cell = this.cellInPen(pen);
    if (!cell) return null;
    const kind = pen.pen.animal;
    const view = core.makeView(this.nextId++, kind, core.rng.u32(), 0, 1);
    const mover = createMover(view, SPEED[kind], SPEED[kind] * 1.1, false, ANIMAL_WALK, core.rng.range(-0.25, 0.25), core.rng.range(-0.25, 0.25));
    placeMover(mover, core.world, core.doors, cell.x, cell.y, cell.z);
    view.yaw = core.rng.range(-Math.PI, Math.PI);
    const a: Animal = { id: view.id, view, mover, pen, born, shornYear: 0, alive: true, moving: false, driven: false, wakeAt: core.clock.time + core.rng.range(0, 10) };
    this.grow(a);
    pen.animals.push(a);
    core.animals.push(a);
    return a;
  }

  private grow(a: Animal): void {
    const age = this.core.clock.day - a.born;
    a.view.scale = age >= GROWN ? 1 : 0.5 + (0.5 * Math.max(0, age)) / GROWN;
  }

  private cellInPen(pen: PenState): Cell | null {
    const core = this.core;
    const p = pen.pen;
    for (let tries = 0; tries < 12; tries++) {
      const x = core.rng.intRange(p.x0, p.x1);
      const z = core.rng.intRange(p.z0, p.z1);
      if (isStandable(core.world, x, p.y, z, ANIMAL_WALK)) return { x, y: p.y, z };
    }
    return isStandable(core.world, p.x0, p.y, p.z0, ANIMAL_WALK) ? { x: p.x0, y: p.y, z: p.z0 } : null;
  }

  /** Once a day at dawn: growth, eggs, the spring increase and the autumn cull. */
  daily(): void {
    const core = this.core;
    const env = core.env;
    for (const pen of core.pens) {
      for (const a of pen.animals) this.grow(a);
      const grown = pen.animals.filter((a) => env.day - a.born >= GROWN).length;
      if (pen.pen.animal === 'chicken') {
        for (let i = 0; i < grown; i++) {
          if (!core.rng.chance(0.65)) continue;
          pen.eggs++;
          core.stats.eggsLaid++;
        }
      }
      if (env.season === 0) {
        // A pen wiped out is restocked from the common flock at the turn of the year; otherwise the animals see to it themselves.
        const restock = env.seasonProgress < 0.15 && pen.animals.length < 2;
        // The emptier the pen, the likelier a birth: a flock a fox has been at is back to strength by summer, a full one barely grows.
        const room = pen.capacity - pen.animals.length;
        if (restock || (grown >= 2 && room > 0 && core.rng.chance(Math.min(0.85, 0.2 + 0.15 * room)))) {
          if (this.spawn(pen, restock ? env.day - GROWN : env.day)) core.stats.livestockBorn++;
        }
      } else if (env.season === 2 && pen.owner && pen.animals.length > pen.capacity - 1 && pen.flock === FLOCK_PENNED && pen.pen.animal !== 'chicken') {
        // Autumn: one beast more than the winter fodder will carry goes to the larder.
        const oldest = pen.animals.reduce((p, q) => (q.born < p.born ? q : p));
        this.killLivestock(oldest.id);
        core.stats.livestockLost--;
        pen.owner.stock[G.meat] = (pen.owner.stock[G.meat] as number) + 3;
        pen.owner.stock[G.hide] = (pen.owner.stock[G.hide] as number) + 1;
        this.econ.made(G.meat, 3);
        this.econ.made(G.hide, 1);
      }
    }
  }

  /** Advance every animal one tick. */
  tick(): void {
    const core = this.core;
    const now = core.env.now;
    for (const a of core.animals) {
      if (a.moving) {
        if (stepMover(a.mover, core.world, core.doors) === MOVE_WALKING) continue;
        a.moving = false;
        if (a.driven) this.settle(a);
        a.view.anim = 'idle';
        a.wakeAt = now + core.rng.range(2, 6);
        continue;
      }
      a.view.animTime += SIM_DT;
      if (now >= a.wakeAt) this.idle(a);
    }
  }

  /** A driven animal has stopped: at the pasture it is free to graze, in the pen it is an animal behind a gate again. */
  private settle(a: Animal): void {
    a.driven = false;
    a.mover.opens = false;
    a.mover.walk = ANIMAL_WALK;
    a.mover.speed = SPEED[a.view.kind as 'sheep' | 'cow' | 'chicken'];
  }

  private idle(a: Animal): void {
    const core = this.core;
    const now = core.env.now;
    const pen = a.pen;
    const penned = pen.flock === FLOCK_PENNED;
    if (a.driven) {
      // Waiting for its turn through the gate.
      this.follow(a);
      return;
    }
    if (penned && core.env.daylight < 0.15) {
      a.view.anim = 'sleep';
      a.wakeAt = now + 60;
      return;
    }
    if (core.rng.chance(0.45)) {
      a.view.anim = core.rng.chance(0.6) ? 'eat' : 'idle';
      a.wakeAt = now + core.rng.range(4, 12);
      return;
    }
    const path = this.stroll(a, penned || pen.pen.animal !== 'sheep');
    if (path && startPath(a.mover, path, core.world, core.doors) === MOVE_WALKING) {
      a.moving = true;
      a.view.anim = 'walk';
    } else {
      a.wakeAt = now + core.rng.range(3, 8);
    }
  }

  /** A few cells in a straight line, staying inside the pen or near the middle of the pasture. */
  private stroll(a: Animal, inPen: boolean): Path | null {
    const core = this.core;
    const world = core.world;
    const p = a.pen.pen;
    const pasture = core.plan.pasture;
    const reach = Math.min(pasture.radius * 0.7, 9);
    let x = Math.floor(a.view.x);
    let z = Math.floor(a.view.z);
    const y = feetY(a.view.y);
    const tx = x + core.rng.intRange(-3, 3);
    const tz = z + core.rng.intRange(-3, 3);
    const xs = [x];
    const ys = [y];
    const zs = [z];
    for (let step = 0; step < 4; step++) {
      const dx = Math.sign(tx - x);
      const dz = Math.sign(tz - z);
      if (dx === 0 && dz === 0) break;
      // One axis at a time, so a stroll never cuts the corner of a fence.
      const nx = dx !== 0 && (dz === 0 || step % 2 === 0) ? x + dx : x;
      const nz = nx === x ? z + dz : z;
      const inside = inPen
        ? nx >= p.x0 && nx <= p.x1 && nz >= p.z0 && nz <= p.z1
        : (nx + 0.5 - pasture.x) ** 2 + (nz + 0.5 - pasture.z) ** 2 <= reach * reach;
      if (!inside || !isStandable(world, nx, y, nz, ANIMAL_WALK)) break;
      x = nx;
      z = nz;
      xs.push(x);
      ys.push(y);
      zs.push(z);
    }
    return xs.length > 1 ? makePath(xs, ys, zs, xs.length) : null;
  }

  // --- the drive to pasture and back ----------------------------------------------

  private pasture(): Cell | null {
    if (this.pastureCell) return this.pastureCell;
    const area = this.core.plan.pasture;
    const y = groundLevel(this.core.world, area.x, area.z);
    this.pastureCell = y < 0 ? this.core.standNear(area.x, this.core.plan.center.y, area.z, 4) : { x: area.x, y, z: area.z };
    return this.pastureCell;
  }

  /** Start the flock for the pasture. Each animal's route is its own way to the gate joined to the shared road out. */
  driveOut(pen: PenState): void {
    const core = this.core;
    const to = this.pasture();
    const gate = pen.pen.outside;
    if (!to || pen.flock !== FLOCK_PENNED) return;
    pen.driveAt = core.env.now;
    const road = core.nav.findNow(gate.x, gate.y, gate.z, to.x, to.y, to.z, 12000, true);
    if (!road) return;
    pen.flock = FLOCK_GOING_OUT;
    this.send(pen, (a) => {
      const out = core.nav.findNow(Math.floor(a.view.x), feetY(a.view.y), Math.floor(a.view.z), gate.x, gate.y, gate.z, 600);
      return out ? joinPaths([out, road]) : null;
    });
  }

  /** Bring the flock home: in to the middle of the pasture, back along the road, and through the gate to a place in the pen. */
  driveHome(pen: PenState): void {
    const core = this.core;
    const from = this.pasture();
    const gate = pen.pen.outside;
    if (!from || (pen.flock !== FLOCK_AT_PASTURE && pen.flock !== FLOCK_GOING_OUT)) return;
    const road = core.nav.findNow(from.x, from.y, from.z, gate.x, gate.y, gate.z, 12000, true);
    pen.flock = FLOCK_COMING_HOME;
    pen.driveAt = core.env.now;
    this.send(pen, (a) => {
      const home = this.cellInPen(pen);
      if (!road || !home) return null;
      const gather1 = core.nav.findNow(Math.floor(a.view.x), feetY(a.view.y), Math.floor(a.view.z), from.x, from.y, from.z, 600);
      const inward = core.nav.findNow(gate.x, gate.y, gate.z, home.x, home.y, home.z, 600);
      return gather1 && inward ? joinPaths([gather1, road, inward]) : null;
    });
  }

  private readonly routes = new Map<Animal, Path>();

  /** Give each animal of a pen its drive route; they set off one after another so the flock strings out along the road. */
  private send(pen: PenState, route: (a: Animal) => Path | null): void {
    const core = this.core;
    let turn = 0;
    for (const a of pen.animals) {
      stopMover(a.mover, core.doors);
      a.moving = false;
      const path = route(a);
      if (!path) {
        this.routes.delete(a);
        continue;
      }
      this.routes.set(a, path);
      a.driven = true;
      a.mover.opens = true;
      a.mover.walk = VILLAGER_WALK;
      a.mover.speed = DRIVE_SPEED;
      a.view.anim = 'idle';
      a.wakeAt = core.env.now + turn++ * 1.1;
    }
  }

  private follow(a: Animal): void {
    const core = this.core;
    const path = this.routes.get(a);
    this.routes.delete(a);
    if (path && startPath(a.mover, path, core.world, core.doors) === MOVE_WALKING) {
      a.moving = true;
      a.view.anim = 'walk';
      return;
    }
    this.settle(a);
    a.wakeAt = core.env.now + 2;
  }

  /** Once a second: notice a finished drive, and bring the flock in by itself if dusk or rain finds it still out. */
  watch(): void {
    const core = this.core;
    const env = core.env;
    for (const pen of core.pens) {
      if (pen.flock === FLOCK_PENNED) continue;
      const arrived = pen.animals.every((a) => !a.driven);
      const late = env.now - pen.driveAt > DRIVE_TIMEOUT;
      if (pen.flock === FLOCK_GOING_OUT && (arrived || late)) {
        pen.flock = FLOCK_AT_PASTURE;
      } else if (pen.flock === FLOCK_COMING_HOME && (arrived || late)) {
        for (const a of pen.animals) {
          const p = pen.pen;
          const inside = a.view.x >= p.x0 && a.view.x < p.x1 + 1 && a.view.z >= p.z0 && a.view.z < p.z1 + 1;
          if (inside && !a.driven) continue;
          // Still out after all this time: carried in under someone's arm.
          const cell = this.cellInPen(pen);
          if (!cell) continue;
          placeMover(a.mover, core.world, core.doors, cell.x, cell.y, cell.z);
          a.moving = false;
          this.routes.delete(a);
          this.settle(a);
          core.stats.strays++;
        }
        pen.flock = FLOCK_PENNED;
      }
      if ((pen.flock === FLOCK_AT_PASTURE || pen.flock === FLOCK_GOING_OUT) && (env.bad || env.hour >= env.sunset - 0.5 || env.hour < 5)) this.driveHome(pen);
    }
  }

  // --- the people who keep them ------------------------------------------------------

  /** May the flock be out now? Daylight, dry, no deep snow, and home well before sunset. */
  private grazing(): boolean {
    const env = this.core.env;
    return !env.bad && this.core.ctx.weather.snowCover < 0.5 && env.hour >= 7.25 && env.hour < env.sunset - 1.5;
  }

  shepherdWork(r: Resident): void {
    const core = this.core;
    const env = core.env;
    const b = r.job as Business;
    const pen = b.pens.find((p) => p.pen.animal === 'sheep' && p.animals.length > 0);
    // One of the shepherds has the flock each day; the other keeps the yard.
    const lead = pen !== undefined && b.workers[env.day % b.workers.length] === r;
    if (pen && lead) {
      const out = this.grazing();
      // If no road to the pasture could be found, do not search for one again every few seconds.
      if (pen.flock === FLOCK_PENNED && out && env.now - pen.driveAt > 120) {
        r.activity = 'Letting the flock out to pasture';
        r.outdoor = true;
        if (!go(core, r, pen.pen.outside)) return;
        this.driveOut(pen);
      }
      if (pen.flock === FLOCK_COMING_HOME || (pen.flock !== FLOCK_PENNED && !out)) {
        this.driveHome(pen);
        r.activity = 'Bringing the flock home';
        if (!go(core, r, pen.pen.outside)) return;
        face(r, pen.pen.gate);
        act(core, r, 'idle', 5);
        return;
      }
      if (pen.flock !== FLOCK_PENNED) {
        this.minding(r, pen);
        return;
      }
    }
    if (r.packKind === PACK_JOB && r.packCount > 0) {
      unloadAtJob(core, r);
      return;
    }
    if (this.penChores(r)) return;
    workshop(core, this.econ, r);
  }

  /** Out with the flock: stand by, and in late spring take the fleeces. Uses `r.target` for the sheep being shorn. */
  private minding(r: Resident, pen: PenState): void {
    const core = this.core;
    const env = core.env;
    r.outdoor = true;
    const centre = this.pasture() as Cell;
    if (env.season === 0 && env.seasonProgress > 0.5 && pen.flock === FLOCK_AT_PASTURE) {
      const sheep = pen.animals.find((a) => a.shornYear !== env.year && !a.moving && env.day - a.born >= GROWN);
      if (sheep) {
        const cell: Cell = { x: Math.floor(sheep.view.x), y: feetY(sheep.view.y), z: Math.floor(sheep.view.z) };
        if (r.target && gaveUp(r, r.target)) sheep.shornYear = env.year;
        r.target = cell;
        r.activity = 'Shearing the sheep';
        const near = Math.abs(r.view.x - sheep.view.x) < 1.6 && Math.abs(r.view.z - sheep.view.z) < 1.6;
        // The chosen sheep stands still to be caught, or the shepherd would follow it round the meadow all morning.
        sheep.wakeAt = Math.max(sheep.wakeAt, env.now + 30);
        if (!near && !go(core, r, cell, true, false)) return;
        sheep.wakeAt = env.now + 13;
        r.view.yaw = Math.atan2(sheep.view.x - r.view.x, sheep.view.z - r.view.z);
        act(core, r, 'work', 12, TOOLS_ITEM, () => {
          if (!sheep.alive || sheep.shornYear === env.year) return;
          sheep.shornYear = env.year;
          gather(this.econ, r, G.wool, WOOL_PER_SHEEP, PACK_JOB);
          core.stats.woolShorn += WOOL_PER_SHEEP;
        });
        return;
      }
    }
    r.activity = 'Minding the flock at pasture';
    const post: Cell = core.standNear(centre.x + 3, centre.y, centre.z + 2, 3) ?? centre;
    if (!go(core, r, post)) return;
    face(r, centre);
    act(core, r, core.rng.chance(0.3) ? 'sit' : 'idle', 15 + core.rng.float() * 10);
  }

  /**
   * The morning round of the pens a business owns: feed, look them over, and
   * bring in the eggs. Returns true when the resident was sent to do it.
   */
  penChores(r: Resident): boolean {
    const core = this.core;
    const env = core.env;
    const b = r.job;
    if (!b || env.hour < 6.5 || env.daylight < 0.3 || env.bad) return false;
    for (const pen of b.pens) {
      if (pen.tendedDay === env.day || pen.flock !== FLOCK_PENNED) continue;
      const gate = pen.pen.outside;
      // Whoever holds the place by the gate is doing it; nobody else need come.
      const place = packCell(gate.x, gate.y, gate.z);
      const holder = core.places.get(place);
      if (holder !== undefined && holder !== r.id) continue;
      core.hold(r, place);
      const hens = pen.pen.animal === 'chicken';
      r.activity = hens ? 'Collecting eggs' : `Feeding the ${pen.pen.animal === 'cow' ? 'cows' : 'sheep'}`;
      if (!go(core, r, gate)) return true;
      face(r, pen.pen.gate);
      act(core, r, 'work', 8, hens && pen.eggs > 0 ? (ITEM_ID[G.egg] as number) : -1, () => {
        pen.tendedDay = env.day;
        if (pen.eggs > 0) gather(this.econ, r, G.egg, pen.eggs, PACK_JOB);
        pen.eggs = 0;
        // A wet spring can keep the flock in on the days the fleeces are ready; they are taken at the pen instead.
        if (pen.pen.animal === 'sheep' && env.season === 0 && env.seasonProgress > 0.8) this.shearInPen(r, pen);
        core.release(r);
      });
      return true;
    }
    return false;
  }

  private shearInPen(r: Resident, pen: PenState): void {
    const year = this.core.env.year;
    for (const a of pen.animals) {
      if (a.shornYear === year || this.core.env.day - a.born < GROWN) continue;
      a.shornYear = year;
      gather(this.econ, r, G.wool, WOOL_PER_SHEEP, PACK_JOB);
      this.core.stats.woolShorn += WOOL_PER_SHEEP;
    }
  }
}
