import { describe, expect, it } from 'vitest';
import { B, IS_LEAVES, isWater } from '../../world/blocks';
import { ANIM_STATES, type EntityView } from '../api';
import { SIM_DT } from '../clock';
import { daylight } from '../sky';
import { FIXTURE } from './fixture';
import { H_WOOD, Habitat } from './habitat';
import { WILD_KINDS } from './species';
import { airFloor } from './terrain';
import { type Rig, makeRig, makeView, misplaced } from './testkit';
import { type Animal, MODE_PADDLE } from './types';

const WILD_ANIMS = new Set(['idle', 'walk', 'run', 'eat', 'sleep', 'swim', 'fly', 'glide', 'dead']);
const only = (populations: Record<string, number>): { eco: { populations: Record<string, number>; immigration: boolean } } => ({
  eco: { populations: { deer: 0, rabbit: 0, boar: 0, fox: 0, wolf: 0, songbird: 0, crow: 0, gull: 0, duck: 0, fish: 0, ...populations }, immigration: false },
});

/** Run until the clock next reads this hour of the day. */
function untilHour(rig: Rig, hour: number): void {
  const wrapped = (h: number): number => (h - hour + 24) % 24;
  let guard = 0;
  while (wrapped(rig.clock.hour) < 23.9 && guard++ < 20000) rig.ticks(1);
  while (wrapped(rig.clock.hour) > 12 && guard++ < 40000) rig.ticks(1);
}

const doing = (rig: Rig, v: EntityView): string => rig.eco.inspect(v.id)?.lines[0] ?? '';
const why = (rig: Rig, v: EntityView): string => rig.eco.inspect(v.id)?.lines[1] ?? '';
const share = (views: EntityView[], test: (v: EntityView) => boolean): number => views.filter(test).length / Math.max(1, views.length);

describe('what the renderer is given', () => {
  it('views are well formed, keep their identity, and are never inside a block or outside the world', () => {
    const rig = makeRig({ startDay: 1 });
    const views = rig.eco.views;
    const seen = new Map<number, EntityView>();
    const problems: string[] = [];
    const below = new Set<number>();
    let wentDown = 0;
    let cameUp = 0;
    expect(views.length).toBeGreaterThan(200);
    rig.days(1, (tick) => {
      if (tick % 97 !== 0) return;
      expect(rig.eco.views).toBe(views);
      const ids = new Set<number>();
      for (const v of views) {
        // Hidden means down a burrow, and nothing else: only rabbits, only the living, and exactly while they are below.
        const underground = doing(rig, v) === 'Down its burrow.';
        if ((v.hidden === true) !== underground || (underground && v.kind !== 'rabbit')) problems.push(`${v.kind}#${v.id} has hidden=${String(v.hidden)} while "${doing(rig, v)}"`);
        if (v.hidden && !below.has(v.id)) {
          below.add(v.id);
          wentDown++;
        } else if (!v.hidden && below.delete(v.id) && v.anim !== 'dead') cameUp++;
        const known = seen.get(v.id);
        if (known && known !== v) problems.push(`#${v.id} is a different object than before`);
        seen.set(v.id, v);
        if (ids.has(v.id)) problems.push(`#${v.id} is in the list twice`);
        ids.add(v.id);
        if (v.id < 100000) problems.push(`id ${v.id} is in the village's range`);
        if (!(WILD_KINDS as readonly string[]).includes(v.kind)) problems.push(`#${v.id} has kind ${v.kind}`);
        if (!WILD_ANIMS.has(v.anim) || !(ANIM_STATES as readonly string[]).includes(v.anim)) problems.push(`${v.kind} has anim ${v.anim}`);
        if (!(v.scale > 0.3 && v.scale <= 1.07)) problems.push(`${v.kind} has scale ${v.scale}`);
        if (!(v.yaw >= -Math.PI - 1e-9 && v.yaw <= Math.PI + 1e-9)) problems.push(`${v.kind} has yaw ${v.yaw}`);
        if (!Number.isFinite(v.animTime) || v.held !== -1 || v.role !== 0 || v.bubble !== '') problems.push(`${v.kind} has odd fields`);
      }
      problems.push(...misplaced(rig.world, views));
    });
    expect(problems.slice(0, 5)).toEqual([]);
    // Over a day the rabbits went to ground and came up again, many times between them.
    expect(wentDown).toBeGreaterThan(40);
    expect(cameUp).toBeGreaterThan(40);
    // Every kind was drawn, and with more than one look.
    for (const kind of WILD_KINDS) {
      const of = [...seen.values()].filter((v) => v.kind === kind);
      expect(of.length).toBeGreaterThan(1);
      expect(new Set(of.map((v) => v.look)).size).toBeGreaterThan(1);
    }
  });

  it('a walker faces the way it goes, turns smoothly, and its gait keeps time with the ground it covers', () => {
    const rig = makeRig({ ...only({ deer: 10, rabbit: 16, boar: 6 }), startDay: 1, startHour: 5, weather: 'clear' });
    const last = new Map<number, { x: number; y: number; z: number; yaw: number; t: number }>();
    let moving = 0;
    let facing = 0;
    let turnMax = 0;
    let stepMax = 0;
    let climbMax = 0;
    let strideLo = Infinity;
    let strideHi = 0;
    rig.days(0.25, () => {
      for (const v of rig.eco.views) {
        const p = last.get(v.id);
        last.set(v.id, { x: v.x, y: v.y, z: v.z, yaw: v.yaw, t: v.animTime });
        if (!p || v.anim === 'dead') continue;
        const dx = v.x - p.x;
        const dz = v.z - p.z;
        const d = Math.hypot(dx, dz);
        let turn = Math.abs(v.yaw - p.yaw);
        if (turn > Math.PI) turn = 2 * Math.PI - turn;
        turnMax = Math.max(turnMax, turn);
        stepMax = Math.max(stepMax, d);
        if (d > 0) climbMax = Math.max(climbMax, v.y - p.y);
        if (d < 0.02 || (v.anim !== 'walk' && v.anim !== 'run')) continue;
        moving++;
        let off = Math.abs(Math.atan2(dx, dz) - v.yaw);
        if (off > Math.PI) off = 2 * Math.PI - off;
        if (off < 0.6) facing++;
        const stride = (v.animTime - p.t) / d;
        strideLo = Math.min(strideLo, stride);
        strideHi = Math.max(strideHi, stride);
      }
    });
    expect(moving).toBeGreaterThan(2000);
    // Yaw is atan2(dx, dz): it agrees with the direction of travel except in the middle of a turn.
    expect(facing / moving).toBeGreaterThan(0.9);
    expect(turnMax).toBeLessThanOrEqual(0.5 + 1e-6);
    // Nothing outruns its own top speed, and nothing climbs more than one block in a step.
    expect(stepMax).toBeLessThan(8.8 * SIM_DT * 1.02);
    expect(climbMax).toBeLessThanOrEqual(1 + 1e-6);
    // Animation time advances with distance: one second per stride-length, whatever the speed.
    expect(strideLo).toBeGreaterThan(0.1);
    expect(strideHi).toBeLessThan(1.2);
  });

  it('the dead lie where they fell for a moment, then are cleared away', () => {
    const rig = makeRig({ ...only({ deer: 6 }), startDay: 1 });
    const deer = rig.living('deer')[0] as EntityView;
    expect(rig.eco.wildlife.harvest(deer.id)).not.toBeNull();
    expect(deer.anim).toBe('dead');
    expect(rig.eco.views.includes(deer)).toBe(true);
    expect(doing(rig, deer)).toBe('Dead.');
    const { x, y, z } = deer;
    rig.ticks(20);
    expect(rig.eco.views.includes(deer)).toBe(true);
    expect([deer.x, deer.y, deer.z]).toEqual([x, y, z]);
    rig.ticks(60);
    expect(rig.eco.views.includes(deer)).toBe(false);
    expect(rig.eco.inspect(deer.id)).toBeNull();
    expect(rig.count('deer')).toBe(5);
  });

  it('the young are born small and grow', () => {
    const rig = makeRig({ ...only({ deer: 10, rabbit: 16 }), startDay: 0, weather: 'clear' });
    rig.days(4.5);
    const young = rig.living().filter((v) => v.scale < 0.8);
    expect(young.length).toBeGreaterThan(3);
    const titles = new Set(young.map((v) => rig.eco.inspect(v.id)?.subtitle.split(',')[0]));
    expect(titles.has('Kit') || titles.has('Fawn')).toBe(true);
    const kit = young[0] as EntityView;
    const was = kit.scale;
    expect(doing(rig, kit).length).toBeGreaterThan(3);
    rig.days(2);
    if (rig.eco.views.includes(kit) && kit.anim !== 'dead') expect(kit.scale).toBeGreaterThan(was);
  });
});

describe('daily habits', () => {
  it('deer feed at dusk and lie up in the woods by day; night finds the day animals asleep and the fox abroad', () => {
    // Fair weather throughout: rain has its own test, and would send the deer to cover at any hour.
    const rig = makeRig({ ...only({ deer: 15, rabbit: 40, fox: 4, songbird: 24, fish: 30, duck: 8 }), startDay: 8, weather: 'clear' });
    const habitat = new Habitat(rig.world, []);
    const inWood = (v: EntityView): boolean => habitat.share(H_WOOD, v.x, v.z) > 0.15;
    const resting = (v: EntityView): boolean => v.anim === 'idle' || v.anim === 'sleep';

    untilHour(rig, 13);
    const noon = rig.living('deer');
    expect(share(noon, inWood)).toBeGreaterThan(0.7);
    expect(share(noon, resting)).toBeGreaterThan(0.7);
    expect(share(noon, (v) => why(rig, v) === 'It lies up through the day.')).toBeGreaterThan(0.6);
    // Songbirds are about in the daytime: perched, feeding or on the wing, not asleep.
    expect(share(rig.living('songbird'), (v) => v.anim !== 'sleep')).toBeGreaterThan(0.9);
    expect(share(rig.living('fox'), (v) => v.anim === 'sleep')).toBeGreaterThan(0.7);

    untilHour(rig, 20);
    const dusk = rig.living('deer');
    expect(share(dusk, (v) => !inWood(v))).toBeGreaterThan(0.6);
    expect(share(dusk, (v) => why(rig, v) !== 'It lies up through the day.' && v.anim !== 'sleep')).toBeGreaterThan(0.8);
    expect(share(rig.living('rabbit'), (v) => doing(rig, v) !== 'Down its burrow.')).toBeGreaterThan(0.6);
    // Out feeding, they are there to be seen.
    expect(share(rig.living('rabbit'), (v) => !v.hidden)).toBeGreaterThan(0.6);

    untilHour(rig, 1.5);
    expect(daylight(rig.clock)).toBeLessThan(0.05);
    expect(share(rig.living('deer'), (v) => v.anim === 'sleep')).toBeGreaterThan(0.8);
    expect(share(rig.living('rabbit'), (v) => doing(rig, v) === 'Down its burrow.')).toBeGreaterThan(0.8);
    // Below ground they are hidden from view; nothing else in the country ever is.
    expect(share(rig.living('rabbit'), (v) => v.hidden === true)).toBeGreaterThan(0.8);
    expect(rig.living().filter((v) => v.kind !== 'rabbit' && v.hidden)).toEqual([]);
    const birds = rig.living('songbird');
    expect(share(birds, (v) => v.anim === 'sleep')).toBeGreaterThan(0.9);
    expect(birds.some((v) => v.anim === 'fly' || v.anim === 'glide')).toBe(false);
    // They roost in the trees: on a leaf block, not on the ground.
    expect(share(birds, (v) => IS_LEAVES[rig.world.get(Math.floor(v.x), Math.floor(v.y) - 1, Math.floor(v.z))] === 1)).toBeGreaterThan(0.8);
    expect(share(rig.living('duck'), (v) => v.anim === 'sleep')).toBeGreaterThan(0.8);
    // The fox keeps other hours, and fish do not sleep.
    expect(rig.living('fox').some((v) => v.anim !== 'sleep')).toBe(true);
    expect(share(rig.living('fish'), (v) => v.anim === 'swim')).toBe(1);
  });

  it('hard rain sends the deer under the trees', () => {
    const exposed = (weather: 'clear' | 'storm'): { open: number; sheltering: number } => {
      const rig = makeRig({ ...only({ deer: 15 }), startDay: 8, startHour: 18.5, weather });
      // Let the pinned weather arrive before the clock starts: a storm takes some minutes to build.
      for (let i = 0; i < 600; i++) rig.weather.update(1);
      expect(rig.weather.isRaining).toBe(weather === 'storm');
      rig.days(0.11);
      const deer = rig.living('deer');
      return {
        open: share(deer, (v) => rig.world.exposed(Math.floor(v.x), Math.floor(v.y), Math.floor(v.z))),
        sheltering: share(deer, (v) => why(rig, v) === 'It is sheltering from the rain.'),
      };
    };
    const fine = exposed('clear');
    const wet = exposed('storm');
    expect(fine.open).toBeGreaterThan(0.6);
    expect(fine.sheltering).toBe(0);
    expect(wet.open).toBeLessThan(0.25);
    expect(wet.sheltering).toBeGreaterThan(0.7);
  });
});

describe('where they live and how they keep together', () => {
  it('deer keep in herds, rabbits in warrens, boar in the woods and the wolves in the highland', () => {
    const rig = makeRig({ ...only({ deer: 15, rabbit: 40, boar: 10, wolf: 4, fox: 4 }), startDay: 8, weather: 'clear' });
    const habitat = new Habitat(rig.world, []);
    const band = (v: EntityView): number => Number(/of (\d+)\.$/.exec(rig.eco.inspect(v.id)?.lines.find((l) => l.startsWith('One of a')) ?? '')?.[1] ?? 1);
    untilHour(rig, 13);
    for (const v of rig.living('deer')) {
      expect(band(v)).toBeGreaterThanOrEqual(3);
      expect(band(v)).toBeLessThanOrEqual(7);
    }
    for (const v of rig.living('rabbit')) expect(band(v)).toBeLessThanOrEqual(12);
    expect(share(rig.living('rabbit'), (v) => band(v) >= 3)).toBeGreaterThan(0.8);
    // Boar lie up in their wood through the middle of the day.
    expect(share(rig.living('boar'), (v) => habitat.share(H_WOOD, v.x, v.z) > 0.15)).toBeGreaterThan(0.7);
    // The pack is one pack, of three to five, at its den high up and far from the middle of the map.
    const wolves = rig.living('wolf');
    for (const v of wolves) {
      expect(band(v)).toBe(wolves.length);
      expect(v.y).toBeGreaterThanOrEqual(habitat.highY - 1);
      expect(Math.hypot(v.x - 128, v.z - 128)).toBeGreaterThan(60);
    }
    expect(wolves.length).toBeGreaterThanOrEqual(3);
    expect(wolves.length).toBeLessThanOrEqual(5);
    // Foxes are on their own.
    for (const v of rig.living('fox')) expect(rig.eco.inspect(v.id)?.lines.includes('Lives alone.')).toBe(true);
  });

  it('a flock in the air keeps together, keeps apart, and keeps clear of the ground', () => {
    const rig = makeRig({ ...only({ gull: 12, songbird: 16, crow: 8 }), startDay: 8, startHour: 9, weather: 'clear' });
    let samples = 0;
    let tight = 0;
    let closest = Infinity;
    let crowded = 0;
    let low = 0;
    const turned = new Map<number, { yaw: number; sum: number }>();
    rig.days(0.25, (tick) => {
      if (tick % 5 !== 0) return;
      const flying = rig.living().filter((v) => v.anim === 'fly' || v.anim === 'glide');
      // Terrain avoidance: no bird in the air is ever below the top of what is under it.
      for (const v of flying) if (v.y < airFloor(rig.world, Math.floor(v.x), Math.floor(v.z)) + 0.25) low++;
      const gulls = flying.filter((v) => v.kind === 'gull');
      for (const v of gulls) {
        const t = turned.get(v.id) ?? { yaw: v.yaw, sum: 0 };
        let d = Math.abs(v.yaw - t.yaw);
        if (d > Math.PI) d = 2 * Math.PI - d;
        turned.set(v.id, { yaw: v.yaw, sum: t.sum + d });
      }
      if (gulls.length < 9) return;
      samples++;
      // Cohesion: the colony on the wing is one loose group, not birds scattered over the map.
      const cx = gulls.reduce((n, v) => n + v.x, 0) / gulls.length;
      const cz = gulls.reduce((n, v) => n + v.z, 0) / gulls.length;
      if (gulls.every((v) => Math.hypot(v.x - cx, v.z - cz) < 45)) tight++;
      // Separation: they do not fly through one another.
      let near = Infinity;
      for (let i = 0; i < gulls.length; i++) {
        for (let j = i + 1; j < gulls.length; j++) {
          const a = gulls[i] as EntityView;
          const b = gulls[j] as EntityView;
          near = Math.min(near, Math.hypot(a.x - b.x, a.y - b.y, a.z - b.z));
        }
      }
      closest = Math.min(closest, near);
      if (near < 0.5) crowded++;
    });
    expect(low).toBe(0);
    expect(samples).toBeGreaterThan(100);
    expect(tight / samples).toBeGreaterThan(0.9);
    expect(crowded / samples).toBeLessThan(0.05);
    expect(closest).toBeGreaterThan(0.1);
    // Gulls wheel: over a quarter of a day each has turned through several full circles.
    const turns = [...turned.values()].map((t) => t.sum / (2 * Math.PI));
    expect(turns.length).toBe(12);
    expect(Math.min(...turns)).toBeGreaterThan(3);
  });
});

describe('ducks on the water', () => {
  it('a duck paddling under a bough stays on the water', () => {
    const rig = makeRig({ ...only({ duck: 8 }), startDay: 8, startHour: 9, weather: 'clear' });
    const world = rig.world;
    const pond = FIXTURE.pond;
    // Boughs over the pond: leaves three blocks above every third column of its water.
    let boughs = 0;
    for (let dz = -pond.radius; dz <= pond.radius; dz++) {
      for (let dx = -pond.radius; dx <= pond.radius; dx++) {
        const x = pond.x + dx;
        const z = pond.z + dz;
        // The floor of open air over a column of water is the cell above its top water cell.
        const top = airFloor(world, x, z) - 1;
        if ((x + z) % 3 !== 0 || !isWater(world.get(x, top, z))) continue;
        world.set(x, top + 3, z, B.oak_leaves);
        boughs++;
      }
    }
    expect(boughs).toBeGreaterThan(20);
    // A bird flies up when the floor of open air over it is not the one it settled under, which is how it
    // knows its branch was cut. A paddler has to carry that with it from column to column.
    let paddling = 0;
    const lost: string[] = [];
    for (let t = 0; t < 6000; t++) {
      rig.ticks(1);
      for (const v of rig.living('duck')) {
        const a = v as unknown as Animal;
        if (a.mode !== MODE_PADDLE) continue;
        paddling++;
        if (a.perchFloor !== airFloor(world, a.cx, a.cz) && lost.length < 3) lost.push(`duck ${a.id} at ${a.cx},${a.cz}: settled under ${a.perchFloor}, now under ${airFloor(world, a.cx, a.cz)}`);
      }
    }
    expect(paddling).toBeGreaterThan(300);
    expect(lost).toEqual([]);
  });
});

describe('keeping away from people', () => {
  it('a deer runs from a person walking up to it, and takes the herd with it', () => {
    const person = makeView(7, 'villager', 0, 0, 0);
    const rig = makeRig({ ...only({ deer: 12 }), startDay: 8, startHour: 12, people: [person], weather: 'clear' });
    // Far away at first, so the herd settles undisturbed.
    person.x = 5;
    person.z = 250;
    person.y = 20;
    rig.days(0.05);
    const deer = rig.living('deer');
    const target = deer[0] as EntityView;
    expect(target.anim === 'run').toBe(false);
    const start = { x: target.x + 28, z: target.z };
    person.x = start.x;
    person.z = start.z;
    person.y = target.y;
    let nearest = Infinity;
    let ran = false;
    let reason = '';
    rig.ticks(450, () => {
      // Walk straight at the animal, at a walking pace.
      const dx = target.x - person.x;
      const dz = target.z - person.z;
      const d = Math.hypot(dx, dz);
      person.x += (dx / d) * 1.5 * SIM_DT;
      person.z += (dz / d) * 1.5 * SIM_DT;
      nearest = Math.min(nearest, d);
      if (target.anim === 'run' && !ran) {
        ran = true;
        reason = `${doing(rig, target)} ${why(rig, target)}`;
      }
    });
    expect(ran).toBe(true);
    expect(reason).toBe('Running away. Someone came too close.');
    // It never let the walker get near, and it has put distance between them.
    expect(nearest).toBeGreaterThan(9);
    expect(Math.hypot(target.x - person.x, target.z - person.z)).toBeGreaterThan(20);
    // Its herd-mates within sight went too: none is left standing close to where the person now is.
    for (const v of rig.living('deer')) expect(Math.hypot(v.x - person.x, v.z - person.z)).toBeGreaterThan(12);
  });

  it('a rabbit bolts for its burrow when the player comes near', () => {
    const player = { x: 5, y: 20, z: 250 };
    const rig = makeRig({ ...only({ rabbit: 16 }), startDay: 8, startHour: 19, player, weather: 'clear' });
    rig.days(0.03);
    const out = rig.living('rabbit').filter((v) => doing(rig, v) !== 'Down its burrow.');
    expect(out.length).toBeGreaterThan(4);
    const target = out[0] as EntityView;
    player.x = target.x + 4;
    player.z = target.z + 1;
    player.y = target.y;
    let ran = false;
    rig.ticks(100, () => {
      if (target.anim === 'run') ran = true;
    });
    expect(ran || doing(rig, target) === 'Down its burrow.').toBe(true);
    rig.ticks(100);
    // Either safe underground, or well clear.
    const safe = doing(rig, target) === 'Down its burrow.' || Math.hypot(target.x - player.x, target.z - player.z) > 7;
    expect(safe).toBe(true);

    // Its warren went to ground with it. A rabbit down its burrow is hidden: not to be drawn or picked, and not
    // there for a hunter to find, though he is standing over it.
    const gone = rig.living('rabbit').filter((v) => v.hidden);
    expect(gone.length).toBeGreaterThan(0);
    for (const v of gone) {
      expect(doing(rig, v)).toBe('Down its burrow.');
      expect(rig.eco.wildlife.findAnimal(v.x, v.z, 1.5, ['rabbit'])?.hidden ?? false).toBe(false);
    }
    // When the coast is clear they come up again, and are seen again.
    player.x = 5;
    player.z = 250;
    rig.ticks(600);
    expect(share(gone, (v) => !v.hidden && doing(rig, v) !== 'Down its burrow.')).toBeGreaterThan(0.7);
  });

  it('birds take wing and fish dart away', () => {
    const player = { x: 5, y: 40, z: 250 };
    const rig = makeRig({ ...only({ songbird: 16, fish: 40 }), startDay: 8, startHour: 10, player, weather: 'clear' });
    // Wait for a moment when most of the birds are down.
    const down = (): EntityView[] => rig.living('songbird').filter((v) => v.anim !== 'fly' && v.anim !== 'glide');
    for (let i = 0; i < 3000 && down().length < 12; i++) rig.ticks(1);
    const perched = down();
    expect(perched.length).toBeGreaterThanOrEqual(12);
    const bird = perched[0] as EntityView;
    player.x = bird.x + 2;
    player.y = bird.y;
    player.z = bird.z;
    rig.ticks(30);
    expect(bird.anim === 'fly' || bird.anim === 'glide').toBe(true);
    // The rest of the flock went up with it.
    expect(share(perched, (v) => v.anim === 'fly' || v.anim === 'glide')).toBeGreaterThan(0.4);

    const fish = rig.living('fish')[0] as EntityView;
    player.x = fish.x + 1;
    player.y = fish.y + 1;
    player.z = fish.z;
    const from = Math.hypot(fish.x - player.x, fish.z - player.z);
    rig.ticks(15);
    expect(Math.hypot(fish.x - player.x, fish.z - player.z)).toBeGreaterThan(from + 1);
    // And its school moves off with it rather than drifting back under the swimmer.
    rig.ticks(100);
    expect(Math.hypot(fish.x - player.x, fish.z - player.z)).toBeGreaterThan(3.5);
    expect(misplaced(rig.world, rig.eco.views)).toEqual([]);
  });

  it('wild animals keep out of an avoided area', () => {
    const area = { x: FIXTURE.meadow.x, z: FIXTURE.meadow.z, radius: 32 };
    const rig = makeRig({ eco: { avoid: [area], populations: { songbird: 0, crow: 0, gull: 0, duck: 0, fish: 0 }, immigration: false }, startDay: 1 });
    const inside = (v: EntityView): boolean => Math.hypot(v.x - area.x, v.z - area.z) < area.radius - 0.75;
    expect(rig.living().filter(inside)).toEqual([]);
    const trespass: string[] = [];
    const roundIt = new Set<number>();
    rig.days(1.5, (tick) => {
      if (tick % 50 !== 0) return;
      for (const v of rig.living()) {
        if (inside(v)) trespass.push(`${v.kind} at ${v.x.toFixed(0)},${v.z.toFixed(0)}`);
        if (Math.hypot(v.x - area.x, v.z - area.z) < area.radius + 40) roundIt.add(v.id);
      }
    });
    expect(trespass).toEqual([]);
    // They were not simply elsewhere: animals were living and feeding right round the edge of it. (Counted over
    // the run, not at its last moment: on this seed no warren lies near, and the herds that feed there come and go.)
    expect(roundIt.size).toBeGreaterThan(10);
  });
});
