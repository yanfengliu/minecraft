// What the interface needs of the game it is drawn over. The game is the layer
// above this one, so the interface does not import it: it names here what it
// reads and what it may ask for, and the game is handed in as something that
// has those. Everything named is from a layer below.

import type { Input } from '../player/input';
import type { Inventory } from '../player/inventory';
import type { Trade } from '../player/trade';
import type { RenderStats } from '../render/renderer';
import type { TileSet } from '../render/tiles';
import type { EntityView, InspectInfo, VillagePlan } from '../sim/api';
import type { Clock } from '../sim/clock';
import type { EcoSim } from '../sim/eco';
import type { VillageSim } from '../sim/village';
import type { Regime, Weather } from '../sim/weather';

/** Something said or shown above a creature's head. */
export interface Speech {
  x: number;
  y: number;
  z: number;
  text: string;
  kind: 'bubble' | 'tag';
}

export interface GameHost {
  readonly plan: VillagePlan | null;
  readonly renderer: { readonly tileSet: TileSet; readonly stats: RenderStats };
  readonly clock: Clock;
  readonly weather: Weather;
  readonly input: Input;
  readonly player: { readonly x: number; readonly y: number; readonly z: number };
  readonly inventory: Inventory;
  /** The village (null where the island has none) and the wildlife. */
  readonly life: { readonly village: VillageSim | null; readonly eco: EcoSim };
  /** The player's dealings with the village; null where there is none. */
  readonly trade: Trade | null;
  /** Simulated seconds per real second. */
  timeScale: number;
  paused: boolean;
  /** The weather pinned from the almanac, or null while it runs free. */
  readonly forcedWeather: Regime | null;
  readonly fps: number;
  readonly frameMs: number;
  /** The creature under the crosshair, within reach, if any. */
  readonly focus: EntityView | null;

  setWeather(regime: Regime | null): void;
  setHour(hour: number): void;
  skipDays(days: number): void;
  inspect(id: number): InspectInfo | null;
  /** What a right click would do to the creature in focus, as a line to show under the crosshair. */
  focusPrompt(): string;
  speech(): Speech[];
  /** Where a point in the world falls on the screen, as fractions of its width and height, or null if behind the camera. */
  project(x: number, y: number, z: number): { x: number; y: number; depth: number } | null;
  debugLines(): string[];
}
