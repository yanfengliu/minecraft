import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { MeshJob, MeshResult } from '../mesh/job';
import { B } from '../world/blocks';
import { World } from '../world/world';
import { MeshPool } from './meshPool';

/** Stands in for a mesh worker: keeps what it was sent, and answers or fails when the test says so. */
class FakeWorker {
  static all: FakeWorker[] = [];
  onmessage: ((e: MessageEvent<MeshResult>) => void) | null = null;
  onerror: ((e: ErrorEvent) => void) | null = null;
  onmessageerror: ((e: MessageEvent) => void) | null = null;
  jobs: MeshJob[] = [];
  terminated = false;

  constructor() {
    FakeWorker.all.push(this);
  }

  postMessage(job: MeshJob): void {
    this.jobs.push(job);
  }

  terminate(): void {
    this.terminated = true;
  }

  /** Answer the oldest job with an empty mesh. */
  answer(): void {
    const job = this.jobs.shift();
    if (!job) throw new Error('no job to answer');
    const result: MeshResult = { id: job.id, section: job.section, states: job.states, light: job.light, data: new Uint32Array(0), opaque: 0, cutout: 0, translucent: 0, minY: 0, maxY: 0 };
    this.onmessage?.({ data: result } as MessageEvent<MeshResult>);
  }

  /** Throw away the oldest job, as a worker whose code threw on it does, and report the error. */
  crash(message: string): void {
    this.jobs.shift();
    this.onerror?.({ message, filename: 'mesh.worker.js', lineno: 12 } as ErrorEvent);
  }
}

/** A world whose eight sections all have something to mesh. */
function world(): World {
  const w = new World(64, 64, 64, 0);
  for (let i = 0; i < 8; i++) w.setRaw((i & 1) * 32 + 5, ((i >> 1) & 1) * 32 + 5, ((i >> 2) & 1) * 32 + 5, B.stone);
  return w;
}

/** Let every worker that can still answer do so until nothing is left in flight with them. */
function drain(): void {
  for (let guard = 0; guard < 1000; guard++) {
    const busy = FakeWorker.all.find((w) => !w.terminated && w.jobs.length > 0);
    if (!busy) return;
    busy.answer();
  }
  throw new Error('the pool never ran out of work');
}

describe('the mesh pool', () => {
  beforeEach(() => {
    FakeWorker.all = [];
    vi.stubGlobal('Worker', FakeWorker);
  });
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('meshes every section and reports nothing wrong when the workers behave', () => {
    const meshed: number[] = [];
    const pool = new MeshPool(world(), (section) => meshed.push(section), 2);
    pool.queueAll();
    pool.update(0, 0, 0);
    expect(FakeWorker.all.map((w) => w.jobs.length)).toEqual([1, 1]);
    drain();
    expect(pool.pending).toBe(0);
    expect(meshed.sort((a, b) => a - b)).toEqual([0, 1, 2, 3, 4, 5, 6, 7]);
    expect(pool.completed).toBe(8);
    expect(pool.error).toBeNull();
  });

  it('lets go of the section a failing worker held, says what happened, and finishes the rest', () => {
    // Without this the section stayed in flight for ever and the loading screen, which waits for
    // nothing to be pending, never went away.
    const heard: Error[] = [];
    const pool = new MeshPool(world(), () => undefined, 2);
    pool.onError = (e) => heard.push(e);
    pool.queueAll();
    pool.update(0, 0, 0);
    const [first, second] = FakeWorker.all as [FakeWorker, FakeWorker];
    // Both have started; then one throws on a section.
    first.answer();
    second.answer();
    const lost = first.jobs[0]!.section;
    first.crash('boom');
    expect(pool.error?.message).toContain('boom');
    expect(pool.error?.message).toContain(`section ${lost}`);
    expect(pool.error?.message).toContain('mesh.worker.js:12');
    expect(heard).toEqual([pool.error]);
    // The worker threw but is alive: it is given more work, and the pool runs dry.
    expect(first.terminated).toBe(false);
    drain();
    expect(pool.pending).toBe(0);
    expect(pool.failed).toBe(1);
    expect(pool.completed).toBe(7);
  });

  it('retires a worker that never started and goes on with the others', () => {
    const pool = new MeshPool(world(), () => undefined, 2);
    pool.queueAll();
    pool.update(0, 0, 0);
    const [first, second] = FakeWorker.all as [FakeWorker, FakeWorker];
    // A script that will not load fires a bare event: no message, no file.
    first.jobs.shift();
    first.onerror?.({} as ErrorEvent);
    expect(first.terminated).toBe(true);
    expect(pool.error?.message).toContain('could not start');
    drain();
    expect(first.jobs.length).toBe(0);
    expect(second.terminated).toBe(false);
    expect(pool.pending).toBe(0);
    // The section the dead worker had been handed was never tried: the other one meshed it.
    expect(pool.completed).toBe(8);
    expect(pool.failed).toBe(0);
  });

  it('says so when no worker could start at all', () => {
    const heard: string[] = [];
    const pool = new MeshPool(world(), () => undefined, 2);
    pool.onError = (e) => heard.push(e.message);
    pool.queueAll();
    pool.update(0, 0, 0);
    for (const w of FakeWorker.all) {
      w.jobs.shift();
      w.onerror?.({} as ErrorEvent);
    }
    expect(heard.length).toBe(2);
    expect(heard[1]).toContain('no mesh worker is left');
    // Nothing can mesh what is still queued; the caller is told by `error`, not by `pending` reaching zero.
    expect(pool.pending).toBeGreaterThan(0);
    expect(pool.error).not.toBeNull();
    // A late event from a worker already retired changes nothing.
    FakeWorker.all[0]!.onerror?.({} as ErrorEvent);
    expect(heard.length).toBe(2);
  });

  it('meshes again a section that was edited while its job was failing', () => {
    const w = world();
    const pool = new MeshPool(w, () => undefined, 1);
    pool.queueAll();
    pool.update(0, 0, 0);
    const worker = FakeWorker.all[0]!;
    worker.answer();
    const lost = worker.jobs[0]!.section;
    // The section changes while the job that will fail is in flight.
    w.dirty.add(lost);
    pool.update(0, 0, 0);
    worker.crash('boom');
    drain();
    expect(pool.pending).toBe(0);
    // Seven sections meshed once, and the lost one again after its edit.
    expect(pool.completed).toBe(8);
  });
});
