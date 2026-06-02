// playwright.config.ts
//
// Headless Chromium e2e for the Conductor Control Room UI. The spec starts a
// live daemon against a keyless OFFLINE .conductor/ repo itself (see
// e2e/ui.spec.ts beforeAll), so there is NO global `webServer` here — the
// fixture owns daemon lifecycle + teardown.
//
// vitest globs `tests/**/*.test.ts`; this runner globs `e2e/**/*.spec.ts`, so
// the two suites never collide. Neither tsconfig (src/** and src/ui/**) compiles
// e2e/, so `npm run typecheck` / `npm run build` stay clean.

import { defineConfig, devices } from '@playwright/test';

export default defineConfig({
  testDir: './e2e',
  testMatch: '**/*.spec.ts',
  // All daemon/repo/git setup happens in beforeAll; 60s per test is generous
  // headroom for build-cold first paint + two offline op runs.
  timeout: 60_000,
  expect: { timeout: 15_000 },
  // Deterministic offline adapter → no flakiness budget needed locally.
  retries: 0,
  // Single worker: each spec owns one daemon on a random port; running specs
  // in parallel would still be safe (separate temp repos), but serial keeps
  // resource use predictable in CI.
  workers: 1,
  fullyParallel: false,
  forbidOnly: !!process.env['CI'],
  reporter: [['list']],
  // Screenshots / traces / results land in a gitignored dir.
  outputDir: 'e2e/.output/results',
  use: {
    headless: true,
    screenshot: 'only-on-failure',
    trace: 'retain-on-failure',
  },
  projects: [
    {
      name: 'chromium',
      use: { ...devices['Desktop Chrome'] },
    },
  ],
});
