// The fields: crop growth, which this simulation owns for every field in the
// plan, and the farmer's work on them. The blocks are the truth (a crop's stage
// is its block state, wet soil is the wet farmland variant); this module keeps
// only what blocks cannot hold, such as progress toward the next stage.

import { clamp } from '../../core/math';
import { rand2 } from '../../core/rng';
import { B, BLOCKS, REPLACEABLE, cropStage } from '../../world/blocks';
import type { Cell } from '../api';
import { DAY_SECONDS, SIM_DT } from '../clock';
import { groundLevel } from '../nav';
import { act, cue, face, feetY, gaveUp, go } from './agent';
import type { Core } from './core';
import type { Economy } from './economy';
import { CARRY, G, ITEM_ID, TOOLS_ITEM, goodIndex } from './goods';
import { type Business, type FieldState, PACK_JOB, type Resident } from './model';
import { gather, hasDelivery, haul, spotOf, toolFactor, unloadAtJob } from './work';

/** Simulated seconds between growth visits to one cell. */
const GROW_PERIOD = 30;
/** Growth stages per day in mild, damp-enough conditions. */
const GROW_RATE = 0.6;
const OP_NONE = 0;
const OP_HARVEST = 1;
const OP_TILL = 2;
const OP_SOW = 3;
const OP_WATER = 4;
/** Cells one trip to the well waters, and trips a farmer makes in a day. */
const WATER_LOAD = 12;
const WATER_TRIPS = 2;
/** A barn holding this many times its target of a crop leaves that crop's field fallow. */
const FALLOW_AT = 2.5;

const isFarmland = (s: number): boolean => s === B.farmland || s === B.farmland + 1;

export class Crops {
  private readonly core: Core;
  private field = 0;
  private cell = 0;
  private owed = 0;
  private readonly total: number;

  constructor(core: Core) {
    this.core = core;
    this.total = core.fields.reduce((n, f) => n + f.w * f.d, 0);
  }

  /** Visit a few cells each tick, round robin, so every cell is seen about twice an in-game hour. */
  tick(): void {
    if (this.total === 0) return;
    this.owed += (this.total * SIM_DT) / GROW_PERIOD;
    while (this.owed >= 1) {
      this.owed -= 1;
      const fs = this.core.fields[this.field] as FieldState;
      this.visit(fs, this.cell);
      if (++this.cell >= fs.w * fs.d) {
        this.cell = 0;
        this.field = (this.field + 1) % this.core.fields.length;
      }
    }
  }

  private visit(fs: FieldState, i: number): void {
    const core = this.core;
    const world = core.world;
    const weather = core.ctx.weather;
    const now = core.env.now;
    const f = fs.f;
    const x = f.x0 + (i % fs.w);
    const z = f.z0 + Math.floor(i / fs.w);
    const dt = now - (fs.seen[i] as number);
    fs.seen[i] = now;
    let soil = world.get(x, f.y, z);
    if (!isFarmland(soil)) return;
    // Rain and a soaked ground wet the soil; so does a farmer with a bucket. It dries when the ground does.
    const byHand = (fs.watered[i] as number) > now;
    const rained = (weather.precipitation > 0.05 && !weather.snowing) || weather.wetness > 0.4;
    if (soil === B.farmland && (byHand || rained)) {
      soil = B.farmland + 1;
      world.set(x, f.y, z, soil);
    } else if (soil === B.farmland + 1 && !byHand && weather.wetness < 0.2 && weather.precipitation <= 0.05) {
      soil = B.farmland;
      world.set(x, f.y, z, soil);
    }
    const crop = world.get(x, f.y + 1, z);
    const stage = cropStage(crop);
    // Nothing grows in winter; a crop caught by it waits for spring.
    if (stage < 0 || stage >= 3 || core.env.season === 3 || dt <= 0) return;
    const warmth = clamp((weather.temperature + 6) / 20, 0.25, 1.25);
    const moisture = soil === B.farmland + 1 ? 1.25 : 0.85;
    // Each cell has its own vigour, so a field ripens raggedly rather than all at once.
    const vigour = 0.8 + 0.4 * rand2(x, z, 9173);
    let g = (fs.growth[i] as number) + (Math.min(dt, DAY_SECONDS) / DAY_SECONDS) * GROW_RATE * warmth * moisture * vigour;
    if (g >= 1) {
      g -= 1;
      world.set(x, f.y + 1, z, crop + 1);
      core.stats.cropStages++;
    }
    fs.growth[i] = Math.min(g, 0.99);
  }
}

function canSow(core: Core, farm: Business, fs: FieldState): boolean {
  const env = core.env;
  // Sown late in autumn a crop overwinters and is the first harvest of spring; later than that the seed is wasted.
  if (env.season === 3 || (env.season === 2 && env.seasonProgress > 0.75)) return false;
  const g = G[fs.f.crop];
  return (farm.stock[g] as number) < (farm.target[g] as number) * FALLOW_AT;
}

/** What a field cell needs done, for a farmer who may or may not be carrying water. */
function opFor(core: Core, farm: Business, fs: FieldState, i: number, hasWater: boolean): number {
  const world = core.world;
  const f = fs.f;
  const x = f.x0 + (i % fs.w);
  const z = f.z0 + Math.floor(i / fs.w);
  const soil = world.get(x, f.y, z);
  const above = world.get(x, f.y + 1, z);
  const stage = cropStage(above);
  if (stage === 3) return OP_HARVEST;
  if (stage >= 0) {
    if (hasWater && stage <= 1 && soil === B.farmland && (fs.watered[i] as number) <= core.env.now) return OP_WATER;
    return OP_NONE;
  }
  if (!REPLACEABLE[above] || !canSow(core, farm, fs)) return OP_NONE;
  if (!isFarmland(soil)) return soil === B.dirt || soil === B.grass ? OP_TILL : OP_NONE;
  return fs.tilled[i] ? OP_SOW : OP_TILL;
}

function claimed(core: Core, fs: FieldState, i: number, r: Resident): boolean {
  const id = fs.claim[i] as number;
  if (id === 0 || id === r.id) return false;
  const other = core.residentById.get(id);
  return other !== undefined && other.field === fs && other.plot === i;
}

/** Let go of the field cell a farmer was working. */
export function releasePlot(r: Resident): void {
  if (r.field && r.plot >= 0 && r.field.claim[r.plot] === r.id) r.field.claim[r.plot] = 0;
  r.field = null;
  r.plot = -1;
  r.op = OP_NONE;
}

/** The nearest cell of the farm's fields that needs work; harvest before tilling and sowing, watering last. */
function findPlot(core: Core, farm: Business, r: Resident): { fs: FieldState; i: number; op: number } | null {
  const vx = r.view.x;
  const vz = r.view.z;
  let best: { fs: FieldState; i: number; op: number } | null = null;
  let bestScore = Infinity;
  for (const fs of farm.fields) {
    const f = fs.f;
    const n = fs.w * fs.d;
    for (let i = 0; i < n; i++) {
      const op = opFor(core, farm, fs, i, r.water > 0);
      if (op === OP_NONE || claimed(core, fs, i, r)) continue;
      const dx = f.x0 + (i % fs.w) + 0.5 - vx;
      const dz = f.z0 + Math.floor(i / fs.w) + 0.5 - vz;
      const score = Math.abs(dx) + Math.abs(dz) + (op === OP_HARVEST ? 0 : op === OP_WATER ? 60 : 30);
      if (score < bestScore) {
        bestScore = score;
        best = { fs, i, op };
      }
    }
  }
  return best;
}

/** Seedlings standing in dry soil in dry weather: worth a trip to the well when there are a few. */
function thirsty(core: Core, farm: Business): number {
  const weather = core.ctx.weather;
  if (weather.wetness > 0.15 || core.env.season === 3) return 0;
  let n = 0;
  for (const fs of farm.fields) {
    for (let i = 0; i < fs.w * fs.d; i++) if (opFor(core, farm, fs, i, true) === OP_WATER) n++;
  }
  return n;
}

/** Work one cell of the farm's fields. Returns false when there is nothing to do out there. */
function fieldJob(core: Core, econ: Economy, r: Resident, farm: Business): boolean {
  if (r.field) {
    const f = r.field.f;
    if (gaveUp(r, { x: f.x0 + (r.plot % r.field.w), y: f.y + 1, z: f.z0 + Math.floor(r.plot / r.field.w) })) {
      // No way to that cell just now; leave the fields for a while rather than pick its neighbour and fail again.
      releasePlot(r);
      r.plotRetryAt = core.env.now + 30;
      return false;
    }
  }
  if (r.plotRetryAt > core.env.now) return false;
  if (r.field) {
    // The cell may have changed since it was chosen: grown, been picked by someone, or been built on.
    const op = opFor(core, farm, r.field, r.plot, r.water > 0);
    if (op === OP_NONE) releasePlot(r);
    else r.op = op;
  }
  if (!r.field) {
    const job = findPlot(core, farm, r);
    if (!job) return false;
    r.field = job.fs;
    r.plot = job.i;
    r.op = job.op;
    job.fs.claim[job.i] = r.id;
  }
  const fs = r.field;
  const i = r.plot;
  const f = fs.f;
  const cell: Cell = { x: f.x0 + (i % fs.w), y: f.y + 1, z: f.z0 + Math.floor(i / fs.w) };
  const v = r.view;
  r.outdoor = true;
  r.activity = `${['', 'Harvesting', 'Tilling', 'Sowing', 'Watering'][r.op]} ${f.crop} at ${farm.site.b.name}`;
  // Reach the cells round about without trampling to each one.
  const near = Math.abs(Math.floor(v.x) - cell.x) <= 1 && Math.abs(Math.floor(v.z) - cell.z) <= 1 && Math.abs(feetY(v.y) - cell.y) <= 1;
  if (!near && !go(core, r, cell, true, false)) return true;
  face(r, cell);
  const world = core.world;
  const speed = toolFactor(r);
  if (r.op === OP_HARVEST) {
    act(core, r, 'work', 5 * speed, ITEM_ID[G[f.crop]] as number, () => {
      const crop = world.get(cell.x, cell.y, cell.z);
      if (cropStage(crop) === 3) {
        world.set(cell.x, cell.y, cell.z, B.air);
        const wet = world.get(cell.x, f.y, cell.z) === B.farmland + 1;
        const g = goodIndex(BLOCKS[crop]?.family ?? f.crop);
        gather(econ, r, g < 0 ? G[f.crop] : g, 2 + (core.rng.chance(wet ? 0.5 : 0.15) ? 1 : 0), PACK_JOB);
        fs.growth[i] = 0;
        fs.tilled[i] = 0;
        core.stats.cellsHarvested++;
      }
      releasePlot(r);
    });
  } else if (r.op === OP_TILL) {
    act(core, r, 'work', 4 * speed, TOOLS_ITEM, () => {
      const wet = (fs.watered[i] as number) > core.env.now || core.ctx.weather.wetness > 0.4;
      world.set(cell.x, f.y, cell.z, B.farmland + (wet ? 1 : 0));
      fs.tilled[i] = 1;
      core.stats.cellsTilled++;
    });
    cue(core, r, 'dust', 1.6, { x: cell.x, y: f.y, z: cell.z });
  } else if (r.op === OP_SOW) {
    act(core, r, 'work', 3 * speed, ITEM_ID[G[f.crop]] as number, () => {
      if (REPLACEABLE[world.get(cell.x, cell.y, cell.z)] && isFarmland(world.get(cell.x, f.y, cell.z))) {
        world.set(cell.x, cell.y, cell.z, B[f.crop]);
        fs.growth[i] = 0;
        core.stats.cellsSown++;
      }
      releasePlot(r);
    });
  } else {
    act(core, r, 'work', 2.5, -1, () => {
      fs.watered[i] = core.env.now + DAY_SECONDS;
      if (world.get(cell.x, f.y, cell.z) === B.farmland) world.set(cell.x, f.y, cell.z, B.farmland + 1);
      r.water--;
      core.stats.cellsWatered++;
      releasePlot(r);
    });
  }
  return true;
}

/** A farmer's working day: the fields when the weather and the season allow, the barn and the yard otherwise. */
export function farmWork(core: Core, econ: Economy, r: Resident, penChores: (r: Resident) => boolean): void {
  const farm = r.job as Business;
  const env = core.env;
  if (r.packKind === PACK_JOB && r.packCount >= CARRY) {
    unloadAtJob(core, r);
    return;
  }
  // Whoever is between rows takes the cart when a customer is waiting: a mill without grain stops the village's bread.
  if (!r.field && (r.haul || hasDelivery(core, farm))) {
    if (!r.haul && r.packKind === PACK_JOB && r.packCount > 0) {
      unloadAtJob(core, r);
      return;
    }
    if (haul(core, econ, r)) return;
  }
  const outdoors = !env.bad && env.daylight > 0.3;
  if (outdoors && env.season !== 3) {
    if (fieldJob(core, econ, r, farm)) return;
    if (r.water === 0 && r.waterTrips < WATER_TRIPS && r.packCount === 0 && thirsty(core, farm) >= 6) {
      const spot = core.claim(r, core.wellSpots);
      if (spot) {
        r.activity = 'Fetching water for the fields';
        r.outdoor = true;
        if (!go(core, r, spot)) return;
        act(core, r, 'work', 6, -1, () => {
          r.water = WATER_LOAD;
          r.waterTrips++;
          core.release(r);
        });
        return;
      }
    }
  } else {
    releasePlot(r);
  }
  if (r.packKind === PACK_JOB && r.packCount > 0) {
    unloadAtJob(core, r);
    return;
  }
  if (haul(core, econ, r)) return;
  if (penChores(r)) return;
  yardWork(core, econ, r, outdoors);
}

/** Nothing pressing in the fields: mend and thresh at the farmhouse, and in the cold months bring in firewood. */
function yardWork(core: Core, econ: Economy, r: Resident, outdoors: boolean): void {
  const farm = r.job as Business;
  const home = r.home;
  if (outdoors && (home.larder[G.firewood] as number) < 8 && r.retryAt <= core.env.now) {
    if (r.target && gaveUp(r, r.target)) {
      r.target = null;
      r.retryAt = core.env.now + 60;
    } else {
      r.activity = 'Gathering firewood';
      r.outdoor = true;
      if (!r.target) {
        const area = core.plan.forest;
        const a = core.rng.range(0, Math.PI * 2);
        const x = Math.round(area.x + Math.sin(a) * area.radius * 0.8);
        const z = Math.round(area.z + Math.cos(a) * area.radius * 0.8);
        const y = groundLevel(core.world, x, z);
        r.target = y < 0 ? null : { x, y, z };
      }
      if (r.target) {
        const spot = r.target;
        if (!go(core, r, spot, true, false)) return;
        act(core, r, 'work', 25, ITEM_ID[G.firewood] as number, () => {
          // Windfall for the gatherer's own hearth: it never passes through a shop.
          home.larder[G.firewood] = (home.larder[G.firewood] as number) + 2;
          econ.made(G.firewood, 2);
          r.target = null;
          r.retryAt = core.env.now + 120;
        });
        return;
      }
    }
  }
  const spot = spotOf(farm.site, 'workbench') ?? farm.site.spots[0];
  // The first there takes the bench; the others find room about the house.
  const cell = core.claim(r, spot ? [spot.spot.stand, ...farm.site.floor] : farm.site.floor) ?? farm.site.b.entry;
  r.activity = `Mending and threshing at ${farm.site.b.name}`;
  if (!go(core, r, cell)) return;
  if (spot?.spot.block) face(r, spot.spot.block);
  act(core, r, 'work', 15 + core.rng.float() * 10, TOOLS_ITEM);
}
