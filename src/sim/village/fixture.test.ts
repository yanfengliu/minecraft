import { describe, expect, it } from 'vitest';
import { B, IS_LOG, isBed, isDoor, isGate } from '../../world/blocks';
import { isStandable } from '../../world/walk';
import { BUILDING_KINDS, validateVillagePlan } from '../api';
import { Navigator, PATH_FOUND, PATH_PENDING, VILLAGER_WALK } from '../nav';
import { createFixtureVillage } from './fixture';

describe('fixture village', () => {
  const { world, plan } = createFixtureVillage(7);

  it('validates against the blocks it built', () => {
    expect(validateVillagePlan(world, plan)).toEqual([]);
  });

  it('has every kind of building the simulation knows, and enough beds', () => {
    const kinds = new Set(plan.buildings.map((b) => b.kind));
    for (const kind of BUILDING_KINDS) expect(kinds.has(kind), kind).toBe(true);
    expect(plan.buildings.filter((b) => b.kind === 'house').length).toBeGreaterThanOrEqual(6);
    expect(plan.buildings.filter((b) => b.kind === 'farm').length).toBe(2);
    const beds = plan.buildings.reduce((n, b) => n + b.beds.length, 0);
    expect(beds).toBeGreaterThanOrEqual(40);
    expect(beds).toBeLessThanOrEqual(50);
    expect(plan.fields.length).toBeGreaterThanOrEqual(4);
    expect(plan.pens.map((p) => p.animal).sort()).toEqual(['chicken', 'cow', 'sheep']);
    expect(plan.stalls.length).toBeGreaterThanOrEqual(4);
    expect(plan.lamps.length).toBeGreaterThanOrEqual(6);
    expect(plan.patrol.length).toBeGreaterThanOrEqual(4);
    expect(plan.dock.length).toBeGreaterThanOrEqual(1);
    expect(plan.mine?.faces.length).toBeGreaterThanOrEqual(2);
  });

  it('builds real blocks for what the plan names', () => {
    for (const b of plan.buildings) {
      expect(b.door, b.name).not.toBeNull();
      expect(isDoor(world.get(b.door!.x, b.door!.y, b.door!.z))).toBe(true);
      expect(isDoor(world.get(b.door!.x, b.door!.y + 1, b.door!.z))).toBe(true);
      for (const bed of b.beds) expect(isBed(world.get(bed.block.x, bed.block.y, bed.block.z))).toBe(true);
      // Roofed: rain does not reach the floor.
      expect(world.exposed(b.x0 + 2, b.floorY, b.z0 + 2), b.name).toBe(false);
      expect(b.lights.length, b.name).toBeGreaterThan(0);
      expect(b.storage ?? b.seats[0], b.name).toBeDefined();
    }
    for (const p of plan.pens) expect(isGate(world.get(p.gate.x, p.gate.y, p.gate.z))).toBe(true);
    for (const c of plan.dock) {
      const water = [[1, 0], [-1, 0], [0, 1], [0, -1]].some(([dx, dz]) => world.get(c.x + dx!, c.y - 1, c.z + dz!) === B.water_source);
      expect(water).toBe(true);
    }
    for (const c of plan.mine!.faces) {
      const stone = [[1, 0], [-1, 0], [0, 1], [0, -1]].some(([dx, dz]) => !isStandable(world, c.x + dx!, c.y, c.z + dz!, VILLAGER_WALK));
      expect(stone).toBe(true);
      expect(world.exposed(c.x, c.y, c.z)).toBe(false);
    }
    let logs = 0;
    const f = plan.forest;
    for (let z = f.z - f.radius; z <= f.z + f.radius; z++) {
      for (let x = f.x - f.radius; x <= f.x + f.radius; x++) if (IS_LOG[world.get(x, 32, z)]) logs++;
    }
    expect(logs).toBeGreaterThanOrEqual(8);
  });

  it('connects every named place to the square on foot', () => {
    const nav = new Navigator(world, { budgetPerTick: 100000 });
    const c = plan.center;
    const targets = [
      plan.well, ...plan.gathering, ...plan.dock, ...plan.patrol, plan.mine!.entrance, ...plan.mine!.faces,
      ...plan.stalls.flatMap((s) => [s.stand, s.customer]),
      ...plan.pens.flatMap((p) => [p.outside, { x: p.x0, y: p.y, z: p.z0 }]),
      ...plan.buildings.flatMap((b) => [b.entry, ...b.beds.map((bed) => bed.stand), ...b.work.map((w) => w.stand), ...b.seats, ...(b.storage ? [b.storage] : [])]),
      ...plan.fields.map((fl) => ({ x: fl.x0, y: fl.y + 1, z: fl.z0 })),
    ];
    for (const t of targets) {
      const req = nav.request(c.x, c.y, c.z, t.x, t.y, t.z, false);
      for (let i = 0; i < 20 && req.status === PATH_PENDING; i++) nav.update();
      expect(req.status, `${t.x},${t.y},${t.z}`).toBe(PATH_FOUND);
    }
  });

  it('is the same world for the same seed', () => {
    const again = createFixtureVillage(7);
    let differ = 0;
    for (let y = 28; y < 50; y++) for (let z = 0; z < 128; z++) for (let x = 0; x < 128; x++) if (world.get(x, y, z) !== again.world.get(x, y, z)) differ++;
    expect(differ).toBe(0);
    expect(again.plan).toEqual(plan);
  });
});
