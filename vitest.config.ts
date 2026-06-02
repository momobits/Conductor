import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    globals: false,
    environment: 'node',
    include: ['tests/**/*.test.ts'],
    // Several integration tests spin up a real daemon (HTTP server + chokidar
    // watcher) or drive a card through the full pipeline against a real git
    // repo. In isolation these finish in ~1-4s, but under full-suite
    // parallelism they occasionally breach a 5s ceiling (notably the
    // daemon-shutdown, full-lifecycle-sweep, and offline-lifecycle tests).
    // 30s gives ample headroom for contention without letting a genuine hang
    // waste minutes. Tune per-test with the timeout arg where finer control
    // is needed.
    testTimeout: 30000,
    hookTimeout: 30000,
    passWithNoTests: true,
  },
});
