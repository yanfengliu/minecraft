import { describe, expect, it } from 'vitest';
import { B } from '../../world/blocks';
import { FOOD_FLOWER, FOOD_GRASS } from './species';
import { FOOD, floorCellY } from './terrain';
import { NO_ANIMALS, countForage, makeRig } from './testkit';

const only = (populations: Record<string, number>, immigration = false): { eco: { populations: Record<string, number>; immigration: boolean } } => ({
  eco: { populations: { ...NO_ANIMALS, ...populations }, immigration },
});

describe('grazers and the plants they live on', () => {
  it('grazing lowers the plant cover, and it recovers when the grazers are gone', () => {
    // Autumn, when growth is slow enough for heavy grazing to show in a few days; and dry, so that the two
    // meadows being compared grow at the same known rate whatever the weather would have done.
    const empty = makeRig({ ...only({}), startDay: 14, weather: 'clear' });
    const start = countForage(empty.world);
    empty.days(4);
    const ungrazed = countForage(empty.world);
    expect(ungrazed).toBeGreaterThan(start);

    const rig = makeRig({ ...only({ deer: 40, rabbit: 100 }), startDay: 14, weather: 'clear' });
    expect(countForage(rig.world)).toBe(start);
    let eaten = 0;
    let stripped = 0;
    rig.world.changed.on((c) => {
      if (((FOOD[c.old] as number) & (FOOD_GRASS | FOOD_FLOWER)) !== 0 && c.state === B.air) eaten++;
      if (c.old === B.berry_bush + 1 && c.state === B.berry_bush) stripped++;
    });
    rig.days(4);
    const grazed = countForage(rig.world);
    const mouths = rig.eco.stats().eaten;
    // Every mouthful was a plant taken out of the world, or a bush stripped of its berries.
    expect(eaten + stripped).toBe((mouths.deer ?? 0) + (mouths.rabbit ?? 0));
    expect(eaten).toBeGreaterThan(1500);
    expect(stripped).toBeGreaterThan(0);
    expect(grazed).toBeLessThan(start * 0.9);
    expect(grazed).toBeLessThan(ungrazed * 0.8);

    // The hunter clears them out; the meadow is left alone through winter and into spring.
    for (const v of rig.living()) expect(rig.eco.wildlife.harvest(v.id)).not.toBeNull();
    rig.days(0.01);
    expect(rig.eco.views.length).toBe(0);
    rig.days(16);
    expect(rig.clock.season).toBe('spring');
    const recovered = countForage(rig.world);
    expect(recovered).toBeGreaterThan(grazed * 1.5);
    expect(recovered).toBeGreaterThan(start);
  });

  it('with nothing to eat they go hungry, then die of it', () => {
    const rig = makeRig({ ...only({ deer: 12, rabbit: 24 }), startDay: 21 });
    // A winter meadow grazed bare: nothing left standing, and nothing will grow until spring.
    for (let z = 0; z < rig.world.sz; z++) {
      for (let x = 0; x < rig.world.sx; x++) {
        const y = floorCellY(rig.world, x, z);
        const s = rig.world.get(x, y, z);
        if (FOOD[s] || s === B.berry_bush) rig.world.set(x, y, z, B.air);
      }
    }
    expect(countForage(rig.world)).toBe(0);
    rig.days(1.5);
    // The inspector's first bar is how well fed the animal is: full is good, so a hungry animal reads low.
    const hungry = rig.living().filter((v) => (rig.eco.inspect(v.id)?.bars[0]?.value ?? 1) < 0.4).length;
    expect(hungry).toBeGreaterThan(rig.living().length * 0.7);
    expect(rig.row('deer').starved + rig.row('rabbit').starved).toBe(0);
    rig.days(4.5);
    expect(rig.row('rabbit').starved).toBeGreaterThan(12);
    expect(rig.row('deer').starved).toBeGreaterThan(6);
    expect(rig.eco.stats().eaten.deer).toBe(0);
  });
});

describe('hunters and the hunted', () => {
  it('rabbits are held down where there are foxes and multiply where there are none', () => {
    const run = (fox: number): ReturnType<typeof makeRig> => {
      const rig = makeRig({ ...only({ rabbit: 32, fox }), startDay: 0, weather: 'fair' });
      rig.days(21);
      return rig;
    };
    const free = run(0);
    const hunted = run(4);
    expect(free.row('rabbit').killed).toBe(0);
    expect(hunted.row('rabbit').killed).toBeGreaterThan(25);
    expect(hunted.eco.stats().kills.fox).toBe(hunted.row('rabbit').killed);
    // By the end of autumn the difference is plain.
    expect(free.count('rabbit')).toBeGreaterThan(hunted.count('rabbit') + 8);
    expect(free.count('rabbit')).toBeGreaterThan(32);
    // The foxes did well on them.
    expect(hunted.count('fox')).toBeGreaterThanOrEqual(4);
    expect(hunted.row('fox').starved).toBe(0);
  });

  it('hunters with nothing to hunt starve, and stay gone', () => {
    const rig = makeRig({ ...only({ fox: 4, wolf: 4 }), startDay: 0 });
    rig.days(4);
    // Still alive, and hungry.
    expect(rig.count('fox') + rig.count('wolf')).toBeGreaterThanOrEqual(6);
    // It is slow: a wolf goes six days from a full belly before it is starving and a hardy one lasts four more on
    // nothing, and the litters born in these first days outlive their mothers by a week. Across ten seeds the
    // last of them died between day 13 and day 18.
    rig.days(18);
    for (const kind of ['fox', 'wolf']) {
      const row = rig.row(kind);
      expect(row.count).toBe(0);
      expect(row.starved).toBeGreaterThanOrEqual(4);
      expect(row.starved).toBe(row.deaths);
      expect(row.arrived).toBe(0);
    }
    expect(rig.eco.stats().kills.fox + rig.eco.stats().kills.wolf).toBe(0);
    rig.days(3);
    expect(rig.eco.views.length).toBe(0);
  });

  it('a species that has died out wanders back in when that is allowed', () => {
    const rig = makeRig({ ...only({ fox: 4, wolf: 4 }, true), startDay: 0 });
    let fewestFoxes = 99;
    let fewestWolves = 99;
    // Long enough for the slowest to starve (the third week, as the test above found) and three more days to
    // pass with the country all but empty of them.
    rig.days(26, (tick) => {
      if (tick % 600 !== 0) return;
      fewestFoxes = Math.min(fewestFoxes, rig.count('fox'));
      fewestWolves = Math.min(fewestWolves, rig.count('wolf'));
    });
    // They starved down to nothing, or to a last animal that could not have bred...
    expect(fewestFoxes).toBeLessThan(2);
    expect(fewestWolves).toBeLessThan(2);
    // ...and after some days others of their kind arrived.
    expect(rig.row('fox').arrived).toBeGreaterThanOrEqual(2);
    expect(rig.row('wolf').arrived).toBeGreaterThanOrEqual(2);
    // A species that was left out on purpose is not brought in.
    expect(rig.row('deer').arrived).toBe(0);
    expect(rig.count('deer')).toBe(0);
  });
});
