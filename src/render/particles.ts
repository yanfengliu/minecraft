// Small short-lived cubes: chips from a broken block, smoke from a chimney,
// sparks off an anvil, spray where something hits water. They are simulated on
// the CPU, fall under the world's gravity, and are drawn as boxes along with
// the creatures, so they are lit and shadowed like everything else.

import { hash32 } from '../core/rng';
import { SOLID, WATER_LEVEL } from '../world/blocks';
import type { World } from '../world/world';
import type { EntityRenderer } from './entities/renderer';

interface Particle {
  x: number; y: number; z: number;
  vx: number; vy: number; vz: number;
  age: number;
  life: number;
  size: number;
  r: number; g: number; b: number;
  glow: number;
  /** Multiplier on gravity: 1 falls, 0 floats, negative rises. */
  weight: number;
  drag: number;
  /** Grows (above 0) or shrinks (below 0) over its life. */
  swell: number;
}

const GRAVITY = 9.81;
const MAX = 2400;
type Rgb = readonly [number, number, number];

export class Particles {
  private readonly list: Particle[] = [];
  private seed = 1;
  /** Wind in metres per second, which carries smoke and spray. */
  windX = 0;
  windZ = 0;

  get count(): number {
    return this.list.length;
  }

  private rand(): number {
    this.seed = hash32(this.seed + 0x9e3779b9);
    return this.seed / 4294967296;
  }

  private emit(n: number, x: number, y: number, z: number, spread: number, speed: number, lift: number, life: number, size: number,
    color: Rgb, weight: number, drag: number, glow = 0, swell = -0.6): void {
    for (let i = 0; i < n && this.list.length < MAX; i++) {
      const a = this.rand() * Math.PI * 2;
      const up = this.rand();
      const s = speed * (0.4 + 0.6 * this.rand());
      const shade = 0.8 + 0.4 * this.rand();
      this.list.push({
        x: x + (this.rand() - 0.5) * spread, y: y + (this.rand() - 0.5) * spread, z: z + (this.rand() - 0.5) * spread,
        vx: Math.cos(a) * s * (1 - up * 0.5), vy: lift * (0.5 + this.rand()) + up * s * 0.6, vz: Math.sin(a) * s * (1 - up * 0.5),
        age: 0, life: life * (0.6 + 0.8 * this.rand()), size: size * (0.7 + 0.6 * this.rand()),
        r: color[0] * shade, g: color[1] * shade, b: color[2] * shade, glow, weight, drag, swell,
      });
    }
  }

  /** A named effect at a point. `color` is linear RGB where the effect takes its colour from something. */
  burst(kind: string, x: number, y: number, z: number, color: Rgb = [0.4, 0.4, 0.4], strength = 1): void {
    switch (kind) {
      case 'break': this.emit(Math.round(14 * strength), x, y, z, 0.7, 2.6, 1.6, 0.7, 0.085, color, 1, 0.6); break;
      case 'dust': this.emit(Math.round(8 * strength), x, y, z, 0.6, 0.9, 0.4, 0.9, 0.09, color, 0.05, 2.2, 0, 0.6); break;
      case 'smoke': this.emit(Math.round(2 * strength), x, y, z, 0.25, 0.25, 0.9, 3.6, 0.13, [0.2, 0.2, 0.21], -0.045, 0.5, 0, 1.6); break;
      case 'sparks': this.emit(Math.round(9 * strength), x, y, z, 0.15, 3.2, 1.6, 0.5, 0.035, [1, 0.55, 0.15], 0.8, 0.4, 3); break;
      case 'hammer': this.emit(4, x, y, z, 0.15, 2.4, 1.2, 0.35, 0.03, [1, 0.6, 0.2], 0.8, 0.4, 3); break;
      case 'splash': this.emit(Math.round(12 * strength), x, y, z, 0.4, 2.2, 2.4, 0.6, 0.06, [0.62, 0.74, 0.8], 1, 0.3); break;
      case 'leaves': this.emit(Math.round(10 * strength), x, y, z, 0.9, 1.2, 0.5, 2.2, 0.07, color, 0.12, 1.4); break;
      case 'chop': this.emit(5, x, y, z, 0.3, 2, 1.4, 0.6, 0.06, [0.55, 0.42, 0.24], 1, 0.6); break;
      case 'feathers': this.emit(10, x, y, z, 0.4, 1.4, 1.2, 1.8, 0.05, [0.85, 0.85, 0.8], 0.08, 1.8); break;
      default: break;
    }
  }

  update(dt: number, world: World): void {
    const list = this.list;
    for (let i = list.length - 1; i >= 0; i--) {
      const p = list[i] as Particle;
      p.age += dt;
      if (p.age >= p.life) {
        list[i] = list[list.length - 1] as Particle;
        list.pop();
        continue;
      }
      p.vy -= GRAVITY * p.weight * dt;
      const k = Math.exp(-p.drag * dt);
      // Light things drift with the wind.
      const carried = p.weight < 0.3 ? 0.6 * dt : 0;
      p.vx = p.vx * k + (this.windX * 0.25 - p.vx) * carried;
      p.vz = p.vz * k + (this.windZ * 0.25 - p.vz) * carried;
      p.vy *= k;
      const nx = p.x + p.vx * dt;
      const ny = p.y + p.vy * dt;
      const nz = p.z + p.vz * dt;
      const s = world.get(Math.floor(nx), Math.floor(ny), Math.floor(nz));
      if (SOLID[s] && p.weight > 0.3) {
        // Chips come to rest where they land.
        p.vx *= 0.3;
        p.vz *= 0.3;
        p.vy = Math.abs(p.vy) < 1 ? 0 : -p.vy * 0.25;
      } else if (WATER_LEVEL[s] && p.weight > 0.3) {
        p.life = Math.min(p.life, p.age + 0.15);
        p.x = nx; p.y = ny; p.z = nz;
      } else {
        p.x = nx; p.y = ny; p.z = nz;
      }
    }
  }

  draw(out: EntityRenderer, world: World): void {
    for (const p of this.list) {
      const t = p.age / p.life;
      const half = Math.max(0.006, p.size * (1 + p.swell * t) * (t > 0.8 ? (1 - t) * 5 : 1));
      const light = world.getLight(Math.floor(p.x), Math.floor(p.y), Math.floor(p.z));
      out.addBox(p.x, p.y, p.z, half, half, half, 0, 0, 0, 1, p.r, p.g, p.b, (light >> 4) / 15, (light & 15) / 15, p.glow * (1 - t));
    }
  }
}
