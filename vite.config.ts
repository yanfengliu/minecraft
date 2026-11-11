import { defineConfig } from 'vitest/config';

// Ports are fixed so the dev preview, the browser gate and any second checkout
// never guess: dev 5317, built preview 4317 (the browser gate serves the build).
export default defineConfig({
  base: './',
  server: { host: '127.0.0.1', port: 5317, strictPort: true },
  preview: { host: '127.0.0.1', port: 4317, strictPort: true },
  worker: { format: 'es' },
  build: {
    target: 'es2023',
    sourcemap: true,
    chunkSizeWarningLimit: 4096,
  },
  test: {
    include: ['src/**/*.test.ts'],
    environment: 'node',
    // Simulation soak tests run whole in-game seasons; they are still unit
    // tests, so the budget is generous rather than split into a second lane.
    testTimeout: 60_000,
  },
});
