import { defineConfig } from '@playwright/test';

// The browser gate serves the production build and renders on the machine's GPU.
// Fleet R22: a gate that rasterises a deferred renderer on the CPU of a machine
// with a GPU is a defect, so the launch flags ask ANGLE for D3D11 and the smoke
// test fails on a software renderer unless ALLOW_SOFTWARE_GL=1 says a GPU-less
// host is expected.
export default defineConfig({
  testDir: './tests/browser',
  outputDir: './output/playwright',
  fullyParallel: false,
  workers: 1,
  retries: 0,
  timeout: 180_000,
  reporter: [['line']],
  use: {
    browserName: 'chromium',
    headless: true,
    viewport: { width: 1280, height: 720 },
    deviceScaleFactor: 1,
    baseURL: 'http://127.0.0.1:4317',
    trace: 'retain-on-failure',
    screenshot: 'only-on-failure',
    launchOptions: {
      args: ['--use-angle=d3d11', '--enable-gpu', '--ignore-gpu-blocklist', '--enable-unsafe-webgpu'],
    },
  },
  webServer: {
    command: 'npm run preview',
    url: 'http://127.0.0.1:4317',
    reuseExistingServer: false,
    timeout: 60_000,
  },
});
