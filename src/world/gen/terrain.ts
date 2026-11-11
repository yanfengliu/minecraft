// The shape of the island: a height field with a mountain massif, hills, a
// highland lake, a river running from it to the sea, and a flattened shelf for
// the village. Everything here is 2D maps over the columns; `fill.ts` turns
// them into voxels. Headless and deterministic.

import { clamp, lerp, smoothstep } from '../../core/math';
import { type Noise, createNoise, fbm2, ridged2 } from '../../core/noise';
import { Rng } from '../../core/rng';

export interface IslandConfig {
  seed: number;
  sx: number;
  sy: number;
  sz: number;
  seaLevel: number;
}

export const DEFAULT_ISLAND: IslandConfig = { seed: 20261111, sx: 768, sy: 128, sz: 768, seaLevel: 40 };

export const BIOME_SEA = 0;
export const BIOME_BEACH = 1;
export const BIOME_MEADOW = 2;
export const BIOME_FOREST = 3;
export const BIOME_PINE = 4;
export const BIOME_HIGHLAND = 5;
export const BIOME_ROCK = 6;
export const BIOME_SNOW = 7;
export const BIOME_VILLAGE = 8;

export interface Terrain {
  config: IslandConfig;
  /** y of the top solid block per column. */
  height: Int16Array;
  /** y of the top water cell per column, or -1 for none. */
  water: Int16Array;
  /** River flow direction 0..7 per column (0 = +x, counter-clockwise toward -z), or -1 where water is still. */
  flow: Int8Array;
  biome: Uint8Array;
  /** "Landness": positive on land, negative at sea, growing inland. */
  land: Float32Array;
  /** Centre and level of the lake. */
  lake: { x: number; z: number; radius: number; level: number };
  /** Centre and ground height of the flattened village shelf. */
  village: { x: number; z: number; y: number; radius: number };
  /** Points along the river from the lake to the sea. */
  river: { x: number; z: number; level: number }[];
  noise: { detail: Noise; moisture: Noise; patch: Noise };
}

export function buildTerrain(config: IslandConfig): Terrain {
  const { sx, sz, sy, seaLevel, seed } = config;
  const rng = new Rng(seed);
  const nShape = createNoise(rng.u32());
  const nHills = createNoise(rng.u32());
  const nDetail = createNoise(rng.u32());
  const nRidge = createNoise(rng.u32());
  const nCliff = createNoise(rng.u32());
  const nMoist = createNoise(rng.u32());
  const nPatch = createNoise(rng.u32());

  const cx = sx / 2;
  const cz = sz / 2;
  const R = Math.min(sx, sz) / 2;
  const scale = R / 384; // feature sizes follow the world size so small test worlds keep the same layout
  const n = sx * sz;
  const land = new Float32Array(n);
  const h = new Float32Array(n);

  // Mountain in the north-west, a lower ridge in the north-east.
  const mx = cx - 0.36 * R + rng.range(-10, 10) * scale;
  const mz = cz - 0.3 * R + rng.range(-10, 10) * scale;
  const ex = cx + 0.34 * R;
  const ez = cz - 0.3 * R;
  const mSigma = 0.27 * R;
  const eSigma = 0.15 * R;

  for (let z = 0; z < sz; z++) {
    for (let x = 0; x < sx; x++) {
      const dx = (x - cx) / R;
      const dz = (z - cz) / R;
      const d = Math.hypot(dx, dz);
      const fx = x / scale;
      const fz = z / scale;
      let m = 0.74 - d + 0.2 * fbm2(nShape, fx / 220, fz / 220, 4) + 0.05 * fbm2(nShape, fx / 60 + 31.7, fz / 60 - 12.3, 3);
      // The outer band is always sea, so the island never touches the edge of the world.
      m -= smoothstep(0.86, 1.0, Math.max(Math.abs(dx), Math.abs(dz))) * 0.7;
      land[z * sx + x] = m;

      let y: number;
      if (m <= 0) {
        y = seaLevel - 1.6 - 52 * (1 - Math.exp(m * 4.2)) + 1.8 * fbm2(nDetail, fx / 30, fz / 30, 3);
        y = Math.max(y, 5);
      } else {
        const coast = smoothstep(0, 0.07, m);
        const cliff = smoothstep(0.18, 0.4, nCliff.n2(fx / 150, fz / 150));
        y = seaLevel + 0.4 + 3 * coast + 16 * Math.pow(m, 0.85);
        y += cliff * smoothstep(0.008, 0.035, m) * 9;
        y += 9 * fbm2(nHills, fx / 90, fz / 90, 5) * smoothstep(0.03, 0.25, m);
        y += 1.6 * fbm2(nDetail, fx / 22, fz / 22, 3) * coast;
        const mm = Math.exp(-((x - mx) ** 2 + (z - mz) ** 2) / (2 * mSigma * mSigma));
        y += Math.pow(mm, 1.3) * (16 + 60 * ridged2(nRidge, fx / 120, fz / 120, 5));
        const em = Math.exp(-((x - ex) ** 2 + (z - ez) ** 2) / (2 * eSigma * eSigma));
        y += em * (7 + 15 * ridged2(nRidge, fx / 70 + 40, fz / 70 + 40, 4));
        if (y > 104) y = 104 + (y - 104) * 0.55;
      }
      h[z * sx + x] = clamp(y, 3, sy - 6);
    }
  }

  const at = (x: number, z: number): number => h[clamp(Math.round(z), 0, sz - 1) * sx + clamp(Math.round(x), 0, sx - 1)] as number;
  const landAt = (x: number, z: number): number => land[clamp(Math.round(z), 0, sz - 1) * sx + clamp(Math.round(x), 0, sx - 1)] as number;

  // --- village shelf: a low, level site within reach of the south-east shore ---
  let best = { x: cx + 0.3 * R, z: cz + 0.33 * R, score: -Infinity };
  for (let oz = -70; oz <= 70; oz += 10) {
    for (let ox = -70; ox <= 70; ox += 10) {
      const px = cx + 0.3 * R + ox * scale;
      const pz = cz + 0.33 * R + oz * scale;
      const y0 = at(px, pz);
      let rough = 0;
      let minLand = Infinity;
      for (let a = 0; a < 12; a++) {
        const ang = (a / 12) * Math.PI * 2;
        for (const r of [25, 50]) {
          const qx = px + Math.cos(ang) * r * scale;
          const qz = pz + Math.sin(ang) * r * scale;
          rough += Math.abs(at(qx, qz) - y0);
          minLand = Math.min(minLand, landAt(qx, qz));
        }
      }
      if (minLand < 0.04) continue;
      const shore = landAt(px, pz);
      const score = -rough * 0.12 - Math.abs(y0 - (seaLevel + 7)) * 0.6 - Math.abs(shore - 0.19) * 40;
      if (score > best.score) best = { x: px, z: pz, score };
    }
  }
  const vx = Math.round(best.x);
  const vz = Math.round(best.z);
  const vRadius = 78 * scale;
  const vy = Math.round(clamp(at(vx, vz), seaLevel + 4, seaLevel + 10));
  for (let z = Math.max(0, Math.floor(vz - vRadius)); z <= Math.min(sz - 1, Math.ceil(vz + vRadius)); z++) {
    for (let x = Math.max(0, Math.floor(vx - vRadius)); x <= Math.min(sx - 1, Math.ceil(vx + vRadius)); x++) {
      const r = Math.hypot(x - vx, z - vz);
      if (r > vRadius) continue;
      const i = z * sx + x;
      if ((land[i] as number) <= 0.012) continue;
      const t = smoothstep(vRadius, vRadius * 0.62, r);
      // Keep a little roll in the ground so the shelf is not a table top.
      h[i] = lerp(h[i] as number, vy + 0.8 * fbm2(nDetail, x / 40, z / 40, 2), t);
    }
  }

  // --- lake: a bowl between the mountain and the middle of the island ---
  const lx = Math.round(cx - 0.1 * R);
  const lz = Math.round(cz - 0.06 * R);
  const lakeRadius = Math.max(8, 30 * scale);
  const lakeLevel = Math.round(clamp(at(lx, lz) - 1, seaLevel + 9, seaLevel + 26));
  const water = new Int16Array(n).fill(-1);
  const flow = new Int8Array(n).fill(-1);
  for (let z = Math.max(0, Math.floor(lz - lakeRadius * 1.6)); z <= Math.min(sz - 1, Math.ceil(lz + lakeRadius * 1.6)); z++) {
    for (let x = Math.max(0, Math.floor(lx - lakeRadius * 1.6)); x <= Math.min(sx - 1, Math.ceil(lx + lakeRadius * 1.6)); x++) {
      const ang = Math.atan2(z - lz, x - lx);
      const rr = lakeRadius * (1 + 0.22 * nShape.n2(Math.cos(ang) * 1.7 + 9, Math.sin(ang) * 1.7 + 4));
      const r = Math.hypot(x - lx, z - lz);
      const i = z * sx + x;
      if (r <= rr) {
        const depth = 1.5 + 6 * (1 - (r / rr) ** 2);
        h[i] = Math.min(h[i] as number, lakeLevel - depth);
        water[i] = lakeLevel;
      } else if (r <= rr + 6) {
        // A rim so the lake holds its level, falling away gently where the land outside is lower.
        const rim = lakeLevel + 1 - Math.max(0, r - rr - 2) * 0.6;
        h[i] = Math.max(h[i] as number, rim);
      }
    }
  }

  // --- river: from the lake, past the village, to the sea ---
  const river: { x: number; z: number; level: number }[] = [];
  {
    const dirX = vx - lx;
    const dirZ = vz - lz;
    const len = Math.hypot(dirX, dirZ) || 1;
    const ux = dirX / len;
    const uz = dirZ / len;
    // Pass the village on its western side, then run on until well out to sea.
    const px = -uz;
    const pz = ux;
    const side = 58 * scale;
    const total = len * 1.9;
    let level = lakeLevel;
    let prevX = lx;
    let prevZ = lz;
    for (let s = lakeRadius * 0.5; s < total; s += 0.75) {
      const t = s / len;
      const lateral = side * smoothstep(0.25, 0.85, t) + 26 * scale * nShape.n2(s / (70 * scale) + 3.3, 7.7) * smoothstep(0.05, 0.3, t);
      const x = lx + ux * s + px * lateral;
      const z = lz + uz * s + pz * lateral;
      if (x < 2 || z < 2 || x > sx - 3 || z > sz - 3) break;
      const ground = at(x, z);
      const profile = lakeLevel - (lakeLevel - (seaLevel - 1)) * smoothstep(0.02, 1.02, t);
      level = Math.min(level, Math.max(seaLevel - 1, Math.min(Math.floor(ground) - 1, Math.ceil(profile))));
      const ang = Math.atan2(-(z - prevZ), x - prevX);
      river.push({ x, z, level });
      prevX = x;
      prevZ = z;
      if (landAt(x, z) < -0.03) break;
      const dir = ((Math.round(ang / (Math.PI / 4)) % 8) + 8) % 8;
      const halfWidth = lerp(1.8, 3.4, smoothstep(0, 1, t)) * Math.max(0.7, scale);
      const reach = halfWidth + 4;
      for (let cz2 = Math.floor(z - reach); cz2 <= Math.ceil(z + reach); cz2++) {
        for (let cx2 = Math.floor(x - reach); cx2 <= Math.ceil(x + reach); cx2++) {
          if (cx2 < 0 || cz2 < 0 || cx2 >= sx || cz2 >= sz) continue;
          const dist = Math.hypot(cx2 - x, cz2 - z);
          if (dist > reach) continue;
          const i = cz2 * sx + cx2;
          if (dist <= halfWidth) {
            if ((water[i] as number) === lakeLevel && level === lakeLevel) continue;
            const existing = water[i] as number;
            const w = existing >= 0 ? Math.min(existing, level) : level;
            water[i] = w;
            flow[i] = dir;
            h[i] = Math.min(h[i] as number, w - 1 - Math.round(1.3 * (1 - dist / halfWidth)));
          } else if ((water[i] as number) < 0) {
            // Banks: a shallow valley that never dips below the waterline.
            const bank = level + 1 + (dist - halfWidth) * 1.1;
            h[i] = Math.max(Math.min(h[i] as number, bank), level + 1);
          }
        }
      }
    }
  }

  // --- integer heights, sea, biomes ---
  const height = new Int16Array(n);
  const biome = new Uint8Array(n);
  for (let i = 0; i < n; i++) height[i] = Math.round(h[i] as number);
  for (let i = 0; i < n; i++) {
    if ((water[i] as number) < 0 && (height[i] as number) < seaLevel - 1) water[i] = seaLevel - 1;
    if ((water[i] as number) >= 0 && (height[i] as number) >= (water[i] as number)) height[i] = (water[i] as number) - 1;
  }
  for (let z = 0; z < sz; z++) {
    for (let x = 0; x < sx; x++) {
      const i = z * sx + x;
      const y = height[i] as number;
      const m = land[i] as number;
      let slope = 0;
      if (x > 0) slope = Math.max(slope, Math.abs((height[i - 1] as number) - y));
      if (x < sx - 1) slope = Math.max(slope, Math.abs((height[i + 1] as number) - y));
      if (z > 0) slope = Math.max(slope, Math.abs((height[i - sx] as number) - y));
      if (z < sz - 1) slope = Math.max(slope, Math.abs((height[i + sx] as number) - y));
      const inVillage = Math.hypot(x - vx, z - vz) < vRadius * 1.15;
      const moisture = fbm2(nMoist, x / scale / 130, z / scale / 130, 3);
      let b: number;
      if ((water[i] as number) >= 0) b = BIOME_SEA;
      else if (y <= seaLevel + 1 && m < 0.06 && slope < 3) b = BIOME_BEACH;
      else if (y >= 108) b = BIOME_SNOW;
      else if (slope >= 3 || y >= 98) b = BIOME_ROCK;
      else if (inVillage) b = BIOME_VILLAGE;
      else if (y >= 84) b = BIOME_HIGHLAND;
      else if (y >= 68 && moisture > -0.25) b = BIOME_PINE;
      else if (moisture > 0.02) b = BIOME_FOREST;
      else b = BIOME_MEADOW;
      biome[i] = b;
    }
  }

  return {
    config,
    height,
    water,
    flow,
    biome,
    land,
    lake: { x: lx, z: lz, radius: lakeRadius, level: lakeLevel },
    village: { x: vx, z: vz, y: vy, radius: vRadius },
    river,
    noise: { detail: nDetail, moisture: nMoist, patch: nPatch },
  };
}
