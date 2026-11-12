// The country round the village: where the woodcutters, the shepherd and the
// hunter go to work. Read off the terrain's biome map once the village has
// claimed its own ground.

import type { Area } from '../../plan';
import { BIOME_FOREST, BIOME_HIGHLAND, BIOME_MEADOW, BIOME_PINE, type Terrain } from '../terrain';

export interface Country {
  forest: Area;
  pasture: Area;
  hunting: Area;
}

/** Survey the land round a village centred on (cx, cz). `reserved` marks the columns the village has taken. */
export function surveyCountry(t: Terrain, reserved: Uint8Array, cx: number, cz: number): Country {
  const { sx, sz } = t.config;
  const inside = (x: number, z: number): boolean => x >= 2 && z >= 2 && x < sx - 2 && z < sz - 2;
  const open = (x: number, z: number): boolean => inside(x, z) && (t.water[z * sx + x] as number) < 0;

  /**
   * The best place between `rMin` and `rMax` blocks out for an area of this radius of the ground wanted;
   * failing any, `rMin` blocks out in the direction (fx, fz), beside a road.
   */
  const survey = (wanted: (biome: number) => boolean, rMin: number, rMax: number, radius: number, fx: number, fz: number): Area => {
    let best: Area = { x: cx + fx * rMin, z: cz + fz * rMin, radius };
    // Below this nothing found is worth more than the fallback beside the road.
    let bestScore = 0.25;
    for (let r = rMin; r <= rMax; r += 14) {
      for (let k = 0; k < 24; k++) {
        const ang = (k / 24) * Math.PI * 2;
        const x = Math.round(cx + Math.cos(ang) * r);
        const z = Math.round(cz + Math.sin(ang) * r);
        if (!open(x, z)) continue;
        let hits = 0;
        let samples = 0;
        for (let dz = -radius; dz <= radius; dz += 5) {
          for (let dx = -radius; dx <= radius; dx += 5) {
            const qx = x + dx;
            const qz = z + dz;
            samples++;
            if (open(qx, qz) && reserved[qz * sx + qx] === 0 && wanted(t.biome[qz * sx + qx] as number)) hits++;
          }
        }
        // How much of the place is the ground wanted, less a charge for the walk: it is walked there and
        // back every working day, so a wood twice as far has to be much the better wood. (Scored by
        // cover alone, the woodcutters were sent 180 blocks to the island's densest forest.)
        const score = hits / samples - 0.55 * ((r - rMin) / Math.max(1, rMax - rMin));
        if (score > bestScore) {
          bestScore = score;
          best = { x, z, radius };
        }
      }
    }
    return best;
  };

  return {
    forest: survey((b) => b === BIOME_FOREST || b === BIOME_PINE, 70, 190, 34, 0, -1),
    pasture: survey((b) => b === BIOME_MEADOW, 66, 150, 20, 1, 0),
    hunting: survey((b) => b === BIOME_FOREST || b === BIOME_PINE || b === BIOME_HIGHLAND, 105, 260, 55, 0, -1),
  };
}
