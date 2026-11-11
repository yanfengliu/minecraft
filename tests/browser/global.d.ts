// What the page publishes for the browser gate; mirrors DebugApi in src/main.ts.
export {};

declare global {
  interface Window {
    __tidewick?: {
      ready: boolean;
      webgl2: boolean;
      renderer: string;
      error: string | null;
      game: {
        info: { spawn: { x: number; y: number; z: number } };
        player: { x: number; y: number; z: number; onGround: boolean; flying: boolean };
        plan: {
          center: { x: number; y: number; z: number };
          buildings: unknown[];
          fields: unknown[];
          lamps: unknown[];
        } | null;
        pool: { pending: number };
        fps: number;
        stop(): void;
        world: { get(x: number, y: number, z: number): number; set(x: number, y: number, z: number, state: number): boolean };
        renderer: { settings: { ssao: boolean; shafts: boolean; bloom: boolean; fxaa: boolean } };
        inventory: { count(item: number): number };
        physics: {
          spawnBlock(state: number, x: number, y: number, z: number): number;
          spawnItem(item: number, count: number, x: number, y: number, z: number): number;
          bodies: readonly { id: number; kind: string; y: number; sleeping: boolean }[];
          stats: { bodies: number; awakeBodies: number; falling: number; stepMs: number };
        };
      } | null;
      look(x: number, y: number, z: number, yawDeg: number, pitchDeg: number): void;
      setHour(hour: number): void;
      setWeather(regime: string | null): void;
      setTimeScale(scale: number): void;
      step(seconds: number): void;
      probe(cols?: number, rows?: number): number[];
      stats(): Record<string, number | string>;
      block(name: string): number;
      item(name: string): number;
    };
  }
}
