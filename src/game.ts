// Wires the world, the simulations and the renderer together and runs the loop.

import { clamp } from './core/math';
import { Rng, rand3 } from './core/rng';
import { Life } from './life';
import type { Physics } from './physics';
import { Input } from './player/input';
import { Interaction, REACH } from './player/interaction';
import { Inventory } from './player/inventory';
import { CREATURE_HEIGHT, pickCreature } from './player/pick';
import { Player } from './player/player';
import { Trade } from './player/trade';
import { BodyDrawer } from './render/bodies';
import { lineUp } from './render/entities/lineup';
import { Environment } from './render/environment';
import { HeldItem } from './render/held';
import { WOOD_DUST, showPhysicsEvent } from './render/impacts';
import { MeshPool } from './render/meshPool';
import { Particles } from './render/particles';
import { type Camera, type FrameInfo, Renderer } from './render/renderer';
import { type AnimState, type EntityView, type InspectInfo, type VillagePlan, createBasicActions } from './sim/api';
import { Clock, DAY_SECONDS, HOUR_SECONDS, SIM_DT } from './sim/clock';
import { type Regime, Weather } from './sim/weather';
import type { Speech } from './ui/host';
import { Hud } from './ui/hud';
import { watchAttachments } from './world/attach';
import { BLOCKS, IS_LOG } from './world/blocks';
import type { IslandInfo } from './world/gen/island';
import { DEFAULT_ISLAND, type IslandConfig } from './world/gen/terrain';
import { dropOf } from './world/items';
import { LightEngine } from './world/light';
import { selectionBox } from './world/raycast';
import { World } from './world/world';
import type { GenResult } from './workers/gen.worker';

export type Progress = (stage: string, fraction: number) => void;

/** How far away a creature can be looked at and spoken to, in metres, when no block is nearer. */
const CREATURE_REACH = 6.5;
/** How far from the camera something has to be before its particles are not worth throwing, in metres. */
const EFFECT_RANGE = 90;
/** Simulation steps one frame may run: 4 simulated seconds, enough for 120x time-lapse at 30 frames a second. */
const MAX_STEPS_PER_FRAME = 40;
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
  /** The village and the wildlife. */
  readonly life: Life;
  /** The player's dealings with the village; null where there is none. */
  readonly trade: Trade | null;
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
  /** What villagers have said to the player and until when (in `elapsed` seconds) it stays above their heads. */
  private readonly said = new Map<number, { text: string; until: number }>();
  private readonly hand = new HeldItem();

  private constructor(canvas: HTMLCanvasElement, gen: GenResult, world: World, physics: Physics) {
    this.world = world;
    this.info = gen.info;
    this.plan = gen.plan;
    this.physics = physics;
    this.bodies = new BodyDrawer(world);
    const near = (x: number, z: number): boolean => (x - this.camera.x) ** 2 + (z - this.camera.z) ** 2 < EFFECT_RANGE * EFFECT_RANGE;
    physics.events.on((e) => {
      if (near(e.x, e.z)) showPhysicsEvent(this.particles, e, (state) => this.colorOf(state));
    });
    watchAttachments(this.world, (x, y, z, state) => {
      const d = dropOf(state);
      if (d) this.drop(d.id, 1, x, y, z);
    });
    this.renderer = new Renderer(canvas, this.world);
    this.world.changed.on((c) => {
      // Only an edit at the top of its column changes how far down the rain comes. The simulations edit the
      // world all day (doors, crops, wet soil), and each edit had the whole map sent to the GPU again.
      if (c.y + 1 >= this.world.height(c.x, c.z)) this.renderer.heightsDirty = true;
    });
    const workers = clamp((navigator.hardwareConcurrency || 4) - 2, 2, 8);
    this.pool = new MeshPool(this.world, (section, mesh) => this.renderer.setMesh(section, mesh), workers);
    this.clock = new Clock(9);
    const rng = new Rng(gen.info.config.seed ^ 0x5eed);
    this.weather = new Weather(rng.fork('weather'), this.clock);
    this.weather.lightning.on((s) => this.env.strike(s.intensity));
    const basic = createBasicActions(this.world);
    this.life = new Life(this.world, this.clock, this.weather, rng.fork('life'), this.plan, {
      // A woodcutter's tree is taken away whole and counted once: he is paid in logs for what he fells,
      // and a trunk left lying as blocks as well would be the same wood twice. (A tree the player cuts
      // falls for real: see section 10 of the design.) The crown goes in a shower of leaves.
      fellTree: (x, y, z) => {
        let top = y;
        while ((IS_LOG[this.world.get(x, top + 1, z)] as number) === 1) top++;
        const leaf = this.world.get(x, top + 1, z);
        const logs = basic.fellTree(x, y, z);
        if (logs > 0 && near(x, z)) {
          this.particles.burst('leaves', x + 0.5, top + 0.5, z + 0.5, this.colorOf(leaf), 4);
          this.particles.burst('dust', x + 0.5, y + 0.3, z + 0.5, WOOD_DUST, 1.5);
        }
        return logs;
      },
      effect: (kind, x, y, z) => {
        if (near(x, z)) this.particles.burst(kind, x, y, z);
      },
    });
    const village = this.life.village;
    this.trade = village ? new Trade(village, this.inventory, (item, count) => {
      physics.spawnItem(item, count, this.player.x, this.player.y + 1, this.player.z);
    }) : null;
    this.renderer.entities.tradeOf = (role) => village?.professions[role] ?? '';
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

  /** Turn the clock to an hour of the current day (the almanac, and inspection). */
  setHour(hour: number): void {
    this.setClock(this.clock.day * DAY_SECONDS + hour * HOUR_SECONDS);
  }

  /** Move the calendar on by whole days without living through them. */
  skipDays(days: number): void {
    this.setClock(this.clock.time + days * DAY_SECONDS);
  }

  /**
   * Set the clock rather than step it. Nothing is simulated for the time between: the village and the
   * wildlife each notice the jump on their next tick and carry on from where they were, and the
   * weather plans its next change from the new time.
   */
  private setClock(time: number): void {
    this.clock.time = time;
    this.weather.resync();
  }

  /** Stand one of every creature in a row in front of the player, each in the given pose. */
  showLineUp(anim: AnimState = 'idle'): void {
    const p = this.player;
    this.lineUp.length = 0;
    this.lineUp.push(...lineUp(this.world, p.x, p.y, p.z, p.yaw, anim));
  }

  /** Every creature in the world this frame. */
  creatures(): readonly EntityView[] {
    return this.seen;
  }

  /** What the inspector card shows for a creature. */
  inspect(id: number): InspectInfo | null {
    const v = this.lineUp.find((q) => q.id === id);
    return v ? { title: v.kind, subtitle: `in the line-up, ${v.anim}`, lines: [], bars: [] } : this.life.inspect(id);
  }

  /** The line under the crosshair when a creature is in focus. */
  focusPrompt(): string {
    const who = this.focus;
    const village = this.life.village;
    if (!who || !village || (who.kind !== 'villager' && who.kind !== 'child')) return '';
    return village.canTrade(who.id) ? 'Right-click to trade' : 'Right-click to talk';
  }

  /**
   * Right-click on a villager: trade if they are serving, otherwise pass the time of day. Returns
   * whether there was anyone to greet. Who is under the crosshair is worked out afresh: the player
   * has turned since `focus` was last set, and a click must land on what they see now.
   */
  private greet(reach: number): boolean {
    const who = pickCreature(this.seen, this.player.eye, this.player.look, reach);
    const village = this.life.village;
    if (!who || !village || (who.kind !== 'villager' && who.kind !== 'child')) return false;
    if (this.trade && village.canTrade(who.id)) {
      this.trade.begin(who.id);
      this.hud.show('trade');
    } else {
      const line = village.talk(who.id);
      if (line) this.said.set(who.id, { text: line, until: this.elapsed + 4.5 });
    }
    return true;
  }

  /** What is being said, and by whom, near the player. */
  speech(): Speech[] {
    const out: Speech[] = [];
    const p = this.player;
    for (const v of this.seen) {
      // What a villager says to the player takes the place of whatever they were saying to each other.
      const reply = this.said.get(v.id);
      if (reply && reply.until < this.elapsed) this.said.delete(v.id);
      const text = reply && reply.until >= this.elapsed ? reply.text : v.bubble;
      if (!text) continue;
      const d2 = (v.x - p.x) ** 2 + (v.z - p.z) ** 2;
      if (d2 > 28 * 28) continue;
      const at = this.renderer.entities.drawn(v.id) ?? v;
      out.push({ x: at.x, y: at.y + CREATURE_HEIGHT[v.kind] * v.scale + 0.35, z: at.z, text, kind: 'bubble' });
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
    const p = this.player;
    const who = this.life.player;
    who.x = p.x;
    who.y = p.y;
    who.z = p.z;
    // Simulation steps: fixed size, as many as the time scale calls for.
    if (!this.paused) {
      this.simDebt += dt * this.timeScale;
      const due = Math.floor(this.simDebt / SIM_DT);
      // A frame runs at most this many steps: if the simulations cannot keep up with the time-lapse
      // asked for, time runs a little slower instead of the frame rate collapsing.
      let steps = Math.min(due, MAX_STEPS_PER_FRAME);
      this.simDebt = due > MAX_STEPS_PER_FRAME ? 0 : this.simDebt - steps * SIM_DT;
      while (steps-- > 0) {
        this.clock.advance(SIM_DT);
        this.weather.update(SIM_DT);
        this.life.tick();
      }
    }

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
        this.hand.swing = 1;
      },
      placed: () => {
        this.hand.swing = 1;
      },
      use: (hit) => this.greet(hit ? hit.t : CREATURE_REACH),
      gained: (x, y, z, item, count) => this.drop(item, count, x, y, z),
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
    this.life.collect(this.seen);
    // A creature behind the block being aimed at is out of reach.
    this.focus = pickCreature(this.seen, this.player.eye, this.player.look, t ? t.t : CREATURE_REACH);

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

  /** The typical colour of a block (linear RGB), for the chips it breaks into. */
  colorOf(state: number): [number, number, number] {
    const tile = (BLOCKS[state]?.tiles[4] ?? 0) * 3;
    const a = this.renderer.tileSet.average;
    return [a[tile] as number, a[tile + 1] as number, a[tile + 2] as number];
  }

  /** Put items into the world where a block was, with a small hop so they are seen to come loose. */
  private drop(itemId: number, count: number, x: number, y: number, z: number): void {
    const a = rand3(x, y, z, this.drops++) * Math.PI * 2;
    this.physics.spawnItem(itemId, count, x + 0.5, y + 0.5, z + 0.5, { x: Math.cos(a) * 0.9, y: 2.4, z: Math.sin(a) * 0.9 });
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
    const p = this.player;
    this.hand.draw(this.bodies, ents, cam, this.inventory.held, this.env, p.onGround ? Math.hypot(p.vx, p.vz) : 0, this.interaction.progress > 0, this.elapsed, dt);
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
