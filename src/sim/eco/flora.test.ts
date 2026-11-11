import { beforeAll, describe, expect, it } from 'vitest';
import { B, IS_LEAVES, IS_LOG } from '../../world/blocks';
import { speciesOfSapling } from '../../world/gen/trees';
import type { World } from '../../world/world';
import { FIXTURE } from './fixture';
import { FOOD_FLOWER, FOOD_GRASS } from './species';
import { FOOD, countFloor, floorCellY } from './terrain';
import { NO_ANIMALS, type Rig, countForage, countState, makeRig } from './testkit';

const isForage = (s: number): boolean => ((FOOD[s] as number) & (FOOD_GRASS | FOOD_FLOWER)) !== 0;
const isFlower = (s: number): boolean => ((FOOD[s] as number) & FOOD_FLOWER) !== 0;
const isSapling = (s: number): boolean => speciesOfSapling(s) !== null;
const isMushroom = (s: number): boolean => s === B.mushroom_brown || s === B.mushroom_red;
const isLog = (s: number): boolean => IS_LOG[s] === 1;
const plantsOnly = { eco: { populations: NO_ANIMALS } };

/** Columns of bare or planted grass that are open to the sky. */
function openGrass(world: World): number {
  let n = 0;
  for (let z = 0; z < world.sz; z++) {
    for (let x = 0; x < world.sx; x++) if (world.get(x, world.height(x, z) - 1, z) === B.grass) n++;
  }
  return n;
}

function plantNeighbours(world: World, x: number, y: number, z: number): number {
  let n = 0;
  for (let dz = -1; dz <= 1; dz++) {
    for (let dx = -1; dx <= 1; dx++) if ((dx !== 0 || dz !== 0) && isForage(world.get(x + dx, y, z + dz))) n++;
  }
  return n;
}

/** How many columns within `r` of (cx, cz) have a ground-level cell that matches. */
function around(world: World, cx: number, cz: number, r: number, match: (s: number) => boolean): number {
  let n = 0;
  for (let dz = -r; dz <= r; dz++) {
    for (let dx = -r; dx <= r; dx++) {
      if (dx * dx + dz * dz <= r * r && match(world.get(cx + dx, floorCellY(world, cx + dx, cz + dz), cz + dz))) n++;
    }
  }
  return n;
}

// One world left to its plants for two years, looked at as it goes. Everything
// the plants do is slow, so the tests below share the run rather than each
// simulating its own seasons.
describe('two years of plants with nothing eating them', () => {
  interface Look {
    forage: number;
    tallGrass: number;
    ripe: number;
    mushrooms: number;
    trunks: number;
    grass: number;
    canopy: number;
    cover: number;
    season: string;
    regrown: number;
    reseeded: number;
  }
  const looks = new Map<number, Look>();
  const at = (day: number): Look => looks.get(day) as Look;
  let rig: Rig;
  let bushes = 0;
  let stood = 0;
  let felled = 0;
  const bad: string[] = [];
  const kinds = new Set<number>();
  const mushroomKinds = new Set<number>();
  let sprouted = 0;
  let displaced = 0;
  let before = 0;
  const wood = FIXTURE.woods[0];
  const R = 11;
  const open = [
    { x: FIXTURE.meadow.x, z: FIXTURE.meadow.z, sapling: B.oak_sapling, log: B.oak_log },
    { x: FIXTURE.meadow.x + 12, z: FIXTURE.meadow.z, sapling: B.birch_sapling, log: B.birch_log },
    { x: FIXTURE.meadow.x, z: FIXTURE.meadow.z + 12, sapling: B.pine_sapling, log: B.pine_log },
  ];
  const openAt = new Map<number, number[]>();
  const shaded = { x: -1, y: -1, z: -1 };
  const shadedAt = new Map<number, number>();
  // A field, a path and a hut on the edge of the oak wood, where seeds fall thickest.
  const fx = wood.x + 34;
  const fz = wood.z;
  let fy = 0;
  const built = new Set<string>();

  beforeAll(() => {
    rig = makeRig({ ...plantsOnly, startDay: 0 });
    const world = rig.world;
    bushes = countState(world, B.berry_bush, B.berry_bush + 1);

    fy = world.height(fx, fz) - 1;
    const put = (x: number, y: number, z: number, s: number): void => {
      world.set(x, y, z, s);
      built.add(`${x},${y},${z}`);
    };
    for (let dz = -6; dz <= 6; dz++) {
      for (let dx = 0; dx <= 12; dx++) {
        for (let up = 1; up <= 12; up++) world.set(fx + dx, fy + up, fz + dz, B.air);
        if (dx <= 6) {
          put(fx + dx, fy, fz + dz, B.farmland);
          put(fx + dx, fy + 1, fz + dz, B.wheat + 1);
        } else if (dx === 7) put(fx + dx, fy, fz + dz, B.path);
        else if (dx >= 9 && Math.abs(dz) <= 2) put(fx + dx, fy, fz + dz, B.oak_planks);
        else put(fx + dx, fy, fz + dz, B.grass);
      }
    }
    put(fx + 9, fy + 1, fz - 2, B.fence);

    // The woodcutters come through the middle of the oak wood: every trunk in a circle is felled.
    stood = around(world, wood.x, wood.z, R, isLog);
    for (let dz = -R; dz <= R; dz++) {
      for (let dx = -R; dx <= R; dx++) {
        if (dx * dx + dz * dz > R * R) continue;
        const y = floorCellY(world, wood.x + dx, wood.z + dz);
        if (IS_LOG[world.get(wood.x + dx, y, wood.z + dz)]) felled += rig.ctx.actions.fellTree(wood.x + dx, y, wood.z + dz);
      }
    }

    // Three saplings out in the meadow, and one in the oak wood, clear of the felling, under a closed crown with
    // no trunk beside it.
    for (const s of open) world.set(s.x, world.height(s.x, s.z), s.z, s.sapling);
    for (let dz = -6; dz <= 6 && shaded.x < 0; dz++) {
      for (let dx = -6; dx <= 6 && shaded.x < 0; dx++) {
        const x = wood.x + dx;
        const z = wood.z + 20 + dz;
        const y = floorCellY(world, x, z);
        if (world.get(x, y, z) !== B.air || world.get(x, y - 1, z) !== B.forest_floor || world.exposed(x, y, z)) continue;
        if (around(world, x, z, 2, isLog) === 0) Object.assign(shaded, { x, y, z });
      }
    }
    world.set(shaded.x, shaded.y, shaded.z, B.oak_sapling);

    before = countForage(world);
    world.changed.on((c) => {
      if (built.has(`${c.x},${c.y},${c.z}`)) bad.push(`changed what was built at ${c.x},${c.y},${c.z}: ${c.old} to ${c.state}`);
      const under = world.get(c.x, c.y - 1, c.z);
      if (isForage(c.old) && !isForage(c.state)) displaced++;
      if (isForage(c.state)) {
        sprouted++;
        kinds.add(c.state);
        // Only onto bare grass, open to the sky, with at most one plant beside it: the bound on density.
        if (c.old !== B.air || under !== B.grass || !world.exposed(c.x, c.y, c.z)) bad.push(`sprouted in a bad place at ${c.x},${c.y},${c.z}`);
        if (plantNeighbours(world, c.x, c.y, c.z) > 1) bad.push(`sprouted in a crowd at ${c.x},${c.y},${c.z}`);
      } else if (isMushroom(c.state)) {
        mushroomKinds.add(c.state);
        // On the forest floor, or on grass in the shade of a tree; and only in autumn.
        if (under !== B.forest_floor && !(under === B.grass && !world.exposed(c.x, c.y, c.z))) bad.push(`mushroom in the open at ${c.x},${c.y},${c.z}`);
        if (rig.clock.season !== 'autumn') bad.push(`mushroom came up in ${rig.clock.season}`);
      } else if (isSapling(c.state)) {
        if (under !== B.grass && under !== B.forest_floor) bad.push(`sapling on ${under} at ${c.x},${c.y},${c.z}`);
        // A sapling keeps three blocks clear of the field, the path and the hut.
        for (let dz = -3; dz <= 3; dz++) {
          for (let dx = -3; dx <= 3; dx++) {
            for (let dy = -1; dy <= 0; dy++) {
              const key = `${c.x + dx},${c.y + dy},${c.z + dz}`;
              if (built.has(key) && world.get(c.x + dx, c.y + dy, c.z + dz) !== B.grass) bad.push(`sapling at ${c.x},${c.y},${c.z} too near what is built`);
            }
          }
        }
      }
    });

    let day = 0;
    for (const next of [2.5, 4, 7, 9.5, 11, 14, 19, 21, 27.5, 28, 31, 56]) {
      rig.days(next - day);
      day = next;
      looks.set(day, {
        forage: countForage(world),
        tallGrass: countState(world, B.tall_grass),
        ripe: countState(world, B.berry_bush + 1),
        mushrooms: countFloor(world, isMushroom),
        trunks: countFloor(world, isLog),
        grass: openGrass(world),
        canopy: rig.eco.plants().canopy,
        cover: rig.eco.plants().cover,
        season: rig.clock.season,
        regrown: around(world, wood.x, wood.z, R, isLog),
        reseeded: around(world, wood.x, wood.z, R, isSapling),
      });
      openAt.set(day, open.map((s) => world.get(s.x, floorCellY(world, s.x, s.z), s.z)));
      shadedAt.set(day, world.get(shaded.x, shaded.y, shaded.z));
    }
  }, 120_000);

  it('tall grass, ferns and flowers spread onto bare open grass, never into a crowd', () => {
    expect(bad).toEqual([]);
    expect(at(4).forage).toBeGreaterThan(before + 1000);
    for (const s of [B.tall_grass, B.fern, B.poppy, B.daisy, B.bluebell, B.buttercup]) expect(kinds.has(s)).toBe(true);
    // Nothing eats them here, so what stands is what was there, plus what sprouted, less what trees and winter took.
    expect(rig.eco.stats().sprouted).toBe(sprouted);
    expect(countForage(rig.world)).toBe(before + sprouted - displaced);
  });

  it('they level off at a bounded density', () => {
    const summer = at(14).forage / at(14).grass;
    const autumn = at(21).forage / at(21).grass;
    expect(summer).toBeGreaterThan(0.2);
    expect(autumn).toBeLessThan(0.34);
    // Nearly full by the end of summer: the autumn adds little.
    expect(autumn - summer).toBeLessThan(0.03);
    // The figures the census shows are estimates from sampled columns; they agree with a full count.
    expect(Math.abs(at(21).cover - autumn)).toBeLessThan(0.03);
    expect(Math.abs(rig.eco.plants().tallGrass - at(56).tallGrass) / at(56).tallGrass).toBeLessThan(0.1);
  });

  it('berry bushes ripen through summer and autumn and are bare again by the end of winter', () => {
    expect(at(4).ripe).toBe(0);
    expect(at(11).season).toBe('summer');
    expect(at(11).ripe).toBeGreaterThan(bushes * 0.4);
    expect(at(19).season).toBe('autumn');
    expect(at(19).ripe).toBeGreaterThan(bushes * 0.85);
    expect(at(27.5).season).toBe('winter');
    expect(at(27.5).ripe).toBeLessThan(bushes * 0.15);
    expect(countState(rig.world, B.berry_bush, B.berry_bush + 1)).toBe(bushes);
  });

  it('mushrooms come up under the trees in autumn and are gone by spring', () => {
    expect(at(21).mushrooms).toBeGreaterThan(at(14).mushrooms + 40);
    expect(mushroomKinds.has(B.mushroom_brown) && mushroomKinds.has(B.mushroom_red)).toBe(true);
    expect(at(31).season).toBe('spring');
    expect(at(31).mushrooms).toBeLessThan(15);
  });

  it('a sapling in the open becomes a tree of its kind after some days', () => {
    // Not at once: it stands some days first.
    expect(openAt.get(2.5)).toEqual(open.map((s) => s.sapling));
    expect(openAt.get(9.5)).toEqual(open.map((s) => s.log));
    for (const s of open) {
      const y = floorCellY(rig.world, s.x, s.z);
      expect(rig.world.get(s.x, y + 2, s.z)).toBe(s.log);
      expect(IS_LEAVES[rig.world.get(s.x, rig.world.height(s.x, s.z) - 1, s.z)]).toBe(1);
    }
  });

  it('a sapling shaded by a closed crown never makes a tree, and in the end dies', () => {
    expect(shaded.x).toBeGreaterThan(0);
    expect(shadedAt.get(11)).toBe(B.oak_sapling);
    expect(shadedAt.get(21)).toBe(B.air);
  });

  it('felled woodland seeds itself from the trees left standing and grows back', () => {
    expect(stood).toBeGreaterThan(8);
    expect(felled).toBeGreaterThan(30);
    expect(at(7).reseeded + at(7).regrown).toBeGreaterThanOrEqual(2);
    // By the second spring there are trees again, of the wood's own kind, and no thicker than they stood before.
    expect(at(28).regrown).toBeGreaterThanOrEqual(4);
    expect(around(rig.world, wood.x, wood.z, R, (s) => s === B.oak_log)).toBe(at(56).regrown);
    expect(at(56).regrown).toBeLessThanOrEqual(stood * 2);
  });

  it('the woods thicken without swallowing the meadows', () => {
    const first = at(28).trunks - at(2.5).trunks;
    const second = at(56).trunks - at(28).trunks;
    expect(first).toBeGreaterThan(10);
    // Growth is slowing: the second year adds far fewer trees than the first.
    expect(second).toBeLessThan(first * 0.5);
    // The woods fill their own gaps and creep a little; the open grass is nearly all still there.
    expect(at(56).grass).toBeGreaterThan(at(2.5).grass * 0.95);
    expect(at(56).canopy).toBeLessThan(at(2.5).canopy * 1.6);
    // No two trunks side by side.
    let crowded = 0;
    for (let z = 2; z < 254; z++) {
      for (let x = 2; x < 254; x++) {
        const y = floorCellY(rig.world, x, z);
        if (IS_LOG[rig.world.get(x, y, z)] && IS_LOG[rig.world.get(x + 1, floorCellY(rig.world, x + 1, z), z)]) crowded++;
      }
    }
    expect(crowded).toBeLessThan(4);
  });

  it('nothing is sown, grown or seeded on farmland, crops, paths or anything built', () => {
    expect(bad).toEqual([]);
    for (let dz = -6; dz <= 6; dz++) {
      for (let dx = 0; dx <= 6; dx++) {
        expect(rig.world.get(fx + dx, fy, fz + dz)).toBe(B.farmland);
        expect(rig.world.get(fx + dx, fy + 1, fz + dz)).toBe(B.wheat + 1);
      }
      expect(rig.world.get(fx + 7, fy, fz + dz)).toBe(B.path);
      expect(rig.world.get(fx + 7, fy + 1, fz + dz)).toBe(B.air);
    }
    // The strip of grass between the path and the hut was not exempt: plants grew there as anywhere.
    let onStrip = 0;
    for (let dz = -6; dz <= 6; dz++) if (isForage(rig.world.get(fx + 8, fy + 1, fz + dz))) onStrip++;
    expect(onStrip).toBeGreaterThan(0);
    expect(rig.eco.stats().saplingsSeeded).toBeGreaterThan(20);
  });
});

describe('the seasons and the weather', () => {
  it('nothing spreads in winter, and the flowers die back', () => {
    const rig = makeRig({ ...plantsOnly, startDay: 21 });
    const grass = countState(rig.world, B.tall_grass);
    const flowers = countFloor(rig.world, isFlower);
    rig.days(6);
    expect(rig.clock.season).toBe('winter');
    expect(rig.eco.stats().sprouted).toBe(0);
    expect(countState(rig.world, B.tall_grass)).toBe(grass);
    expect(countFloor(rig.world, isFlower)).toBeLessThan(flowers * 0.5);
  });

  it('plants grow faster on wet ground than on dry, and faster in spring than in autumn', () => {
    const grown = (startDay: number, weather: 'clear' | 'rain'): number => {
      const rig = makeRig({ ...plantsOnly, startDay, weather });
      rig.days(2);
      return rig.eco.stats().sprouted;
    };
    const summerDry = grown(8, 'clear');
    const summerWet = grown(8, 'rain');
    const springWet = grown(3, 'rain');
    const autumnWet = grown(15, 'rain');
    expect(summerDry).toBeGreaterThan(100);
    expect(summerWet).toBeGreaterThan(summerDry * 1.8);
    expect(springWet).toBeGreaterThan(summerWet * 1.3);
    expect(autumnWet).toBeLessThan(summerWet * 0.7);
    expect(autumnWet).toBeGreaterThan(0);
  });
});
