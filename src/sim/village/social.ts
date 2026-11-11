// What people say: a greeting in passing, the odd remark about the weather,
// prices or an empty stomach, the line a villager gives when the player greets
// them, and the thought the inspector shows. Wording draws on its own random
// stream, so nothing said here can change what happens in the village.

import { FAIR_DAY, REST_DAY } from '../clock';
import type { Core } from './core';
import type { Economy } from './economy';
import { G, LABEL, PROFESSIONS, VALUE } from './goods';
import { PHASE_WALK, type Resident } from './model';
import type { Needs } from './needs';

/** Bubbles showing at once across the whole village. */
const MAX_BUBBLES = 3;
const BUBBLE_SECONDS = 4;
/** Blocks within which two people notice each other. */
const NEAR = 2.3;

const TRADE_LINES: Record<string, string[]> = {
  farmer: ['The soil tells you when it is ready.', 'A dry week and the wheat will stand.', 'Never enough hands at harvest.'],
  miller: ['The stones have been turning since dawn.', 'Good grain makes good flour, and that is all there is to it.'],
  baker: ['The oven has been hot since before light.', 'First loaves are out. Mind, they are still warm.'],
  innkeeper: ['There is a fresh barrel on. Come by this evening.', 'A village is only as good as its ale.'],
  smith: ['Iron wants patience and a hot fire.', 'Bring me a blunt tool and I will send you home with a sharp one.'],
  carpenter: ['Measure twice. I have the scars from measuring once.', 'Oak is honest wood.'],
  weaver: ['The loom never tires, only the weaver.', 'Good cloth outlasts the one who wove it.'],
  storekeeper: ['If the village makes it, I have it on the shelf.', 'Prices move. I only write them down.'],
  priest: ['The chapel door is open to all, Restday or no.', 'Go gently.'],
  reeve: ['Somebody has to keep the accounts straight.', 'The fee keeps the lamps lit and the watch fed.'],
  fisher: ['They bite best before the sun is high.', 'The pond gives what it gives.'],
  hunter: ['You do not find the deer. You wait where the deer will be.', 'Quiet in the woods today.'],
  woodcutter: ['For every tree I take I set a sapling.', 'A sharp axe is half the work.'],
  miner: ['It is cool in the mine whatever the weather.', 'There is good ore in that hill yet.'],
  shepherd: ['The flock knows the way better than I do.', 'A fox was about last night.'],
  guard: ['All quiet. I mean to keep it so.', 'The lamps are lit at dusk, whoever is on.'],
  labourer: ['There is always something wants carrying.'],
  child: ['Want to see how fast I can run?', 'I am not allowed past the pond.', 'I found a beetle. It is mine.'],
};

const given = (r: Resident): string => r.name.split(' ')[0] as string;

export class Social {
  private readonly core: Core;
  private readonly econ: Economy;
  private bubbles = 0;
  private wasBad: boolean;

  constructor(core: Core, econ: Economy) {
    this.core = core;
    this.econ = econ;
    this.wasBad = core.env.bad;
  }

  /** Show a line over a resident's head for a few seconds. Refused if they spoke recently or too many are talking. */
  say(r: Resident, text: string, quiet = 60): boolean {
    const now = this.core.env.now;
    if (r.asleep || r.quietUntil > now || this.bubbles >= MAX_BUBBLES) return false;
    if (r.view.bubble === '') this.bubbles++;
    r.view.bubble = text;
    r.bubbleUntil = now + BUBBLE_SECONDS;
    r.quietUntil = now + quiet + this.core.chatter.range(0, quiet * 0.5);
    return true;
  }

  /** One side of a conversation between two people standing together. */
  chat(r: Resident, other: Resident): void {
    const c = this.core.chatter;
    if (!c.chance(0.5)) return;
    const about = other.child ? 'How are your lessons?' : `And how is ${PROFESSIONS[other.trade]} work these days?`;
    this.say(r, c.pick([
      `How goes it, ${given(other)}?`, about, 'So I said to him...', 'Did you hear the wind last night?', 'You never did!',
      'That is what I heard, anyway.', 'Well, I never.',
    ]), 45);
  }

  /** Once a simulated second: clear old bubbles, let people who pass greet, and now and then let someone remark. */
  sweep(): void {
    const core = this.core;
    const now = core.env.now;
    const people = core.residents;
    for (const r of people) {
      if (r.view.bubble !== '' && now >= r.bubbleUntil) {
        r.view.bubble = '';
        this.bubbles--;
      }
    }
    for (let i = 0; i < people.length; i++) {
      const a = people[i] as Resident;
      if (a.asleep) continue;
      for (let j = i + 1; j < people.length; j++) {
        const b = people[j] as Resident;
        const dx = a.view.x - b.view.x;
        if (dx > NEAR || dx < -NEAR) continue;
        const dz = a.view.z - b.view.z;
        if (dz > NEAR || dz < -NEAR || b.asleep) continue;
        // Company counts whether or not anyone speaks.
        a.social = Math.min(1, a.social + 0.004);
        b.social = Math.min(1, b.social + 0.004);
        if (a.phase !== PHASE_WALK && b.phase !== PHASE_WALK) continue;
        const speaker = a.phase === PHASE_WALK ? a : b;
        if (this.say(speaker, this.greeting(speaker, speaker === a ? b : a), 90)) core.stats.greetings++;
      }
    }
    // The player walking up gets a word, and whoever is minding a counter or a stall turns to face a customer.
    const player = core.ctx.player;
    if (player) {
      for (const r of people) {
        const dx = player.x - r.view.x;
        const dz = player.z - r.view.z;
        if (r.asleep || dx * dx + dz * dz > 9 || Math.abs(player.y - r.view.y) > 2) continue;
        if (r.selling && r.phase !== PHASE_WALK) r.view.yaw = Math.atan2(dx, dz);
        const c = core.chatter;
        this.say(r, r.selling ? c.pick(['What can I get you?', 'Looking to buy?', 'Fair prices here.']) : c.pick(['Good day, stranger.', 'Hello there.', 'Well met.']), 150);
      }
    }
    const turnedBad = core.env.bad && !this.wasBad;
    this.wasBad = core.env.bad;
    // One person in a while says what is on their mind; when the rain starts, someone caught in it says so.
    if (turnedBad || core.chatter.chance(0.05)) {
      const r = people[core.chatter.int(people.length)];
      if (r && !r.asleep) {
        const line = this.remark(r, turnedBad);
        if (line) this.say(r, line, 120);
      }
    }
  }

  private greeting(r: Resident, other: Resident): string {
    const env = this.core.env;
    const c = this.core.chatter;
    const name = given(other);
    if (env.bad && c.chance(0.4)) return c.pick([`Foul day, ${name}.`, 'Get in out of the wet!']);
    const hello = env.hour < 11 ? 'Morning' : env.hour < 17 ? 'Good day' : 'Evening';
    return c.pick([`${hello}, ${name}.`, `${hello}!`, `${name}.`, r.child ? `Hello, ${name}!` : 'Mind how you go.']);
  }

  /** A remark fitting how the resident is and what is going on, or '' when there is nothing to say. */
  private remark(r: Resident, rainJustBegan: boolean): string {
    const core = this.core;
    const env = core.env;
    const c = core.chatter;
    if (rainJustBegan) return r.outdoor ? c.pick(['Here it comes.', 'Rain! Under cover, quick.', 'There goes the afternoon.']) : '';
    if (r.hunger > 0.6) return c.pick(['I am famished.', 'Is it not time to eat?', 'My belly is growling.']);
    if (r.energy < 0.22) return c.pick(['I am dead on my feet.', 'Bed cannot come soon enough.']);
    if (env.bad && r.inside < 0) return c.pick(['Soaked to the skin.', 'This weather!']);
    if (c.chance(0.4)) {
      const g = r.job && r.job.spec.sells.length > 0 ? G[c.pick(r.job.spec.sells)] : G.bread;
      const ratio = this.econ.marketPrice(g) / (VALUE[g] as number);
      if (ratio > 1.35) return `${cap(LABEL[g] as string)} is dear this week.`;
      if (ratio < 0.7) return `${cap(LABEL[g] as string)} is going cheap.`;
    }
    if (env.weekday === FAIR_DAY && env.hour < 13) return c.pick(['Fair day! The square will be full.', 'I must get to the stalls.']);
    if (env.weekday === REST_DAY) return c.pick(['A day of rest, and well earned.', 'No work today.']);
    if (r.inside < 0 && env.temperature < 2) return 'Bitter cold.';
    return c.chance(0.5) ? c.pick(TRADE_LINES[PROFESSIONS[r.trade] as string] ?? ['Hm.']) : '';
  }

  /** What a villager says when the player greets them. */
  talk(r: Resident): string {
    const core = this.core;
    const env = core.env;
    const c = core.chatter;
    const trade = PROFESSIONS[r.trade] as string;
    if (r.asleep) return '...';
    if (r.hunger > 0.6) return c.pick(['Forgive me, I have not eaten and can think of nothing else.', 'I would talk, but my stomach is louder than I am.']);
    if (r.energy < 0.22) return c.pick(['I can barely keep my eyes open.', 'Ask me tomorrow. I am asleep where I stand.']);
    if (env.bad) return c.pick(['No day to be out of doors. Come in under the eaves.', 'It will pass. It always does.']);
    if (c.chance(0.35)) {
      const g = r.job && r.job.spec.sells.length > 0 ? G[c.pick(r.job.spec.sells)] : G.bread;
      const price = this.econ.marketPrice(g);
      const ratio = price / (VALUE[g] as number);
      const coins = Math.max(1, Math.round(price));
      const how = ratio > 1.3 ? 'and dear at that' : ratio < 0.75 ? 'which is cheap' : 'a fair price';
      return `${cap(LABEL[g] as string)} is at ${coins} ${coins === 1 ? 'coin' : 'coins'} today, ${how}.`;
    }
    if (env.weekday === FAIR_DAY && env.hour < 13 && c.chance(0.5)) return 'It is fair day. You will find most of us on the square.';
    if (env.temperature < 2 && c.chance(0.3)) return 'Keep your fire in. There is frost about.';
    return c.pick(TRADE_LINES[trade] ?? ['Good day to you.']);
  }

  /** The thought shown in the inspector: the most pressing thing on a resident's mind. */
  thought(r: Resident, needs: Needs): string {
    const env = this.core.env;
    if (r.asleep) return 'Dreaming.';
    if (needs.hunger > 0.7) return 'Starving. Nothing matters until there is food.';
    if (needs.hunger > 0.45) return 'Looking forward to the next meal.';
    if (needs.energy < 0.25) return 'Worn out, and thinking of bed.';
    if (env.bad && r.inside < 0) return 'Wet through. Shelter first.';
    if (needs.social < 0.25) return 'Could do with some company.';
    if (!r.child && r.coin < 6) return 'Counting coppers, and not many of them.';
    if (env.weekday === (FAIR_DAY + 6) % 7) return 'The fair is tomorrow.';
    if (needs.mood > 0.75) return 'Content with the day.';
    return r.child ? 'Wondering what is over the hill.' : 'Thinking about the work in hand.';
  }
}

const cap = (s: string): string => s.charAt(0).toUpperCase() + s.slice(1);
