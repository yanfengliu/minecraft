// Mesh scheduling on the main thread: drains the world's dirty set, hands the
// nearest stale sections to idle workers, and delivers finished meshes. Only
// one job per section is ever in flight, so results cannot arrive out of order.
//
// A worker can fail: its script may not load, or meshing a section may throw.
// Either way the section it held is let go, so `pending` cannot stick on a job
// that will never come back, and the failure is kept in `error` and passed to
// `onError`. Whoever waits on `pending` must look at `error` as well.

import { type SectionCopy, allocSectionCopy, extractSection, sectionIsHidden } from '../mesh/extract';
import type { MeshJob, MeshResult } from '../mesh/job';
import type { MeshOutput } from '../mesh/mesher';
import type { World } from '../world/world';

export type MeshSink = (section: number, mesh: MeshOutput | null) => void;

/** What a worker's `error` event carries: an ErrorEvent when its code threw, a bare Event when its script would not load. */
interface WorkerFailure {
  message?: string;
  filename?: string;
  lineno?: number;
}

export class MeshPool {
  private readonly world: World;
  private readonly sink: MeshSink;
  private readonly workers: Worker[] = [];
  private readonly idle: Worker[] = [];
  private readonly spare: SectionCopy[] = [];
  /** Sections waiting for a job. */
  private readonly queued = new Set<number>();
  /** Sections with a job in flight; true means it went stale again meanwhile. */
  private readonly flying = new Map<number, boolean>();
  /** The section each busy worker is meshing. */
  private readonly working = new Map<Worker, number>();
  /** Workers that have answered at least once, and so are known to have started. */
  private readonly proven = new Set<Worker>();
  private nextId = 1;
  private camX = 0;
  private camY = 0;
  private camZ = 0;
  /** Jobs completed since the pool was created. */
  completed = 0;
  /** Jobs a worker threw on since the pool was created. */
  failed = 0;
  /**
   * The first failure of a mesh worker, or null while there has been none. A
   * section lost this way keeps whatever mesh it had until it is next edited.
   * Once no worker is left, nothing more can be meshed and `pending` will not
   * reach zero: the message says so.
   */
  error: Error | null = null;
  /** Called with every failure, the first included. */
  onError: ((error: Error) => void) | null = null;

  constructor(world: World, sink: MeshSink, workerCount: number) {
    this.world = world;
    this.sink = sink;
    for (let i = 0; i < workerCount; i++) {
      const w = new Worker(new URL('../workers/mesh.worker.ts', import.meta.url), { type: 'module' });
      w.onmessage = (e: MessageEvent<MeshResult>) => this.finish(w, e.data);
      // The event is left to run its course as well, so the browser still logs the error with its stack.
      w.onerror = (e: ErrorEvent) => this.fail(w, e);
      w.onmessageerror = () => this.fail(w, { message: 'its answer could not be read' });
      this.workers.push(w);
      this.idle.push(w);
    }
  }

  /** Sections still to mesh, counting those in flight. */
  get pending(): number {
    return this.queued.size + this.flying.size;
  }

  /** Mark every section stale (first load). */
  queueAll(): void {
    for (let i = 0; i < this.world.sectionCount; i++) this.queued.add(i);
  }

  /** Take in newly dirty sections and dispatch jobs, nearest to the camera first. Call once per frame. */
  update(camX: number, camY: number, camZ: number): void {
    this.camX = camX;
    this.camY = camY;
    this.camZ = camZ;
    const world = this.world;
    if (world.dirty.size > 0) {
      for (const s of world.dirty) {
        if (this.flying.has(s)) this.flying.set(s, true);
        else this.queued.add(s);
      }
      world.dirty.clear();
    }
    this.dispatch();
  }

  private dispatch(): void {
    const world = this.world;
    const { nsx, nsz } = world;
    while (this.idle.length > 0 && this.queued.size > 0) {
      let best = -1;
      let bestDist = Infinity;
      for (const s of this.queued) {
        const dx = (s % nsx) * 32 + 16 - this.camX;
        // Height counts double: what is level with the eye matters more than what is far above or below.
        const dy = (Math.floor(s / (nsx * nsz)) * 32 + 16 - this.camY) * 2;
        const dz = (Math.floor(s / nsx) % nsz) * 32 + 16 - this.camZ;
        const d = dx * dx + dy * dy + dz * dz;
        if (d < bestDist) {
          bestDist = d;
          best = s;
        }
      }
      this.queued.delete(best);
      const sx = best % nsx;
      const sz = Math.floor(best / nsx) % nsz;
      const sy = Math.floor(best / (nsx * nsz));
      if (sectionIsHidden(world, sx, sy, sz)) {
        this.completed++;
        this.sink(best, null);
        continue;
      }
      const copy = this.spare.pop() ?? allocSectionCopy();
      extractSection(world, sx, sy, sz, copy);
      const job: MeshJob = { id: this.nextId++, section: best, ox: sx * 32, oy: sy * 32, oz: sz * 32, states: copy.states, light: copy.light };
      const worker = this.idle.pop() as Worker;
      this.flying.set(best, false);
      this.working.set(worker, best);
      worker.postMessage(job, [copy.states.buffer, copy.light.buffer]);
    }
  }

  private finish(worker: Worker, result: MeshResult): void {
    this.proven.add(worker);
    this.working.delete(worker);
    this.idle.push(worker);
    this.spare.push({ states: result.states, light: result.light });
    const stale = this.flying.get(result.section) === true;
    this.flying.delete(result.section);
    if (stale) this.queued.add(result.section);
    this.completed++;
    this.sink(result.section, result.data.length > 0 ? result : null);
    // Keep the workers fed between frames, so a full remesh is bounded by them and not by the frame rate.
    this.dispatch();
  }

  /** A worker reported an error: let go of the section it held, record what happened, and carry on with whoever is left. */
  private fail(worker: Worker, event: WorkerFailure): void {
    if (!this.workers.includes(worker)) return;
    const section = this.working.get(worker);
    this.working.delete(worker);
    const started = this.proven.has(worker);
    if (section !== undefined) {
      const stale = this.flying.get(section) === true;
      this.flying.delete(section);
      // A worker that never started did not fail on this section, and another can take it. One that
      // threw while meshing it would throw on the same blocks again: that section waits until it has changed.
      if (!started || stale) this.queued.add(section);
      if (started) this.failed++;
    }
    const where = event.filename ? ` (${event.filename}${event.lineno ? `:${event.lineno}` : ''})` : '';
    let what: string;
    if (started) {
      // It threw on this one section and is still listening: back to work.
      if (!this.idle.includes(worker)) this.idle.push(worker);
      what = `a mesh worker failed${section !== undefined ? ` on section ${section}` : ''}: ${event.message || 'unknown error'}${where}`;
    } else {
      // It never answered, so it never started (its script did not load, or threw before it could listen): no use sending it more.
      worker.terminate();
      this.workers.splice(this.workers.indexOf(worker), 1);
      const at = this.idle.indexOf(worker);
      if (at >= 0) this.idle.splice(at, 1);
      what = `a mesh worker could not start: ${event.message || 'its script did not load'}${where}`;
      if (this.workers.length === 0) what += '; no mesh worker is left, so the world cannot be drawn';
    }
    const error = new Error(what);
    this.error ??= error;
    this.onError?.(error);
    this.dispatch();
  }

  dispose(): void {
    for (const w of this.workers) w.terminate();
    this.workers.length = 0;
    this.idle.length = 0;
    this.working.clear();
  }
}
