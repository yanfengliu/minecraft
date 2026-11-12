import { describe, expect, it } from 'vitest';
import type { AnimState, EntityView } from '../../sim/api';
import { World } from '../../world/world';
import { type FakeGl, fakeGl } from '../fakeGl';
import { EntityRenderer } from './renderer';

/** Floats per instance, as the renderer lays them out: three rows of a 3x4 transform first. */
const STRIDE = 24;
const world = new World(64, 64, 64, 0);

interface Box {
  /** Centre of the box in the world. */
  x: number;
  y: number;
  z: number;
  /** The three rows of its 3x3: each column is one edge of the box. */
  rows: number[][];
  /** y of its lowest corner. */
  low: number;
  volume: number;
}

/** The boxes of the last upload a renderer made. */
function uploaded(fake: FakeGl): Box[] {
  const calls = fake.callsTo('bufferSubData');
  const [, , data, from, length] = calls[calls.length - 1]!.args as [number, number, Float32Array, number, number];
  const out: Box[] = [];
  for (let o = from; o < from + length; o += STRIDE) {
    const rows = [0, 4, 8].map((r) => [data[o + r]!, data[o + r + 1]!, data[o + r + 2]!]);
    const edge = (c: number): number => Math.hypot(rows[0]![c]!, rows[1]![c]!, rows[2]![c]!);
    const y = data[o + 7]!;
    out.push({
      x: data[o + 3]!, y, z: data[o + 11]!, rows,
      low: y - 0.5 * (Math.abs(rows[1]![0]!) + Math.abs(rows[1]![1]!) + Math.abs(rows[1]![2]!)),
      volume: edge(0) * edge(1) * edge(2),
    });
  }
  return out;
}

const AT = { x: 20.5, y: 30, z: 20.5 };

/** One person drawn alone: the boxes they are made of. The same child's model at whatever size is asked for. */
function figure(anim: AnimState, scale: number): Box[] {
  const fake = fakeGl();
  const r = new EntityRenderer(fake.gl);
  const view: EntityView = { id: 7, kind: 'child', look: 5, role: 0, ...AT, yaw: 0.7, anim, animTime: 1.3, scale, held: -1, bubble: '' };
  r.begin();
  r.addEntity(view, world, 1 / 60);
  r.finish();
  return uploaded(fake);
}

describe('the creature renderer', () => {
  it('poses a small figure as the large one, scaled about where it stands', () => {
    // Sitting lowers the body and sleeping slides it along the bed, by distances that suit a grown
    // figure. Applied unscaled to a child, they sank it into the stool and laid it across the footboard.
    const small = 0.56;
    for (const anim of ['sit', 'sleep', 'dead', 'walk', 'idle'] as const) {
      const big = figure(anim, 1);
      const little = figure(anim, small);
      expect(little.length).toBe(big.length);
      for (let i = 0; i < big.length; i++) {
        const b = big[i]!;
        const l = little[i]!;
        const where = `${anim}, box ${i}`;
        expect(l.x - AT.x, where).toBeCloseTo((b.x - AT.x) * small, 5);
        expect(l.y - AT.y, where).toBeCloseTo((b.y - AT.y) * small, 5);
        expect(l.z - AT.z, where).toBeCloseTo((b.z - AT.z) * small, 5);
        for (let r = 0; r < 3; r++) for (let c = 0; c < 3; c++) expect(l.rows[r]![c]!, where).toBeCloseTo(b.rows[r]![c]! * small, 5);
      }
    }
  });

  it('seats a child on the seat and lays it on the bed, at any size', () => {
    /** Where the figure's weight is: the mean of its boxes' centres, each counted by its volume. */
    const middle = (boxes: Box[]): { x: number; z: number } => {
      const total = boxes.reduce((sum, b) => sum + b.volume, 0);
      return { x: boxes.reduce((sum, b) => sum + b.x * b.volume, 0) / total, z: boxes.reduce((sum, b) => sum + b.z * b.volume, 0) / total };
    };
    const lowest = (boxes: Box[]): number => Math.min(...boxes.map((b) => b.low)) - AT.y;
    // The figure faces this way (see `figure`), and across it is this.
    const ahead = { x: Math.sin(0.7), z: Math.cos(0.7) };
    const along = (b: { x: number; z: number }): number => (b.x - AT.x) * ahead.x + (b.z - AT.z) * ahead.z;
    const across = (b: { x: number; z: number }): number => (b.x - AT.x) * ahead.z - (b.z - AT.z) * ahead.x;
    for (const scale of [1, 0.88, 0.52]) {
      // Seated, the thighs rest on the seat, which is the height the figure is placed at: neither sunk into it nor hovering.
      const seated = lowest(figure('sit', scale));
      expect(seated, `seated at scale ${scale}`).toBeGreaterThan(-0.04);
      expect(seated, `seated at scale ${scale}`).toBeLessThan(0.04);
      // Asleep, it lies on its back with the head pressed a little into the pillow.
      const asleep = figure('sleep', scale);
      expect(lowest(asleep), `asleep at scale ${scale}`).toBeGreaterThan(-0.15 * scale);
      expect(lowest(asleep), `asleep at scale ${scale}`).toBeLessThan(0.01);
      // It lies where the village lays it: feet at the place it was put, by the foot of the bed, and
      // the rest of it from there toward where it faces, which is the pillow. Not the other way about.
      const reach = asleep.map((b) => along(b));
      expect(Math.min(...reach), `asleep at scale ${scale}`).toBeGreaterThan(-0.1 * scale);
      expect(Math.max(...reach), `asleep at scale ${scale}`).toBeGreaterThan(1.3 * scale);
      expect(Math.max(...reach), `asleep at scale ${scale}`).toBeLessThan(1.95 * scale);
      expect(Math.abs(across(middle(asleep))), `asleep at scale ${scale}`).toBeLessThan(0.05);
      // Face up: the eyes, the two smallest boxes, are above the middle of the head, the biggest.
      const bySize = [...asleep].sort((a, b) => a.volume - b.volume);
      const head = bySize[bySize.length - 1]!;
      expect(bySize[0]!.y, `asleep at scale ${scale}`).toBeGreaterThan(head.y);
      expect(bySize[1]!.y, `asleep at scale ${scale}`).toBeGreaterThan(head.y);
    }
  });

  it('uploads the boxes queued, and nothing at all when there are none', () => {
    const fake = fakeGl();
    const r = new EntityRenderer(fake.gl);
    r.begin();
    r.finish();
    // A length of 0 would be read by WebGL as "to the end of the array": the whole of it, every frame.
    expect(fake.callsTo('bufferSubData')).toEqual([]);
    r.begin();
    for (let i = 0; i < 3; i++) r.addBox(i, 1, 2, 0.5, 0.5, 0.5, 0, 0, 0, 1, 1, 1, 1, 1, 0);
    r.finish();
    const sent = fake.callsTo('bufferSubData');
    expect(sent.length).toBe(1);
    expect(sent[0]!.args[4]).toBe(3 * STRIDE);
    expect(uploaded(fake).map((b) => b.x)).toEqual([0, 1, 2]);
    // And none again once the frame holds nothing.
    r.begin();
    r.finish();
    expect(fake.callsTo('bufferSubData').length).toBe(1);
  });

  it('grows its buffer on the GPU when the boxes outgrow it', () => {
    const fake = fakeGl();
    const r = new EntityRenderer(fake.gl);
    const made = fake.callsTo('bufferData').length;
    r.begin();
    for (let i = 0; i < 5000; i++) r.addBox(i, 1, 2, 0.5, 0.5, 0.5, 0, 0, 0, 1, 1, 1, 1, 1, 0);
    r.finish();
    const grown = fake.callsTo('bufferData');
    expect(grown.length).toBe(made + 1);
    expect(grown[grown.length - 1]!.args[1]).toBeGreaterThanOrEqual(5000 * STRIDE * 4);
    expect(fake.callsTo('bufferSubData')[0]!.args[4]).toBe(5000 * STRIDE);
    // Once grown it is not made again.
    r.begin();
    r.addBox(0, 1, 2, 0.5, 0.5, 0.5, 0, 0, 0, 1, 1, 1, 1, 1, 0);
    r.finish();
    expect(fake.callsTo('bufferData').length).toBe(made + 1);
  });
});
