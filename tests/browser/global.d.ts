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
      } | null;
      look(x: number, y: number, z: number, yawDeg: number, pitchDeg: number): void;
      setHour(hour: number): void;
      setWeather(regime: string | null): void;
      setTimeScale(scale: number): void;
      step(seconds: number): void;
      probe(cols?: number, rows?: number): number[];
      stats(): Record<string, number | string>;
    };
  }
}
