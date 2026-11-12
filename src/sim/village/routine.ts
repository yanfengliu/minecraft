// The daily routine: given the hour, the weekday, the season, the weather and
// how a resident is, decide what they should be doing, and hand over to the
// task that does it. Each trade has a timetable (rise, breakfast, work, midday
// meal, work, errands, supper, evening, bed) shifted by a personal offset; the
// weekday bends it (market on Fairday, chapel and rest on Restday), and the
// tasks themselves give way to rain, snow and darkness.

import { rand2 } from '../../core/rng';
import { FAIR_DAY, REST_DAY, hourIn } from '../clock';
import { act, go, lieDown } from './agent';
import type { Core } from './core';
import { type Economy, richest } from './economy';
import { MARKET_CLOSES, MARKET_OPENS, carryHome, dropErrand, fetchWater, shop, shoppingList, worthATrip } from './errands';
import { farmWork, releasePlot } from './fields';
import { PROFESSIONS, TRADE } from './goods';
import type { Livestock } from './livestock';
import { meal } from './meals';
import {
  type Business, MEAL_BREAKFAST, MEAL_LUNCH, MEAL_SUPPER, PACK_DELIVERY, PACK_HOME, PACK_JOB, PHASE_IDLE, type Resident, type Site,
} from './model';
import { HUNGER_PECKISH, HUNGER_URGENT, updateNeeds } from './needs';
import { fisherWork, hunterWork, minerWork } from './outdoor';
import {
  type Parts, chapelService, homeEvening, lessons, marketVisit, onTheSquare, play, priestWork, reeveWork, stallSelling, tavernEvening,
} from './pastimes';
import type { Social } from './social';
import {
  DAWN_WATCH_STARTS, DUTY_DAWN, DUTY_DAY, DUTY_FIRST, FIRST_WATCH_ENDS, LAMPS_BEFORE_SUNSET, type Lights, dutyOf, guardPost, patrol,
} from './watch';
import { type Woods, woodcutterWork } from './woods';
import { deliver, unloadAtJob, workshop } from './work';

const GOAL_LEISURE = 0;
const GOAL_SLEEP = 1;
const GOAL_MEAL = 2;
const GOAL_WORK = 3;
const GOAL_DELIVER = 4;
const GOAL_UNLOAD = 5;
const GOAL_CARRY_HOME = 6;
const GOAL_SHOP = 7;
const GOAL_WATER = 8;
const GOAL_MARKET = 9;
const GOAL_STALL = 10;
const GOAL_CHAPEL = 11;
const GOAL_LESSONS = 12;
const GOAL_PLAY = 13;
const GOAL_PATROL = 14;
const GOAL_LAMPS = 15;
const GOAL_POST = 16;

/** Hours of the day by trade: rise, start work, stop work, supper, bed. */
const TIMETABLE: Record<string, readonly [number, number, number, number, number]> = {
  default: [5.75, 6.75, 17, 18.25, 21.25],
  // The baker is up before anyone so there is bread by breakfast; the innkeeper keeps the house open through the evening.
  baker: [4.5, 5, 14.5, 17.75, 20.25],
  innkeeper: [7, 8, 21.25, 17, 22],
  storekeeper: [6, 7, 18, 18.5, 21.25],
  priest: [5.5, 6.25, 16.5, 18, 21],
  reeve: [6.25, 7.25, 16.5, 18.25, 21.5],
};
/** Trades that keep their place while the rest of the village goes to the fair. */
const KEEPS_SHOP = new Set<number>([TRADE.storekeeper, TRADE.baker, TRADE.innkeeper, TRADE.shepherd, TRADE.guard]);
/** Weekdays on which the children have lessons. */
const LESSON_DAYS = new Set([0, 2, 5]);
const SERVICE_FROM = 8.75;
const SERVICE_TO = 10.25;
const MEAL_LABELS = ['Having breakfast', 'Eating a midday meal', 'Having supper'];

export class Routine {
  private readonly core: Core;
  private readonly econ: Economy;
  private readonly woods: Woods;
  private readonly livestock: Livestock;
  private readonly lights: Lights;
  private readonly parts: Parts;
  private readonly chapel: Site | null;
  private readonly priest: Resident | null;
  private readonly tavern: Business | null;
  private readonly penChores: (r: Resident) => boolean;
  /** Hour at which the sleeper being looked at is due to rise; set by `choose`, read by `sleep`. */
  private wakeHour = 6;

  constructor(core: Core, econ: Economy, woods: Woods, livestock: Livestock, lights: Lights, social: Social) {
    this.core = core;
    this.econ = econ;
    this.woods = woods;
    this.livestock = livestock;
    this.lights = lights;
    this.parts = { core, econ, social };
    this.chapel = core.sites.find((s) => s.b.kind === 'chapel') ?? null;
    this.priest = core.residents.find((r) => r.trade === TRADE.priest) ?? null;
    this.tavern = core.businesses.find((b) => b.site.b.kind === 'tavern') ?? null;
    this.penChores = (r) => livestock.penChores(r);
  }

  /** Decide what a resident does next and start them on it. Called whenever they finish something. */
  think(r: Resident): void {
    const core = this.core;
    const env = core.env;
    updateNeeds(core, r);
    r.outdoor = false;
    r.selling = false;
    r.running = false;
    if (r.day !== env.day) {
      r.day = env.day;
      r.meals = 0;
      r.waterTrips = 0;
      r.mug = 0;
      // Tonight's plan, fixed for the day: the tavern, the square, or home. Hashed, so it costs the random stream nothing.
      const roll = rand2(r.id, env.day, 7717);
      r.evening = r.child ? 0 : roll < 0.4 ? 1 : roll < 0.65 ? 2 : 0;
    }
    let goal = r.child ? this.chooseChild(r) : r.trade === TRADE.guard ? this.chooseGuard(r) : this.chooseAdult(r);
    // Goods carried for the workplace are put down there before anything but work, food and sleep.
    if (r.packKind === PACK_JOB && r.packCount > 0 && r.job && goal !== GOAL_WORK && goal !== GOAL_SLEEP && goal !== GOAL_MEAL) goal = GOAL_UNLOAD;
    // A hunter with a kill lying in the field fetches it before anything else is thought of. It is a walk
    // of a few seconds; left for the midday meal, the body was gone when they came back, the place where it
    // lay was forgotten with the rest of the morning's plans, and an animal had died for nothing.
    if (r.trade === TRADE.hunter && r.goal === GOAL_WORK && r.targetId > 0 && r.target) goal = GOAL_WORK;
    if (goal !== r.goal) this.leave(r, goal);
    if (goal !== GOAL_SLEEP && r.asleep) r.asleep = false;
    this.run(r, goal);
    // Whatever happened, never leave someone with nothing in hand: they would be asked again every tick.
    if (r.phase === PHASE_IDLE) act(core, r, 'idle', 2);
  }

  /** Tidy up after the goal just ended: claims, half-made plans and scratch state must not leak into the next one. */
  private leave(r: Resident, next: number): void {
    const core = this.core;
    r.goal = next;
    r.step = next === GOAL_PATROL ? -1 : 0;
    r.target = null;
    r.targetId = 0;
    core.release(r);
    releasePlot(r);
    dropErrand(r);
    if (r.haul && !r.haul.loaded && r.job) {
      // A delivery planned but not yet picked up is let go, so a workmate can take it.
      const h = r.haul;
      h.to.incoming[h.good] = (h.to.incoming[h.good] as number) - h.qty;
      r.haul = null;
      if (r.job.hauler === r.id) r.job.hauler = 0;
    }
  }

  // --- what should they be doing? -------------------------------------------------

  private chooseAdult(r: Resident): number {
    const env = this.core.env;
    const h = env.hour;
    const t = TIMETABLE[PROFESSIONS[r.trade] as string] ?? (TIMETABLE.default as readonly [number, number, number, number, number]);
    const rest = env.weekday === REST_DAY;
    const late = env.season === 3 ? 0.5 : 0;
    const wake = t[0] + r.jitter + late + (rest ? 0.75 : 0);
    const bed = t[4] + r.jitter * 0.5;
    this.wakeHour = wake;
    if (r.packKind === PACK_DELIVERY && r.haul?.loaded) return GOAL_DELIVER;
    if (hourIn(h, bed, wake) || (r.energy < 0.08 && h > 19)) return GOAL_SLEEP;
    if (r.hunger >= HUNGER_URGENT) return GOAL_MEAL;
    if (r.packKind === PACK_HOME) return GOAL_CARRY_HOME;
    if (!(r.meals & MEAL_BREAKFAST) && h >= wake && h < wake + 1.25) return GOAL_MEAL;
    if (!(r.meals & MEAL_LUNCH) && h >= 12 && h < 13.25 && r.hunger > HUNGER_PECKISH) return GOAL_MEAL;
    const supper = t[3] + r.jitter * 0.5;
    if (!(r.meals & MEAL_SUPPER) && h >= supper && h < supper + 1.5) return GOAL_MEAL;
    // An errand begun is finished, whatever the timetable says next.
    if (r.goal === GOAL_SHOP && r.targetId > 0) return GOAL_SHOP;
    const start = t[1] + r.jitter + late;
    const end = t[2] + r.jitter * 0.5;
    if (rest) {
      if (h >= SERVICE_FROM && h < SERVICE_TO && this.chapel) return GOAL_CHAPEL;
      // The inn opens at noon and the flock still wants grass; everyone else has the day.
      if (r.trade === TRADE.innkeeper && h >= 12 && h < end) return GOAL_WORK;
      if (r.trade === TRADE.shepherd && h >= SERVICE_TO && h < end) return GOAL_WORK;
      return this.freeTime(r, h);
    }
    if (env.weekday === FAIR_DAY && !env.bad && h >= MARKET_OPENS - 0.25 && h < MARKET_CLOSES) {
      if (this.minds(r)) return GOAL_STALL;
      if (h >= 10 && h < 12 && !KEEPS_SHOP.has(r.trade)) return GOAL_MARKET;
    }
    if (h >= start && h < end && r.job) return GOAL_WORK;
    return this.freeTime(r, h);
  }

  /** Is this the worker who takes the business's stall today? */
  private minds(r: Resident): boolean {
    const b = r.job;
    return b !== null && b.stall !== null && b.workers[this.core.env.day % b.workers.length] === r;
  }

  private chooseChild(r: Resident): number {
    const env = this.core.env;
    const h = env.hour;
    const wake = 6.5 + r.jitter + (env.season === 3 ? 0.5 : 0);
    const bed = 20 + r.jitter * 0.5;
    this.wakeHour = wake;
    if (hourIn(h, bed, wake) || (r.energy < 0.08 && h > 18)) return GOAL_SLEEP;
    if (r.hunger >= HUNGER_URGENT) return GOAL_MEAL;
    if (!(r.meals & MEAL_BREAKFAST) && h >= wake && h < wake + 1.25) return GOAL_MEAL;
    if (!(r.meals & MEAL_LUNCH) && h >= 11.75 && h < 13.25 && r.hunger > HUNGER_PECKISH) return GOAL_MEAL;
    if (!(r.meals & MEAL_SUPPER) && h >= 17.75 && h < 19.25) return GOAL_MEAL;
    const rest = env.weekday === REST_DAY;
    if (rest && h >= SERVICE_FROM && h < SERVICE_TO && this.chapel) return GOAL_CHAPEL;
    const fine = !env.bad && env.daylight > 0.3;
    if (!rest && env.weekday !== FAIR_DAY && LESSON_DAYS.has(env.weekday) && h >= 8.5 && h < 11.5 && this.chapel && this.priest) return GOAL_LESSONS;
    if (fine && r.age >= 8 && h >= 13.25 && h < 17.5 && this.waterWanted(r)) return GOAL_WATER;
    if (fine && h >= 8 && h < 17.75) return GOAL_PLAY;
    return GOAL_LEISURE;
  }

  private chooseGuard(r: Resident): number {
    const env = this.core.env;
    const h = env.hour;
    const n = this.lights.guards;
    const today = dutyOf(n, r, env.day);
    const yesterday = dutyOf(n, r, env.day - 1);
    // After a first watch, and before one, the morning is for sleep; the dawn watch rises in the small hours.
    const wake = (today === DUTY_DAWN ? DAWN_WATCH_STARTS - 0.25 : today === DUTY_FIRST || yesterday === DUTY_FIRST ? 8.5 : 6) + r.jitter * 0.3;
    const bed = today === DUTY_FIRST ? FIRST_WATCH_ENDS : (today === DUTY_DAWN && n < 3 ? 19.75 : 21.3) + r.jitter * 0.3;
    this.wakeHour = wake;
    if (h < wake || h >= bed) return GOAL_SLEEP;
    if (today === DUTY_DAWN && h >= 12.5 && h < 15.5) {
      this.wakeHour = 15.5;
      return GOAL_SLEEP;
    }
    if (r.hunger >= HUNGER_URGENT) return GOAL_MEAL;
    // Lamps come before supper, at both ends of the night, and whoever of the watch is up lends a hand with them:
    // but only while there is a lamp this guard can do something about.
    const lit = this.lights.lampsWanted();
    if ((lit ? h > 12 : h < 12) && this.lights.lampWaiting(r)) return GOAL_LAMPS;
    if (r.packKind === PACK_HOME) return GOAL_CARRY_HOME;
    const watchEnds = env.sunrise + 0.9;
    // The dawn watch eats before going out: it is a long cold while until sunrise.
    if (!(r.meals & MEAL_BREAKFAST) && h >= wake && h < wake + 1.5) return GOAL_MEAL;
    const lunch = today === DUTY_DAWN ? 11.25 : 12;
    if (!(r.meals & MEAL_LUNCH) && h >= lunch && h < lunch + 1.25 && r.hunger > HUNGER_PECKISH) return GOAL_MEAL;
    // A long window for supper: on a late round of the lamps it is eaten afterwards.
    const supper = today === DUTY_FIRST ? Math.min(17.5, env.sunset - 2.25) : 18;
    if (!(r.meals & MEAL_SUPPER) && h >= supper && h < supper + 2.5) return GOAL_MEAL;
    if (r.goal === GOAL_SHOP && r.targetId > 0) return GOAL_SHOP;
    // The first watch ends at the guardhouse, not at the far end of the round: bed is then a short walk away.
    if (today === DUTY_FIRST && h >= env.sunset - LAMPS_BEFORE_SUNSET) return env.dark && h < FIRST_WATCH_ENDS - 0.75 ? GOAL_PATROL : GOAL_POST;
    if (today === DUTY_DAWN && h >= DAWN_WATCH_STARTS && h < watchEnds) return env.dark ? GOAL_PATROL : GOAL_POST;
    if (env.weekday === REST_DAY && h >= SERVICE_FROM && h < SERVICE_TO && this.chapel) return GOAL_CHAPEL;
    if (today === DUTY_DAY && h >= Math.max(wake + 1, 9.5) && h < 17) return GOAL_POST;
    if (today === DUTY_DAWN && h >= 15.5 && h < 17.5) return GOAL_POST;
    return this.freeTime(r, h);
  }

  /** Off duty: see to the household's errands, and otherwise take one's ease. */
  private freeTime(r: Resident, h: number): number {
    const core = this.core;
    const env = core.env;
    const home = r.home;
    if (h < 6 || h >= 20) return GOAL_LEISURE;
    const free = home.errand === 0 || home.errand === r.id;
    if (!env.bad && free && this.waterWanted(r)) {
      // Where a child is old enough to carry it, water is the child's job unless evening comes and it is still not done.
      // Other households draw theirs either before work or after it, so the whole village is not at the well at once.
      const carrier = home.members.some((m) => m.child && m.age >= 8);
      if (carrier ? h >= 17.5 : home.id % 2 === 0 || h >= 12) return GOAL_WATER;
    }
    // On Fairday the shopping waits for the market.
    const beforeFair = env.weekday === FAIR_DAY && h < MARKET_OPENS + 2 && !env.bad;
    if (free && !beforeFair && home.shopDay !== env.day && r.coin > 0 && richest(home.members) === r && worthATrip(shoppingList(core, home, 3))) return GOAL_SHOP;
    return GOAL_LEISURE;
  }

  private waterWanted(r: Resident): boolean {
    const home = r.home;
    const core = this.core;
    return home.waterDay !== core.env.day && (home.errand === 0 || home.errand === r.id) && core.anyFree(r, core.wellSpots);
  }

  // --- doing it ----------------------------------------------------------------------

  private run(r: Resident, goal: number): void {
    const core = this.core;
    const econ = this.econ;
    switch (goal) {
      case GOAL_SLEEP: this.sleep(r); return;
      case GOAL_MEAL: this.eat(r); return;
      case GOAL_WORK: this.work(r); return;
      case GOAL_DELIVER: deliver(core, econ, r); return;
      case GOAL_UNLOAD: unloadAtJob(core, r); return;
      case GOAL_CARRY_HOME: carryHome(core, r); return;
      case GOAL_SHOP:
        if (shop(core, econ, r, 3)) return;
        // Nothing worth going for after all, so the time is the resident's own, and it is spent as leisure under
        // that goal: the scratch fields belong to one task at a time, and what leisure keeps in them is not to be
        // read back at the next thought as an errand begun.
        r.home.shopDay = core.env.day;
        this.leave(r, GOAL_LEISURE);
        this.leisure(r);
        return;
      case GOAL_WATER:
        r.home.errand = r.id;
        fetchWater(core, r);
        return;
      // Wherever people gather there is only so much room; whoever finds none goes home.
      case GOAL_MARKET:
        if (!marketVisit(this.parts, r)) homeEvening(this.parts, r);
        return;
      case GOAL_STALL: stallSelling(this.parts, r, r.job as Business); return;
      case GOAL_CHAPEL:
        if (!chapelService(this.parts, r, this.chapel as Site, r === this.priest)) homeEvening(this.parts, r);
        return;
      case GOAL_LESSONS:
        if (!lessons(this.parts, r, this.chapel as Site)) homeEvening(this.parts, r);
        return;
      case GOAL_PLAY:
        if (!play(this.parts, r)) homeEvening(this.parts, r);
        return;
      case GOAL_PATROL: patrol(core, r); return;
      case GOAL_LAMPS:
        if (!this.lights.lampRound(r)) guardPost(core, r);
        return;
      case GOAL_POST: guardPost(core, r); return;
      default: this.leisure(r);
    }
  }

  private sleep(r: Resident): void {
    const core = this.core;
    const h = core.env.hour;
    // Sleep in stretches that end exactly at the hour of rising, so nobody oversleeps by a stretch.
    const left = ((this.wakeHour - h + 24) % 24) * 60;
    if (!r.asleep) {
      r.activity = 'Going to bed';
      if (!go(core, r, r.bed.stand)) return;
      lieDown(core, r);
      r.asleep = true;
      r.activity = 'Asleep';
    }
    act(core, r, 'sleep', Math.min(60, left + 0.2));
  }

  private eat(r: Resident): void {
    const core = this.core;
    const env = core.env;
    const h = env.hour;
    const which = h < 10.5 ? 0 : h < 15.5 ? 1 : 2;
    const bit = [MEAL_BREAKFAST, MEAL_LUNCH, MEAL_SUPPER][which] as number;
    // On a working day the midday meal is carried from home and eaten at the workplace.
    const away = r.job !== null && r.job.site !== r.home.site && r.inside !== core.sites.indexOf(r.home.site);
    const packed = which === 1 && !r.child && away && env.weekday !== REST_DAY;
    meal(core, this.econ, r, bit, packed, MEAL_LABELS[which] as string);
  }

  private work(r: Resident): void {
    const core = this.core;
    const econ = this.econ;
    switch (r.trade) {
      case TRADE.farmer: farmWork(core, econ, r, this.penChores); return;
      case TRADE.woodcutter: woodcutterWork(core, econ, this.woods, r); return;
      case TRADE.miner: minerWork(core, econ, r); return;
      case TRADE.fisher: fisherWork(core, econ, r); return;
      case TRADE.hunter: hunterWork(core, econ, r); return;
      case TRADE.shepherd: this.livestock.shepherdWork(r); return;
      case TRADE.priest: {
        const env = core.env;
        const teaching = LESSON_DAYS.has(env.weekday) && env.weekday !== FAIR_DAY && env.hour >= 8.5 && env.hour < 11.5;
        priestWork(this.parts, r, teaching);
        return;
      }
      case TRADE.reeve: reeveWork(this.parts, r); return;
      case TRADE.guard: guardPost(core, r); return;
      default: workshop(core, econ, r);
    }
  }

  private leisure(r: Resident): void {
    const env = this.core.env;
    const h = env.hour;
    let venue = r.evening;
    const light = !env.bad && env.daylight > 0.25;
    const rest = env.weekday === REST_DAY;
    // The odd half hour between breakfast and work is spent at home, not walking to the square and back.
    if (!rest && h < 12) venue = 0;
    // By day on Restday, people who would sit at home step out if the weather is kind.
    if (venue === 0 && !r.child && light && rest && h >= 10 && h < 17) venue = 2;
    const tavern = this.tavern;
    // The tavern is for after supper (or a Restday afternoon): nobody walks there only to walk home to eat and back again.
    const open = rest ? h >= 12 && h < 21 : h >= 17 && h < 21 && (r.meals & MEAL_SUPPER) !== 0;
    if (venue === 1 && (!tavern || !open || r.coin < 6 || tavern.site === r.home.site)) venue = light ? 2 : 0;
    if (venue === 2 && !light) venue = 0;
    if (venue === 1 && tavern && tavernEvening(this.parts, r, tavern)) return;
    if (venue === 2 && onTheSquare(this.parts, r)) return;
    homeEvening(this.parts, r);
  }
}
