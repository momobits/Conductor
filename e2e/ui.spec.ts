// e2e/ui.spec.ts
//
// Headless Chromium e2e for the Conductor Control Room UI, driving a REAL
// daemon serving a KEYLESS offline .conductor/ repo. Codifies the manual
// dogfood run:
//   - Board renders the seeded card tile + the 7 lifecycle columns w/ badges.
//   - Card-detail renders the dossier + per-op artifact sections; analyze/plan
//     sidebar buttons enabled, review/implement/verify/resolve disabled for a
//     `discovered` card.
//   - "Run analyze" → the analyze section shows "last run:" + renders the
//     artifact (no longer "— not yet run —"). THIS is the regression guard for
//     the artifact-discovery bug (card_artifacts_index discovers by run-dir
//     contents, not events.jsonl — see src/rpc/methods.ts:874).
//   - "Run plan" → plan section renders too (proves the per-op index + op chain).
//   - #/monitor renders brain status (idle/standby) + a Start brain button.
//
// Fully keyless: routing.default='offline' routes every op to the deterministic
// OfflineAdapter (no ANTHROPIC_API_KEY, no network). Each run creates its own
// temp git repo + daemon and tears them down in afterAll.
//
// Assumes dist/ is fresh — the `test:e2e` script runs `npm run build` first.

import { test, expect, type Page } from '@playwright/test';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync, readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { simpleGit } from 'simple-git';

// ── Types for the dist daemon import (no .d.ts dependency on src/) ──────────
interface DaemonHandle {
  url: string;
  port: number;
  shutdown: () => Promise<void>;
}
type StartDaemon = (args: { repo: string; port: number }) => Promise<DaemonHandle>;

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(HERE, '..');
const DIST_DAEMON = pathToFileURL(join(REPO_ROOT, 'dist', 'daemon', 'index.js')).href;
const DIST_CLI = join(REPO_ROOT, 'dist', 'cli', 'index.js');

const CARD_SLUG = 'e2e-offline-demo';
const CARD_TITLE = 'E2E offline demo card';
// runCardNew derives the id as `${YYYY-MM-DD}-${normalizedSlug}` from `new Date()`.
// We resolve the real id post-creation from the created card path rather than
// recomputing the date here (avoids a midnight-rollover race).

let tmp: string;
let handle: DaemonHandle;
let token: string;
let baseURL: string;
let cardId: string;

// The 7 lifecycle columns, in board order.
const COLUMNS = [
  'discovered', 'planned', 'approved', 'building',
  'verifying', 'shipped', 'archived',
] as const;

test.describe.configure({ mode: 'serial' });

test.beforeAll(async () => {
  // 1. Temp git repo with identity + a seed commit + a fixture file.
  tmp = mkdtempSync(join(tmpdir(), 'conductor-e2e-'));
  const git = simpleGit(tmp);
  await git.init();
  await git.addConfig('user.email', 'e2e@conductor.test');
  await git.addConfig('user.name', 'Conductor E2E');
  await git.addConfig('commit.gpgsign', 'false');
  writeFileSync(join(tmp, 'math.js'), 'export const add = (a, b) => a + b;\n', 'utf8');
  await git.add(['math.js']);
  await git.commit('chore: seed fixture');

  // 2. Scaffold a keyless offline .conductor/ via the REAL CLI (realism: this
  //    is the exact `conductor init --provider offline` code path users run).
  //    --no-detect-verify keeps the offline preset's verify_command untouched.
  execFileSync(process.execPath, [DIST_CLI, 'init', '--provider', 'offline', '--no-detect-verify'], {
    cwd: tmp,
    stdio: 'pipe',
  });

  // 3. File a card via the CLI. The daemon isn't up yet, so runCardNew takes
  //    its filesystem path (discoverDaemon returns null) and writes the card.
  const cardOut = execFileSync(
    process.execPath,
    [DIST_CLI, 'card', 'new', CARD_SLUG, '--title', CARD_TITLE, '--kind', 'feature'],
    { cwd: tmp, stdio: 'pipe' },
  ).toString();
  // CLI prints `Card created: <path>`; derive the id from the filename.
  const m = cardOut.match(/Card created: (.+\.md)\s*$/);
  if (!m) throw new Error(`could not parse card path from CLI output: ${cardOut}`);
  cardId = m[1]!.trim().replace(/\\/g, '/').split('/').pop()!.replace(/\.md$/, '');

  // Commit the scaffold so the repo is clean (the offline implement op commits;
  // a dirty tree isn't required here, but keeps the fixture tidy).
  await git.add(['.conductor', '.gitignore']);
  await git.commit('chore: conductor init + seed card');

  // 4. Start the real daemon on a random port (port 0). Import from dist.
  //    startDaemon() awaits server.listen() before resolving, so the HTTP
  //    server is already accepting connections by the time the handle returns.
  const mod = (await import(DIST_DAEMON)) as { startDaemon: StartDaemon };
  handle = await mod.startDaemon({ repo: tmp, port: 0 });
  baseURL = handle.url;

  // 5. Read the auth token the daemon wrote. The UI authenticates via
  //    ?token=<token> on first load.
  token = readFileSync(join(tmp, '.conductor', 'auth.token'), 'utf8').trim();

  // 6. Deterministic readiness gate: poll the daemon over real HTTP until it
  //    answers an authenticated request before any browser navigation. This
  //    closes the (theoretical) window between server.listen() resolving and
  //    the first request being serviceable, and keeps CI (slower, Linux) from
  //    racing the very first page.goto against a not-quite-warm server.
  await waitForDaemonReady(baseURL, token);
});

/**
 * Probe the daemon over HTTP (the same auth path the UI uses) until it returns
 * a non-5xx response or the deadline elapses. We hit `/` (the UI shell) with the
 * bearer token; any 2xx/3xx/4xx means the listener + auth middleware are live.
 * Uses Node's global fetch (Node 20+); no Playwright browser needed.
 */
async function waitForDaemonReady(base: string, tok: string, timeoutMs = 20_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  let lastErr: unknown;
  while (Date.now() < deadline) {
    try {
      const r = await fetch(`${base}/?token=${encodeURIComponent(tok)}`, {
        headers: { authorization: `Bearer ${tok}` },
      });
      // Drain the body so the socket is released promptly (no lingering
      // half-open connection that server.close() would later wait on).
      await r.arrayBuffer().catch(() => undefined);
      if (r.status < 500) return;
      lastErr = new Error(`daemon not ready: HTTP ${r.status}`);
    } catch (e) {
      lastErr = e;
    }
    await new Promise((res) => setTimeout(res, 100));
  }
  throw new Error(`daemon did not become ready within ${timeoutMs}ms: ${String(lastErr)}`);
}

test.afterAll(async () => {
  // Teardown ordering matters. The daemon's HTTP server.close() waits for all
  // in-flight connections to drain — and the UI holds a long-lived SSE stream
  // (GET /events) open for the duration of each page. Playwright tears down the
  // per-test page (and thus its SSE fetch) before this afterAll runs, so the
  // connection is normally already gone. But to make teardown BULLETPROOF
  // regardless of client timing, we race shutdown() against a hard cap so the
  // suite can never hang on a stray half-open SSE socket. After the daemon is
  // down, the browser-side SSE client (events.ts connectLoop) would see
  // ECONNREFUSED — that error is caught internally and the spec never asserts on
  // console errors, so post-shutdown reconnect noise is benign by construction.
  try {
    if (handle) {
      await Promise.race([
        handle.shutdown(),
        new Promise<void>((res) => setTimeout(res, 10_000)),
      ]);
    }
  } catch {
    // A shutdown error must not mask test results or leak the temp dir.
  } finally {
    if (tmp) {
      try {
        rmSync(tmp, { recursive: true, force: true });
      } catch {
        // Windows can briefly hold a handle on the just-closed sqlite/runtime
        // file; force:true already retries. Swallow any residual EBUSY so a
        // teardown filesystem hiccup never reports the run as failed.
      }
    }
  }
});

/** Navigate to a hash route with the token query param (first-load auth). */
async function gotoWithToken(page: Page, hash: string): Promise<void> {
  await page.goto(`${baseURL}/?token=${encodeURIComponent(token)}${hash}`);
}

test('board loads: title, seeded card tile, and 7 columns with autonomy badges', async ({ page }) => {
  await gotoWithToken(page, '#/board');

  await expect(page).toHaveTitle('Conductor — Control Room');

  // Status pill flips to connected once the initial scan RPC succeeds.
  await expect(page.locator('#status')).toHaveAttribute('data-state', 'connected');

  // The seeded card tile renders (links to #/card/<id>).
  const tile = page.locator(`a.card-tile[data-id="${cardId}"]`);
  await expect(tile).toBeVisible();
  await expect(tile.locator('.title')).toHaveText(CARD_TITLE);

  // All 7 lifecycle columns render, each with a count + an autonomy/final badge.
  for (const col of COLUMNS) {
    const column = page.locator(`section.column[data-column="${col}"]`);
    await expect(column).toBeVisible();
    await expect(column.locator('.col-count')).toBeVisible();
    // policyForExit() always emits a badge (per-edge policy, or 'final' for
    // the terminal archived column).
    await expect(column.locator('.column-head .badge')).toHaveCount(1);
  }

  // The seeded card sits in `discovered` (one tile in that column).
  await expect(
    page.locator('section.column[data-column="discovered"] a.card-tile'),
  ).toHaveCount(1);
});

test('card detail: dossier + per-op sections render; analyze/plan enabled, others disabled', async ({ page }) => {
  await gotoWithToken(page, '#/board');
  await page.locator(`a.card-tile[data-id="${cardId}"]`).click();

  // URL hash routes to the card.
  await expect(page).toHaveURL(new RegExp(`#/card/${cardId.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}$`));

  // Dossier: the side panel renders the card title + frontmatter (id row).
  const side = page.locator('aside.side');
  await expect(side.locator('h3')).toHaveText(CARD_TITLE);
  await expect(side.locator('dl dt', { hasText: 'id' })).toBeVisible();

  // Description surface (the card body) renders.
  await expect(page.locator('section.surface.description .render')).toBeVisible();

  // Per-op artifact section hosts render for the pipeline ops.
  for (const op of ['analyze', 'plan', 'review', 'implement', 'verify']) {
    await expect(page.locator(`section.op-section[data-op="${op}"]`)).toBeAttached();
  }

  // Sidebar op buttons: discovered → analyze + plan enabled; the rest disabled.
  const btn = (op: string) => page.locator(`#op-controls button[data-op="${op}"]`);
  await expect(btn('analyze')).toBeEnabled();
  await expect(btn('plan')).toBeEnabled();
  await expect(btn('review')).toBeDisabled();
  await expect(btn('implement')).toBeDisabled();
  await expect(btn('verify')).toBeDisabled();
  await expect(btn('resolve')).toBeDisabled();
});

test('Run analyze: section renders artifact (regression guard for artifact discovery)', async ({ page }) => {
  await gotoWithToken(page, `#/card/${cardId}`);

  const analyzeSection = page.locator('section.op-section[data-op="analyze"]');
  // Pre-state: not yet run. (Web-first retry covers the async per-op render that
  // fires on mount — if the section paints empty-then-populated we still catch
  // the CTA before the click.)
  await expect(analyzeSection).toContainText('— not yet run —');

  // Click the sidebar "Analyze" button (op_invoke runs the offline analyze op).
  // Wait for the button-state machine to enable it first: the sidebar handler is
  // bound at mount but applyButtonStates() runs after the card RPC resolves, so
  // on a cold/slow box the button is briefly present-but-disabled. click()
  // already auto-waits for actionability, but the explicit toBeEnabled() turns a
  // silent no-op click into a clear, fast failure if enablement ever regresses.
  const analyzeBtn = page.locator('#op-controls button[data-op="analyze"]');
  await expect(analyzeBtn).toBeEnabled();
  await analyzeBtn.click();

  // Web-first wait: op_complete SSE fires → section re-queries the artifacts
  // index and re-renders. The header now shows "last run:" and the section no
  // longer shows the empty CTA. THIS is the artifact-discovery regression guard.
  await expect(analyzeSection).toContainText('last run:', { timeout: 30_000 });
  await expect(analyzeSection).not.toContainText('— not yet run —');

  // The rendered artifact markdown is present (the offline analyze stub emits a
  // "## Approach" heading among others — assert a stable substring).
  await expect(analyzeSection.locator('.render')).toContainText('OFFLINE STUB');
});

test('Run plan: section renders its artifact (per-op index + op chain)', async ({ page }) => {
  await gotoWithToken(page, `#/card/${cardId}`);

  const planSection = page.locator('section.op-section[data-op="plan"]');
  await expect(planSection).toContainText('— not yet run —');

  const planBtn = page.locator('#op-controls button[data-op="plan"]');
  await expect(planBtn).toBeEnabled();
  await planBtn.click();

  await expect(planSection).toContainText('last run:', { timeout: 30_000 });
  await expect(planSection).not.toContainText('— not yet run —');
  // Offline plan stub emits a "Step 1.1 — offline placeholder" line.
  await expect(planSection.locator('.render')).toContainText('offline placeholder');
});

test('monitor: renders brain status (idle/standby) + Start brain button', async ({ page }) => {
  await gotoWithToken(page, '#/monitor');

  await expect(page.locator('.monitor h1')).toHaveText('Monitor');

  // Brain is idle on a fresh daemon — the live pill reads "idle · standby".
  const pill = page.locator('.brain-live');
  await expect(pill).toHaveAttribute('data-running', 'false');
  await expect(pill).toContainText('idle · standby');

  // Start brain button is present + enabled (brain not running).
  const startBtn = page.locator('.brain-actions button[data-act="start"]');
  await expect(startBtn).toBeVisible();
  await expect(startBtn).toBeEnabled();
  await expect(startBtn).toHaveText('Start brain');
});
