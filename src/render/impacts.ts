// What physics reports, turned into something to see: spray where a body
// meets water, dust where it lands hard, leaves and chips where a block bursts.

import { clamp } from '../core/math';
import type { PhysicsEvent } from '../physics/types';
import { IS_LEAVES } from '../world/blocks';
import type { Particles } from './particles';

type Rgb = readonly [number, number, number];

/** The colour of the dust each material throws up when something made of it lands hard; indexed like `MATERIALS`. */
export const DUST: readonly Rgb[] = [
  [0.4, 0.4, 0.4], [0.42, 0.42, 0.42], [0.3, 0.22, 0.14], [0.6, 0.52, 0.34], [0.4, 0.39, 0.37], [0.4, 0.28, 0.15], [0.2, 0.36, 0.12], [0.22, 0.38, 0.14],
  [0.7, 0.68, 0.62], [0.7, 0.8, 0.82], [0.45, 0.46, 0.48], [0.6, 0.5, 0.2], [0.45, 0.24, 0.17], [0.6, 0.72, 0.8], [0.9, 0.92, 0.95], [0.5, 0.36, 0.27],
];
/** Dust of wood, for a tree coming down. */
export const WOOD_DUST = DUST[5] as Rgb;

/** Throw the particles for one physics event. `colorOf` gives a block state's typical colour. */
export function showPhysicsEvent(fx: Particles, e: PhysicsEvent, colorOf: (state: number) => Rgb): void {
  switch (e.type) {
    case 'splash': fx.burst('splash', e.x, e.y, e.z, undefined, clamp(e.strength * 0.4, 0.5, 4)); break;
    case 'impact':
      if (e.energy > 1500) fx.burst('dust', e.x, e.y, e.z, DUST[e.material] ?? (DUST[0] as Rgb), clamp(e.energy / 20000, 0.5, 4));
      break;
    case 'collapse': fx.burst('dust', e.x, e.y, e.z, DUST[1] as Rgb, clamp(e.blocks / 3, 1, 6)); break;
    case 'burst': {
      const leaves = (IS_LEAVES[e.state] as number) === 1;
      fx.burst(leaves ? 'leaves' : 'break', e.x, e.y, e.z, colorOf(e.state), leaves ? 0.6 : 1);
      break;
    }
    case 'land': fx.burst('dust', e.x, e.y - 0.4, e.z, colorOf(e.state), 0.7); break;
  }
}
