import { describe, expect, it } from 'vitest';
import type { EntityKind, EntityView } from '../api';
import { DAY_SECONDS } from '../clock';
import { FIXTURE } from './fixture';
import { WILD_KINDS } from './species';
import { NO_ANIMALS, makeRig } from './testkit';

const only = (populations: Record<string, number>): { eco: { populations: Record<string, number>; immigration: boolean } } => ({
  eco: { populations: { ...NO_ANIMALS, ...populations }, immigration: false },
});

describe('finding and taking game', () => {
  it('findAnimal gives the nearest living animal of the kinds asked for, within the radius', () => {
    const rig = makeRig({ ...only({ deer: 10, rabbit: 16, boar: 6, duck: 6 }), startDay: 1 });
    rig.days(0.05);
    const { findAnimal, harvest } = rig.eco.wildlife;
    const brute = (x: number, z: number, radius: number, kinds: readonly EntityKind[]): EntityView | null => {
      let best: EntityView | null = null;
      let bestD = radius;
      for (const v of rig.living()) {
        const d = Math.hypot(v.x - x, v.z - z);
        if (kinds.includes(v.kind) && !v.hidden && d < bestD) {
          bestD = d;
          best = v;
        }
      }
      return best;
    };
    const queries: [number, number, number, EntityKind[]][] = [
      [128, 128, 400, ['deer']],
      [128, 128, 400, ['rabbit', 'boar']],
      [200, 160, 60, ['deer', 'rabbit', 'boar', 'duck']],
      [60, 60, 25, ['rabbit']],
      [FIXTURE.pond.x, FIXTURE.pond.z, 40, ['duck']],
      [240, 20, 12, ['deer', 'rabbit']],
    ];
    let found = 0;
    for (const [x, z, radius, kinds] of queries) {
      const got = findAnimal(x, z, radius, kinds);
      expect(got).toBe(brute(x, z, radius, kinds));
      if (got) found++;
    }
    expect(found).toBeGreaterThanOrEqual(4);
    // Nothing of that kind, no kinds at all, and kinds that are not wild: null.
    expect(findAnimal(128, 128, 400, ['wolf'])).toBeNull();
    expect(findAnimal(128, 128, 400, [])).toBeNull();
    expect(findAnimal(128, 128, 400, ['sheep', 'villager'])).toBeNull();
    expect(findAnimal(128, 128, 0.01, ['deer'])).toBeNull();

    // A dead animal is no longer found; the next nearest is.
    const first = findAnimal(128, 128, 400, ['deer']) as EntityView;
    expect(harvest(first.id)).not.toBeNull();
    const second = findAnimal(128, 128, 400, ['deer']) as EntityView;
    expect(second).not.toBe(first);
    expect(second.anim).not.toBe('dead');
  });

  it('a rabbit down its burrow is not there to be found, and is again when it comes up', () => {
    // The small hours: the warrens are asleep below ground.
    const rig = makeRig({ ...only({ rabbit: 16 }), startDay: 8, startHour: 2, weather: 'clear' });
    const { findAnimal } = rig.eco.wildlife;
    rig.days(0.03);
    const rabbits = rig.living('rabbit');
    const below = rabbits.filter((v) => v.hidden);
    expect(rabbits.length).toBe(16);
    expect(below.length).toBeGreaterThanOrEqual(13);
    // Standing on the burrow, a hunter finds no rabbit in it; at most one that is still above ground nearby.
    for (const v of below) expect(findAnimal(v.x, v.z, 3, ['rabbit'])?.hidden ?? false).toBe(false);
    const up = rabbits.filter((v) => !v.hidden);
    const nearestUp = (x: number, z: number): EntityView | null => up.reduce<EntityView | null>((best, v) => (!best || Math.hypot(v.x - x, v.z - z) < Math.hypot(best.x - x, best.z - z) ? v : best), null);
    expect(findAnimal(128, 128, 400, ['rabbit'])).toBe(nearestUp(128, 128));

    // Morning: they are out feeding, and the nearest of them is found as any animal is.
    rig.days(0.17);
    const out = rig.living('rabbit').filter((v) => !v.hidden);
    expect(out.length).toBeGreaterThanOrEqual(10);
    const got = findAnimal(128, 128, 400, ['rabbit']) as EntityView;
    expect(got.hidden).toBe(false);
    for (const v of out) expect(Math.hypot(v.x - 128, v.z - 128)).toBeGreaterThanOrEqual(Math.hypot(got.x - 128, got.z - 128) - 1e-9);
  });

  it('harvest kills an animal once and gives what it yields', () => {
    const rig = makeRig({ ...only({ deer: 6, rabbit: 8, boar: 4, fox: 2, wolf: 3, duck: 4, songbird: 6 }), startDay: 8 });
    const { harvest } = rig.eco.wildlife;
    const yields: Record<string, { meat: number; hide: number }> = {
      deer: { meat: 5, hide: 2 }, rabbit: { meat: 1, hide: 1 }, boar: { meat: 4, hide: 1 }, fox: { meat: 0, hide: 1 },
      wolf: { meat: 0, hide: 2 }, duck: { meat: 1, hide: 0 }, songbird: { meat: 0, hide: 0 },
    };
    for (const [kind, want] of Object.entries(yields)) {
      const v = rig.living(kind)[0] as EntityView;
      const before = rig.count(kind);
      expect(harvest(v.id)).toEqual(want);
      expect(v.anim).toBe('dead');
      expect(rig.count(kind)).toBe(before - 1);
      expect(rig.row(kind).hunted).toBe(1);
      expect(rig.row(kind).deaths).toBe(1);
      // Gone: a second hunter gets nothing.
      expect(harvest(v.id)).toBeNull();
    }
    expect(harvest(99)).toBeNull();
    expect(harvest(123456789)).toBeNull();
    rig.ticks(60);
    expect(rig.eco.views.some((v) => v.anim === 'dead')).toBe(false);
  });

  it('a young animal yields less than a grown one', () => {
    const rig = makeRig({ ...only({ deer: 12 }), startDay: 0 });
    rig.days(4.2);
    const fawn = rig.living('deer').find((v) => v.scale < 0.7) as EntityView;
    expect(fawn).toBeDefined();
    const got = rig.eco.wildlife.harvest(fawn.id) as { meat: number; hide: number };
    expect(got.meat).toBeLessThan(5);
    expect(got.meat).toBeGreaterThanOrEqual(2);
    expect(got.hide).toBeLessThanOrEqual(2);
  });
});

describe('fishing', () => {
  it('is good where there is water with fish in it and nothing where there is none', () => {
    const rig = makeRig({ ...only({ fish: 96 }), startDay: 1 });
    const { fishAbundance, catchFish } = rig.eco.wildlife;
    const { pond, meadow } = FIXTURE;
    expect(fishAbundance(pond.x, pond.z)).toBeGreaterThan(0.99);
    // From the bank, a few blocks back from the water.
    expect(fishAbundance(pond.x + pond.radius + 5, pond.z)).toBeGreaterThan(0.99);
    expect(fishAbundance(20, 128)).toBeGreaterThan(0.99);
    expect(fishAbundance(meadow.x, meadow.z)).toBe(0);
    for (let i = 0; i < 20; i++) expect(catchFish(meadow.x, meadow.z)).toBe(false);
    expect(rig.row('fish').hunted).toBe(0);
  });

  it('fishing a spot hard lowers its abundance, which then recovers', () => {
    const rig = makeRig({ ...only({ fish: 96 }), startDay: 1 });
    const { fishAbundance, catchFish } = rig.eco.wildlife;
    const { pond } = FIXTURE;
    const inPond = (): number => rig.living('fish').filter((v) => Math.hypot(v.x - pond.x, v.z - pond.z) < 100 && v.x > 44).length;
    const stockAtStart = rig.eco.stats().fishStock;
    const fishAtStart = inPond();
    expect(fishAtStart).toBeGreaterThan(5);

    // A good morning's fishing: nearly every cast lands one, and each one landed comes off the stock.
    let landed = 0;
    let last = fishAbundance(pond.x, pond.z);
    for (let i = 0; i < 10; i++) {
      if (!catchFish(pond.x, pond.z)) continue;
      landed++;
      const now = fishAbundance(pond.x, pond.z);
      expect(now).toBeLessThan(last);
      last = now;
    }
    expect(landed).toBeGreaterThanOrEqual(7);
    expect(rig.eco.stats().fishStock).toBeCloseTo(stockAtStart - landed, 6);

    // Then a greedy week of it in one go.
    let late = 0;
    for (let i = 0; i < 300; i++) {
      const got = catchFish(pond.x, pond.z);
      if (got) landed++;
      if (got && i >= 250) late++;
    }
    const low = fishAbundance(pond.x, pond.z);
    expect(low).toBeLessThan(0.1);
    // Fished out: the last fifty casts caught next to nothing.
    expect(late).toBeLessThanOrEqual(3);
    expect(rig.eco.stats().fishStock).toBeCloseTo(stockAtStart - landed, 6);
    // The sea, which nobody fished, is as it was.
    expect(fishAbundance(20, 128)).toBeGreaterThan(0.99);
    // Fewer fish are to be seen in the pond and river, and the census knows where they went.
    rig.ticks(5);
    expect(inPond()).toBeLessThanOrEqual(2);
    expect(rig.row('fish').hunted).toBe(fishAtStart - inPond());

    // Left alone, the stock grows back, slowly at first.
    rig.days(2);
    const early = fishAbundance(pond.x, pond.z);
    expect(early).toBeGreaterThan(low);
    expect(early).toBeLessThan(0.5);
    rig.days(8);
    expect(fishAbundance(pond.x, pond.z)).toBeGreaterThan(0.6);
    expect(inPond()).toBeGreaterThanOrEqual(fishAtStart - 4);
  });
});

describe('the inspector, the census and the history', () => {
  it('inspect says what an animal is, what it is doing and why, and how it fares', () => {
    const rig = makeRig({ startDay: 8 });
    rig.days(0.3);
    const labels: Record<string, string> = {
      deer: 'Deer', rabbit: 'Rabbit', boar: 'Wild boar', fox: 'Fox', wolf: 'Wolf', songbird: 'Songbird', crow: 'Crow', gull: 'Gull', duck: 'Duck', fish: 'Fish',
    };
    let reasons = 0;
    for (const v of rig.living()) {
      const info = rig.eco.inspect(v.id);
      if (!info) throw new Error(`no inspector for ${v.kind}#${v.id}`);
      expect(info.title).toBe(labels[v.kind]);
      expect(info.subtitle).toMatch(/^[A-Z][a-z -]+, (born today|\d+ days? old|\d+ years? (and \d seasons? )?old)$/);
      expect(info.lines.length).toBeGreaterThanOrEqual(2);
      expect(info.lines[0]).toMatch(/^[A-Z].*\.$/);
      if (/^(It|Someone|A hunter|This|The)/.test(info.lines[1] ?? '')) reasons++;
      expect(info.bars.map((b) => b.label)).toEqual(['Fed', 'Energy', 'Health', 'Age']);
      for (const b of info.bars) {
        expect(b.value).toBeGreaterThanOrEqual(0);
        expect(b.value).toBeLessThanOrEqual(1);
      }
    }
    // Most animals at any moment can say why they are doing what they are doing.
    expect(reasons).toBeGreaterThan(rig.living().length * 0.8);
    expect(rig.eco.inspect(5)).toBeNull();
    expect(rig.eco.inspect(987654321)).toBeNull();
    // Sex and age are in the subtitle: a herd has both stags and does.
    const deer = rig.living('deer').map((v) => rig.eco.inspect(v.id)?.subtitle.split(',')[0]);
    expect(deer.includes('Stag') && deer.includes('Doe')).toBe(true);
  });

  it('the census counts what is on view, and births, arrivals and deaths account for every change', () => {
    const rig = makeRig({ startDay: 0 });
    const start = rig.eco.census();
    expect(start.map((r) => r.kind)).toEqual([...WILD_KINDS]);
    const onView = (kind: string): number => rig.living(kind).length;
    for (const r of start) {
      expect(r.count).toBe(onView(r.kind));
      expect(r.count).toBeGreaterThan(0);
      expect(r.cap).toBeGreaterThanOrEqual(r.count);
      expect([r.births, r.deaths, r.arrived, r.away]).toEqual([0, 0, 0, 0]);
    }
    rig.days(5);
    for (const [i, r] of rig.eco.census().entries()) {
      expect(r.count).toBe(onView(r.kind));
      expect(r.count).toBe((start[i]?.count ?? 0) + r.births + r.arrived - r.deaths - r.away);
      expect(r.deaths).toBe(r.oldAge + r.starved + r.killed + r.hunted);
      expect(r.count).toBeLessThanOrEqual(r.cap);
    }
    expect(rig.row('rabbit').births).toBeGreaterThan(5);
    const plants = rig.eco.plants();
    expect(plants.cover).toBeGreaterThan(0.05);
    expect(plants.cover).toBeLessThan(0.5);
    expect(plants.tallGrass).toBeGreaterThan(2000);
    expect(plants.canopy).toBeGreaterThan(0.04);
    expect(plants.ripeBushes).toBe(0);
  });

  it('history holds one number per species per day, oldest first, in a bounded ring', () => {
    const rig = makeRig({ ...only({ deer: 10, rabbit: 16 }), startDay: 0 });
    expect(Object.keys(rig.eco.history())).toEqual([...WILD_KINDS]);
    expect(rig.eco.history().deer).toEqual([10]);
    const seen: number[] = [10];
    let day = rig.clock.day;
    rig.days(3.9, () => {
      if (rig.clock.day === day) return;
      day = rig.clock.day;
      seen.push(rig.count('deer'));
    });
    expect(rig.eco.history().deer).toEqual(seen);
    // The day it began, and one for each midnight since.
    expect(seen.length).toBe(5);
    expect(rig.eco.history().rabbit?.length).toBe(5);
    expect(rig.eco.history().fish).toEqual([0, 0, 0, 0, 0]);

    // Years on, only the most recent four are kept. (Whole days at a stride: only the daily sample matters here.)
    const long = makeRig({ ...only({}), startDay: 0 });
    for (let d = 0; d < 130; d++) {
      long.clock.advance(DAY_SECONDS);
      long.eco.tick();
    }
    expect(long.eco.history().deer?.length).toBe(112);
  });
});
