import { expect, test } from '@playwright/test';

// The build must boot in a real browser on a hardware WebGL2 context. A
// software rasteriser here would make every later visual gate slow and
// unrepresentative, so it fails unless ALLOW_SOFTWARE_GL=1 says this host has
// no GPU.
test('boots on a hardware WebGL2 context', async ({ page }) => {
  const errors: string[] = [];
  page.on('pageerror', (e) => errors.push(String(e)));
  page.on('console', (m) => {
    if (m.type() === 'error') errors.push(m.text());
  });
  await page.goto('/');
  await page.waitForFunction(() => window.__tidewick !== undefined, undefined, { timeout: 60_000 });
  const report = await page.evaluate(() => window.__tidewick);
  expect(report?.error).toBeNull();
  expect(report?.webgl2).toBe(true);
  console.log(`WebGL renderer: ${report?.renderer}`);
  if (process.env.ALLOW_SOFTWARE_GL !== '1') {
    expect(report?.renderer ?? '').not.toMatch(/swiftshader|llvmpipe|software|basic render/i);
  }
  expect(errors).toEqual([]);
});
