// Seeded gradient noise (improved Perlin) in 2D and 3D, plus the fractal sums
// terrain and textures are built from. Output of the base functions is roughly
// in [-1, 1].

import { Rng } from './rng';

export interface Noise {
  n2(x: number, y: number): number;
  n3(x: number, y: number, z: number): number;
}

const fade = (t: number): number => t * t * t * (t * (t * 6 - 15) + 10);

function grad2(h: number, x: number, y: number): number {
  switch (h & 7) {
    case 0: return x + y;
    case 1: return x - y;
    case 2: return -x + y;
    case 3: return -x - y;
    case 4: return x * 1.4142;
    case 5: return -x * 1.4142;
    case 6: return y * 1.4142;
    default: return -y * 1.4142;
  }
}

function grad3(h: number, x: number, y: number, z: number): number {
  const g = h & 15;
  const u = g < 8 ? x : y;
  const v = g < 4 ? y : g === 12 || g === 14 ? x : z;
  return ((g & 1) === 0 ? u : -u) + ((g & 2) === 0 ? v : -v);
}

export function createNoise(seed: number): Noise {
  const perm = new Uint8Array(512);
  const p = new Uint8Array(256);
  for (let i = 0; i < 256; i++) p[i] = i;
  const rng = new Rng(seed);
  for (let i = 255; i > 0; i--) {
    const j = rng.int(i + 1);
    const t = p[i] as number;
    p[i] = p[j] as number;
    p[j] = t;
  }
  for (let i = 0; i < 512; i++) perm[i] = p[i & 255] as number;

  function n2(x: number, y: number): number {
    const xf = Math.floor(x);
    const yf = Math.floor(y);
    const X = xf & 255;
    const Y = yf & 255;
    x -= xf;
    y -= yf;
    const u = fade(x);
    const v = fade(y);
    const a = (perm[X] as number) + Y;
    const b = (perm[X + 1] as number) + Y;
    const g00 = grad2(perm[a] as number, x, y);
    const g10 = grad2(perm[b] as number, x - 1, y);
    const g01 = grad2(perm[a + 1] as number, x, y - 1);
    const g11 = grad2(perm[b + 1] as number, x - 1, y - 1);
    const x0 = g00 + u * (g10 - g00);
    const x1 = g01 + u * (g11 - g01);
    return (x0 + v * (x1 - x0)) * 0.7071;
  }

  function n3(x: number, y: number, z: number): number {
    const xf = Math.floor(x);
    const yf = Math.floor(y);
    const zf = Math.floor(z);
    const X = xf & 255;
    const Y = yf & 255;
    const Z = zf & 255;
    x -= xf;
    y -= yf;
    z -= zf;
    const u = fade(x);
    const v = fade(y);
    const w = fade(z);
    const A = (perm[X] as number) + Y;
    const AA = (perm[A] as number) + Z;
    const AB = (perm[A + 1] as number) + Z;
    const B = (perm[X + 1] as number) + Y;
    const BA = (perm[B] as number) + Z;
    const BB = (perm[B + 1] as number) + Z;
    const g000 = grad3(perm[AA] as number, x, y, z);
    const g100 = grad3(perm[BA] as number, x - 1, y, z);
    const g010 = grad3(perm[AB] as number, x, y - 1, z);
    const g110 = grad3(perm[BB] as number, x - 1, y - 1, z);
    const g001 = grad3(perm[AA + 1] as number, x, y, z - 1);
    const g101 = grad3(perm[BA + 1] as number, x - 1, y, z - 1);
    const g011 = grad3(perm[AB + 1] as number, x, y - 1, z - 1);
    const g111 = grad3(perm[BB + 1] as number, x - 1, y - 1, z - 1);
    const x00 = g000 + u * (g100 - g000);
    const x10 = g010 + u * (g110 - g010);
    const x01 = g001 + u * (g101 - g001);
    const x11 = g011 + u * (g111 - g011);
    const y0 = x00 + v * (x10 - x00);
    const y1 = x01 + v * (x11 - x01);
    return y0 + w * (y1 - y0);
  }

  return { n2, n3 };
}

/** Fractal Brownian motion: summed octaves, normalised back to about [-1, 1]. */
export function fbm2(noise: Noise, x: number, y: number, octaves: number, lacunarity = 2, gain = 0.5): number {
  let amp = 1;
  let freq = 1;
  let sum = 0;
  let norm = 0;
  for (let i = 0; i < octaves; i++) {
    sum += amp * noise.n2(x * freq, y * freq);
    norm += amp;
    amp *= gain;
    freq *= lacunarity;
  }
  return sum / norm;
}

export function fbm3(noise: Noise, x: number, y: number, z: number, octaves: number, lacunarity = 2, gain = 0.5): number {
  let amp = 1;
  let freq = 1;
  let sum = 0;
  let norm = 0;
  for (let i = 0; i < octaves; i++) {
    sum += amp * noise.n3(x * freq, y * freq, z * freq);
    norm += amp;
    amp *= gain;
    freq *= lacunarity;
  }
  return sum / norm;
}

/** Ridged multifractal in [0, 1]: sharp crests, used for mountain spines. */
export function ridged2(noise: Noise, x: number, y: number, octaves: number, lacunarity = 2, gain = 0.5): number {
  let amp = 1;
  let freq = 1;
  let sum = 0;
  let norm = 0;
  let prev = 1;
  for (let i = 0; i < octaves; i++) {
    let r = 1 - Math.abs(noise.n2(x * freq, y * freq));
    r *= r;
    sum += r * amp * prev;
    norm += amp;
    prev = r;
    amp *= gain;
    freq *= lacunarity;
  }
  return sum / norm;
}
