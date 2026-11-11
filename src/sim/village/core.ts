// The shared state of the village simulation and the small services every
// behaviour module needs: the moment (`env`), buildings as sites, who is
// standing where, cues, and lighting blocks. Behaviour lives in the other
// modules and takes a `Core`.

import type { Rng } from '../../core/rng';
import { B } from '../../world/blocks';
import { isStandable } from '../../world/walk';
import type { World } from '../../world/world';
import type { Building, Cell, EntityKind, EntityView, SimContext, VillagePlan } from '../api';
import type { Clock } from '../clock';
import { Doors, Navigator, VILLAGER_WALK, cellX, cellY, cellZ, nearestStandable, packCell } from '../nav';
import { daylight, sunTimes } from '../sky';
import {
  type Animal, type Business, type Env, type FieldState, type Household, type PenState, type Resident, type Site, type VillageStats,
  emptyStats,
} from './model';

/** Ticks between refreshes of `env`: once a simulated second. */
export const ENV_EVERY = 10;

export class Core {
  readonly ctx: SimContext;
  readonly world: World;
  readonly clock: Clock;
  readonly plan: VillagePlan;
  /** Decisions that change what happens. */
  readonly rng: Rng;
  /** Wording only, kept apart so that greeting a villager never changes the village's future. */
  readonly chatter: Rng;
  readonly nav: Navigator;
  readonly doors: Doors;
  readonly stats: VillageStats = emptyStats();
  readonly env: Env;

  readonly sites: Site[] = [];
  readonly siteById = new Map<number, Site>();
  readonly households: Household[] = [];
  readonly businesses: Business[] = [];
  readonly businessById = new Map<number, Business>();
  readonly residents: Resident[] = [];
  readonly residentById = new Map<number, Resident>();
  readonly animals: Animal[] = [];
  readonly fields: FieldState[] = [];
  readonly pens: PenState[] = [];
  /** Everything the renderer draws: residents first, then livestock. */
  readonly views: EntityView[] = [];
  /** Standing cells round the well; only so many can draw water at once. */
  readonly wellSpots: Cell[] = [];
  /** Standing room on the square, round the gathering points the plan names. */
  readonly squareSpots: Cell[] = [];
  /**
   * For each cell of standing room, by packed cell, the named point it hangs
   * off (the gathering point, the well, a building's doorstep). People walk to
   * the point and then the last few steps, so the long leg is a shared route.
   */
  readonly anchors = new Map<number, Cell>();
  /** Stools sat on, by packed cell of the stool block, to the resident on each. */
  readonly stools = new Map<number, number>();
  /** Standing places taken, by packed cell, to the resident holding each. */
  readonly places = new Map<number, number>();
  /** Coin held by the village as a body: fed by the market fee and the tithe, paid out as stipends and relief. */
  readonly treasury = { coin: 0 };
  ticks = 0;
  /** Ask the routine what a resident does next. Set by the facade, so the runtime need not import the routine. */
  think: (r: Resident) => void = () => {};

  /** Site index + 1 for every column under a building, 0 elsewhere. */
  private readonly siteGrid: Int16Array;

  constructor(ctx: SimContext, plan: VillagePlan) {
    this.ctx = ctx;
    this.world = ctx.world;
    this.clock = ctx.clock;
    this.plan = plan;
    this.rng = ctx.rng.fork('village');
    this.chatter = ctx.rng.fork('village-chatter');
    this.nav = new Navigator(ctx.world);
    this.doors = new Doors(ctx.world);
    this.siteGrid = new Int16Array(this.world.sx * this.world.sz);
    this.env = {
      now: 0, day: 0, hour: 0, weekday: 0, season: 0, seasonProgress: 0, year: 1, daylight: 1, dark: false, bad: false,
      sunrise: 6, sunset: 18, temperature: 10,
    };
    for (const b of plan.buildings) this.addSite(b);
    // Standing room: nobody shares a cell, so every place people gather needs more cells than the plan names.
    const taken = new Set<number>();
    for (const s of plan.stalls) for (const c of [s.stand, s.customer]) taken.add(packCell(c.x, c.y, c.z));
    // Doorsteps are kept clear.
    for (const b of plan.buildings) taken.add(packCell(b.entry.x, b.entry.y, b.entry.z));
    const hang = (cells: Cell[], anchor: Cell): Cell[] => {
      for (const c of cells) this.anchors.set(packCell(c.x, c.y, c.z), anchor);
      return cells;
    };
    this.wellSpots.push(...hang(this.roomAround(plan.well, 1, taken), plan.well));
    if (this.wellSpots.length === 0) this.wellSpots.push(plan.well);
    for (const g of plan.gathering.length > 0 ? plan.gathering : [plan.center]) this.squareSpots.push(...hang(this.roomAround(g, 2, taken), g));
    for (const site of this.sites) site.forecourt.push(...hang(this.roomAround(site.b.entry, 3, taken), site.b.entry));
    this.refreshEnv();
  }

  /**
   * Open standable cells within `radius` columns of a cell and on its level,
   * not under any building and not already in `taken`; each is added to
   * `taken`, so lists built one after another never overlap.
   */
  private roomAround(c: Cell, radius: number, taken: Set<number>): Cell[] {
    const out: Cell[] = [];
    for (let dz = -radius; dz <= radius; dz++) {
      for (let dx = -radius; dx <= radius; dx++) {
        const x = c.x + dx;
        const z = c.z + dz;
        const key = packCell(x, c.y, z);
        if (taken.has(key) || this.siteIndexAt(x, z) >= 0 || !isStandable(this.world, x, c.y, z, VILLAGER_WALK)) continue;
        taken.add(key);
        out.push({ x, y: c.y, z });
      }
    }
    return out;
  }

  /** Bring `env` up to the clock and the weather. Cheap enough for once a second, too dear for every tick. */
  refreshEnv(): void {
    const env = this.env;
    const clock = this.clock;
    const weather = this.ctx.weather;
    env.now = clock.time;
    env.day = clock.day;
    env.hour = clock.hour;
    env.weekday = clock.dayOfWeek;
    env.season = clock.seasonIndex;
    env.seasonProgress = clock.seasonProgress;
    env.year = clock.year;
    env.daylight = daylight(clock);
    env.dark = env.daylight < 0.8;
    env.bad = weather.isRaining;
    env.temperature = weather.temperature;
    const sun = sunTimes(clock);
    env.sunrise = sun.rise;
    env.sunset = sun.set;
  }

  private addSite(b: Building): void {
    const world = this.world;
    const interior: Cell[] = [];
    for (let z = b.z0; z <= b.z1; z++) {
      for (let x = b.x0; x <= b.x1; x++) {
        if (x >= 0 && z >= 0 && x < world.sx && z < world.sz) this.siteGrid[z * world.sx + x] = this.sites.length + 1;
        // A stool is for sitting on, whether or not the block table lets a walker stand on one.
        const free = isStandable(world, x, b.floorY, z, VILLAGER_WALK) && world.get(x, b.floorY, z) !== B.stool;
        if (free && !(b.door && b.door.x === x && b.door.z === z)) interior.push({ x, y: b.floorY, z });
      }
    }
    // Nearest the door first, so a visitor does not push to the back of the room.
    const door = b.door ?? b.entry;
    interior.sort((p, q) => Math.abs(p.x - door.x) + Math.abs(p.z - door.z) - (Math.abs(q.x - door.x) + Math.abs(q.z - door.z)));
    const drop = b.storage ?? interior[0] ?? b.entry;
    const counter = b.work.find((w) => w.kind === 'counter') ?? null;
    let customer = interior[0] ?? b.entry;
    if (counter?.block) {
      // Across the counter from whoever serves at it.
      const cx = counter.block.x * 2 - counter.stand.x;
      const cz = counter.block.z * 2 - counter.stand.z;
      if (isStandable(world, cx, b.floorY, cz, VILLAGER_WALK)) customer = { x: cx, y: b.floorY, z: cz };
    }
    // Floor nobody has a use for: not where a sleeper gets up, a worker stands, a sitter sits or a customer is served.
    const spoken = new Set<number>();
    for (const c of [drop, customer, ...b.seats, ...b.beds.map((bed) => bed.stand), ...b.work.map((w) => w.stand)]) spoken.add(packCell(c.x, c.y, c.z));
    const floor = interior.filter((c) => !spoken.has(packCell(c.x, c.y, c.z)));
    const site: Site = {
      b, interior, floor, forecourt: [], drop, customer,
      spots: b.work.map((spot) => ({ spot, user: 0, until: 0, fireUntil: 0, lit: false })),
      awake: 0, lit: false, hearthUntil: 0,
    };
    this.sites.push(site);
    this.siteById.set(b.id, site);
  }

  /** Index of the site whose footprint covers this column, or -1. */
  siteIndexAt(x: number, z: number): number {
    const world = this.world;
    const cx = Math.floor(x);
    const cz = Math.floor(z);
    if (cx < 0 || cz < 0 || cx >= world.sx || cz >= world.sz) return -1;
    return (this.siteGrid[cz * world.sx + cx] as number) - 1;
  }

  makeView(id: number, kind: EntityKind, look: number, role: number, scale: number): EntityView {
    const view: EntityView = { id, kind, look, role, x: 0, y: 0, z: 0, yaw: 0, anim: 'idle', animTime: 0, scale, held: -1, bubble: '' };
    this.views.push(view);
    return view;
  }

  /** True when an entity stands in this feet cell. */
  at(view: EntityView, c: Cell): boolean {
    return Math.floor(view.x) === c.x && Math.floor(view.z) === c.z && Math.abs(view.y - c.y) < 1.2;
  }

  /**
   * Pick a standing place for a resident from a list and hold it, or return
   * null when every place is taken: nobody shares a cell. A resident keeps the
   * place they already hold if it is in the list; otherwise the search starts
   * at a per-resident offset, which spreads people over the seats instead of
   * filling them in order.
   */
  claim(r: Resident, cells: readonly Cell[], from = r.id): Cell | null {
    if (cells.length === 0) return null;
    if (r.place >= 0) {
      for (const c of cells) if (packCell(c.x, c.y, c.z) === r.place && this.places.get(r.place) === r.id) return c;
    }
    const start = from % cells.length;
    for (let i = 0; i < cells.length; i++) {
      const c = cells[(start + i) % cells.length] as Cell;
      const key = packCell(c.x, c.y, c.z);
      const holder = this.places.get(key);
      if (holder === undefined || holder === r.id) {
        this.hold(r, key);
        return c;
      }
    }
    return null;
  }

  /** True when one of these places is free, or already this resident's. */
  anyFree(r: Resident, cells: readonly Cell[]): boolean {
    for (const c of cells) {
      const holder = this.places.get(packCell(c.x, c.y, c.z));
      if (holder === undefined || holder === r.id) return true;
    }
    return false;
  }

  /** Take one specific place if it is free. Returns false when someone else holds it. */
  hold(r: Resident, key: number): boolean {
    const holder = this.places.get(key);
    if (holder !== undefined && holder !== r.id) return false;
    if (r.place !== key) this.release(r);
    this.places.set(key, r.id);
    r.place = key;
    return true;
  }

  release(r: Resident): void {
    if (r.place >= 0 && this.places.get(r.place) === r.id) this.places.delete(r.place);
    r.place = -1;
  }

  /** A cue for the renderer at the middle of a block's top face. */
  effect(kind: string, c: Cell): void {
    this.ctx.actions.effect(kind, c.x + 0.5, c.y + 1, c.z + 0.5);
  }

  /**
   * Switch a block that has a lit variant on or off, keeping its orientation.
   * Lit is always the next state id after unlit (lanterns, forges, ovens per
   * facing), so one helper serves them all. Does nothing if the block has gone.
   */
  setLit(c: Cell, lit: boolean): void {
    const world = this.world;
    const s = world.get(c.x, c.y, c.z);
    let base = -1;
    if (s >= B.lantern && s < B.lantern + 2) base = B.lantern;
    else if (s >= B.hanging_lantern && s < B.hanging_lantern + 2) base = B.hanging_lantern;
    else if (s >= B.forge && s < B.forge + 2) base = B.forge;
    else if (s >= B.campfire && s < B.campfire + 2) base = B.campfire;
    else if (s >= B.oven && s < B.oven + 8) base = B.oven + (((s - B.oven) >> 1) << 1);
    if (base < 0) return;
    world.set(c.x, c.y, c.z, base + (lit ? 1 : 0));
  }

  /** A standable cell at or beside the given one, for standing next to a block that may sit in a wall or on a post. */
  standNear(x: number, y: number, z: number, radius = 2): Cell | null {
    const key = nearestStandable(this.world, x, y, z, radius, VILLAGER_WALK);
    return key < 0 ? null : { x: cellX(key), y: cellY(key), z: cellZ(key) };
  }

  dispose(): void {
    this.nav.dispose();
  }
}
