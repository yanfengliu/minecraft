import { beforeAll, describe, expect, it } from 'vitest';
import { B, IS_LEAVES, IS_LOG } from '../../blocks';
import { type Cell, type VillagePlan, validateVillagePlan } from '../../plan';
import type { World } from '../../world';
import { type Island, generateIsland } from '../island';
import { DEFAULT_ISLAND, type IslandConfig } from '../terrain';
import { cellKey, lakeHoles, walkableFrom, waterFaults } from '../testkit';
import { buildVillage } from './index';

// The island the game loads, the seed the README offers, and islands two thirds the size. On those the
// shelf the village stands on is tighter than the village, so lots move along their roads or go unbuilt,
// which is what the later stages of the builder used to get wrong: seed 1 put a lamp on a doorstep and
// had no farm for its fields, 5 and 17 levelled a field through a farmhouse, 14 grew a tree across a
// field gate, 42 cut a cave into the river bank.
const SMALLER = { ...DEFAULT_ISLAND, sx: 512, sz: 512 };
const ISLANDS: { name: string; config: IslandConfig; full: boolean }[] = [
  { name: 'the default island', config: DEFAULT_ISLAND, full: true },
  { name: 'seed 7', config: { ...DEFAULT_ISLAND, seed: 7 }, full: true },
  ...[1, 5, 14, 17, 42].map((seed) => ({ name: `seed ${seed}, 512 across`, config: { ...SMALLER, seed }, full: false })),
];

/** The blocks people walk on that the village lays: roads and lanes, the square, plank decks, fields. */
const MADE_GROUND = new Set<number>([B.path, B.cobble, B.mossy_cobble, B.oak_planks, B.farmland, B.farmland + 1]);
const isTree = (state: number): boolean => IS_LOG[state] === 1 || IS_LEAVES[state] === 1;

describe.each(ISLANDS)('the village generated on $name', ({ config, full }) => {
  let island: Island;
  let world: World;
  let plan: VillagePlan;

  beforeAll(() => {
    // Throws, with the validator's message, if what was built does not match the plan.
    island = generateIsland(config, buildVillage);
    world = island.world;
    expect(island.plan, 'a village was built').not.toBeNull();
    plan = island.plan!;
  }, 120_000);

  it('is built, with the buildings and trades the simulation needs', () => {
    const kinds = new Set(plan.buildings.map((b) => b.kind));
    const beds = plan.buildings.reduce((n, b) => n + b.beds.length, 0);
    const farms = plan.buildings.filter((b) => b.kind === 'farm').length;
    console.log(`village (${config.seed}, ${config.sx}): ${plan.buildings.length} buildings, ${beds} beds, ${farms} farms, ${plan.fields.length} fields, ${plan.pens.length} pens, ${plan.lamps.length} lamps, dock ${plan.dock.length}, mine ${plan.mine ? 'yes' : 'no'}`);
    expect(plan.stalls).toHaveLength(4);
    // A field is a farm's: the farms share what fields there are, and without a farm there are none.
    for (const f of plan.fields) expect(plan.buildings.find((b) => b.id === f.owner)?.kind, `owner of field ${f.id}`).toBe('farm');
    if (farms > 0) expect(plan.fields.length).toBeGreaterThanOrEqual(2);
    if (!full) return;
    for (const k of ['house', 'farm', 'mill', 'bakery', 'tavern', 'smithy', 'carpenter', 'weaver', 'store', 'chapel', 'hall', 'woodcutter', 'guardhouse'] as const) {
      expect(kinds.has(k), `no ${k}`).toBe(true);
    }
    expect(plan.buildings.length).toBeGreaterThanOrEqual(20);
    expect(beds).toBeGreaterThanOrEqual(40);
  });

  it('matches the blocks in the world', () => {
    expect(validateVillagePlan(world, plan)).toEqual([]);
  });

  it('can be walked: every place the plan names is reached from the square, a step the path search takes at a time', () => {
    const p = plan;
    const seen = walkableFrom(world, p.center, 280, { opensGates: true });
    const missing: string[] = [];
    const need = (c: Cell, what: string): void => {
      if (!seen.has(cellKey(c.x, c.y, c.z))) missing.push(`${what} at ${c.x},${c.y},${c.z}`);
    };
    need(p.well, 'well');
    p.gathering.forEach((c, i) => need(c, `gathering ${i}`));
    p.patrol.forEach((c, i) => need(c, `patrol ${i}`));
    p.dock.forEach((c, i) => need(c, `dock ${i}`));
    p.stalls.forEach((s) => { need(s.stand, `stall ${s.id} seller`); need(s.customer, `stall ${s.id} customer`); });
    if (p.mine) { need(p.mine.entrance, 'mine entrance'); p.mine.faces.forEach((c, i) => need(c, `mine face ${i}`)); }
    for (const b of p.buildings) {
      need(b.entry, `${b.name} entry`);
      b.beds.forEach((bed, i) => need(bed.stand, `${b.name} bed ${i}`));
      b.work.forEach((w) => need(w.stand, `${b.name} ${w.kind}`));
      b.seats.forEach((c, i) => need(c, `${b.name} seat ${i}`));
      if (b.storage) need(b.storage, `${b.name} chest`);
    }
    for (const f of p.fields) {
      need({ x: f.x0, y: f.y + 1, z: f.z0 }, `field ${f.id}`);
      need({ x: f.x1, y: f.y + 1, z: f.z1 }, `far corner of field ${f.id}`);
    }
    for (const pen of p.pens) { need(pen.outside, `pen ${pen.id} gate`); need({ x: pen.x0, y: pen.y, z: pen.z0 }, `pen ${pen.id}`); }
    // The country the far trades work has no cell of its own in the plan: somewhere to stand near its middle will do.
    const columns = new Set<number>();
    for (const key of seen) columns.add(key % (1024 * 1024));
    for (const [name, a] of [['forest', p.forest], ['pasture', p.pasture], ['hunting ground', p.hunting]] as const) {
      let near = false;
      for (let dz = -6; dz <= 6 && !near; dz++) for (let dx = -6; dx <= 6; dx++) if (columns.has((a.z + dz) * 1024 + a.x + dx)) near = true;
      if (!near) missing.push(`${name} round ${a.x},${a.z}`);
    }
    expect(missing).toEqual([]);
  });

  it('keeps trees out of the streets and houses', () => {
    const intruders: string[] = [];
    // No branch anywhere under a roof.
    for (const b of plan.buildings) {
      for (let z = b.z0; z <= b.z1; z++) {
        for (let x = b.x0; x <= b.x1; x++) {
          for (let y = b.floorY; y < world.sy; y++) if (isTree(world.get(x, y, z))) intruders.push(`in ${b.name} at ${x},${y},${z}`);
        }
      }
    }
    // And none in the way on made ground: room over it to walk, and to step up.
    const cells = [...plan.patrol, ...plan.dock, ...plan.buildings.map((b) => b.entry), ...plan.fields.flatMap((f) => [{ x: f.x0, y: f.y, z: f.z0 }, { x: f.x1, y: f.y, z: f.z1 }])];
    const x0 = Math.min(...cells.map((c) => c.x)) - 4;
    const x1 = Math.max(...cells.map((c) => c.x)) + 4;
    const z0 = Math.min(...cells.map((c) => c.z)) - 4;
    const z1 = Math.max(...cells.map((c) => c.z)) + 4;
    const y0 = Math.min(...cells.map((c) => c.y)) - 8;
    const y1 = Math.max(...cells.map((c) => c.y)) + 8;
    let made = 0;
    for (let z = z0; z <= z1; z++) {
      for (let x = x0; x <= x1; x++) {
        for (let y = y0; y <= y1; y++) {
          if (!MADE_GROUND.has(world.get(x, y, z))) continue;
          made++;
          for (let up = 1; up <= 3; up++) if (isTree(world.get(x, y + up, z))) intruders.push(`over the ground at ${x},${y},${z}`);
        }
      }
    }
    expect(made).toBeGreaterThan(1000);
    expect(intruders).toEqual([]);
  });

  it('leaves the water where it was: nothing cut below a bank, the lake whole', () => {
    expect(waterFaults(world, config.seaLevel - 6, island.info.lake.level + 1)).toEqual({ hanging: 0, stillOpen: 0, overBank: 0, first: [] });
    expect(lakeHoles(world, island.info.lake)).toBe(0);
  });
});

describe('island generation with a village', () => {
  it('refuses, by name, a village that does not match its plan', () => {
    // A builder that plans a bed where it built none: the fault is stopped where the island is made.
    const config = { ...DEFAULT_ISLAND, sx: 192, sz: 192 };
    const builder = (world: World): VillagePlan => {
      const x = 96;
      const z = 96;
      const y = world.groundY(x, z) + 1;
      const here = { x, y, z };
      const house = {
        id: 0, kind: 'house' as const, name: 'Nowhere', x0: x, z0: z, x1: x, z1: z, floorY: y, entry: here, door: null,
        beds: [{ stand: here, block: { x: x + 1, y, z } }], work: [], seats: [], storage: null, lights: [], chimney: null,
      };
      const area = { x, z, radius: 4 };
      return {
        name: 'Nowhere', center: here, buildings: [house], fields: [], pens: [], stalls: [], well: here, gathering: [], dock: [], mine: null,
        forest: area, pasture: area, hunting: area, lamps: [], patrol: [],
      };
    };
    expect(() => generateIsland(config, builder)).toThrow(/seed 20261111 .* does not match its plan: .*bed\[0\] is not a bed block/);
  });
});
