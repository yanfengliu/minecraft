// What the inspector panel says about a wild animal: what it is, what it is
// doing and why, and how it is faring. Plain words built from the animal's
// state; nothing here feeds back into the simulation.

import type { InspectInfo } from '../api';
import { DAY_SECONDS, DAYS_PER_SEASON, DAYS_PER_YEAR } from '../clock';
import { BOAR, FISH, GT_SOLO } from './species';
import type { Eco } from './state';
import {
  type Animal, ST_CHASE, ST_COURT, ST_DABBLE, ST_DEAD, ST_EAT, ST_FEED, ST_FLEE, ST_FLY, ST_FOLLOW, ST_HIDE, ST_HUNT, ST_IDLE,
  ST_PERCH, ST_REST, ST_ROOST, ST_SEEK, ST_SLEEP, ST_STALK, ST_SWIM, ST_TRAVEL, ST_WANDER, WHY_BAND, WHY_BREED, WHY_DAY,
  WHY_FED, WHY_FLOCK, WHY_HABIT, WHY_HUNGRY, WHY_MOTHER, WHY_NIGHT, WHY_PERSON, WHY_PREDATOR, WHY_RAIN, WHY_SEASON,
  WHY_STARVING, WHY_TIRED,
} from './types';

const DOING: Record<number, string> = {
  [ST_IDLE]: 'Standing about',
  [ST_WANDER]: 'Ambling',
  [ST_SEEK]: 'Looking for something to eat',
  [ST_EAT]: 'Feeding',
  [ST_REST]: 'Resting',
  [ST_SLEEP]: 'Asleep',
  [ST_FLEE]: 'Running away',
  [ST_HUNT]: 'Ranging for prey',
  [ST_STALK]: 'Creeping up on its prey',
  [ST_CHASE]: 'Running its prey down',
  [ST_FEED]: 'Eating a kill',
  [ST_COURT]: 'Courting',
  [ST_FOLLOW]: 'Keeping to its mother',
  [ST_TRAVEL]: 'On the move',
  [ST_FLY]: 'On the wing',
  [ST_PERCH]: 'Perched',
  [ST_ROOST]: 'Roosting',
  [ST_SWIM]: 'Swimming',
  [ST_DABBLE]: 'Dabbling',
  [ST_HIDE]: 'Down its burrow',
  [ST_DEAD]: 'Dead',
};

const WHY: Record<number, string> = {
  [WHY_HUNGRY]: 'It is hungry.',
  [WHY_HABIT]: 'This is the hour it feeds.',
  [WHY_DAY]: 'It lies up through the day.',
  [WHY_NIGHT]: 'It is night.',
  [WHY_PERSON]: 'Someone came too close.',
  [WHY_PREDATOR]: 'A hunter is near.',
  [WHY_RAIN]: 'It is sheltering from the rain.',
  [WHY_BREED]: 'It is the breeding season.',
  [WHY_MOTHER]: 'It is too young to be on its own.',
  [WHY_BAND]: 'It is keeping with the others.',
  [WHY_TIRED]: 'It is getting its breath back.',
  [WHY_FED]: 'It has eaten enough for now.',
  [WHY_STARVING]: 'It is starving.',
  [WHY_FLOCK]: 'The flock is moving.',
  [WHY_SEASON]: 'The season is turning.',
};

function age(days: number): string {
  if (days < 1) return 'born today';
  if (days < DAYS_PER_YEAR) return `${Math.floor(days)} ${Math.floor(days) === 1 ? 'day' : 'days'} old`;
  const years = Math.floor(days / DAYS_PER_YEAR);
  const seasons = Math.floor((days % DAYS_PER_YEAR) / DAYS_PER_SEASON);
  const y = `${years} ${years === 1 ? 'year' : 'years'}`;
  return seasons === 0 ? `${y} old` : `${y} and ${seasons} ${seasons === 1 ? 'season' : 'seasons'} old`;
}

export function inspectAnimal(e: Eco, a: Animal): InspectInfo {
  const sp = a.sp;
  const days = (e.now - a.born) / DAY_SECONDS;
  const grown = days >= sp.mature;
  const lines: string[] = [];

  let doing = DOING[a.state] ?? 'Idle';
  if (a.state === ST_EAT && sp.index === BOAR && !a.hasFood) doing = 'Rooting in the leaf litter';
  if (a.state === ST_SWIM && sp.index !== FISH) doing = 'Paddling';
  lines.push(`${doing}.`);
  const why = a.alive ? WHY[a.why] : undefined;
  if (why) lines.push(why);

  if (a.alive) {
    const n = a.group.members.length;
    if (sp.groupType === GT_SOLO) lines.push(n > 1 ? `Shares its den with ${n - 1} young.` : 'Lives alone.');
    else if (n > 1) lines.push(`One of a ${sp.band} of ${n}.`);
    else lines.push(`The last of its ${sp.band}.`);
    if (a.dueAt > 0) lines.push('Carrying young.');
    else if (a.young > 0) lines.push(`Raising ${a.young} young.`);
  }

  return {
    title: sp.label,
    subtitle: `${grown ? (a.female ? sp.female : sp.male) : sp.young}, ${age(days)}`,
    lines,
    bars: [
      { label: 'Hunger', value: a.hunger },
      { label: 'Energy', value: a.energy },
      { label: 'Health', value: a.alive ? a.health : 0 },
      { label: 'Age', value: Math.min(1, (e.now - a.born) / a.lifespan) },
    ],
  };
}
