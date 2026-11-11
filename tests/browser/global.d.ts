// What the page publishes for the browser gate (see src/main.ts and src/debug.ts).
export {};

declare global {
  interface Window {
    __tidewick?: {
      ready: boolean;
      webgl2: boolean;
      renderer: string;
      error: string | null;
      [key: string]: unknown;
    };
  }
}
