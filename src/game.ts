// Wires the world, the simulations and the renderer together and runs the loop.

import { clamp } from './core/math';
import { Rng, rand3 } from './core/rng';
import type { Physics, PhysicsEvent } from './physics';
import { Input } from './player/input';
import { Interaction, REACH } from './player/interaction';
import { Inventory } from './player/inventory';
import { Player } from './player/player';
import { BodyDrawer } from './render/bodies';
import { Environment } from './render/environment';
import { MeshPool } from './render/meshPool';
import { Particles } from './render/particles';
import { type Camera, type FrameInfo, Renderer } from './render/renderer';
import { type AnimState, ENTITY_KINDS, type EntityKind, type EntityView, type InspectInfo, type VillagePlan } from './sim/api';
import { Clock, SIM_DT } from './sim/clock';
import { type Regime, Weather } from './sim/weather';
import { Hud } from './ui/hud';
import { watchAttachments } from './world/attach';
import { BLOCKS, IS_LEAVES } from './world/blocks';
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

/** The colour of the dust each material throws up when something made of it lands hard; indexed like `MATERIALS`. */
const DUST: readonly (readonly [number, number, number])[] = [
  [0.4, 0.4, 0.4], [0.42, 0.42, 0.42], [0.3, 0.22, 0.14], [0.6, 0.52, 0.34], [0.4, 0.39, 0.37], [0.4, 0.28, 0.15], [0.2, 0.36, 0.12], [0.22, 0.38, 0.14],
  [0.7, 0.68, 0.62], [0.7, 0.8, 0.82], [0.45, 0.46, 0.48], [0.6, 0.5, 0.2], [0.45, 0.24, 0.17], [0.6, 0.72, 0.8], [0.9, 0.92, 0.95], [0.5, 0.36, 0.27],
];
/** How far from the player's middle a dropped item is picked up, in metres. */
const PICKUP_RADIUS = 1.45;
/** Seconds of holding the button on a piece of rubble before it breaks into its blocks. */
const RUBBLE_TIME = 0.35;

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
  readonly physics: Physics;
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
  private readonly bodies: BodyDrawer;
  /** The piece of rubble the player is hitting, and for how long. */
  private rubble = { id: -1, held: 0 };
  /** Seconds before items are picked up again, after a pick-up that did not fit in the pack. */
  private pickupWait = 0;
  private drops = 0;
  /** 1 at the moment of a blow or a placement, falling to 0: swings the held item. */
  private swing = 0;
  /** Metres walked, for the sway of the held item. */
  private stride = 0;

  private constructor(canvas: HTMLCanvasElement, gen: GenResult, world: World, physics: Physics) {
    this.world = world;
    this.info = gen.info;
    this.plan = gen.plan;
    this.physics = physics;
    this.bodies = new BodyDrawer(world);
    physics.events.on((e) => this.onPhysics(e));
    watchAttachments(this.world, (x, y, z, state) => {
      const d = dropOf(state);
      if (d) this.drop(d.id, 1, x, y, z);
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
    // The physics library is large, so it loads in its own chunk while the island is being raised.
    const [gen, { Physics: PhysicsLayer }] = await Promise.all([generate(config), import('./physics')]);
    progress('Shaping the land', 0.55);
    const world = World.fromData(gen.world);
    // Light is repaired first after any edit, so everything else that reacts to a change sees current light.
    new LightEngine(world).attach();
    const physics = await PhysicsLayer.create(world, { seed: gen.info.config.seed, now: () => performance.now() });
    const game = new Game(canvas, gen, world, physics);
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
    const s = this.physics.stats;
    return [
      `${this.seen.length} creatures · ${this.renderer.entities.count} boxes`,
      `physics ${s.stepMs.toFixed(2)} ms · ${s.bodies} bodies (${s.awakeBodies} awake) · ${s.falling} falling · ${s.fluidActive} water cells`,
      `exposure ${this.env.exposure.toFixed(2)}`,
    ];
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

    const p = this.player;
    p.update(dt, this.input, this.world, (x, y, z) => this.physics.flowAt(x, y, z));
    // Rubble that came to rest out of square is a body, not a block, and the block ray cannot see it:
    // whichever of the two the crosshair meets first is the one the player is working on.
    const e = p.eye;
    const l = p.look;
    const body = this.input.enabled ? this.physics.pickBody(e.x, e.y, e.z, l.x, l.y, l.z, REACH) : null;
    this.interaction.update(dt, this.input, p, this.world, this.inventory, {
      broke: (x, y, z, state, drop) => {
        if (drop) this.drop(drop.item, drop.count, x, y, z);
        this.particles.burst('break', x + 0.5, y + 0.5, z + 0.5, this.colorOf(state));
        this.swing = 1;
      },
      placed: () => {
        this.swing = 1;
      },
    }, body ? body.distance : REACH);
    if (body && !this.interaction.target && this.input.buttons.has(0)) {
      if (this.rubble.id !== body.id) this.rubble = { id: body.id, held: 0 };
      this.rubble.held += dt;
      if (this.rubble.held >= RUBBLE_TIME && this.physics.breakBody(body.id)) this.rubble.id = -1;
    } else {
      this.rubble.id = -1;
    }

    // Physics runs in real time whatever the calendar's speed: water and falling stone do not hurry with the clock.
    if (!this.paused) {
      this.physics.setPusher(p.x, p.y, p.z, 0.3, 1.8);
      this.physics.step(dt);
      this.pickupWait = Math.max(0, this.pickupWait - dt);
      if (this.pickupWait === 0) {
        for (const s of this.physics.collectItems(p.x, p.y + 0.9, p.z, PICKUP_RADIUS)) {
          const left = this.inventory.add(s.item, s.count);
          if (left > 0) {
            // A full pack: put back what did not fit and leave it lying for a few seconds.
            this.physics.spawnItem(s.item, left, p.x, p.y + 1, p.z, { x: l.x * 2.5, y: 1.5, z: l.z * 2.5 });
            this.pickupWait = 4;
          }
        }
      }
    }
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

  /** What the player holds, drawn low on the right of the view as if in the hand: it swings with a blow and sways with a stride. */
  private drawHeld(ents: Renderer['entities'], dt: number): void {
    this.swing = Math.max(0, this.swing - dt * 5);
    const held = this.inventory.held;
    if (!held) return;
    const cam = this.camera;
    const p = this.player;
    const sy = Math.sin(cam.yaw), cy = Math.cos(cam.yaw);
    const sp = Math.sin(cam.pitch), cp = Math.cos(cam.pitch);
    // The view's own axes: forward, right (level) and up.
    const fx = sy * cp, fy = sp, fz = cy * cp;
    const rx = -cy, rz = sy;
    const ux = -sy * sp, uy = cp, uz = -cy * sp;
    const speed = p.onGround ? Math.hypot(p.vx, p.vz) : 0;
    this.stride += speed * dt;
    const digging = this.interaction.progress > 0 ? 0.5 + 0.5 * Math.sin(this.elapsed * 17) : 0;
    const blow = Math.max(this.swing, digging * 0.7);
    const sway = Math.sin(this.stride * 1.6) * 0.012 * Math.min(1, speed / 3);
    const ahead = 0.5 + 0.12 * blow;
    const side = 0.36 - 0.06 * blow + sway;
    const down = 0.3 + 0.08 * blow + Math.abs(sway) * 0.6;
    const turn = cam.yaw + 0.62 - 0.5 * blow;
    this.bodies.item(ents, {
      x: cam.x + fx * ahead + rx * side - ux * down, y: cam.y + fy * ahead - uy * down, z: cam.z + fz * ahead + rz * side - uz * down,
      qx: 0, qy: Math.sin(turn / 2), qz: 0, qw: Math.cos(turn / 2),
    }, held.item, 1, this.env, 0.17);
  }

  /** Put items into the world where a block was, with a small hop so they are seen to come loose. */
  private drop(itemId: number, count: number, x: number, y: number, z: number): void {
    const a = rand3(x, y, z, this.drops++) * Math.PI * 2;
    this.physics.spawnItem(itemId, count, x + 0.5, y + 0.5, z + 0.5, { x: Math.cos(a) * 0.9, y: 2.4, z: Math.sin(a) * 0.9 });
  }

  /** What physics reports becomes something to see: spray, dust, flying leaves. */
  private onPhysics(e: PhysicsEvent): void {
    const cam = this.camera;
    if ((e.x - cam.x) ** 2 + (e.z - cam.z) ** 2 > 90 * 90) return;
    const fx = this.particles;
    switch (e.type) {
      case 'splash': fx.burst('splash', e.x, e.y, e.z, undefined, clamp(e.strength * 0.4, 0.5, 4)); break;
      case 'impact':
        if (e.energy > 1500) fx.burst('dust', e.x, e.y, e.z, DUST[e.material] ?? DUST[0], clamp(e.energy / 20000, 0.5, 4));
        break;
      case 'collapse': fx.burst('dust', e.x, e.y, e.z, DUST[1], clamp(e.blocks / 3, 1, 6)); break;
      case 'burst': {
        const leaves = (IS_LEAVES[e.state] as number) === 1;
        fx.burst(leaves ? 'leaves' : 'break', e.x, e.y, e.z, this.colorOf(e.state), leaves ? 0.6 : 1);
        break;
      }
      case 'land': fx.burst('dust', e.x, e.y - 0.4, e.z, this.colorOf(e.state), 0.7); break;
    }
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
    this.bodies.draw(ents, this.physics.bodies, this.env, cam.x, cam.z);
    this.drawHeld(ents, dt);
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
