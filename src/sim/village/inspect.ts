// What the inspector panel shows for a villager or a farm animal.

import type { InspectInfo } from '../api';
import type { Core } from './core';
import { PROFESSIONS } from './goods';
import { type Animal, FLOCK_PENNED, type Resident } from './model';
import { peekNeeds } from './needs';
import type { Social } from './social';

const cap = (s: string): string => s.charAt(0).toUpperCase() + s.slice(1);
const coins = (n: number): string => `${n} ${n === 1 ? 'coin' : 'coins'}`;

export function inspectResident(core: Core, social: Social, r: Resident): InspectInfo {
  const needs = peekNeeds(core, r);
  const trade = PROFESSIONS[r.trade] as string;
  const subtitle = r.child ? `Child of the ${r.home.name} household, aged ${r.age}` : `${cap(trade)}, aged ${r.age}`;
  const lines = [r.asleep ? 'Asleep in bed' : r.activity, social.thought(r, needs)];
  if (!r.child) lines.push(`Purse: ${coins(r.coin)}`);
  lines.push(`Home: ${r.home.site.b.name}`);
  if (r.job) lines.push(`Works at: ${r.job.site.b.name}${r.job.lastWage > 0 ? ` (last paid ${coins(r.job.lastWage)})` : ''}`);
  if (r.packCount > 0) lines.push(`Carrying ${r.packCount} ${r.packCount === 1 ? 'item' : 'items'}`);
  return {
    title: r.name,
    subtitle,
    lines,
    // Every bar reads the same way: full is good. "Hunger" full means well fed.
    bars: [
      { label: 'Hunger', value: 1 - needs.hunger },
      { label: 'Energy', value: needs.energy },
      { label: 'Social', value: needs.social },
      { label: 'Mood', value: needs.mood },
    ],
  };
}

export function inspectAnimal(core: Core, a: Animal): InspectInfo {
  const pen = a.pen;
  const kind = a.view.kind === 'chicken' ? 'hen' : a.view.kind;
  const age = core.clock.day - a.born;
  const doing = a.view.anim === 'sleep' ? 'Asleep' : a.moving ? (a.driven ? 'Being driven along the road' : 'Wandering') : a.view.anim === 'eat' ? 'Feeding' : 'Standing about';
  const lines = [doing, pen.flock === FLOCK_PENNED ? 'In the pen' : 'Out at pasture'];
  if (pen.owner) lines.push(`Belongs to ${pen.owner.site.b.name}`);
  if (a.view.kind === 'sheep') lines.push(a.shornYear === core.clock.year ? 'Shorn this year' : 'In full fleece');
  return {
    title: cap(kind),
    subtitle: age < 6 ? 'Young farm animal' : 'Farm animal',
    lines,
    bars: [{ label: 'Growth', value: Math.min(1, Math.max(0, a.view.scale * 2 - 1)) }],
  };
}
