// Wires the world, the simulations and the renderer together and runs the loop.

import { clamp } from './core/math';
import { Rng } from './core/rng';
import { Input } from './player/input';
import { Interaction } from './player/interaction';
import { Inventory } from './player/inventory';
import { Player } from './player/player';
import { Environment } from './render/environment';
import { MeshPool } from './render/meshPool';
import { type Camera, type FrameInfo, Renderer } from './render/renderer';
import { Clock, SIM_DT } from './sim/clock';
import { type Regime, Weather } from './sim/weather';
import { watchAttachments } from './world/attach';
import { B } from './world/blocks';
import type { IslandInfo } from './world/gen/island';
import { DEFAULT_ISLAND, type IslandConfig } from './world/gen/terrain';
import { dropOf } from './world/items';
import { LightEngine } from './world/light';
import { selectionBox } from './world/raycast';
import { World } from './world/world';
import type { GenResult } from './workers/gen.worker';

export type Progress = (stage: string, fraction: number) => void;

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
  readonly renderer: Renderer;
  readonly pool: MeshPool;
  readonly clock: Clock;
  readonly weather: Weather;
  readonly env = new Environment();
  readonly input: Input;
  readonly player: Player;
  readonly inventory = new Inventory();
  readonly interaction = new Interaction();
  readonly camera: Camera;
  /** Simulated seconds per real second. */
  timeScale = 1;
  paused = false;
  /** Frames per second, smoothed, and milliseconds of script time per frame. */
  fps = 0;
  frameMs = 0;

  private last = 0;
  private simDebt = 0;
  private elapsed = 0;
  private running = false;

  private constructor(canvas: HTMLCanvasElement, gen: GenResult) {
    this.world = World.fromData(gen.world);
    this.info = gen.info;
    // Light is repaired first after any edit, so everything else that reacts to a change sees current light.
    new LightEngine(this.world).attach();
    watchAttachments(this.world, (_x, _y, _z, state) => {
      const d = dropOf(state);
      if (d) this.inventory.add(d.id, 1);
    });
    this.renderer = new Renderer(canvas, this.world);
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
    canvas.addEventListener('click', () => this.input.lock());
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
      this.update(dt);
      this.render(dt);
      this.input.endFrame();
      this.frameMs = this.frameMs * 0.9 + (performance.now() - began) * 0.1;
      this.fps = this.fps * 0.92 + (1 / Math.max(dt, 1e-4)) * 0.08;
      requestAnimationFrame(loop);
    };
    requestAnimationFrame(loop);
  }

  stop(): void {
    this.running = false;
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

  /**
   * Run the loop by hand for `seconds` at a fixed frame rate. For checks that
   * must not depend on the browser delivering animation frames (a hidden tab
   * delivers none).
   */
  advance(seconds: number, rate = 60): void {
    const dt = 1 / rate;
    for (let i = Math.round(seconds * rate); i > 0; i--) {
      this.update(dt);
      this.render(dt);
      this.input.endFrame();
    }
  }

  setWeather(regime: Regime | null): void {
    this.weather.force(regime);
  }

  /** Jump the calendar to an hour of the current day (debugging and inspection). */
  setHour(hour: number): void {
    this.clock.time = this.clock.day * 1440 + hour * 60;
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
      broke: (_x, _y, _z, _state, drop) => {
        if (drop) this.inventory.add(drop.item, drop.count);
      },
    });
    const t = this.interaction.target;
    const box = t ? selectionBox(this.world, t.x, t.y, t.z) : null;
    this.renderer.selection = box ? { box, progress: this.interaction.progress } : null;

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
    const info: FrameInfo = {
      time: this.elapsed,
      hour: this.clock.hour,
      wind: { x: w.windX, z: w.windZ, strength: clamp(w.windSpeed / 16, 0, 1) },
      weather: { wetness: w.wetness, snow: w.snowCover, rain: w.precipitation, cloud: w.cloudCover, storm: w.storminess },
      underwater: this.player.headUnder,
    };
    this.renderer.render(cam, this.env, info);
  }
}
