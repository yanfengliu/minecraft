import { describe, expect, it } from 'vitest';
import { Rng } from '../../core/rng';
import { B, IS_LEAVES, IS_LOG, WATER_SOURCE } from '../../world/blocks';
import { isStandable } from '../../world/walk';
import { FIXTURE, createFixtureLandscape, fixtureRiverZ } from './fixture';
import { H_FRESH, H_HIGH, H_MEADOW, H_SEA, H_SHORE, H_WOOD, Habitat, STRIDE } from './habitat';
import { countFloor, floorCellY, waterTop } from './terrain';
import { fixtureWorld } from './testkit';

const isRiver = (s: number): boolean => s >= B.river && s < B.river + 8;

describe('fixture landscape', () => {
  const world = fixtureWorld(1);

  it('is a 256 by 256 world with a real sea level', () => {
    expect([world.sx, world.sy, world.sz]).toEqual([256, 64, 256]);
    expect(world.seaLevel).toBe(FIXTURE.seaLevel);
    // The heightmap was rebuilt after the raw writes: it agrees with the blocks.
    const rng = new Rng(5);
    for (let i = 0; i < 400; i++) {
      const x = rng.int(256);
      const z = rng.int(256);
      const before = world.height(x, z);
      expect(world.get(x, before, z) === B.air || !isStandable(world, x, before - 1, z)).toBe(true);
    }
    const copy = world.clone();
    copy.recomputeHeightmap();
    expect(Array.from(copy.heightmap)).toEqual(Array.from(world.heightmap));
  });

  it('has sea along the west edge below sea level, and a sand shore behind it', () => {
    for (let z = 0; z < 256; z += 8) {
      expect(world.get(0, world.seaLevel - 1, z)).toBe(B.water_source);
      expect(world.get(0, world.seaLevel, z)).toBe(B.air);
      // Walking east from the sea the first dry ground is sand.
      let x = 0;
      while (waterTop(world, x, z) >= 0) x++;
      const river = isRiver(world.get(x - 1, world.seaLevel - 1, z));
      if (!river) expect(world.get(x, world.height(x, z) - 1, z)).toBe(B.sand);
      expect(x).toBeGreaterThan(24);
      expect(x).toBeLessThan(48);
    }
  });

  it('has meadow with tall grass and flowers', () => {
    const { x, z } = FIXTURE.meadow;
    expect(world.get(x, world.height(x, z) - 1, z)).toBe(B.grass);
    expect(countFloor(world, (s) => s === B.tall_grass)).toBeGreaterThan(3000);
    for (const flower of [B.poppy, B.daisy, B.bluebell, B.buttercup]) expect(countFloor(world, (s) => s === flower)).toBeGreaterThan(5);
    expect(countFloor(world, (s) => s === B.berry_bush)).toBeGreaterThan(30);
  });

  it('has woods of all three species standing on forest floor', () => {
    const logs = new Map<number, number>();
    let onFloor = 0;
    let trunks = 0;
    for (let z = 0; z < 256; z++) {
      for (let x = 0; x < 256; x++) {
        const y = floorCellY(world, x, z);
        const s = world.get(x, y, z);
        if (!IS_LOG[s]) continue;
        trunks++;
        logs.set(s, (logs.get(s) ?? 0) + 1);
        if (world.get(x, y - 1, z) === B.forest_floor) onFloor++;
      }
    }
    expect(logs.get(B.oak_log) ?? 0).toBeGreaterThan(20);
    expect(logs.get(B.birch_log) ?? 0).toBeGreaterThan(15);
    expect(logs.get(B.pine_log) ?? 0).toBeGreaterThan(15);
    expect(onFloor).toBe(trunks);
    for (const w of FIXTURE.woods) {
      // The middle of each wood is under its own kind of leaves, or close to them.
      let leaves = 0;
      const leaf = w.species === 'oak' ? B.oak_leaves : w.species === 'birch' ? B.birch_leaves : B.pine_leaves;
      for (let dz = -8; dz <= 8; dz++) {
        for (let dx = -8; dx <= 8; dx++) {
          const top = world.get(w.x + dx, world.height(w.x + dx, w.z + dz) - 1, w.z + dz);
          if (IS_LEAVES[top]) expect(top).toBe(leaf);
          if (top === leaf) leaves++;
        }
      }
      expect(leaves).toBeGreaterThan(60);
    }
  });

  it('has a pond of still water and a river of flowing water that runs from it to the sea', () => {
    const { pond } = FIXTURE;
    expect(world.get(pond.x, 17, pond.z)).toBe(B.water_source);
    expect(world.get(pond.x, 18, pond.z)).toBe(B.air);
    let reaches = 0;
    for (let x = 44; x <= pond.x - pond.radius; x++) {
      const z = Math.round(fixtureRiverZ(x));
      const top = waterTop(world, x, z);
      expect(top).toBeGreaterThanOrEqual(world.seaLevel - 1);
      expect(isRiver(world.get(x, top, z))).toBe(true);
      reaches++;
    }
    expect(reaches).toBeGreaterThan(50);
    // It meets the sea at sea level.
    expect(WATER_SOURCE[world.get(30, world.seaLevel - 1, Math.round(fixtureRiverZ(30)))]).toBe(1);
  });

  it('has a stony highland well above the meadow', () => {
    const { highland, meadow } = FIXTURE;
    const top = world.height(highland.x, highland.z);
    expect(top).toBeGreaterThan(world.height(meadow.x, meadow.z) + 10);
    let stone = 0;
    for (let dz = -10; dz <= 10; dz++) {
      for (let dx = -10; dx <= 10; dx++) {
        const s = world.get(highland.x + dx, world.height(highland.x + dx, highland.z + dz) - 1, highland.z + dz);
        if (s === B.stone || s === B.granite || s === B.gravel) stone++;
      }
    }
    expect(stone).toBeGreaterThan(300);
  });

  it('is the same for the same seed and different for another', () => {
    const again = createFixtureLandscape(1);
    const other = createFixtureLandscape(2);
    let same = 0;
    let differs = 0;
    for (let z = 0; z < 256; z += 3) {
      for (let x = 0; x < 256; x += 3) {
        const y = floorCellY(world, x, z);
        if (again.get(x, y, z) === world.get(x, y, z) && again.height(x, z) === world.height(x, z)) same++;
        if (other.get(x, y, z) !== world.get(x, y, z) || other.height(x, z) !== world.height(x, z)) differs++;
      }
    }
    expect(same).toBe(86 * 86);
    expect(differs).toBeGreaterThan(500);
  });
});

describe('habitat survey of the fixture', () => {
  const world = fixtureWorld(1);
  const habitat = new Habitat(world, []);
  const area = (c: number): number => (habitat.total[c] as number) * STRIDE * STRIDE;

  it('finds every kind of country the animals need', () => {
    expect(area(H_SEA)).toBeGreaterThan(6000);
    expect(area(H_SHORE)).toBeGreaterThan(1000);
    expect(area(H_MEADOW)).toBeGreaterThan(30000);
    expect(area(H_WOOD)).toBeGreaterThan(3500);
    expect(area(H_FRESH)).toBeGreaterThan(300);
    expect(area(H_HIGH)).toBeGreaterThan(3000);
    expect(habitat.classAt(4, 128)).toBe(H_SEA);
    expect(habitat.classAt(FIXTURE.pond.x, FIXTURE.pond.z)).toBe(H_FRESH);
    expect(habitat.classAt(FIXTURE.meadow.x, FIXTURE.meadow.z)).toBe(H_MEADOW);
    expect(habitat.classAt(FIXTURE.highland.x, FIXTURE.highland.z)).toBe(H_HIGH);
    expect(habitat.share(H_WOOD, FIXTURE.woods[0].x, FIXTURE.woods[0].z)).toBeGreaterThan(0.6);
  });

  it('tells the sea from fresh water and groups each into bodies', () => {
    const sea = habitat.bodies.filter((b) => b.sea);
    const fresh = habitat.bodies.filter((b) => !b.sea);
    expect(sea.length).toBeGreaterThanOrEqual(2);
    expect(fresh.length).toBeGreaterThanOrEqual(1);
    expect(habitat.bodyNear(FIXTURE.pond.x, FIXTURE.pond.z, 4)?.sea).toBe(false);
    expect(habitat.bodyNear(FIXTURE.river.x, fixtureRiverZ(FIXTURE.river.x), 4)?.sea).toBe(false);
    expect(habitat.bodyNear(6, 100, 4)?.sea).toBe(true);
    expect(habitat.bodyNear(FIXTURE.meadow.x, FIXTURE.meadow.z, 10)).toBeNull();
  });

  it('answers where-is questions from the map', () => {
    const rng = new Rng(9);
    const spot = { x: 0, y: 0, z: 0 };
    for (const c of [H_SEA, H_FRESH, H_SHORE, H_MEADOW, H_WOOD, H_HIGH]) {
      for (let i = 0; i < 20; i++) {
        expect(habitat.pick(c, rng, spot)).toBe(true);
        expect(habitat.classAt(spot.x, spot.z)).toBe(c);
      }
    }
    expect(habitat.nearest(H_WOOD, FIXTURE.meadow.x, FIXTURE.meadow.z, 120, spot)).toBe(true);
    expect(habitat.classAt(spot.x, spot.z)).toBe(H_WOOD);
    expect(habitat.pickNear(H_MEADOW, FIXTURE.meadow.x, FIXTURE.meadow.z, 5, 20, rng, spot)).toBe(true);
    expect(Math.hypot(spot.x - FIXTURE.meadow.x, spot.z - FIXTURE.meadow.z)).toBeLessThan(22);
    // The river lies between a point north of it and a point south of it.
    const rz = fixtureRiverZ(74);
    expect(habitat.crossesWater(74, rz - 12, 74, rz + 12)).toBe(true);
    expect(habitat.crossesWater(200, 150, 220, 170)).toBe(false);
  });

  it('follows a wood that is felled', () => {
    const w = FIXTURE.woods[2];
    const before = habitat.total[H_WOOD] as number;
    for (let dz = -30; dz <= 30; dz++) {
      for (let dx = -30; dx <= 30; dx++) {
        const x = w.x + dx;
        const z = w.z + dz;
        for (let y = world.height(x, z) - 1; y > 0 && (IS_LEAVES[world.get(x, y, z)] || IS_LOG[world.get(x, y, z)] || world.get(x, y, z) === B.air); y--) world.set(x, y, z, B.air);
      }
    }
    for (let i = 0; i < habitat.gx * habitat.gz; i++) habitat.refreshNext();
    expect(habitat.total[H_WOOD] as number).toBeLessThan(before * 0.8);
    expect(habitat.share(H_WOOD, w.x, w.z)).toBe(0);
  });
});
