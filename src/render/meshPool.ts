// Mesh scheduling on the main thread: drains the world's dirty set, hands the
// nearest stale sections to idle workers, and delivers finished meshes. Only
// one job per section is ever in flight, so results cannot arrive out of order.

import { type SectionCopy, allocSectionCopy, extractSection, sectionIsHidden } from '../mesh/extract';
import type { MeshJob, MeshResult } from '../mesh/job';
import type { MeshOutput } from '../mesh/mesher';
import type { World } from '../world/world';

export type MeshSink = (section: number, mesh: MeshOutput | null) => void;

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
  private nextId = 1;
  private camX = 0;
  private camY = 0;
  private camZ = 0;
  /** Jobs completed since the pool was created. */
  completed = 0;

  constructor(world: World, sink: MeshSink, workerCount: number) {
    this.world = world;
    this.sink = sink;
    for (let i = 0; i < workerCount; i++) {
      const w = new Worker(new URL('../workers/mesh.worker.ts', import.meta.url), { type: 'module' });
      w.onmessage = (e: MessageEvent<MeshResult>) => this.finish(w, e.data);
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
      worker.postMessage(job, [copy.states.buffer, copy.light.buffer]);
    }
  }

  private finish(worker: Worker, result: MeshResult): void {
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

  dispose(): void {
    for (const w of this.workers) w.terminate();
    this.workers.length = 0;
    this.idle.length = 0;
  }
}
