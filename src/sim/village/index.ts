// The village simulation's facade. Construct it from a `SimContext` and a
// validated `VillagePlan`, advance the clock by `SIM_DT`, then call `tick()`.
// Everything the game needs is here: the entity views to draw, the inspector,
// the livestock service for predators, the ledger, and trade for the player.
// Headless and deterministic: the same seed and the same inputs give the same
// village.

import type { GoodName } from '../../world/items';
import type { EntityView, InspectInfo, LivestockApi, SimContext, VillagePlan } from '../api';
import { SIM_DT } from '../clock';
import { interrupt, tickResident } from './agent';
import { Core, ENV_EVERY } from './core';
import { Economy, type LedgerView } from './economy';
import { Crops } from './fields';
import { G, PROFESSIONS } from './goods';
import { inspectAnimal, inspectResident } from './inspect';
import { Livestock } from './livestock';
import { PHASE_ACT, PHASE_IDLE, PHASE_WALK, type VillageStats } from './model';
import { populate } from './populate';
import { Routine } from './routine';
import { Social } from './social';
import { Lights } from './watch';
import { Woods } from './woods';

export type { LedgerGood, LedgerView } from './economy';
export type { VillageStats } from './model';
export { PROFESSIONS } from './goods';

/** Days one person takes to wear out a unit of cloth, and one working adult a set of tools. */
const CLOTH_DAYS = 28;
const TOOL_DAYS = 14;
/** A gap between ticks longer than this many simulated seconds means the clock was set, not stepped. */
const JUMP = 5;

export class VillageSim {
  /** Every villager, child and farm animal. Objects are stable for an entity's life and mutated in place. */
  readonly views: EntityView[];
  /** The villagers and children alone: what `SimContext.people` should return, for animals that keep their distance. */
  readonly people: readonly EntityView[];
  readonly livestock: LivestockApi;
  readonly stats: VillageStats;
  /** `EntityView.role` indexes this list. */
  readonly professions: readonly string[] = PROFESSIONS;
  /** The simulation's internals, for tests and debugging tools. The game should not need them. */
  readonly core: Core;
  readonly economy: Economy;

  private readonly crops: Crops;
  private readonly woods: Woods;
  private readonly herd: Livestock;
  private readonly lights: Lights;
  private readonly social: Social;
  private readonly routine: Routine;
  private lastTime: number;
  private lastDay: number;
  private lastHour: number;
  private wasBad: boolean;

  constructor(ctx: SimContext, plan: VillagePlan) {
    const core = new Core(ctx, plan);
    this.core = core;
    this.economy = new Economy(core);
    populate(core, this.economy);
    this.herd = new Livestock(core, this.economy);
    this.crops = new Crops(core);
    this.woods = new Woods(core);
    this.lights = new Lights(core);
    this.social = new Social(core, this.economy);
    this.routine = new Routine(core, this.economy, this.woods, this.herd, this.lights, this.social);
    core.think = (r) => this.routine.think(r);
    this.views = core.views;
    this.people = core.residents.map((r) => r.view);
    this.stats = core.stats;
    this.livestock = this.herd;
    this.lastTime = core.clock.time;
    this.lastDay = core.env.day;
    this.lastHour = Math.floor(core.env.hour);
    this.wasBad = core.env.bad;
  }

  /** Advance by one `SIM_DT`. The caller advances `ctx.clock` first. */
  tick(): void {
    const core = this.core;
    const env = core.env;
    const now = core.clock.time;
    if (now < this.lastTime || now - this.lastTime > JUMP) this.resync(now);
    this.lastTime = now;
    env.now = now;
    env.hour = core.clock.hour;
    if (core.ticks % ENV_EVERY === 0) this.everySecond();
    core.ticks++;
    core.nav.update();
    for (const r of core.residents) {
      // A walker's animation advances with the ground covered (in the follower); everyone else's with time.
      if (r.phase !== PHASE_WALK) r.view.animTime += SIM_DT;
      tickResident(core, r);
    }
    this.herd.tick();
    this.crops.tick();
  }

  private everySecond(): void {
    const core = this.core;
    const env = core.env;
    core.refreshEnv();
    if (env.bad && !this.wasBad) {
      // The rain has come on: whoever is out in it breaks off and thinks again, which sends them under cover.
      for (const r of core.residents) if (r.outdoor && !r.asleep && r.phase !== PHASE_IDLE) interrupt(core, r);
    }
    this.wasBad = env.bad;
    this.lights.sweep();
    this.social.sweep();
    this.herd.watch();
    this.woods.tick();
    const hour = Math.floor(env.hour);
    if (hour !== this.lastHour) {
      this.lastHour = hour;
      this.economy.updatePrices();
      if (hour === 18) this.economy.payDay();
      if (hour === 5) this.herd.daily();
    }
    if (env.day !== this.lastDay) {
      this.lastDay = env.day;
      this.newDay();
    }
  }

  private newDay(): void {
    const econ = this.economy;
    econ.closeDay();
    econ.spoil();
    for (const home of this.core.households) {
      const larder = home.larder;
      const adults = home.members.filter((m) => !m.child).length;
      home.clothWear = Math.min(2, home.clothWear + home.members.length / CLOTH_DAYS);
      home.toolWear = Math.min(2, home.toolWear + adults / TOOL_DAYS);
      while (home.clothWear >= 1 && (larder[G.cloth] as number) > 0) {
        larder[G.cloth] = (larder[G.cloth] as number) - 1;
        home.clothWear -= 1;
        econ.used(G.cloth, 1);
      }
      while (home.toolWear >= 1 && (larder[G.tools] as number) > 0) {
        larder[G.tools] = (larder[G.tools] as number) - 1;
        home.toolWear -= 1;
        econ.used(G.tools, 1);
      }
    }
  }

  /** The clock was set rather than stepped (a debug jump): pull every timer back within reach of the new time. */
  private resync(now: number): void {
    const core = this.core;
    const soon = now + 2;
    for (const r of core.residents) {
      if (r.phase === PHASE_ACT) {
        r.actEnd = Math.min(r.actEnd, soon);
        r.wakeAt = Math.min(r.wakeAt, r.actEnd);
      }
      r.needsAt = Math.min(r.needsAt, now);
      r.quietUntil = Math.min(r.quietUntil, now + 120);
      r.bubbleUntil = Math.min(r.bubbleUntil, soon);
      r.shopAgainAt = Math.min(r.shopAgainAt, soon);
      r.firewoodAt = Math.min(r.firewoodAt, soon);
      r.restUntil = Math.min(r.restUntil, soon);
      r.plotRetryAt = Math.min(r.plotRetryAt, soon);
    }
    for (const a of core.animals) a.wakeAt = Math.min(a.wakeAt, soon);
    for (const site of core.sites) {
      site.hearthUntil = Math.min(site.hearthUntil, now + 60);
      for (const spot of site.spots) {
        spot.until = Math.min(spot.until, soon);
        spot.fireUntil = Math.min(spot.fireUntil, soon);
      }
    }
    for (const f of core.fields) for (let i = 0; i < f.seen.length; i++) f.seen[i] = Math.min(f.seen[i] as number, now);
    this.lastHour = -1;
  }

  /** What the inspector shows for one of this simulation's entities, or null if the id is not ours. */
  inspect(id: number): InspectInfo | null {
    const core = this.core;
    const r = core.residentById.get(id);
    if (r) return inspectResident(core, this.social, r);
    const a = core.animals.find((an) => an.id === id);
    return a ? inspectAnimal(core, a) : null;
  }

  /** Prices, stocks and the day's production and consumption, with the village's coin. Plain data. */
  ledger(): LedgerView {
    return this.economy.ledger();
  }

  /** True when this villager is a seller standing at their counter or market stall. */
  canTrade(villagerId: number): boolean {
    const r = this.core.residentById.get(villagerId);
    return r !== undefined && r.selling && r.phase === PHASE_ACT && !r.asleep;
  }

  /** Coins the player would pay for `qty` of a good, or null if the village cannot supply it. */
  quoteBuy(good: GoodName | string, qty: number): number | null {
    return this.economy.quoteBuy(good, qty);
  }

  /** Coins the village would pay the player for `qty` of a good, or null if nobody will take it. */
  quoteSell(good: GoodName | string, qty: number): number | null {
    return this.economy.quoteSell(good, qty);
  }

  /** The player buys from the village. Stock leaves the shelves and `coins` enters the tills; the caller debits the player. */
  buy(good: GoodName | string, qty: number): { ok: boolean; coins: number } {
    return this.economy.buy(good, qty);
  }

  /** The player sells to the village. Stock joins a business's shelves and `coins` leaves its till; the caller credits the player. */
  sell(good: GoodName | string, qty: number): { ok: boolean; coins: number } {
    return this.economy.sellFromPlayer(good, qty);
  }

  /** One line a villager says when greeted. */
  talk(id: number): string {
    const r = this.core.residentById.get(id);
    return r ? this.social.talk(r) : '';
  }

  /** Stop listening to the world. Call when the simulation is thrown away. */
  dispose(): void {
    this.woods.dispose();
    this.core.dispose();
  }
}
