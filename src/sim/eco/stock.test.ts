import { describe, expect, it } from 'vitest';
import type { EntityView, LivestockApi } from '../api';
import { daylight } from '../sky';
import { FIXTURE } from './fixture';
import { NO_ANIMALS, type Rig, makeRig, makeView } from './testkit';

const only = (populations: Record<string, number>): { eco: { populations: Record<string, number>; immigration: boolean } } => ({
  eco: { populations: { ...NO_ANIMALS, ...populations }, immigration: false },
});

describe('the village stock', () => {
  /** The village's side of the bargain, faked: what was asked for, and what was taken and when. */
  type Stock = LivestockApi & { killed: { id: number; day: number; light: number }[]; asked: string[] };

  function farm(animals: EntityView[]): Stock {
    const killed: { id: number; day: number; light: number }[] = [];
    const asked: string[] = [];
    let clock: Rig['clock'] | null = null;
    return {
      killed,
      asked,
      // As the contract has it: the nearest farm animal, of the kinds named if any are.
      findLivestock(x, z, radius, kinds) {
        asked.push(kinds ? kinds.join('+') : 'any');
        let best: EntityView | null = null;
        let bestD = radius;
        for (const a of animals) {
          const d = Math.hypot(a.x - x, a.z - z);
          if (a.anim !== 'dead' && d < bestD && (!kinds || kinds.includes(a.kind))) {
            bestD = d;
            best = a;
          }
        }
        return best;
      },
      killLivestock(id) {
        const a = animals.find((v) => v.id === id);
        if (a) a.anim = 'dead';
        killed.push({ id, day: clock ? clock.time / 1440 : -1, light: clock ? daylight(clock) : -1 });
      },
      // Not part of the contract: lets the fake stamp its kills with the time.
      ...{ watch: (c: Rig['clock']) => { clock = c; } },
    } as Stock;
  }

  /** Four animals of another kind standing close round one: whoever looks for "the nearest" from outside finds one of these first. */
  function ring(firstId: number, kind: EntityView['kind'], round: EntityView): EntityView[] {
    return [[-1.5, -1.5], [1.5, -1.5], [-1.5, 1.5], [1.5, 1.5]].map(([dx, dz], i) => makeView(firstId + i, kind, round.x + (dx ?? 0), round.y, round.z + (dz ?? 0)));
  }

  it('a hungry fox slips into the village by night and takes a hen', () => {
    const area = { x: FIXTURE.meadow.x, z: FIXTURE.meadow.z, radius: 20 };
    const hen = makeView(31, 'chicken', area.x + 0.5, 0, area.z + 0.5);
    // The hen is in among the sheep. A fox has no use for a sheep: it asks for hens, and is given the hen.
    const stock = farm([...ring(40, 'sheep', hen), hen]);
    const rig = makeRig({ eco: { avoid: [area], ...only({ fox: 4 }).eco }, startDay: 1, livestock: stock });
    (stock as unknown as { watch: (c: Rig['clock']) => void }).watch(rig.clock);
    hen.y = rig.world.height(Math.floor(hen.x), Math.floor(hen.z));
    const inside = (v: EntityView): boolean => Math.hypot(v.x - area.x, v.z - area.z) < area.radius - 1;
    let byDay = 0;
    let byNight = 0;
    rig.days(4, (tick) => {
      if (tick % 20 !== 0 || stock.killed.length > 0) return;
      const n = rig.living('fox').filter(inside).length;
      if (daylight(rig.clock) > 0.5) byDay += n;
      else byNight += n;
    });
    expect(stock.killed.length).toBe(1);
    expect(stock.killed[0]?.id).toBe(31);
    expect(stock.killed[0]?.light).toBeLessThan(0.25);
    // It came in under cover of darkness, and only then.
    expect(byNight).toBeGreaterThan(0);
    expect(byDay).toBe(0);
    expect(rig.eco.stats().raids.fox).toBe(1);
    // Every time a fox looked over the village it was for hens and nothing else.
    expect([...new Set(stock.asked)]).toEqual(['chicken']);
  });

  it('a pack with nothing wild to hunt takes a sheep at pasture', () => {
    const sheep = makeView(32, 'sheep', 190.5, 0, 122.5);
    // Hens scratching about round the sheep are nearer the pack whichever way it comes; it asks for sheep.
    const stock = farm([...ring(50, 'chicken', sheep), sheep]);
    const rig = makeRig({ ...only({ wolf: 4 }), startDay: 8, livestock: stock });
    (stock as unknown as { watch: (c: Rig['clock']) => void }).watch(rig.clock);
    sheep.y = rig.world.height(Math.floor(sheep.x), Math.floor(sheep.z));
    rig.days(5);
    expect(stock.killed.map((k) => k.id)).toEqual([32]);
    expect(rig.eco.stats().raids.wolf).toBe(1);
    expect(rig.count('wolf')).toBe(4);
    expect([...new Set(stock.asked)]).toEqual(['sheep']);
  });
});
