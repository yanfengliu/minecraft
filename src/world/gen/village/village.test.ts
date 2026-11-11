import { describe, expect, it } from 'vitest';
import { type Cell, validateVillagePlan } from '../../../sim/api';
import { IS_LEAVES, IS_LOG } from '../../blocks';
import { standHeight } from '../../walk';
import { generateIsland } from '../island';
import { DEFAULT_ISLAND } from '../terrain';
import { buildVillage } from './index';

// The full island: the village only fits a world large enough to hold its shelf.
const island = generateIsland(DEFAULT_ISLAND, buildVillage);
const { world, plan } = island;

describe('the generated village', () => {
  it('is built, with the buildings and trades the simulation needs', () => {
    expect(plan).not.toBeNull();
    const kinds = new Set(plan!.buildings.map((b) => b.kind));
    for (const k of ['house', 'farm', 'mill', 'bakery', 'tavern', 'smithy', 'carpenter', 'weaver', 'store', 'chapel', 'hall', 'woodcutter', 'guardhouse'] as const) {
      expect(kinds.has(k), `no ${k}`).toBe(true);
    }
    const beds = plan!.buildings.reduce((n, b) => n + b.beds.length, 0);
    console.log(`village: ${plan!.buildings.length} buildings, ${beds} beds, ${plan!.fields.length} fields, ${plan!.pens.length} pens, ${plan!.lamps.length} lamps, dock ${plan!.dock.length}, mine ${plan!.mine ? 'yes' : 'no'}`);
    expect(plan!.buildings.length).toBeGreaterThanOrEqual(20);
    expect(beds).toBeGreaterThanOrEqual(40);
    expect(plan!.fields.length).toBeGreaterThanOrEqual(2);
    expect(plan!.stalls).toHaveLength(4);
  });

  it('matches the blocks in the world', () => {
    expect(validateVillagePlan(world, plan!)).toEqual([]);
  });

  it('can be walked: every place the plan names is reachable on foot from the square', () => {
    const opt = { opensGates: true };
    const p = plan!;
    const key = (x: number, y: number, z: number): number => (y * 1024 + z) * 1024 + x;
    const seen = new Set<number>();
    const queue: number[] = [p.center.x, p.center.y, p.center.z];
    seen.add(key(p.center.x, p.center.y, p.center.z));
    while (queue.length > 0) {
      const z = queue.pop()!;
      const y = queue.pop()!;
      const x = queue.pop()!;
      const here = standHeight(world, x, y, z, opt);
      for (const [dx, dz] of [[1, 0], [-1, 0], [0, 1], [0, -1]] as const) {
        const nx = x + dx;
        const nz = z + dz;
        if (Math.abs(nx - p.center.x) > 150 || Math.abs(nz - p.center.z) > 190) continue;
        for (const ny of [y, y + 1, y - 1]) {
          const h = standHeight(world, nx, ny, nz, opt);
          // A walker steps up or down at most one block.
          if (Number.isNaN(h) || Math.abs(h - here) > 1.01) continue;
          const k = key(nx, ny, nz);
          if (!seen.has(k)) {
            seen.add(k);
            queue.push(nx, ny, nz);
          }
          break;
        }
      }
    }
    const missing: string[] = [];
    const need = (c: Cell, what: string): void => {
      if (!seen.has(key(c.x, c.y, c.z))) missing.push(`${what} at ${c.x},${c.y},${c.z}`);
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
    for (const f of p.fields) need({ x: f.x0, y: f.y + 1, z: f.z0 }, `field ${f.id}`);
    for (const pen of p.pens) { need(pen.outside, `pen ${pen.id} gate`); need({ x: pen.x0, y: pen.y, z: pen.z0 }, `pen ${pen.id}`); }
    expect(missing).toEqual([]);
  });

  it('keeps trees out of the streets and houses', () => {
    let intruders = 0;
    for (const b of plan!.buildings) {
      for (let z = b.z0; z <= b.z1; z++) {
        for (let x = b.x0; x <= b.x1; x++) {
          for (let y = b.floorY; y < b.floorY + 3; y++) {
            const s = world.get(x, y, z);
            if (IS_LOG[s] || IS_LEAVES[s]) intruders++;
          }
        }
      }
    }
    expect(intruders).toBe(0);
  });
});
