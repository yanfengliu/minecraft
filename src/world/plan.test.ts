import { describe, expect, it } from 'vitest';
import { Rng } from '../core/rng';
import { B, gateState } from './blocks';
import { SPECS, buildShell, furnish } from './gen/village/buildings';
import { Frame } from './gen/village/frame';
import { type Building, type BuildingKind, type Cell, type VillagePlan, validateVillagePlan } from './plan';
import { type World, createFlatWorld } from './world';

const GROUND = 31;
const FEET = GROUND + 1;

/**
 * Three of the generator's own buildings on flat ground, a field, a pen and a
 * lamp: a small plan with one of everything the validator looks at.
 */
function hamlet(): { world: World; plan: VillagePlan; farm: Building; bakery: Building; smithy: Building } {
  const world = createFlatWorld(64, 64, GROUND, 64);
  world.trackDirty = false;
  const rng = new Rng(1);
  // Each faces north: seen from the front, its left corner is at (x, z) and it runs toward -x and +z.
  const building = (id: number, kind: BuildingKind, x: number, z: number): Building => {
    const spec = SPECS[kind];
    const f = new Frame(world, x, GROUND, z, 0);
    const chimney = buildShell(f, spec.w, spec.d, spec.style, rng);
    const parts = furnish(f, spec);
    const door = spec.w >> 1;
    return {
      id, kind, name: spec.label, x0: x - spec.w + 1, z0: z, x1: x, z1: z + spec.d - 1, floorY: FEET,
      entry: f.cell(door, 1, -1), door: f.cell(door, 1, 0), chimney, ...parts,
    };
  };
  const farm = building(0, 'farm', 20, 20);
  const bakery = building(1, 'bakery', 36, 20);
  const smithy = building(2, 'smithy', 52, 20);

  for (let z = 40; z <= 45; z++) for (let x = 10; x <= 15; x++) world.setRaw(x, GROUND, z, B.farmland);
  for (let z = 39; z <= 44; z++) {
    for (let x = 29; x <= 35; x++) if (x === 29 || x === 35 || z === 39 || z === 44) world.setRaw(x, FEET, z, B.fence);
  }
  world.setRaw(32, FEET, 44, gateState(0, false));
  world.setRaw(40, FEET, 40, B.fence);
  world.setRaw(40, FEET + 1, 40, B.fence);
  world.setRaw(40, FEET + 2, 40, B.lantern);
  const here = { x: 25, y: FEET, z: 34 };
  const area = { x: 50, z: 50, radius: 5 };
  const plan: VillagePlan = {
    name: 'Hamlet', center: here, well: { x: 26, y: FEET, z: 34 }, buildings: [farm, bakery, smithy],
    fields: [{ id: 0, owner: farm.id, crop: 'wheat', x0: 10, z0: 40, x1: 15, z1: 45, y: GROUND }],
    pens: [{ id: 0, owner: farm.id, animal: 'sheep', x0: 30, z0: 40, x1: 34, z1: 43, y: FEET, gate: { x: 32, y: FEET, z: 44 }, outside: { x: 32, y: FEET, z: 45 } }],
    stalls: [], gathering: [], dock: [], mine: null, forest: area, pasture: area, hunting: area,
    lamps: [{ x: 40, y: FEET + 2, z: 40 }], patrol: [],
  };
  return { world, plan, farm, bakery, smithy };
}

const put = (world: World, c: Cell, state: number): void => world.setRaw(c.x, c.y, c.z, state);
const spot = (b: Building, kind: string): { stand: Cell; block: Cell } => {
  const s = b.work.find((w) => w.kind === kind)!;
  return { stand: s.stand, block: s.block! };
};

describe('validateVillagePlan', () => {
  it('passes a plan that matches its blocks', () => {
    const { world, plan } = hamlet();
    expect(validateVillagePlan(world, plan)).toEqual([]);
  });

  it('wants a pen gate to be a gate, in the fence, with the way out beyond it', () => {
    const fenced = hamlet();
    put(fenced.world, fenced.plan.pens[0]!.gate, B.fence);
    expect(validateVillagePlan(fenced.world, fenced.plan).join('\n')).toMatch(/pen#0: no gate block at 32,32,44/);

    const astray = hamlet();
    astray.plan.pens[0]!.gate = { x: 35, y: FEET, z: 44 };
    expect(validateVillagePlan(astray.world, astray.plan).join('\n')).toMatch(/pen#0: gate at 35,32,44 is not in the fence round 30,40\.\.34,43/);

    const sideways = hamlet();
    sideways.plan.pens[0]!.outside = { x: 33, y: FEET, z: 45 };
    expect(validateVillagePlan(sideways.world, sideways.plan).join('\n')).toMatch(/pen#0: outside at 33,32,45 is not the cell beyond the gate/);
  });

  it('wants each work block to be there, of its kind, and beside where its worker stands', () => {
    const gone = hamlet();
    put(gone.world, spot(gone.farm, 'counter').block, B.air);
    expect(validateVillagePlan(gone.world, gone.plan).join('\n')).toMatch(/farm#0 work\[\d\] \(counter\): nothing to work at/);

    const cold = hamlet();
    put(cold.world, spot(cold.bakery, 'oven').block, B.table);
    put(cold.world, spot(cold.smithy, 'forge').block, B.table);
    const problems = validateVillagePlan(cold.world, cold.plan).join('\n');
    expect(problems).toMatch(/bakery#1 work\[\d\] \(oven\): the block at \S+ is not an oven/);
    expect(problems).toMatch(/smithy#2 work\[\d\] \(forge\): the block at \S+ is not a forge/);

    const apart = hamlet();
    const anvil = apart.smithy.work.find((w) => w.kind === 'anvil')!;
    anvil.stand = { ...anvil.stand, x: anvil.stand.x - 1 };
    expect(validateVillagePlan(apart.world, apart.plan).join('\n')).toMatch(/smithy#2 work\[\d\] \(anvil\): stand at \S+ is not beside its block/);
  });

  it('wants a chest where the plan says the store is', () => {
    const { world, plan, farm } = hamlet();
    const s = farm.storage!;
    for (const [dx, dz] of [[1, 0], [-1, 0], [0, 1], [0, -1]] as const) if (world.get(s.x + dx, s.y, s.z + dz) === B.chest) world.setRaw(s.x + dx, s.y, s.z + dz, B.air);
    expect(validateVillagePlan(world, plan).join('\n')).toMatch(/farm#0: no chest beside storage at/);
  });

  it('wants a bed named by its foot, whole, and beside where its sleeper stands', () => {
    const byHead = hamlet();
    const bed = byHead.farm.beds[0]!;
    // The bed lies along the back wall with its head toward local right, which for a north front is -x.
    const head = { x: bed.block.x - 1, y: bed.block.y, z: bed.block.z };
    bed.block = head;
    expect(validateVillagePlan(byHead.world, byHead.plan).join('\n')).toMatch(/farm#0: bed\[0\] at \S+ is the head of the bed, not the foot/);

    const halved = hamlet();
    const foot = halved.farm.beds[0]!.block;
    put(halved.world, { x: foot.x - 1, y: foot.y, z: foot.z }, B.air);
    expect(validateVillagePlan(halved.world, halved.plan).join('\n')).toMatch(/farm#0: bed\[0\] at \S+ has no head end beyond its foot/);

    const across = hamlet();
    const far = across.farm.beds[0]!;
    far.stand = { ...far.stand, z: far.stand.z - 2 };
    expect(validateVillagePlan(across.world, across.plan).join('\n')).toMatch(/farm#0: bed\[0\] stand at \S+ is not beside its bed/);
  });

  it('wants a field the right way round and owned by a farm', () => {
    const turned = hamlet();
    const f = turned.plan.fields[0]!;
    [f.z0, f.z1] = [f.z1, f.z0];
    expect(validateVillagePlan(turned.world, turned.plan)).toEqual(['field#0: rectangle 10,45..15,40 is inside out']);

    const tenant = hamlet();
    tenant.plan.fields[0]!.owner = tenant.bakery.id;
    expect(validateVillagePlan(tenant.world, tenant.plan)).toEqual(['field#0: owner bakery#1 is not a farm']);
  });

  it('wants a roof over every column of a building, a door named by its lower half, and the doorstep before it', () => {
    const open = hamlet();
    const b = open.bakery;
    for (let y = FEET + 1; y < open.world.sy; y++) open.world.setRaw(b.x0 + 2, y, b.z0 + 3, B.air);
    expect(validateVillagePlan(open.world, open.plan).join('\n')).toMatch(new RegExp(`bakery#1: no roof over ${b.x0 + 2},${b.z0 + 3}`));

    const upper = hamlet();
    upper.farm.door = { ...upper.farm.door!, y: FEET + 1 };
    expect(validateVillagePlan(upper.world, upper.plan).join('\n')).toMatch(/farm#0: door at \S+ is the upper half/);

    const aside = hamlet();
    aside.farm.entry = { ...aside.farm.entry, x: aside.farm.entry.x + 1 };
    expect(validateVillagePlan(aside.world, aside.plan).join('\n')).toMatch(/farm#0: entry at \S+ is not beside the door/);
  });
});

describe('the world layer', () => {
  it('imports nothing from a layer above it', () => {
    // The plan's types live here, not with the other contracts in src/sim, so that generation need not reach up for them.
    const sources = import.meta.glob('./**/*.ts', { query: '?raw', import: 'default', eager: true }) as Record<string, string>;
    expect(Object.keys(sources).length).toBeGreaterThan(15);
    const offenders: string[] = [];
    for (const [file, text] of Object.entries(sources)) {
      const folders = file.split('/').length - 2;
      for (const m of text.matchAll(/\b(?:from|import)\s+'(\.{1,2}\/[^']*)'/g)) {
        const segments = (m[1] as string).split('/');
        let depth = folders;
        let k = 0;
        for (; k < segments.length && (segments[k] === '.' || segments[k] === '..'); k++) if (segments[k] === '..') depth--;
        // Out of src/world altogether: only src/core lies below.
        if (depth < 0 && segments[k] !== 'core') offenders.push(`${file} imports ${m[1]}`);
      }
    }
    expect(offenders).toEqual([]);
  });
});
