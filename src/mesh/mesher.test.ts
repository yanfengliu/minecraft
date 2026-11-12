import { describe, expect, it } from 'vitest';
import { B, waterState } from '../world/blocks';
import { LightEngine } from '../world/light';
import { World } from '../world/world';
import { allocSectionCopy, extractSection, sectionIsHidden } from './extract';
import { type MeshOutput, meshSection } from './mesher';

function meshOf(build: (w: World) => void): MeshOutput {
  const w = new World(64, 64, 64, 0);
  w.trackDirty = false;
  build(w);
  w.recomputeHeightmap();
  new LightEngine(w).computeAll();
  const copy = allocSectionCopy();
  extractSection(w, 0, 0, 0, copy);
  return meshSection({ ...copy, ox: 0, oy: 0, oz: 0 });
}

interface Vertex { x: number; y: number; z: number; ao: number; normal: number; tile: number; sky: number; block: number; water: boolean }

function vertices(m: MeshOutput): Vertex[] {
  const out: Vertex[] = [];
  for (let i = 0; i < m.data.length; i += 2) {
    const w0 = m.data[i]!;
    const w1 = m.data[i + 1]!;
    out.push({
      x: (w0 & 1023) / 16, y: ((w0 >>> 10) & 1023) / 16, z: ((w0 >>> 20) & 1023) / 16, ao: w0 >>> 30,
      normal: w1 & 7, tile: (w1 >>> 3) & 1023, sky: (w1 >>> 13) & 31, block: (w1 >>> 18) & 31, water: w1 >>> 31 === 1,
    });
  }
  return out;
}

/** The mesh's quads, each as its four vertices. */
function quads(m: MeshOutput): Vertex[][] {
  const v = vertices(m);
  const out: Vertex[][] = [];
  for (let q = 0; q < v.length; q += 4) out.push(v.slice(q, q + 4));
  return out;
}

describe('mesher', () => {
  it('emits six faces for a lone cube and culls the face two cubes share', () => {
    expect(meshOf((w) => w.setRaw(5, 5, 5, B.stone)).opaque).toBe(6);
    const two = meshOf((w) => { w.setRaw(5, 5, 5, B.stone); w.setRaw(6, 5, 5, B.stone); });
    expect(two.opaque).toBe(10);
    expect(two.cutout + two.translucent).toBe(0);
    expect(two.data.length).toBe(10 * 8);
  });

  it('winds every cube face counter-clockwise seen from outside', () => {
    const m = meshOf((w) => w.setRaw(5, 5, 5, B.stone));
    const v = vertices(m);
    const normals = [[1, 0, 0], [-1, 0, 0], [0, 1, 0], [0, -1, 0], [0, 0, 1], [0, 0, -1]];
    for (let q = 0; q < 6; q++) {
      const [a, b, c] = [v[q * 4]!, v[q * 4 + 1]!, v[q * 4 + 2]!];
      const e1 = [b.x - a.x, b.y - a.y, b.z - a.z];
      const e2 = [c.x - a.x, c.y - a.y, c.z - a.z];
      const cross = [e1[1]! * e2[2]! - e1[2]! * e2[1]!, e1[2]! * e2[0]! - e1[0]! * e2[2]!, e1[0]! * e2[1]! - e1[1]! * e2[0]!];
      const n = normals[a.normal]!;
      expect(cross[0]! * n[0]! + cross[1]! * n[1]! + cross[2]! * n[2]!).toBeGreaterThan(0);
    }
  });

  it('darkens the corners of a floor where walls meet and lights open ground fully', () => {
    const m = meshOf((w) => {
      for (let z = 0; z < 12; z++) for (let x = 0; x < 12; x++) w.setRaw(x, 4, z, B.stone);
      w.setRaw(6, 5, 6, B.stone);
    });
    const top = vertices(m).filter((v) => v.normal === 2 && v.y === 5);
    expect(top.some((v) => v.ao < 3)).toBe(true);
    expect(top.some((v) => v.ao === 3)).toBe(true);
    const open = top.find((v) => v.x === 2 && v.z === 2)!;
    expect(open.sky).toBe(30);
    expect(open.block).toBe(0);
  });

  it('carries torch light on nearby faces', () => {
    const m = meshOf((w) => {
      for (let z = 0; z < 12; z++) for (let x = 0; x < 12; x++) w.setRaw(x, 4, z, B.stone);
      w.setRaw(6, 5, 6, B.torch);
    });
    const near = vertices(m).filter((v) => v.normal === 2 && v.y === 5 && Math.abs(v.x - 6.5) < 1 && Math.abs(v.z - 6.5) < 1);
    expect(Math.max(...near.map((v) => v.block))).toBeGreaterThan(20);
    expect(m.cutout).toBeGreaterThan(0);
  });

  it('lights a wall beside a path, a slab or a stair as it would beside open ground', () => {
    // A path, slab or stair is light-tight: its cell holds no light. A wall face that looks into such
    // a cell, or has one at its foot, once averaged that darkness in and came out half black.
    const eastFace = (build: (w: World) => void): Vertex[] => {
      const m = meshOf((w) => {
        for (let z = 0; z < 12; z++) for (let x = 0; x < 12; x++) w.setRaw(x, 4, z, B.stone);
        w.setRaw(6, 5, 6, B.stone);
        build(w);
      });
      // The wall block's east face: the one quad on that plane above the ground.
      const faces = quads(m).filter((q) => q.every((v) => v.normal === 0 && v.x === 7 && v.y >= 5));
      expect(faces.length).toBe(1);
      return faces[0]!;
    };
    expect(eastFace(() => undefined).map((v) => v.sky)).toEqual([30, 30, 30, 30]);
    const beside: Record<string, (w: World) => void> = {
      'a path at its foot': (w) => { for (let z = 5; z <= 7; z++) w.setRaw(7, 4, z, B.path); },
      'a slab against it': (w) => w.setRaw(7, 5, 6, B.oak_slab),
      'a row of slabs along it': (w) => { for (let z = 5; z <= 7; z++) w.setRaw(7, 5, z, B.oak_slab); },
      // Facing east: the low half of the stair is the one against the wall, so the wall still shows above it.
      'a stair against it': (w) => w.setRaw(7, 5, 6, B.cobble_stairs + 1),
    };
    for (const [what, build] of Object.entries(beside)) {
      expect(eastFace(build).map((v) => v.sky), `a wall with ${what}`).toEqual([30, 30, 30, 30]);
    }
    // Torch light is carried the same way: a lamp by a wall lights it no less for a path running past.
    const torchlit = (build: (w: World) => void): number[] => eastFace((w) => { w.setRaw(8, 5, 6, B.torch); build(w); }).map((v) => v.block);
    expect(torchlit(beside['a path at its foot']!)).toEqual(torchlit(() => undefined));
  });

  it('lights water under a raised slab from the air beside the slab', () => {
    const m = meshOf((w) => {
      for (let z = 3; z <= 7; z++) for (let x = 3; x <= 7; x++) { w.setRaw(x, 3, z, B.stone); w.setRaw(x, 4, z, B.water_source); }
      // The upper half of the cell: half a block of air between the slab and the water, which is in plain view.
      w.setRaw(5, 5, 5, B.oak_slab + 1);
    });
    const under = quads(m).filter((q) => q.every((p) => p.water && p.normal === 2 && p.x >= 5 && p.x <= 6 && p.z >= 5 && p.z <= 6));
    expect(under.length).toBe(1);
    expect(under[0]!.map((p) => p.sky)).toEqual([30, 30, 30, 30]);
  });

  it('sorts geometry into opaque, cutout and translucent runs', () => {
    const m = meshOf((w) => {
      w.setRaw(3, 3, 3, B.stone);
      w.setRaw(8, 3, 3, B.oak_leaves);
      w.setRaw(12, 3, 3, B.window);
      w.setRaw(16, 3, 3, B.tall_grass);
    });
    expect(m.opaque).toBe(6);
    expect(m.cutout).toBe(6 + 2);
    expect(m.translucent).toBe(6);
  });

  it('keeps one shared plane between touching leaves and none between touching glass', () => {
    const leaves = meshOf((w) => { w.setRaw(5, 5, 5, B.oak_leaves); w.setRaw(6, 5, 5, B.oak_leaves); });
    expect(leaves.cutout).toBe(11);
    const glass = meshOf((w) => { w.setRaw(5, 5, 5, B.window); w.setRaw(6, 5, 5, B.window); });
    expect(glass.translucent).toBe(10);
  });

  it('meshes a slab as a half-height box and hides what a full neighbour covers', () => {
    const slab = meshOf((w) => w.setRaw(5, 5, 5, B.oak_slab));
    expect(slab.opaque).toBe(6);
    expect(slab.maxY).toBe(5.5);
    const onStone = meshOf((w) => { w.setRaw(5, 4, 5, B.stone); w.setRaw(5, 5, 5, B.oak_slab); });
    // Stone keeps its top (the slab covers it fully, so that face goes) and the slab loses its bottom.
    expect(onStone.opaque).toBe(5 + 5);
    const row = meshOf((w) => { w.setRaw(5, 5, 5, B.oak_slab); w.setRaw(6, 5, 5, B.oak_slab); });
    expect(row.opaque).toBe(10);
  });

  it('gives a fence arms toward its neighbours', () => {
    const alone = meshOf((w) => w.setRaw(5, 5, 5, B.fence));
    const joined = meshOf((w) => { w.setRaw(5, 5, 5, B.fence); w.setRaw(6, 5, 5, B.fence); });
    expect(alone.opaque).toBe(6);
    expect(joined.opaque).toBeGreaterThan(2 * 6 + 2 * 2 * 4);
  });

  it('lowers the surface of open water and fills it under more water', () => {
    const pool = meshOf((w) => {
      for (let z = 2; z < 8; z++) for (let x = 2; x < 8; x++) { w.setRaw(x, 3, z, B.stone); w.setRaw(x, 4, z, B.water_source); }
    });
    const v = vertices(pool).filter((q) => q.water);
    expect(v.length).toBeGreaterThan(0);
    const tops = v.filter((q) => q.normal === 2);
    // Interior corners sit just under the top of the cell; the edges slope toward the open air around the pool.
    expect(Math.max(...tops.map((q) => q.y))).toBeCloseTo(4 + 15 / 16, 5);
    expect(Math.min(...tops.map((q) => q.y))).toBeLessThan(4.5);
    const deep = meshOf((w) => { w.setRaw(5, 4, 5, B.water_source); w.setRaw(5, 5, 5, B.water_source); });
    const lower = vertices(deep).filter((q) => q.water && q.normal !== 2 && q.normal !== 3 && q.y > 4 && q.y <= 5);
    expect(Math.max(...lower.map((q) => q.y))).toBe(5);
  });

  it('marks flowing water with its direction', () => {
    // The translucent run follows the opaque and cutout runs; read the first water vertex's second word.
    const firstWater = (m: MeshOutput): number => m.data[(m.opaque + m.cutout) * 8 + 1]!;
    const river = firstWater(meshOf((w) => { w.setRaw(5, 3, 5, B.stone); w.setRaw(5, 4, 5, B.river + 3); }));
    expect(river >>> 31).toBe(1);
    expect((river >>> 26) & 1).toBe(1);
    expect((river >>> 23) & 7).toBe(3);
    // Two finite cells at the same level, walled in: nothing to flow toward.
    const still = firstWater(meshOf((w) => {
      for (let z = 4; z <= 6; z++) for (let x = 4; x <= 7; x++) { w.setRaw(x, 3, z, B.stone); w.setRaw(x, 4, z, B.stone); }
      w.setRaw(5, 4, 5, waterState(8));
      w.setRaw(6, 4, 5, waterState(8));
    }));
    expect((still >>> 26) & 1).toBe(0);
    // A finite cell beside a lower one flows toward it (+x is direction 0).
    const sloped = firstWater(meshOf((w) => {
      for (let z = 4; z <= 6; z++) for (let x = 4; x <= 7; x++) { w.setRaw(x, 3, z, B.stone); w.setRaw(x, 4, z, B.stone); }
      w.setRaw(5, 4, 5, waterState(12));
      w.setRaw(6, 4, 5, waterState(4));
    }));
    expect((sloped >>> 26) & 1).toBe(1);
    expect((sloped >>> 23) & 7).toBe(0);
  });

  it('skips sections that cannot show anything', () => {
    const w = new World(96, 96, 96, 0);
    expect(sectionIsHidden(w, 1, 1, 1)).toBe(true);
    for (let i = 0; i < w.sectionCount; i++) w.uniform[i] = B.stone;
    expect(sectionIsHidden(w, 1, 1, 1)).toBe(true);
    expect(sectionIsHidden(w, 1, 2, 1)).toBe(false);
    w.set(40, 40, 40, B.air);
    expect(sectionIsHidden(w, 1, 1, 1)).toBe(false);
  });
});
