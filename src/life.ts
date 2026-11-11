// The living part of the world: the wildlife and (where the island has one)
// the village, built on one shared context so each can see the other. Hunters
// and fishers draw on the wildlife, foxes and wolves on the farm animals, and
// every animal keeps its distance from people and from the player.

import type { Rng } from './core/rng';
import type { Area, EntityView, InspectInfo, SimContext, VillagePlan, WorldActions } from './sim/api';
import type { Clock } from './sim/clock';
import { EcoSim } from './sim/eco';
import { VillageSim } from './sim/village';
import type { WeatherView } from './sim/weather';
import type { World } from './world/world';

/** How far round the village square wild animals keep out, in blocks. Foxes slip in at night all the same. */
const VILLAGE_KEEP_OUT = 62;
/** Ids below this belong to the village (people and farm animals); the wildlife starts here. */
const WILD_IDS = 100000;

/** The ground wild animals should leave alone: the built-up middle, and every field and pen beyond it. */
function keepOut(plan: VillagePlan): Area[] {
  const areas: Area[] = [{ x: plan.center.x, z: plan.center.z, radius: VILLAGE_KEEP_OUT }];
  for (const r of [...plan.fields, ...plan.pens]) {
    areas.push({ x: (r.x0 + r.x1 + 1) / 2, z: (r.z0 + r.z1 + 1) / 2, radius: Math.hypot(r.x1 - r.x0 + 1, r.z1 - r.z0 + 1) / 2 + 5 });
  }
  return areas;
}

export class Life {
  readonly ctx: SimContext;
  readonly eco: EcoSim;
  /** Null on an island too small to hold a village. */
  readonly village: VillageSim | null;
  /** Where the player is; the game keeps it current, and the simulations read it. */
  readonly player = { x: 0, y: 0, z: 0 };

  constructor(world: World, clock: Clock, weather: WeatherView, rng: Rng, plan: VillagePlan | null, actions: WorldActions) {
    this.ctx = { world, clock, weather, rng, actions, player: this.player };
    this.eco = new EcoSim(this.ctx, { avoid: plan ? keepOut(plan) : [] });
    this.ctx.wildlife = this.eco.wildlife;
    this.village = plan ? new VillageSim(this.ctx, plan) : null;
    if (this.village) {
      const people = this.village.people;
      this.ctx.livestock = this.village.livestock;
      this.ctx.people = () => people;
    }
  }

  /** Advance every simulation by one clock step. The caller has advanced the clock and the weather. */
  tick(): void {
    this.village?.tick();
    this.eco.tick();
  }

  /** Append every creature that can be seen to `out`. */
  collect(out: EntityView[]): void {
    if (this.village) for (const v of this.village.views) if (!v.hidden) out.push(v);
    for (const v of this.eco.views) if (!v.hidden) out.push(v);
  }

  inspect(id: number): InspectInfo | null {
    return id < WILD_IDS ? (this.village?.inspect(id) ?? null) : this.eco.inspect(id);
  }
}
