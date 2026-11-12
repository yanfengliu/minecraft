// Generation worker entry: builds the island off the main thread and hands the
// finished world back as transferable arrays.

import { type IslandInfo, generateIsland } from '../world/gen/island';
import type { IslandConfig } from '../world/gen/terrain';
import { buildVillage } from '../world/gen/village';
import type { VillagePlan } from '../world/plan';
import type { WorldData } from '../world/world';

export interface GenResult {
  world: WorldData;
  info: IslandInfo;
  plan: VillagePlan | null;
  timings: Record<string, number>;
}

interface Scope {
  onmessage: ((e: MessageEvent<IslandConfig>) => void) | null;
  postMessage(message: GenResult, transfer: Transferable[]): void;
}

const scope = self as unknown as Scope;

scope.onmessage = (e) => {
  const island = generateIsland(e.data, buildVillage, () => performance.now());
  const world = island.world.data();
  const transfer: Transferable[] = [world.uniform.buffer, world.uniformLight.buffer, world.heightmap.buffer];
  for (const b of world.blocks) if (b) transfer.push(b.buffer);
  for (const l of world.light) if (l) transfer.push(l.buffer);
  scope.postMessage({ world, info: island.info, plan: island.plan, timings: island.timings }, transfer);
};
