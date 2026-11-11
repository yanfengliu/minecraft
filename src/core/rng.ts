// Deterministic randomness. Every simulation system takes an Rng forked from the
// world seed, so a seed reproduces a world and its history exactly. Nothing in
// simulation code may call Math.random().

/** Integer avalanche hash (lowbias32). Returns an unsigned 32-bit integer. */
export function hash32(n: number): number {
  n = (n ^ (n >>> 16)) >>> 0;
  n = Math.imul(n, 0x7feb352d) >>> 0;
  n = (n ^ (n >>> 15)) >>> 0;
  n = Math.imul(n, 0x846ca68b) >>> 0;
  return (n ^ (n >>> 16)) >>> 0;
}

export function hash2i(x: number, y: number, seed = 0): number {
  return hash32((Math.imul(x | 0, 0x1f1f1f1f) ^ Math.imul(y | 0, 0x5bd1e995) ^ Math.imul(seed | 0, 0x27d4eb2f)) >>> 0);
}

export function hash3i(x: number, y: number, z: number, seed = 0): number {
  return hash32(
    (Math.imul(x | 0, 0x1f1f1f1f) ^ Math.imul(y | 0, 0x5bd1e995) ^ Math.imul(z | 0, 0x3c6ef372) ^ Math.imul(seed | 0, 0x27d4eb2f)) >>> 0,
  );
}

/** Position hash in [0, 1). */
export function rand2(x: number, y: number, seed = 0): number {
  return hash2i(x, y, seed) / 4294967296;
}

export function rand3(x: number, y: number, z: number, seed = 0): number {
  return hash3i(x, y, z, seed) / 4294967296;
}

export function seedFromString(s: string): number {
  let h = 2166136261 >>> 0;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 16777619) >>> 0;
  }
  return hash32(h);
}

/** Small fast PRNG (mulberry32). State is one 32-bit integer, so it snapshots trivially. */
export class Rng {
  private s: number;

  constructor(seed: number) {
    this.s = seed >>> 0;
  }

  get state(): number {
    return this.s;
  }

  set state(v: number) {
    this.s = v >>> 0;
  }

  /** Uniform unsigned 32-bit integer. */
  u32(): number {
    this.s = (this.s + 0x6d2b79f5) >>> 0;
    let t = this.s;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return (t ^ (t >>> 14)) >>> 0;
  }

  /** Uniform float in [0, 1). */
  float(): number {
    return this.u32() / 4294967296;
  }

  /** Uniform float in [lo, hi). */
  range(lo: number, hi: number): number {
    return lo + (hi - lo) * this.float();
  }

  /** Uniform integer in [0, n). */
  int(n: number): number {
    return Math.floor(this.float() * n);
  }

  /** Uniform integer in [lo, hi] inclusive. */
  intRange(lo: number, hi: number): number {
    return lo + this.int(hi - lo + 1);
  }

  chance(p: number): boolean {
    return this.float() < p;
  }

  pick<T>(items: readonly T[]): T {
    return items[this.int(items.length)] as T;
  }

  /** Approximately normal variate (sum of three uniforms), mean 0, standard deviation about 1. */
  normal(): number {
    return (this.float() + this.float() + this.float() - 1.5) * 2;
  }

  shuffle<T>(items: T[]): T[] {
    for (let i = items.length - 1; i > 0; i--) {
      const j = this.int(i + 1);
      const tmp = items[i] as T;
      items[i] = items[j] as T;
      items[j] = tmp;
    }
    return items;
  }

  /** An independent stream derived from this one and a label; does not advance this stream. */
  fork(label: string | number): Rng {
    const salt = typeof label === 'number' ? hash32(label) : seedFromString(label);
    return new Rng(hash32((this.s ^ salt) >>> 0));
  }
}
