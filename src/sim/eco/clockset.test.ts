import { describe, expect, it } from 'vitest';
import type { EntityView } from '../api';
import { DAY_SECONDS, HOUR_SECONDS } from '../clock';
import { type Rig, makeRig } from './testkit';

// The game's almanac sets the clock: "next day" and "next season" put it
// forward, and the hour can be moved either way. The time between was not
// lived through, so the wildlife must come out of a jump exactly as it went
// in: nobody aged, starved, born or cleared away on account of it, and nobody
// left waiting on a time that is now hours off.

/** The inspector's bars for an animal: fed, energy, health, age. */
const bars = (rig: Rig, v: EntityView): [number, number, number, number] => {
  const b = (rig.eco.inspect(v.id)?.bars ?? []).map((x) => x.value);
  return [b[0] ?? NaN, b[1] ?? NaN, b[2] ?? NaN, b[3] ?? NaN];
};
const doing = (rig: Rig, v: EntityView): string => rig.eco.inspect(v.id)?.lines[0] ?? '';
const onLand = (rig: Rig): EntityView[] => rig.living().filter((v) => v.kind !== 'fish');
const tally = (views: EntityView[]): Record<string, number> => {
  const out: Record<string, number> = {};
  for (const v of views) out[v.kind] = (out[v.kind] ?? 0) + 1;
  return out;
};

describe('when the clock is set rather than stepped', () => {
  it('put forward a week, nobody is older, hungrier, dead or born for it', () => {
    // No hunters, and a country a day and a half old in which nobody is yet near its end and no young are yet
    // due: in the hour that follows the jump nothing can die or be born except by the jump.
    const rig = makeRig({ startDay: 1, eco: { populations: { fox: 0, wolf: 0 }, immigration: false } });
    rig.days(0.5);
    const before = new Map(onLand(rig).map((v) => [v.id, bars(rig, v)]));
    const counts = tally(onLand(rig));
    const census = rig.eco.census();
    const charted = rig.eco.history().deer?.length ?? 0;
    expect(before.size).toBeGreaterThan(140);
    for (const b of before.values()) expect(b[2]).toBeGreaterThan(0.9);

    rig.clock.time += 7 * DAY_SECONDS;
    rig.ticks(1);
    expect(rig.clock.season).toBe('summer');
    // The jump itself: everyone is as they were. (A mouthful finished in that very tick may have fed one.)
    expect(tally(onLand(rig))).toEqual(counts);
    for (const v of onLand(rig)) {
      const was = before.get(v.id) as [number, number, number, number];
      const is = bars(rig, v);
      expect(is[0], `${v.kind}#${v.id} fed`).toBeGreaterThan(was[0] - 0.01);
      expect(is[2], `${v.kind}#${v.id} health`).toBeGreaterThanOrEqual(was[2] - 1e-9);
      expect(Math.abs(is[3] - was[3]), `${v.kind}#${v.id} age`).toBeLessThan(0.001);
    }

    // An hour on: every one of them is alive, none has been born, and each is at most an hour hungrier and older.
    rig.ticks(600);
    const after = new Map(onLand(rig).map((v) => [v.id, v]));
    expect(tally(onLand(rig))).toEqual(counts);
    for (const [id, was] of before) {
      const v = after.get(id);
      expect(v, `#${id} is still alive`).toBeDefined();
      const is = bars(rig, v as EntityView);
      // The hungriest species gains 0.7 in a day, 0.03 in an hour; a nursing mother a little more.
      expect(is[0], `#${id} fed`).toBeGreaterThan(was[0] - 0.05);
      expect(is[2], `#${id} health`).toBeGreaterThanOrEqual(was[2] - 1e-9);
      expect(is[3] - was[3], `#${id} age`).toBeLessThan(0.002);
      expect(is[3] - was[3], `#${id} age`).toBeGreaterThanOrEqual(0);
    }
    for (const [i, r] of rig.eco.census().entries()) {
      if (r.kind === 'fish') continue;
      expect(r.deaths, `${r.kind} deaths`).toBe(census[i]?.deaths);
      expect(r.births, `${r.kind} births`).toBe(census[i]?.births);
    }
    // The chart has one point for the day arrived at, not one for each day skipped.
    expect(rig.eco.history().deer?.length).toBeLessThanOrEqual(charted + 1);
    expect(rig.eco.history().deer?.length).toBeGreaterThanOrEqual(charted);
  });

  it('put back six hours, they go on moving, thinking and getting hungry', () => {
    // Dusk, when the warrens, the herds and the sounders are all out feeding.
    const rig = makeRig({ startDay: 8, startHour: 19.5, weather: 'clear', eco: { immigration: false } });
    rig.days(0.03);
    const land = onLand(rig);
    const place = (): Map<number, [number, number]> => new Map(land.map((v) => [v.id, [v.x, v.z]]));
    const movedSince = (from: Map<number, [number, number]>): number => land.filter((v) => {
      const p = from.get(v.id) as [number, number];
      return Math.hypot(v.x - p[0], v.z - p[1]) > 0.05;
    }).length;

    // How many are on the move in any one second, before the clock is touched.
    let from = place();
    rig.ticks(10);
    const usual = movedSince(from);
    expect(usual).toBeGreaterThan(20);

    const was = new Map(land.map((v) => [v.id, { bars: bars(rig, v), doing: doing(rig, v) }]));
    from = place();
    rig.clock.time -= 6 * HOUR_SECONDS;
    rig.ticks(10);
    // It is early afternoon again.
    expect(rig.clock.hour).toBeGreaterThan(14);
    expect(rig.clock.hour).toBeLessThan(15);
    // Within a second: as many are moving as before, and those whose turn it was have thought. A thought brings an
    // animal's needs up to date, which shows as a change in its bars, however small.
    expect(movedSince(from)).toBeGreaterThan(usual * 0.7);
    const thought = (): number => land.filter((v) => v.anim !== 'dead' && bars(rig, v).some((b, i) => b !== was.get(v.id)?.bars[i])).length;
    expect(thought()).toBeGreaterThan(land.length * 0.2);

    // Within the hour (sixty simulated seconds): all but the soundest sleepers have thought, hunger has gone on
    // building at its usual rate and no faster, and plenty of them have turned to something else.
    const changed = new Set<number>();
    rig.ticks(590, (tick) => {
      if (tick % 50 !== 0) return;
      for (const v of land) if (doing(rig, v) !== was.get(v.id)?.doing) changed.add(v.id);
    });
    const alive = land.filter((v) => v.anim !== 'dead');
    expect(alive.length).toBeGreaterThan(land.length - 3);
    expect(thought()).toBeGreaterThan(land.length * 0.95);
    let hungrier = 0;
    for (const v of alive) {
      const fed = bars(rig, v)[0];
      const fedBefore = was.get(v.id)?.bars[0] as number;
      if (fed < fedBefore - 0.004) hungrier++;
      expect(fed, `${v.kind}#${v.id} fed`).toBeGreaterThan(fedBefore - 0.05);
    }
    expect(hungrier).toBeGreaterThan(land.length * 0.4);
    expect(changed.size).toBeGreaterThan(30);
    expect(movedSince(from)).toBeGreaterThan(land.length * 0.3);
  });

  it('put back an hour, nobody stands waiting an hour for what it was about to do', () => {
    // Dusk again, and back only to earlier the same dusk, so the herds and warrens have no cause to change
    // what they are at. A grazer standing about looks up every ten seconds or so and now and then strolls on.
    // One still counting the seconds to a moment that is now an hour off would stand like a stone till then.
    const rig = makeRig({ startDay: 8, startHour: 19.5, weather: 'clear', eco: { populations: { fox: 0, wolf: 0 }, immigration: false } });
    rig.days(0.03);
    const idle = rig.living().filter((v) => (v.kind === 'rabbit' || v.kind === 'deer' || v.kind === 'boar') && doing(rig, v) === 'Standing about.');
    expect(idle.length).toBeGreaterThan(40);
    const from = new Map(idle.map((v) => [v.id, [v.x, v.z] as [number, number]]));
    rig.clock.time -= HOUR_SECONDS;
    const strolled = new Set<number>();
    rig.ticks(600, (tick) => {
      if (tick % 20 !== 0) return;
      for (const v of idle) {
        const p = from.get(v.id) as [number, number];
        if (Math.hypot(v.x - p[0], v.z - p[1]) > 1) strolled.add(v.id);
      }
    });
    expect(rig.clock.hour).toBeGreaterThan(19);
    expect(strolled.size).toBeGreaterThan(idle.length * 0.4);
  });

  it('a body lies as long after the clock is put back, or forward, as it would have lain', () => {
    for (const hours of [-6, 24 * 7]) {
      const rig = makeRig({ startDay: 8, eco: { populations: { fox: 0, wolf: 0 }, immigration: false } });
      rig.days(0.01);
      const deer = rig.living('deer')[0] as EntityView;
      expect(rig.eco.wildlife.harvest(deer.id)).not.toBeNull();
      rig.ticks(5);
      rig.clock.time += hours * HOUR_SECONDS;
      // The hunter's kill lies four seconds: still there a second after the jump, gone five seconds after it.
      rig.ticks(10);
      expect(rig.eco.views.includes(deer), `still lying, ${hours} h`).toBe(true);
      rig.ticks(40);
      expect(rig.eco.views.includes(deer), `cleared away, ${hours} h`).toBe(false);
    }
  });

  it('a doe in young before the clock is put forward is still in young after, and drops them when her time comes', () => {
    const rig = makeRig({ startDay: 0, eco: { populations: { fox: 0, wolf: 0, songbird: 0, crow: 0, gull: 0, duck: 0, fish: 0 }, immigration: false } });
    rig.days(1);
    const carrying = (): EntityView[] => rig.living('rabbit').filter((v) => rig.eco.inspect(v.id)?.lines.includes('Carrying young.'));
    const does = carrying();
    const born = rig.row('rabbit').births;
    expect(does.length).toBeGreaterThan(2);
    expect(born).toBe(0);
    // A whole year on, to the same day of spring: had the months between been lived, every litter would be long born.
    rig.clock.time += 28 * DAY_SECONDS;
    rig.ticks(100);
    expect(rig.row('rabbit').births).toBe(0);
    for (const v of does) expect(carrying().includes(v), `rabbit#${v.id} still carrying`).toBe(true);
    rig.days(1.5);
    expect(rig.row('rabbit').births).toBeGreaterThan(5);
  });
});
