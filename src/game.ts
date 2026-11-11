// Wires the world, the simulations and the renderer together and runs the loop.

import { clamp } from './core/math';
import { Rng } from './core/rng';
import { Input } from './player/input';
import { Interaction } from './player/interaction';
import { Inventory } from './player/inventory';
import { Player } from './player/player';
import { Environment } from './render/environment';
import { MeshPool } from './render/meshPool';
import { Particles } from './render/particles';
import { type Camera, type FrameInfo, Renderer } from './render/renderer';
import { type AnimState, ENTITY_KINDS, type EntityKind, type EntityView, type InspectInfo, type VillagePlan } from './sim/api';
import { Clock, SIM_DT } from './sim/clock';
import { type Regime, Weather } from './sim/weather';
import { Hud } from './ui/hud';
import { watchAttachments } from './world/attach';
import { B, BLOCKS } from './world/blocks';
import type { IslandInfo } from './world/gen/island';
import { DEFAULT_ISLAND, type IslandConfig } from './world/gen/terrain';
import { dropOf } from './world/items';
import { LightEngine } from './world/light';
import { selectionBox } from './world/raycast';
import { World } from './world/world';
import type { GenResult } from './workers/gen.worker';

export type Progress = (stage: string, fraction: number) => void;

/** Something said or shown above a creature's head. */
export interface Speech {
  x: number;
  y: number;
  z: number;
  text: string;
  kind: 'bubble' | 'tag';
}

/** Rough standing height of each kind of creature in metres, for picking and for placing words above it. */
const HEIGHT: Record<EntityKind, number> = {
  villager: 1.8, child: 1.15, sheep: 0.9, cow: 1.3, chicken: 0.5, deer: 1.45, rabbit: 0.45, fox: 0.6, wolf: 0.95, boar: 0.85,
  songbird: 0.3, crow: 0.35, gull: 0.35, duck: 0.4, fish: 0.3,
};

function generate(config: IslandConfig): Promise<GenResult> {
  return new Promise((resolve, reject) => {
    const worker = new Worker(new URL('./workers/gen.worker.ts', import.meta.url), { type: 'module' });
    worker.onmessage = (e: MessageEvent<GenResult>) => {
      resolve(e.data);
      worker.terminate();
    };
    worker.onerror = (e) => reject(new Error(`world generation failed: ${e.message}`));
    worker.postMessage(config);
  });
}

export class Game {
  readonly world: World;
  readonly info: IslandInfo;
  readonly plan: VillagePlan | null;
  readonly renderer: Renderer;
  readonly pool: MeshPool;
  readonly clock: Clock;
  readonly weather: Weather;
  readonly env = new Environment();
  readonly input: Input;
  readonly player: Player;
  readonly inventory = new Inventory();
  readonly interaction = new Interaction();
  readonly particles = new Particles();
  readonly camera: Camera;
  readonly hud: Hud;
  /** Simulated seconds per real second. */
  timeScale = 1;
  paused = false;
  /** The weather the player has pinned from the almanac, or null to let it run. */
  forcedWeather: Regime | null = null;
  /** Frames per second, smoothed, and milliseconds of script time per frame. */
  fps = 0;
  frameMs = 0;
  /** The creature under the crosshair, within reach, if any. */
  focus: EntityView | null = null;
  /** Creatures placed by hand for inspecting models and poses; drawn along with whatever the simulations show. */
  readonly lineUp: EntityView[] = [];

  private last = 0;
  private simDebt = 0;
  private elapsed = 0;
  private running = false;
  private readonly seen: EntityView[] = [];

  private constructor(canvas: HTMLCanvasElement, gen: GenResult) {
    this.world = World.fromData(gen.world);
    this.info = gen.info;
    this.plan = gen.plan;
    // Light is repaired first after any edit, so everything else that reacts to a change sees current light.
    new LightEngine(this.world).attach();
    watchAttachments(this.world, (_x, _y, _z, state) => {
      const d = dropOf(state);
      if (d) this.inventory.add(d.id, 1);
    });
    this.renderer = new Renderer(canvas, this.world);
    this.world.changed.on(() => {
      this.renderer.heightsDirty = true;
    });
    const workers = clamp((navigator.hardwareConcurrency || 4) - 2, 2, 8);
    this.pool = new MeshPool(this.world, (section, mesh) => this.renderer.setMesh(section, mesh), workers);
    this.clock = new Clock(9);
    this.weather = new Weather(new Rng(gen.info.config.seed ^ 0x5eed).fork('weather'), this.clock);
    this.weather.lightning.on((s) => this.env.strike(s.intensity));
    this.input = new Input(canvas);
    const s = gen.info.spawn;
    this.player = new Player(s.x, s.y, s.z);
    this.player.yaw = Math.PI * 0.75;
    this.inventory.giveStarterKit();
    this.camera = { x: s.x, y: s.y + 1.62, z: s.z, yaw: this.player.yaw, pitch: 0, fov: (72 * Math.PI) / 180 };
    canvas.addEventListener('click', () => {
      if (this.input.enabled) this.input.lock();
    });
    this.hud = new Hud(document.getElementById('ui') as HTMLElement, this);
  }

  static async create(canvas: HTMLCanvasElement, progress: Progress, config: IslandConfig = DEFAULT_ISLAND): Promise<Game> {
    progress('Raising the island', 0.05);
    const gen = await generate(config);
    progress('Shaping the land', 0.55);
    const game = new Game(canvas, gen);
    game.pool.queueAll();
    const total = game.world.sectionCount;
    await new Promise<void>((resolve) => {
      const step = (): void => {
        game.pool.update(game.camera.x, game.camera.y, game.camera.z);
        progress('Shaping the land', 0.55 + 0.45 * (game.pool.completed / total));
        if (game.pool.pending === 0) resolve();
        else setTimeout(step, 16);
      };
      step();
    });
    return game;
  }

  start(): void {
    if (this.running) return;
    this.running = true;
    this.last = performance.now();
    const loop = (now: number): void => {
      if (!this.running) return;
      const began = performance.now();
      const dt = Math.min(0.1, (now - this.last) / 1000);
      this.last = now;
      this.frame(dt);
      this.frameMs = this.frameMs * 0.9 + (performance.now() - began) * 0.1;
      this.fps = this.fps * 0.92 + (1 / Math.max(dt, 1e-4)) * 0.08;
      requestAnimationFrame(loop);
    };
    requestAnimationFrame(loop);
  }

  stop(): void {
    this.running = false;
  }

  private frame(dt: number): void {
    this.update(dt);
    this.render(dt);
    this.hud.update(dt);
    this.input.endFrame();
  }

  /**
   * Run the loop by hand for `seconds` at a fixed frame rate. For checks that
   * must not depend on the browser delivering animation frames (a hidden tab
   * delivers none).
   */
  advance(seconds: number, rate = 60): void {
    const dt = 1 / rate;
    for (let i = Math.round(seconds * rate); i > 0; i--) this.frame(dt);
  }

  /**
   * Render one frame and read back a coarse grid of what reached the canvas:
   * `cols * rows` pixels as r, g, b bytes, top row first. Reading back also
   * waits for the GPU, so timing around it measures finished frames.
   */
  probe(cols = 16, rows = 9): number[] {
    this.advance(1 / 60);
    const gl = this.renderer.gl;
    gl.bindFramebuffer(gl.FRAMEBUFFER, null);
    const px = new Uint8Array(4);
    const out: number[] = [];
    for (let r = 0; r < rows; r++) {
      for (let c = 0; c < cols; c++) {
        const x = Math.floor(((c + 0.5) / cols) * gl.drawingBufferWidth);
        const y = Math.floor((1 - (r + 0.5) / rows) * gl.drawingBufferHeight);
        gl.readPixels(x, y, 1, 1, gl.RGBA, gl.UNSIGNED_BYTE, px);
        out.push(px[0] as number, px[1] as number, px[2] as number);
      }
    }
    return out;
  }

  setWeather(regime: Regime | null): void {
    this.forcedWeather = regime;
    this.weather.force(regime);
  }

  /** Jump the calendar to an hour of the current day (debugging and inspection). */
  setHour(hour: number): void {
    this.clock.time = this.clock.day * 1440 + hour * 60;
  }

  /** Stand one of every creature in a row in front of the player, each in the given pose. */
  showLineUp(anim: AnimState = 'idle'): void {
    this.lineUp.length = 0;
    const p = this.player;
    const fx = Math.sin(p.yaw);
    const fz = Math.cos(p.yaw);
    ENTITY_KINDS.forEach((kind, i) => {
      for (let row = 0; row < 2; row++) {
        const side = (i - (ENTITY_KINDS.length - 1) / 2) * 1.5;
        const ahead = 5 + row * 2.2;
        const x = p.x + fx * ahead + fz * side;
        const z = p.z + fz * ahead - fx * side;
        const y = this.world.groundY(Math.floor(x), Math.floor(z), Math.floor(p.y) + 6) + 1;
        this.lineUp.push({
          id: 900000 + i * 2 + row, kind, look: i * 7 + row * 3 + 1, role: i + row * 5, x, y, z, yaw: p.yaw + Math.PI + (row ? 0.6 : 0),
          anim, animTime: i * 0.3, scale: 1, held: -1, bubble: '',
        });
      }
    });
  }

  /** Every creature in the world this frame. */
  creatures(): readonly EntityView[] {
    return this.seen;
  }

  /** What the inspector card shows for a creature. */
  inspect(id: number): InspectInfo | null {
    const v = this.lineUp.find((q) => q.id === id);
    return v ? { title: v.kind, subtitle: `in the line-up, ${v.anim}`, lines: [], bars: [] } : null;
  }

  /** The line under the crosshair when a creature is in focus. */
  focusPrompt(): string {
    return '';
  }

  /** What is being said, and by whom, near the player. */
  speech(): Speech[] {
    const out: Speech[] = [];
    const p = this.player;
    for (const v of this.seen) {
      if (!v.bubble) continue;
      const d2 = (v.x - p.x) ** 2 + (v.z - p.z) ** 2;
      if (d2 > 28 * 28) continue;
      const at = this.renderer.entities.drawn(v.id) ?? v;
      out.push({ x: at.x, y: at.y + HEIGHT[v.kind] * v.scale + 0.35, z: at.z, text: v.bubble, kind: 'bubble' });
      if (out.length >= 14) break;
    }
    return out;
  }

  project(x: number, y: number, z: number): { x: number; y: number; depth: number } | null {
    return this.renderer.project(x, y, z);
  }

  /** Extra lines for the F3 readout. */
  debugLines(): string[] {
    return [`${this.seen.length} creatures · ${this.renderer.entities.count} boxes`, `exposure ${this.env.exposure.toFixed(2)}`];
  }

  private update(dt: number): void {
    this.elapsed += dt;
    // Simulation steps: fixed size, as many as the time scale calls for, bounded so a hitch cannot snowball.
    if (!this.paused) {
      this.simDebt += dt * this.timeScale;
      let steps = Math.min(Math.floor(this.simDebt / SIM_DT), 2400);
      this.simDebt -= steps * SIM_DT;
      while (steps-- > 0) {
        this.clock.advance(SIM_DT);
        this.weather.update(SIM_DT);
      }
    }

    this.player.update(dt, this.input, this.world, (x, y, z) => this.flowAt(x, y, z));
    this.interaction.update(dt, this.input, this.player, this.world, this.inventory, {
      broke: (x, y, z, state, drop) => {
        if (drop) this.inventory.add(drop.item, drop.count);
        this.particles.burst('break', x + 0.5, y + 0.5, z + 0.5, this.colorOf(state));
      },
    });
    this.particles.windX = this.weather.windX;
    this.particles.windZ = this.weather.windZ;
    this.particles.update(dt, this.world);
    const t = this.interaction.target;
    const box = t ? selectionBox(this.world, t.x, t.y, t.z) : null;
    this.renderer.selection = box ? { box, progress: this.interaction.progress } : null;

    // Gather the creatures and find the one being looked at.
    this.seen.length = 0;
    for (const v of this.lineUp) {
      v.animTime += dt;
      this.seen.push(v);
    }
    this.focus = this.pick(t ? t.t : 6.5);

    const eye = this.player.eye;
    const cam = this.camera;
    cam.x = eye.x;
    cam.y = eye.y;
    cam.z = eye.z;
    cam.yaw = this.player.yaw;
    cam.pitch = this.player.pitch;
    cam.fov = ((72 + 6 * this.player.rush) * Math.PI) / 180;
    this.pool.update(cam.x, cam.y, cam.z);
  }

  /** The nearest creature the view ray meets before `reach` metres. */
  private pick(reach: number): EntityView | null {
    const e = this.player.eye;
    const l = this.player.look;
    let best: EntityView | null = null;
    let bestT = reach;
    for (const v of this.seen) {
      const dx = v.x - e.x;
      const dz = v.z - e.z;
      if (dx * dx + dz * dz > 64) continue;
      const h = HEIGHT[v.kind] * v.scale;
      const r = Math.max(0.28, h * 0.3);
      // Slab test against a box around the creature.
      let t0 = 0;
      let t1 = bestT;
      const lo = [v.x - r, v.y, v.z - r];
      const hi = [v.x + r, v.y + h, v.z + r];
      const o = [e.x, e.y, e.z];
      const d = [l.x, l.y, l.z];
      let hit = true;
      for (let a = 0; a < 3 && hit; a++) {
        if (Math.abs(d[a] as number) < 1e-9) {
          if ((o[a] as number) < (lo[a] as number) || (o[a] as number) > (hi[a] as number)) hit = false;
          continue;
        }
        let ta = ((lo[a] as number) - (o[a] as number)) / (d[a] as number);
        let tb = ((hi[a] as number) - (o[a] as number)) / (d[a] as number);
        if (ta > tb) [ta, tb] = [tb, ta];
        t0 = Math.max(t0, ta);
        t1 = Math.min(t1, tb);
        if (t0 > t1) hit = false;
      }
      if (hit && t0 < bestT) {
        bestT = t0;
        best = v;
      }
    }
    return best;
  }

  /** The typical colour of a block (linear RGB), for the chips it breaks into. */
  colorOf(state: number): [number, number, number] {
    const tile = (BLOCKS[state]?.tiles[4] ?? 0) * 3;
    const a = this.renderer.tileSet.average;
    return [a[tile] as number, a[tile + 1] as number, a[tile + 2] as number];
  }

  /** The push of flowing water at a point: river cells carry their baked direction. */
  private flowAt(x: number, y: number, z: number): { x: number; z: number } {
    const s = this.world.get(Math.floor(x), Math.floor(y), Math.floor(z));
    if (s >= B.river && s < B.river + 8) {
      const a = ((s - B.river) * Math.PI) / 4;
      return { x: Math.cos(a) * 1.5, z: -Math.sin(a) * 1.5 };
    }
    return { x: 0, z: 0 };
  }

  private render(dt: number): void {
    const cam = this.camera;
    const w = this.weather;
    const light = this.world.getLight(Math.floor(cam.x), Math.floor(cam.y), Math.floor(cam.z));
    this.env.update(this.clock, w, (light >> 4) / 15, (light & 15) / 15, dt);

    const ents = this.renderer.entities;
    ents.begin();
    // Creatures beyond the far cascade are too small to matter and are skipped.
    for (const v of this.seen) {
      if ((v.x - cam.x) ** 2 + (v.z - cam.z) ** 2 < 260 * 260) ents.addEntity(v, this.world, dt);
    }
    this.particles.draw(ents, this.world);
    ents.finish();

    const info: FrameInfo = {
      time: this.elapsed,
      hour: this.clock.hour,
      wind: { x: w.windX, z: w.windZ, strength: clamp(w.windSpeed / 16, 0, 1) },
      weather: { wetness: w.wetness, snow: w.snowCover, rain: w.precipitation, cloud: w.cloudCover, storm: w.storminess, snowing: w.snowing },
      underwater: this.player.headUnder,
    };
    this.renderer.render(cam, this.env, info);
  }
}
