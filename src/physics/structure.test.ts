import { describe, expect, it } from 'vitest';
import { Rng } from '../core/rng';
import { B, IS_LEAVES, IS_LOG } from '../world/blocks';
import { growTree } from '../world/gen/trees';
import { World, createFlatWorld } from '../world/world';
import { Structure, type DetachedCell, type StructureHost, type StructureOptions } from './structure';
import type { PhysicsEvent } from './types';

const GROUND = 31;

interface Rig {
  structure: Structure;
  pieces: { cells: DetachedCell[]; tree: boolean }[];
  drops: { state: number; x: number; y: number; z: number }[];
  events: PhysicsEvent[];
}

function rig(world: World, opts: StructureOptions = {}): Rig {
  const pieces: Rig['pieces'] = [];
  const drops: Rig['drops'] = [];
  const events: PhysicsEvent[] = [];
  const host: StructureHost = {
    emit: (e) => events.push(e),
    detach: (cells, tree) => pieces.push({ cells, tree }),
    drop: (state, x, y, z) => drops.push({ state, x, y, z }),
  };
  const structure = new Structure(world, host, opts);
  world.changed.on((c) => structure.onBlockChanged(c.x, c.y, c.z, c.old, c.state));
  return { structure, pieces, drops, events };
}

/** Every cell above the ground that is not air, as "x,y,z" -> state. */
function above(world: World): Map<string, number> {
  const out = new Map<string, number>();
  for (let y = GROUND + 1; y < world.sy; y++) {
    for (let z = 0; z < world.sz; z++) {
      for (let x = 0; x < world.sx; x++) {
        const s = world.get(x, y, z);
        if (s !== B.air) out.set(`${x},${y},${z}`, s);
      }
    }
  }
  return out;
}

function groundIntact(world: World): boolean {
  for (let z = 0; z < world.sz; z++) for (let x = 0; x < world.sx; x++) if (world.get(x, GROUND, z) !== B.grass) return false;
  return true;
}

/** A plank hut with a door gap, a window, a flat thatch roof and a torch on the wall: interior 5 x 4, walls 3 high. */
function hut(world: World, x0: number, z0: number): void {
  for (let y = GROUND + 1; y <= GROUND + 3; y++) {
    for (let z = z0; z <= z0 + 5; z++) {
      for (let x = x0; x <= x0 + 6; x++) {
        const wall = x === x0 || x === x0 + 6 || z === z0 || z === z0 + 5;
        if (wall) world.setRaw(x, y, z, B.oak_planks);
      }
    }
  }
  for (let z = z0; z <= z0 + 5; z++) for (let x = x0; x <= x0 + 6; x++) world.setRaw(x, GROUND + 4, z, B.thatch);
  world.setRaw(x0 + 3, GROUND + 1, z0, B.air);
  world.setRaw(x0 + 3, GROUND + 2, z0, B.air);
  world.setRaw(x0, GROUND + 2, z0 + 2, B.window);
  world.setRaw(x0 + 1, GROUND + 2, z0 + 3, B.wall_torch + 1);
}

describe('structure', () => {
  it('detaches the trunk and crown of a tree cut at the base, and nothing else', () => {
    for (const species of ['oak', 'birch', 'pine'] as const) {
      const world = createFlatWorld(64, 64, GROUND, 96);
      const r = rig(world);
      expect(growTree(world, 30, GROUND + 1, 30, species, new Rng(species.length * 77), true)).toBe(true);
      const tree = above(world);
      const logs = [...tree.values()].filter((s) => IS_LOG[s]).length;
      const leaves = [...tree.values()].filter((s) => IS_LEAVES[s]).length;
      expect(logs).toBeGreaterThan(3);
      expect(leaves).toBeGreaterThan(10);

      world.set(30, GROUND + 1, 30, B.air);
      r.structure.step();
      expect(r.pieces).toHaveLength(1);
      const piece = r.pieces[0] as Rig['pieces'][number];
      expect(piece.tree).toBe(true);
      // Every block of the tree left the grid: as part of the body, or as a leaf beyond the body's budget.
      expect(above(world).size).toBe(0);
      expect(groundIntact(world)).toBe(true);
      const bodyLogs = piece.cells.filter((c) => IS_LOG[c.state]).length;
      const bodyLeaves = piece.cells.filter((c) => IS_LEAVES[c.state]).length;
      const burst = r.events.filter((e) => e.type === 'burst').length;
      expect(bodyLogs).toBe(logs - 1);
      expect(bodyLeaves + burst).toBe(leaves);
      expect(bodyLeaves).toBeLessThanOrEqual(96);
      for (const c of piece.cells) expect(tree.get(`${c.x},${c.y},${c.z}`)).toBe(c.state);
      expect(r.events.filter((e) => e.type === 'collapse')).toHaveLength(1);
      console.log(`structure tree (${species}): ${logs} logs, ${leaves} leaves -> body of ${piece.cells.length} cells, ${burst} leaves burst`);
    }
  });

  it('fells one tree of a pair with touching crowns and leaves the other standing', () => {
    const world = createFlatWorld(64, 64, GROUND, 96);
    const r = rig(world);
    growTree(world, 26, GROUND + 1, 30, 'oak', new Rng(5), true);
    const first = above(world);
    growTree(world, 30, GROUND + 1, 30, 'oak', new Rng(9), true);
    const both = above(world);
    const secondLogs = [...both.entries()].filter(([k, s]) => IS_LOG[s] && !first.has(k));
    const firstLogs = [...first.values()].filter((s) => IS_LOG[s]).length;
    // The crowns really do touch: some leaf of one is face to face with a leaf of the other.
    expect(both.size).toBeLessThan(first.size + 200);

    const yielded = r.structure.fellTree(26, GROUND + 3, 30);
    expect(yielded).toBe(firstLogs);
    r.structure.step();
    expect(r.pieces).toHaveLength(1);
    const left = above(world);
    // The standing tree keeps every log...
    for (const [k, s] of secondLogs) expect(left.get(k)).toBe(s);
    expect([...left.values()].filter((s) => IS_LOG[s])).toHaveLength(secondLogs.length);
    // ...and every leaf that touches one of them, even where the crowns ran together.
    let hugging = 0;
    for (const [k] of secondLogs) {
      const [lx, ly, lz] = k.split(',').map(Number) as [number, number, number];
      for (let dy = -1; dy <= 1; dy++) for (let dz = -1; dz <= 1; dz++) for (let dx = -1; dx <= 1; dx++) {
        const nk = `${lx + dx},${ly + dy},${lz + dz}`;
        const s = both.get(nk);
        if (s === undefined || !IS_LEAVES[s]) continue;
        hugging++;
        expect(left.get(nk)).toBe(s);
      }
    }
    expect(hugging).toBeGreaterThan(8);
    const leavesLeft = [...left.values()].filter((s) => IS_LEAVES[s]).length;
    expect(leavesLeft).toBeGreaterThan(20);
    console.log(`structure pair: felled ${yielded} logs; the neighbour keeps ${secondLogs.length} logs and ${leavesLeft} leaves (${hugging} touching its trunk)`);
    // The felled one is gone from its own column.
    for (let y = GROUND + 1; y < GROUND + 12; y++) expect(world.get(26, y, 30)).toBe(B.air);
    expect(r.structure.fellTree(10, GROUND, 10)).toBe(0);
  });

  it('leaves a house standing when one wall block is removed', () => {
    const world = createFlatWorld(64, 64, GROUND);
    hut(world, 20, 20);
    const r = rig(world);
    const before = above(world);
    world.set(22, GROUND + 2, 25, B.air);
    world.set(26, GROUND + 1, 22, B.air);
    r.structure.step();
    expect(r.pieces).toHaveLength(0);
    expect(r.drops).toHaveLength(0);
    expect(above(world).size).toBe(before.size - 2);
    // Opening a doorway in a house built on sand is no different: sand under it is ground.
    for (let z = 18; z <= 28; z++) for (let x = 18; x <= 30; x++) for (let y = GROUND - 2; y <= GROUND; y++) world.setRaw(x, y, z, B.sand);
    world.set(24, GROUND + 1, 25, B.air);
    r.structure.step();
    expect(r.pieces).toHaveLength(0);
  });

  it('drops a slab when its last support goes, in chunks, with what was fixed to it', () => {
    const world = createFlatWorld(64, 64, GROUND);
    // Connectivity alone: with the cantilever rule on, the slab's far corners
    // would rightly break off as soon as the first pillars went (next test).
    const r = rig(world, { pieceSize: 32, cantilever: false });
    // A 10 x 8 stone slab on four pillars, a torch standing on it.
    for (let z = 20; z <= 27; z++) for (let x = 20; x <= 29; x++) world.setRaw(x, GROUND + 4, z, B.stone_bricks);
    const pillars = [[20, 20], [29, 20], [20, 27], [29, 27]] as const;
    for (const [x, z] of pillars) for (let y = GROUND + 1; y <= GROUND + 3; y++) world.setRaw(x, y, z, B.cobble);
    world.setRaw(25, GROUND + 5, 23, B.torch);
    for (let i = 0; i < 3; i++) {
      const [x, z] = pillars[i] as readonly [number, number];
      world.set(x, GROUND + 1, z, B.air);
      r.structure.step();
    }
    // Three pillars cut: their stubs hang from the slab, which still stands on the fourth.
    expect(r.pieces).toHaveLength(0);
    expect(world.get(25, GROUND + 4, 23)).toBe(B.stone_bricks);

    world.set(29, GROUND + 1, 27, B.air);
    r.structure.step();
    const cells = r.pieces.flatMap((p) => p.cells);
    // 80 slab blocks and the two blocks left of each pillar.
    expect(cells).toHaveLength(80 + 8);
    expect(r.pieces.length).toBeGreaterThanOrEqual(3);
    for (const p of r.pieces) {
      expect(p.tree).toBe(false);
      expect(p.cells.length).toBeLessThanOrEqual(32);
    }
    expect(new Set(cells.map((c) => `${c.x},${c.y},${c.z}`)).size).toBe(88);
    expect(above(world).size).toBe(0);
    expect(r.drops).toEqual([{ state: B.torch, x: 25.5, y: GROUND + 5.5, z: 23.5 }]);
    expect(groundIntact(world)).toBe(true);
    console.log(`structure slab: 88 blocks came away as ${r.pieces.length} pieces of ${r.pieces.map((p) => p.cells.length).join(', ')}`);
  });

  it('breaks off what reaches past its span once its far support is gone', () => {
    const world = createFlatWorld(64, 64, GROUND);
    const r = rig(world);
    // A plank beam ten long from the top of a brick pier to a post at its far end. Wood spans six.
    for (let y = GROUND + 1; y <= GROUND + 4; y++) world.setRaw(20, y, 30, B.bricks);
    for (let x = 21; x <= 30; x++) world.setRaw(x, GROUND + 4, 30, B.oak_planks);
    for (let y = GROUND + 1; y <= GROUND + 3; y++) world.setRaw(30, y, 30, B.oak_planks);
    // Taking a block from the pier's side changes nothing the beam relies on.
    world.setRaw(19, GROUND + 1, 30, B.bricks);
    world.set(19, GROUND + 1, 30, B.air);
    r.structure.step();
    expect(r.pieces).toHaveLength(0);

    world.set(30, GROUND + 1, 30, B.air);
    r.structure.step();
    const gone = r.pieces.flatMap((p) => p.cells).map((c) => `${c.x},${c.y}`).sort();
    // The beam holds for six blocks out from the pier (x = 21..26); the rest goes, with the post stub hanging from it.
    for (let x = 21; x <= 26; x++) expect(world.get(x, GROUND + 4, 30)).toBe(B.oak_planks);
    for (let x = 27; x <= 30; x++) expect(world.get(x, GROUND + 4, 30)).toBe(B.air);
    expect(gone).toHaveLength(6);
    console.log(`structure cantilever: ${gone.length} blocks failed beyond the span: ${gone.join(' ')}`);

    // With the rule off, the same beam stays whole.
    const world2 = createFlatWorld(64, 64, GROUND);
    const r2 = rig(world2, { cantilever: false });
    for (let y = GROUND + 1; y <= GROUND + 4; y++) world2.setRaw(20, y, 30, B.bricks);
    for (let x = 21; x <= 30; x++) world2.setRaw(x, GROUND + 4, 30, B.oak_planks);
    world2.setRaw(30, GROUND + 3, 30, B.oak_planks);
    world2.set(30, GROUND + 3, 30, B.air);
    r2.structure.step();
    expect(r2.pieces).toHaveLength(0);
  });

  it('finds nothing to do after an ordinary dig, in well under 0.3 ms', () => {
    const world = createFlatWorld(64, 64, GROUND);
    const r = rig(world);
    const rng = new Rng(42);
    const times: number[] = [];
    for (let i = 0; i < 400; i++) {
      // Dig down a random shaft and sideways from its foot: surface, soil and deep stone.
      const x = 4 + rng.int(56);
      const z = 4 + rng.int(56);
      const depth = rng.int(20);
      const y = GROUND - depth;
      if (!world.set(x, y, z, B.air)) continue;
      expect(r.structure.pending).toBe(1);
      // Only the check is timed: the dig itself is the caller's world.set.
      const t0 = performance.now();
      r.structure.step();
      times.push(performance.now() - t0);
    }
    expect(r.pieces).toHaveLength(0);
    expect(r.structure.pending).toBe(0);
    // The first hundred digs warm the JIT.
    const measured = times.slice(100).sort((a, b) => a - b);
    const median = measured[measured.length >> 1] as number;
    const p99 = measured[Math.floor(measured.length * 0.99)] as number;
    console.log(`structure dig: check after a dig takes ${(median * 1000).toFixed(1)} us median, ${(p99 * 1000).toFixed(1)} us at the 99th percentile, over ${measured.length} digs`);
    expect(median).toBeLessThan(0.3);
    expect(p99).toBeLessThan(0.3);
  });
});
