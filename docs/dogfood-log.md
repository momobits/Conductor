# Conductor End-to-End Dogfood Log

Living log of comprehensive testing against a real project. Append-only by design; future sessions read this for continuity.

---

## Session: 2026-05-12 — Initial comprehensive test

### Environment

- **Conductor under test:**
  - Repo: `G:\Projects\Small-Projects\Harness\conductor`
  - Last phase tag: `phase-8-provider-expansion-closed` at `50be256`
  - HEAD before session: `dabbf2b` (docs: quickstart) — 9 follow-up commits past tag
  - Tests at session start: 460/460 passing across 95 files, typecheck clean
  - `conductor` CLI installed globally via `npm link`
- **Project under test:**
  - Path: `G:\Projects\Large-Projects\omniforge`
  - Type: Python project (`pyproject.toml`, `Makefile`, `alembic`, `src/`, `tests/`)
  - Already has `CLAUDE.md`, `AGENTS.md`, `GEMINI.md` (i.e., AI-assisted project)
  - Pre-test state: not yet conductor-initialized (`.conductor/` absent)
- **Adapter:**
  - Provider: `claude-sub:*` (Claude Code subscription, OAuth)
  - `claude` CLI version: 2.1.139
- **Date:** 2026-05-12

### Test plan

Phases run sequentially; conductor v1 isn't multi-Task-Agent-safe yet so parallelism isn't possible.

| Phase | Scope |
|---|---|
| T1 | Bootstrap + first card lifecycle (init, card new, work analyze+plan) |
| T2 | Discover + multi-card queue (scan, order, work on 2+ cards) |
| T3 | Lifecycle gates + halts (review, manual transition, force-advance) |
| T4 | Daemon + RPC + MCP + static UI + brain start/stop |
| T5 | Edge cases (missing card, malformed input, drift, cost telemetry, run log replay/prune) |
| T6 | Permutations (per-card model_overrides, different kinds, multi-step plans) |

---

## Findings log

(Subagents append issues, fixes, and recommendations below.)

### Format

For each finding:

```
### Issue Tnn-N: <short title>
- **Severity:** bug | quality | enhancement | observation
- **Phase:** T<n>
- **Command(s):**
- **Expected:**
- **Actual:**
- **Fix applied:** <commit sha> | None | Deferred to <phase>
- **Notes:**
```

---

## Fixes Applied (Session 2026-05-12)

| Commit | Finding(s) | Fix |
|---|---|---|
| `069bfa2` | T6-1 (critical) | `commitStep()` no longer runs `git add .`; requires explicit `files: string[]` parameter. `implement.ts` now passes the diff files + card markdown path, and the card update is appended BEFORE the commit so it's part of the same step commit. New regression tests prove unrelated uncommitted files stay out. |
| `e54ddbf` | T2-1, T6-2 | New `parseJsonResponse()` helper that strips markdown fences and falls back to extracting the first balanced JSON block. All 8 sites (discover, order, review, verify, implement, resolve, exercise×2) refactored. Verified end-to-end: `conductor discover` now files cards in omniforge (was crashing). |

## Deferred (Tracked for Future Sessions)

| Finding | Severity | Why deferred |
|---|---|---|
| T1-1 | quality | Plan op leaves `[need:]` placeholders for things the Analysis section already resolved. Possible fixes: stronger system prompt, or restructure prompt to require an "inputs from analysis" extraction pass. Worth a dedicated investigation. |
| T1-2 | observation | Work cycle latency (Opus subscription ~50–150s). Documentation issue; the quickstart's "60–120s" estimate is understated. Update timings. |
| T2-2 | quality | Discover writes `# Original Issue` (H1) while other ops use H2. One-line consistency fix in `discover.ts`. |
| T2-3 | quality | Discover has no topic-level dedup. Would file duplicate cards if same TODO surfaces twice. Needs an existing-cards check before filing. |
| T3-1, T3-2 | observation | Transition adjacency enforcement + duplicated recommendation storage. Working as designed; document. |
| T4-1 | quality | Brain events not persisted across daemon restarts. Tied to v2 SQLite migration. |
| T4-2 to T4-4 | observation | Auth token persistence, MCP session handshake, RPC recommend semantics — all working-as-designed; documentation gaps. |
| T5-1 | quality | `work` creates run dir before validating card exists; phantom error runs pollute `run list`. Fix: validate card path before instantiating RunLogWriter. |
| T5-2 | bug | `scan` bails entirely on one malformed card frontmatter; healthy cards hidden. Should log warning + continue. |
| T5-3 | quality | Misleading "Card not found" error when YAML is malformed (file exists, parse fails). Differentiate the error. |
| T5-4 to T5-6 | observation | Drift detection nuances — file list truncated at 10, staged vs unstaged not differentiated, `cost show` exits 0 when daemon down. |

## Final State (Session 2026-05-12)

- HEAD: `e54ddbf`
- Tests: **475/475 passing** across 96 files (was 460/95 at session start — net +15 tests from fix regression suite + parseJsonResponse coverage)
- Typecheck: clean
- Phase tag unchanged: `phase-8-provider-expansion-closed` at `50be256`
- Commits past tag: 11 follow-up fixes/features

omniforge state at session end:
- `.conductor/` initialized with subscription config
- Card `2026-05-12-health-check-endpoint` in `approved` (Original + Analysis + Plan + Adversarial Review + Implementation Guidelines)
- 10+ run logs (some are phantom error runs from T5-1)
- 9 newly-discovered cards in `discovered` (from the post-fix discover run that verified T2-1 end-to-end)
- One conductor-test commit `5e83e6b` lives in omniforge git history from the T6-1 era — working tree is clean now but that commit exists; consider `git reset HEAD~1` in omniforge if you don't want it.

---

## Findings

---

### T1 — Bootstrap + First Card Lifecycle

**Executed:** 2026-05-12  
**Card id:** `2026-05-12-health-check-endpoint`  
**Issue chosen:** "Add /health endpoint to FastAPI app" — real gap confirmed in codebase (no `/health` route in `src/api/routes.py`, no match for `grep "health" src/`).

#### T1.1 — `conductor init --provider subscription`

- **Timing:** < 1s
- **Output:** `Conductor initialized. .conductor/ scaffold ready (config source: subscription, verify_command: pytest).`
- **Verify checks:**
  - `config source: subscription` present in output — PASS
  - `verify_command: pytest` present in output — PASS (pyproject.toml correctly detected over Makefile)
  - All 7 expected subdirs created: `cards/`, `archive/`, `decisions/`, `phases/`, `exercise/`, `snapshots/`, `runs/` — PASS
  - `config.yaml` exists with `claude-sub:` routing for all ops — PASS
  - `state.md`, `ordering.md`, `journal.md` all exist — PASS
- **Observations:** Init is idempotent (re-running does not overwrite). Config contains correct subscription-specific comment block.

#### T1.2 — `conductor card new health-check-endpoint --title "Add /health endpoint to FastAPI app"`

- **Timing:** < 1s
- **Card file created:** `.conductor/cards/2026-05-12-health-check-endpoint.md` (local date 05-12)
- **Verify checks:**
  - File exists at expected path — PASS
  - Frontmatter: `column: discovered`, `kind: issue`, `source: user` — PASS
  - Edited body (description, file:line references, acceptance criteria) was preserved intact — PASS
- **Observations:** Placeholder text correctly present before edit; Edit tool replaced cleanly.

#### T1.3 — `conductor work 2026-05-12-health-check-endpoint`

- **Timing:** 194.7s total (analyze: ~151s, plan: ~43s)
- **Output:** `Done. Card now in column: planned` — PASS
- **Verify checks:**
  - `## Analysis` section appended to card — PASS
  - `## Implementation Plan` section appended to card — PASS
  - `column:` frontmatter updated to `planned` — PASS
  - Run directory created: `.conductor/runs/20260512T090108-2026-05-12-health-check-endpoint/` — PASS
  - `events.jsonl` contains 6 events: PASS
    - `op_start analyze` with `model: claude-sub:opus` — PASS
    - `op_complete analyze` — PASS
    - `op_start plan` — PASS
    - `op_complete plan` — PASS
    - `transition` from `discovered` to `planned` — PASS
    - `complete` — PASS
- **Note:** 194.7s exceeds the expected 60–120s estimate in the test plan. Both ops ran sequentially; analyze alone took 151s. This may reflect opus model latency under subscription or a large prompt.

#### T1.4 — LLM Output Quality Assessment

**Analysis quality: HIGH**

The `## Analysis` section is substantive and factually accurate against the actual source:

- Correctly identified `src/api/routes.py:150` (`create_app()`) and `:178` (`_register_routes()`) — verified correct.
- Correctly identified `src/api/middleware.py:80` (`RateLimitMiddleware`) — verified correct.
- Correctly identified `src/core/database.py:74` (`get_session()`) — verified correct.
- Correctly named `get_session_factory()` (line 59 in database.py) as the appropriate dep to use instead of `get_session`.
- Correctly reasoned why `Depends(get_session)` would produce 500 not 503 on DB failure (connection error in the dep generator raises before the handler runs).
- Correctly noted that `get_session_factory` is NOT currently imported in `routes.py` (only `get_session` and `dispose_engine` are — confirmed).
- Correctly noted `text` must be added to the `from sqlalchemy import func, select` line.
- Referenced `tests/test_routes.py:42-73` (`test_app` + `client_with_user` fixtures using `httpx.AsyncClient` + `ASGITransport`) — verified accurate.
- Correctly noted `tests/api/__init__.py` exists but directory is empty.
- Correctly identified that there is no existing path-based bypass in `RateLimitMiddleware.dispatch` (only a method == OPTIONS bypass) and that the card's AC #4 description of "add to OPTIONS skip list" was inaccurate.
- Referenced `.relay/relay-status.md` to confirm no prior health-check work — the `.relay/` dir does exist in omniforge.

One minor inaccuracy: The analysis stated the routes contain "9 `_register_*` helpers" — the actual `_register_routes()` body at line 178 calls exactly 9 helpers (`_register_auth`, `_register_ingestion`, `_register_voice`, `_register_generation`, `_register_accounts`, `_register_schedule`, `_register_viral`, `_register_credits`, `_register_analytics`) — confirmed accurate.

**Plan quality: MIXED — see finding T1-1 below**

---

### Issue T1-1: Implementation Plan has unresolved [need:] placeholders despite Analysis having answered them
- **Severity:** quality
- **Phase:** T1
- **Command(s):** `conductor work 2026-05-12-health-check-endpoint`
- **Expected:** Plan uses decisions made in the Analysis section; no open [need:] items that were already settled.
- **Actual:** The `## Implementation Plan` section contains multiple "[need:]" placeholders that the Analysis section had already resolved:
  - Step 1.2: `[need: analysis to specify whether path is /health (root) or /api/v1/health]` — the Analysis section's Approach already showed `@app.get("/health")` and explicitly chose `/health`.
  - Step 1.2: `[need: whether the endpoint should be a liveness-only check ... or a readiness check that probes Postgres/Redis]` — the Analysis chose readiness with DB probe.
  - Step 1.5: `[need: existing test directory path — CLAUDE.md doesn't name one]` — the card body explicitly listed `tests/api/` as the test location.
  - Step 1.5 says to place tests "alongside other API tests once located" when `tests/api/` was already known.
  - The "Open items requiring analysis follow-up" section at the bottom of the plan re-lists 5 items that the Analysis fully resolved, including the path choice and liveness vs. readiness decision.
- **Fix applied:** None
- **Notes:** The plan op runs after analyze, so it has the analysis output available. This suggests the plan prompt either (a) does not pass the analysis section as context, or (b) the model is not reading it. The end result is a plan that is less actionable than it should be — a developer following it would still need to make decisions that were already made in the analysis. This is a meaningful UX regression for the analyze→plan pipeline; the core value proposition is that the plan builds on the analysis.

---

### Issue T1-2: Work cycle wall time (194.7s) exceeds documented estimate (60–120s)
- **Severity:** observation
- **Phase:** T1
- **Command(s):** `conductor work 2026-05-12-health-check-endpoint`
- **Expected:** ~60–120s total (from quickstart.md: "Expect ~60–120s total")
- **Actual:** 194.7s total. Analyze: 151.1s, Plan: 43.0s.
- **Fix applied:** None
- **Notes:** The analyze call was 151s against the `claude-sub:opus` adapter. This may be normal for Opus under subscription at this time, or it may be an unusually large prompt due to the card body size. The plan call was 43s which is within range. The quickstart estimate should be updated to reflect that analyze-heavy cards can take 150s+, or the estimate should be qualified as model-dependent. Not a bug in conductor; worth noting as a documentation/expectation gap.

---

### T2 — Discover + Multi-Card Queue

**Executed:** 2026-05-12  
**Cards filed by discover:** 0 (discover failed — see Issue T2-1)  
**T2.3 (work discovered card):** Skipped — no cards filed  

#### T2.1 — `conductor discover`

- **Timing:** 59.3s
- **Model used:** `claude-sub:haiku` (per `routing.functions.discover` in config.yaml)
- **Output:** Exit code 1 — `Failed to parse discover JSON: Unexpected token 'B', "Based on m"... is not valid JSON`
- **Root cause:** The haiku model returned a preamble sentence ("Based on my analysis of the OmniForge codebase, I've identified specific, actionable gaps worth nominating as cards. Here are the key issues:") followed by a markdown-fenced JSON block. The `discover` op calls `JSON.parse(resp.text.trim())` which fails when there is any non-JSON content before the JSON.
- **Cards filed:** 0 — discover bailed before writing any cards. The T1 card `2026-05-12-health-check-endpoint` is untouched.

**Raw LLM output (recovered from error message) — 13 items the model nominated:**

| slug | source_evidence | Evidence real? |
|---|---|---|
| implement-media-file-download-and-resize | src/publishing/publisher.py:45 | REAL — line 45 is a docstring: `For MVP: returns the media URL directly (full download/resize not implemented).` |
| add-health-check-endpoints | CLAUDE.md architecture overview | Real file; but this is a thematic overlap with T1 card — discover didn't deduplicate by topic |
| add-circuit-breaker-pattern-for-external-apis | src/llm/router.py:21-24, src/publishing/publisher.py:21-22 | Partially real — retry logic exists at those files, but lines refer to `_RETRY_DELAYS` constants, not circuit-breaker gaps directly |
| add-correlation-id-request-tracing | src/api/middleware.py request logging | Plausible — middleware exists but no correlation ID confirmed without deeper check |
| add-idempotency-key-tracking | src/credits/manager.py, src/publishing/publisher.py | Files exist; idempotency gap is a reasonable inference |
| add-ratelimit-headers-to-responses | src/api/middleware.py:80-100 | File and line range real (RateLimitMiddleware); header omission plausible |
| add-metrics-and-instrumentation | pyproject.toml has no prometheus dependency | pyproject.toml exists; prometheus absence easily verifiable |
| implement-oauth-redirect-uri-validation | src/publishing/oauth.py:39-120 | File real; line range covers config loading — redirect URI validation gap is a reasonable concern |
| add-automatic-media-file-cleanup | src/generation/video.py, src/generation/carousel.py | Files real; cleanup gap plausible |
| add-database-connection-pool-monitoring | src/core/database.py async engine setup | File real; monitoring gap plausible |
| standardize-timeout-configuration-for-external-apis | src/llm/router.py:24, src/generation/image.py:103 | Partially verified — router.py has timeout config; image.py:103 not independently verified |
| add-openapi-swagger-documentation | src/api/routes.py FastAPI app setup | File real; OpenAPI config absence plausible for FastAPI |
| add-error-scenario-test-coverage | tests/ directory recent factory activity | Vague — "recent factory activity" is not a file:line reference |

**Note:** omniforge has zero TODO/FIXME comments in `src/` — `collectTodos()` returned `(none)`. All 13 nominations came from commit history analysis. The top item (`implement-media-file-download-and-resize`) had the strongest grounded source evidence (actual docstring at line 45). Most other items are inferred from architecture + file existence rather than concrete TODO/FIXME markers.

#### T2.2 — `conductor scan` and `conductor order`

**scan — Timing:** 0.8s  
**scan output:**
```
[planned] (1)
  2026-05-12-health-check-endpoint  p1  unassigned  — Add /health endpoint to FastAPI app
```

- Column grouping: PASS — `[planned] (1)` present
- Card shows id, priority (`p1`), phase (`unassigned`), title — PASS
- T1 card `2026-05-12-health-check-endpoint` visible in `planned` — PASS
- No `[discovered]` column (no discovered cards to show) — correct behavior given T2.1 failure

**order — Timing:** ~8s (first run), ~12s (second verification run)  
**order output:** `Ordering written: 1 card(s) ranked.` — PASS  
**.conductor/ordering.md exists:** PASS  
**Format check:** `1. 2026-05-12-health-check-endpoint — <rationale>` — PASS (matches `<rank>. <slug> — <reason>` format)  
**Rationale quality:** Appropriate for single card — referenced priority (1) and described card's unblocked state and deployment relevance.

**Note:** `order` also uses `JSON.parse(resp.text.trim())` with the same "no Markdown fence" instruction as `discover`. It succeeded here using `claude-sub:sonnet` (no explicit `order` function override, so falls back to `routing.default: claude-sub:sonnet`). Sonnet complied with the no-fence instruction; haiku did not. The ordering.md is regenerated fresh on each `conductor order` call (confirmed by timestamp change between runs).

#### T2.3 — Work a discovered card

**Skipped** — T2.1 filed zero cards due to JSON parse error.

#### T2.4 — Ordering quality

With only 1 card in the queue, ordering is trivially correct — rank 1 for the sole card with a sensible rationale. Cannot assess multi-card ranking logic from this test run. Would need discover to succeed (or manually file more cards) to evaluate cross-card ranking quality.

---

### Issue T2-1: `conductor discover` crashes when haiku returns preamble text before JSON
- **Severity:** bug
- **Phase:** T2
- **Command(s):** `conductor discover`
- **Expected:** `Filed N card(s):` or `No new cards filed.`
- **Actual:** Exit code 1 — `Failed to parse discover JSON: Unexpected token 'B', "Based on m"... is not valid JSON`. The haiku model (claude-sub:haiku) prepended one sentence of English prose then wrapped the JSON in a markdown code fence, violating the "Return ONLY a single JSON object on one line, no Markdown fence" instruction.
- **Fix applied:** None
- **Notes:** The fix is straightforward: extract the first `{...}` block from `resp.text` using a regex before calling `JSON.parse`, or strip markdown fences. A resilient parser would: (1) strip leading/trailing prose, (2) strip ` ```json ` fences, (3) then parse. This pattern is common when smaller models don't reliably follow strict output format instructions. The same vulnerability exists in `src/engine/ops/order.ts` (identical `JSON.parse(resp.text.trim())` pattern) — it just happened to not trigger because `sonnet` (the default model for `order`) complied. If `order` is ever routed to a model that adds fences, it will also fail. Both ops should use a fence-stripping extraction helper before JSON.parse.

---

### Issue T2-2: `discover` body template uses `# Original Issue` (H1) not `## Original Issue` (H2)
- **Severity:** quality
- **Phase:** T2
- **Command(s):** `conductor discover` (filing cards)
- **Expected:** Cards filed by discover have body section `## Original Issue` (H2), consistent with card body conventions and the work op which appends `## Analysis` and `## Implementation Plan` (H2).
- **Actual:** `src/cli/commands/discover.ts` line 57 writes `'# Original Issue'` (H1). This would make the heading visually over-prominent and inconsistent with sections appended later by the work op.
- **Fix applied:** None
- **Notes:** Cannot be verified against a real filed card (T2.1 failed before filing). Confirmed by reading discover.ts source.

---

### Issue T2-3: `discover` topic-level deduplication absent — health-check overlap with existing card
- **Severity:** quality
- **Phase:** T2
- **Command(s):** `conductor discover`
- **Expected:** Discover avoids nominating cards that duplicate the purpose of existing cards, even with different slugs.
- **Actual:** The haiku model nominated `add-health-check-endpoints` (about external API health probes) alongside the existing `2026-05-12-health-check-endpoint` (about the app's own /health endpoint). These are related topics. Current deduplication in `discover.ts` only checks for exact path match (`await access(path)` check on the slug-derived filename). It does not pass existing card titles/descriptions to the LLM for semantic dedup. A developer reviewing filed cards would need to manually identify the overlap.
- **Fix applied:** None
- **Notes:** Fix would be to include a summary of existing card titles in the discover user prompt so the LLM can avoid nominating redundant work.

---

### T3 — Lifecycle Gates + Halts

**Executed:** 2026-05-12  
**Card id:** `2026-05-12-health-check-endpoint`  
**Starting column:** `planned`  
**Ending column:** `approved`

#### T3.1 — `conductor work 2026-05-12-health-check-endpoint` (planned → review op)

- **Timing:** 29.0s total (review op alone: 28.3s per `durationMs` in events.jsonl)
- **Outcome:** `Halted: Review returned NEEDS-CHANGES. Card stays in 'planned'.` — review rejected the plan
- **Column after:** `planned` (unchanged)
- **events.jsonl verified:**
  - `op_start review` with `model: claude-sub:opus` — PASS
  - `op_complete review` with `durationMs: 28296` — PASS
  - `recommendation` event present with `recommended: re_plan` — PASS
  - `halt` event with `reason: "Review returned NEEDS-CHANGES. Card stays in 'planned'."` — PASS
  - Total: 4 events (op_start, op_complete, recommendation, halt)
- **Section name appended:** `## Adversarial Review` (exact heading)
- **Review quality: HIGH** — The review is substantive and directly evaluates the T1 implementation plan. It:
  - Correctly identifies that the plan's [need:] placeholders in Step 1.2 re-open design questions the Analysis already resolved (path = `/health`, readiness with DB probe, response shape `{"status":"ok","db":"ok"}`)
  - Correctly identifies the plan's Step 1.2 liveness-only default `{"status":"ok"}` (no DB call) as directly violating ACs #2/#3
  - Correctly identifies the omitted critical hazard: `Depends(get_session)` surfaces connection errors as 500 not 503, and the plan must require `get_session_factory()` with try/except
  - Provides specific, actionable change instructions (exact file:line, exact import names, exact test patterns to follow)
  - References the analysis's own recommendations back into the review critiques — the review clearly read the analysis, not just the plan in isolation
  - The required-changes list maps one-to-one to real deficiencies identified in T1's finding T1-1
- **Note:** The review independently reached the same conclusion as T1 finding T1-1 about the plan's main deficiency. This cross-validates T1-1. It also confirms the review op passes the full card body (analysis + plan) as context — the review cited analysis-specific details (e.g., `get_session_factory()` pattern, `tests/test_routes.py:42-73` fixture pattern) that were only present in the Analysis section.

#### T3.2 — `conductor transition 2026-05-12-health-check-endpoint approved`

- **Output:** `Card 2026-05-12-health-check-endpoint transitioned to approved.` — PASS (matches expected exactly)
- **Column after:** `approved` (confirmed via frontmatter grep) — PASS

#### T3.3 — Non-adjacent transition: `conductor transition 2026-05-12-health-check-endpoint shipped`

- **Actual behavior:** Exit code 1, error message: `Illegal transition: approved -> shipped`
- **Column after:** `approved` (unchanged — card was not moved)
- **Observation:** Conductor enforces adjacency on the `transition` command. A skip of multiple stages is rejected, not silently allowed. This is the safe behavior; the CLI guards even the human-controlled transition path against non-adjacent jumps.
- **Note:** The spec notes that the human-controlled `transition` command allows "direct overrides," but the actual implementation rejects non-adjacent transitions. Either the spec means only adjacent forward/backward moves qualify as overrides, or there is a spec/implementation mismatch. Either way, the behavior is safe.

#### T3.4 — Nonexistent column: `conductor transition 2026-05-12-health-check-endpoint garbage`

- **Actual behavior:** Exit code 1, error message: `Unknown column: garbage. Valid: discovered, planned, approved, building, verifying, shipped, archived`
- **Observation:** Error is clear and user-friendly — it enumerates all valid column names. Rejection happens at schema/validation level before any adjacency check. No crash or unhandled exception.

#### T3.5 — `conductor run list`

- **Output:** 2 run directories listed, most recent first — PASS
  - `20260512T091224-2026-05-12-health-check-endpoint` — 4 events (T3.1 review run)
  - `20260512T090108-2026-05-12-health-check-endpoint` — 6 events (T1 analyze+plan run)
- **Format:** `<run-dir>\t<completed-ts>\t<N> events` — clean tabular output

---

### Issue T3-1: `transition` command rejects non-adjacent moves despite spec suggesting human overrides are unrestricted
- **Severity:** observation
- **Phase:** T3
- **Command(s):** `conductor transition 2026-05-12-health-check-endpoint shipped`
- **Expected (per spec):** Possibly allowed as a "human override" since `transition` is explicitly human-controlled
- **Actual:** Exit code 1 — `Illegal transition: approved -> shipped`. Conductor enforces adjacency even on the manual transition command.
- **Fix applied:** None
- **Notes:** This is arguably the safer design and is not a bug. A developer who needs to jump multiple stages must call `conductor transition` twice. Worth documenting in the CLI help text. If the spec intends to allow multi-stage overrides, that is a spec/implementation mismatch; if "override" means only adjacent forward/backward, the implementation is correct.

---

### Issue T3-2: Review op `recommendation` event stores full rationale text in events.jsonl (duplication with card body)
- **Severity:** observation
- **Phase:** T3
- **Command(s):** `conductor work 2026-05-12-health-check-endpoint` (planned → review)
- **Expected:** events.jsonl captures the recommendation outcome; detailed rationale may live in card body only
- **Actual:** The `recommendation` event in events.jsonl includes the full `rationale` string for each option (`re_plan` and `reject`). The card's `## Adversarial Review` section is the human-readable version; events.jsonl contains a structured duplicate. No functional issue.
- **Fix applied:** None
- **Notes:** Duplication enables programmatic replay and audit of why a card was halted, which is valuable for tooling. Card body is for human readers; events.jsonl is for tooling. Both are correct in their roles. Flagging for storage/observability awareness only.

---

### T4 — Daemon + RPC + MCP + UI + Brain

**Executed:** 2026-05-12  
**Daemon endpoint:** `http://127.0.0.1:7180` (pid=29200 after restart for MCP session capture)  
**Card state at start:** `2026-05-12-health-check-endpoint` in `approved` — left unchanged throughout T4.

#### T4.1 — Daemon start + endpoint files

- **Command:** `Start-Process node ... daemon start --port 7180`
- **Status output:** `Up: pid=29200 endpoint=http://127.0.0.1:7180` — PASS
- **Endpoint files (all 4):**
  - `daemon.pid`: EXISTS — PASS
  - `daemon.endpoint`: EXISTS — PASS
  - `auth.token`: EXISTS, non-empty (first 8: `0de962ac`) — PASS
  - `mcp.endpoint`: EXISTS — PASS
- **Daemon stdout:** `Daemon up at http://127.0.0.1:7180 (pid=29200)` — PASS
- **Daemon stderr:** empty — PASS

#### T4.2 — JSON-RPC probes

All probes authenticated with valid Bearer token.

| Method | Params | Outcome | Notes |
|---|---|---|---|
| `conductor.card_list` | `{}` | OK — 1 card returned | Card `2026-05-12-health-check-endpoint` in result |
| `conductor.scan` | `{}` | OK — 1 card in `approved` column | Correct column grouping |
| `conductor.recommend` | `{}` | Error -32602 (param validation) | Method is for filing recommendations, NOT getting one; requires `cardId` + `recommendation` object. Test used wrong params. |
| `conductor.transition` | `{cardId:...,to:"discovered"}` | Error -32602 (param validation) | Param name is `id` not `cardId` |
| `conductor.transition` | `{id:...,to:"discovered"}` | Error -32603 — `Invalid transition: approved → discovered` | Non-adjacent backward move rejected — consistent with T3.3 CLI behavior |

**Note on `recommend`:** The method is wired and functional — it's a manual recommendation-filing endpoint for plugins. It is not a "get next card recommendation" method. The test description was misleading. The method itself works correctly.

**RPC methods wired (26 total, from source inspection):**
`card_new`, `card_get`, `card_list`, `card_update`, `transition`, `scan`, `order`, `discover`, `exercise_new`, `exercise_file`, `work_card`, `work_next`, `recommend`, `config_get`, `config_set`, `session_status`, `chat`, `conductor_start`, `conductor_stop`, `conductor_status`, `conductor_set_autonomy`, `tracker_pull`, `run_list`, `run_replay`, `run_prune`, `cost_show`.

#### T4.3 — Auth enforcement

| Case | Expected | Actual |
|---|---|---|
| No Authorization header | 401 | **401** — PASS |
| `Authorization: Bearer wrong-token` | 401 | **401** — PASS |

Auth enforcement: PASS for both missing token and bogus token cases.

#### T4.4 — MCP endpoint

**Initialize:**
- URL: `http://127.0.0.1:7180/mcp`
- StatusCode: `200`
- Content-Type: `text/event-stream`
- Body: `event: message\ndata: {"result":{"protocolVersion":"2025-03-26","capabilities":{"tools":{}},"serverInfo":{"name":"conductor","version":"0.1.0"}},...}`
- Session ID returned in `mcp-session-id` response header (UUID format)
- `protocolVersion`: `2025-03-26` — PASS
- `serverInfo`: `conductor v0.1.0` — PASS

**tools/list (with session ID + initialized notification):**
- StatusCode: `200`
- Tool count: **26** (spec mentions 13 — actual implementation has 26, nearly double)
- Tools returned:
  `conductor.card_new`, `conductor.card_get`, `conductor.card_list`, `conductor.card_update`,
  `conductor.transition`, `conductor.scan`, `conductor.order`, `conductor.discover`,
  `conductor.exercise_new`, `conductor.exercise_file`, `conductor.work_card`, `conductor.work_next`,
  `conductor.recommend`, `conductor.config_get`, `conductor.config_set`, `conductor.session_status`,
  `conductor.chat`, `conductor.brain_start`, `conductor.brain_stop`, `conductor.brain_status`,
  `conductor.set_autonomy`, `conductor.tracker_pull`, `conductor.run_list`, `conductor.run_replay`,
  `conductor.run_prune`, `conductor.cost_show`

**Note:** All tools use permissive `inputSchema: {type:"object",additionalProperties:true}`. Zod validation still applies server-side on args.

**tools/list without session ID:** Returns 400 `{"code":-32000,"message":"Bad Request: Mcp-Session-Id header is required"}` — correct transport-level enforcement.

#### T4.5 — Static UI

- URL: `http://127.0.0.1:7180/`
- StatusCode: `200`
- Content-Type: `text/html; charset=utf-8`
- Content starts with: `<!doctype html>` — SPA shell confirmed
- Nav links: Board, Monitor, Routing — PASS
- JS asset `/main.js`: StatusCode `200`, Content-Type `application/javascript; charset=utf-8`
- JS first chars: `// src/ui/main.ts` (source-mapped comment) — looks like real JS, not an error page — PASS

#### T4.6 — Brain start + idle detection (CRITICAL)

- `conductor brain status` (before start): `Brain: idle (iter=0 halts=0)` — PASS
- `conductor brain start`: `Brain started.` — PASS
- After 8s: `Brain: idle (iter=1 halts=2)` — **PASS — idle detection working correctly**
  - iter=1: one card run attempted
  - halts=2: (1) card's work halted because review returned NEEDS-CHANGES in `approved` column; (2) idle detection fired when the same card was picked again with no progress
  - Count is in range 1–10: **CRITICAL PASS** — NOT in the thousands; commit `105961c` idle detection fix is confirmed working
- `conductor brain stop`: `Brain stopped.` — PASS
- Final status: `Brain: idle (iter=1 halts=2)` — PASS

**Daemon log (stdout/stderr):** Brain events published to internal event bus only; daemon.stdout.log shows startup message only. The `conductor-halt` event with reason `idle: <cardId> halted twice in a row with no progress; queue wedged` fires internally (confirmed by source inspection of `loop.ts:96-100`). No log file written for brain events — see Issue T4-1.

#### T4.7 — Cost telemetry

```
today: $0.0000 (in: 0, out: 0)
ceilings: per-card $5.00, per-day $50.00, halt-on-breach: false
active sessions: (none)
```

As expected: $0.0000 because cost is in-memory, daemon-session-scoped. The prior `conductor work` calls ran in previous daemon sessions. Cost ceilings correctly show defaults. — PASS

#### T4.8 — Daemon stop

- `conductor daemon stop`: `Daemon stopped.` — PASS
- Subsequent status: `Down.` — PASS
- Endpoint file cleanup:
  - `daemon.pid`: REMOVED — PASS
  - `daemon.endpoint`: REMOVED — PASS
  - `mcp.endpoint`: REMOVED — PASS
  - `auth.token`: **STILL PRESENT** — by design (token is rotated on next start, not deleted on stop) — see Issue T4-2

---

### Issue T4-1: Brain events not written to any persistent log file
- **Severity:** quality
- **Phase:** T4
- **Command(s):** `conductor brain start` / `conductor brain stop`
- **Expected:** Brain iteration events, halt events, and idle-detection events visible in daemon log or a separate brain log file for post-hoc diagnosis.
- **Actual:** Brain events (`conductor-halt`, `conductor-iteration`, `conductor-status`, `conductor-decision`) are published to the in-memory `EventBus` only. `daemon.stdout.log` shows only the startup line. When the daemon stops, all brain event history is lost. SSE clients connected at the time receive the events, but no persistent record exists.
- **Fix applied:** None
- **Notes:** The SSE `/events` endpoint streams these events to connected clients in real time, which is correct for the live UI. But for auditability (especially for diagnosing why the brain halted), a persistent brain log file (e.g., `.conductor/brain.log.jsonl`) would be valuable. Lower priority than T2-1 (discover JSON crash).

---

### Issue T4-2: `auth.token` persists on disk after daemon stop
- **Severity:** observation
- **Phase:** T4
- **Command(s):** `conductor daemon stop`
- **Expected:** All daemon-generated ephemeral files (`daemon.pid`, `daemon.endpoint`, `mcp.endpoint`, `auth.token`) cleaned up on stop.
- **Actual:** `daemon.pid`, `daemon.endpoint`, `mcp.endpoint` are deleted; `auth.token` remains. The `shutdown()` function in `daemon/index.ts` calls `clearPidFile`, `clearEndpointFile`, `clearMcpEndpointFile` but has no corresponding `clearAuthToken` call. There is no `clearAuthToken` function in `daemon/auth.ts`.
- **Fix applied:** None
- **Notes:** The token is rotated (overwritten) on every `daemon start` via `generateAuthToken()`, so a stale token from a previous session cannot authenticate to a new daemon. The risk window is the period between daemon stop and next daemon start — a process that read the token during that window holds a credential that won't work once the daemon restarts. Current design is intentional (the rpc client reads the persisted token to reconnect). Worth documenting that the token persists intentionally, and that `.conductor/auth.token` must be in `.gitignore`.

---

### Issue T4-3: MCP `tools/list` requires multi-step session handshake (initialize + initialized + session-id header)
- **Severity:** observation
- **Phase:** T4
- **Command(s):** MCP tools/list without session ID
- **Expected:** Per spec test plan — "list tools" works as a stateless probe.
- **Actual:** `StreamableHTTPServerTransport` enforces stateful sessions. Tools/list requires: (1) POST `initialize` → capture `mcp-session-id` header from response; (2) POST `notifications/initialized` with that header (202); (3) POST `tools/list` with session-id header (200). Without session ID, tools/list returns 400 `Bad Request: Mcp-Session-Id header is required`.
- **Fix applied:** None
- **Notes:** This is correct MCP 2025-03-26 protocol behavior, not a bug. However, the T4 test plan describes a simpler "just POST tools/list" flow that does not account for session establishment. Test documentation should reflect the actual MCP handshake sequence. No functional issue — the MCP transport works correctly once the session is properly established.

---

### Issue T4-4: `conductor.recommend` RPC method semantics mismatch with test plan description
- **Severity:** observation
- **Phase:** T4
- **Command(s):** `conductor.recommend` with `{}`
- **Expected (per test plan):** "gets a recommendation for the next card to work on"
- **Actual:** `conductor.recommend` is for *filing* a recommendation manually (by a plugin or external tool). It takes `{cardId, recommendation: {...}}` params and returns `{ok: true}`. It is NOT a "get next recommendation" method. No such RPC method exists — the brain's ordering logic is done via `work_next` or the Conductor loop, not a separate recommendation endpoint.
- **Fix applied:** None
- **Notes:** Test plan description was misleading. The method is wired and works correctly per its actual design. No conductor bug here.

---

### T5 — Edge Cases + Error Paths

**Executed:** 2026-05-12  
**Card state at start:** `2026-05-12-health-check-endpoint` in `approved`  
**Card state at end:** `approved` (unchanged — no transitions performed)  
**Run dirs at start of T5:** 4 (2 from T1/T3, 1 from T4 brain, 1 from T5.1 below)  
**Run dirs at end of T5:** 6 (additional runs from broken-card work attempts)

#### T5.1 — `conductor work 2026-01-01-does-not-exist` (nonexistent card)

- **Exit code:** 1
- **Output:** `Card not found: 2026-01-01-does-not-exist (looked at G:\Projects\Large-Projects\omniforge\.conductor\cards\2026-01-01-does-not-exist.md)`
- **Error quality:** GOOD — clear message, includes the exact path it looked at, no stack trace
- **Side effect found:** A run directory was created before the error: `.conductor/runs/20260512T092450-2026-01-01-does-not-exist/events.jsonl` — with a single `error` event: `{"ts":"...","kind":"error","card_id":"2026-01-01-does-not-exist","payload":{"message":"Card not found: ..."}}`
- **See:** Issue T5-1

#### T5.2 — `conductor transition 2026-01-01-does-not-exist approved` (nonexistent card)

- **Exit code:** 1
- **Output:** `Card not found: 2026-01-01-does-not-exist (looked at G:\Projects\Large-Projects\omniforge\.conductor\cards\2026-01-01-does-not-exist.md)`
- **Error quality:** GOOD — identical pattern to T5.1, informative path included
- **No run directory created** (transition command does not create run dirs)

#### T5.3 — Re-init idempotency (`conductor init --provider subscription`)

- **Output:** `Conductor scaffold present; .conductor/config.yaml left untouched.` — PASS
- **Timing:** < 1s
- **Card check:** `id: 2026-05-12-health-check-endpoint`, `column: approved` — frontmatter intact — PASS
- **Run dirs check:** 4 run dirs — PASS (all preserved; no directories deleted by re-init)
- **Behavior:** Idempotent — scaffold detected, no overwrite attempted, explicit confirmation in output

#### T5.4 — Malformed card frontmatter (`broken-card.md`)

**Broken card created with:**
```yaml
---
id: broken-card
this is not yaml
column: completely-invalid
---
```

**`conductor scan` on broken card:**
- **Exit code:** 1
- **Output:** `can not read a block mapping entry; a multiline key may not be an implicit key at line 4, column 7:\n    column: completely-invalid\n          ^`
- **Behavior:** scan BAILS ENTIRELY — no cards listed at all. The healthy card `2026-05-12-health-check-endpoint` is NOT shown.
- **Error quality:** MIXED — the YAML parse error message is technically accurate but low-level; the user must understand YAML spec to interpret it. More importantly, one malformed card silences the entire `scan` output.
- **See:** Issue T5-2 (scan silently drops all good cards when one card is malformed)

**`conductor work broken-card` on broken card:**
- **Exit code:** 1
- **Output:** `Card not found: broken-card (looked at G:\Projects\Large-Projects\omniforge\.conductor\cards\broken-card.md)`
- **Behavior:** Counterintuitive — the file exists on disk but work says "Card not found." The work command apparently tries to parse the card before the YAML error manifests as "Card not found" (likely: parse failure causes the card loader to return null/undefined, which the work command interprets as missing). Two run directories were created during this testing.
- **Error quality:** BAD — error says the card doesn't exist, but it does. This is misleading.
- **See:** Issue T5-3

**Broken card deleted:** CONFIRMED — `.conductor/cards/broken-card.md` removed before end of T5.

#### T5.5 — Drift detection

**State 1 — Untracked `.conductor/` (pre-staging):**
```
[control:drift]
  - state-md-template: expected=state.md authored for the project actual=init template (unmodified) — state.md still matches the init scaffold. Capture current cursor before continuing.
  - uncommitted-state-mismatch: expected=clean working tree actual=18 uncommitted file(s) — .factory_state.json, .gitignore, src/ingestion/brand_voice.py, …
```
- **Exit code:** 1
- **Format:** Structured `[control:drift]` block — PASS
- **Two distinct drift signals detected:** (1) `state-md-template` — state.md is still the unmodified init template, (2) `uncommitted-state-mismatch` — 18 uncommitted files
- **Note:** The 18-file count from drift vs 15 entries in `git status --short` suggests drift expands directory entries (`.conductor/` contains multiple files counted individually). The git status output has 15 entries; drift counts 18.

**State 2 — After `git add .conductor/` (staged but uncommitted):**
```
[control:drift]
  - state-md-template: ... (same as above)
  - uncommitted-state-mismatch: expected=clean working tree actual=18 uncommitted file(s) — .factory_state.json, …
```
- **Behavior:** IDENTICAL output in both states — drift does not distinguish between staged and unstaged changes. Both trigger `uncommitted-state-mismatch` with the same count and message.
- **See:** Issue T5-4

**Cleanup:** `git reset HEAD .conductor/` — exit 0 — index reset confirmed.

#### T5.6 — Run log replay

```
conductor run replay 20260512T090108-2026-05-12-health-check-endpoint
```

- **Output:** 6 lines, each valid JSON matching events.jsonl spec:
  ```
  {"ts":"2026-05-12T09:01:08.955Z","kind":"op_start","card_id":"...","op":"analyze","payload":{"model":"claude-sub:opus"}}
  {"ts":"...","kind":"op_complete","card_id":"...","op":"analyze","payload":{"durationMs":151121}}
  {"ts":"...","kind":"op_start","card_id":"...","op":"plan","payload":{"model":"claude-sub:opus"}}
  {"ts":"...","kind":"op_complete","card_id":"...","op":"plan","payload":{"durationMs":43011}}
  {"ts":"...","kind":"transition","card_id":"...","payload":{"from":"discovered","to":"planned"}}
  {"ts":"...","kind":"complete","card_id":"...","payload":{"finalColumn":"planned"}}
  ```
- **Exit code:** 0 — PASS
- **Format:** Each line is valid JSON, matches events.jsonl spec — PASS

#### T5.7 — Run log list + prune

**`conductor run list` output (6 runs, most-recent-first):**
```
20260512T092616-broken-card       2026-05-12T09:26:16.627Z  1 events
20260512T092558-broken-card       2026-05-12T09:25:58.277Z  1 events
20260512T092450-2026-01-01-does-not-exist  2026-05-12T09:24:50.092Z  1 events
20260512T092100-2026-05-12-health-check-endpoint  2026-05-12T09:21:00.400Z  1 events
20260512T091224-2026-05-12-health-check-endpoint  2026-05-12T09:12:52.521Z  4 events
20260512T090108-2026-05-12-health-check-endpoint  2026-05-12T09:04:23.127Z  6 events
```

**`conductor run prune` output:** `removed: (none)` — PASS  
**Exit code:** 0 — PASS  
**Behavior:** No-op when under retention limit (subscription default). Message is correct. Actual prune boundary testing skipped (would require 200+ fake dirs).

**Note on run count:** T3 log said "2 runs." After T4 brain start, a 3rd run was created. T5.1 (work on missing card) created a 4th. The broken-card tests (T5.4) created 2 more (runs 5 and 6). Total 6 runs at end of T5.

#### T5.8 — Drift with explicit uncommitted code change

- **Action:** `"# t5 trace" | Out-File -Append -Encoding utf8 README.md` — created README.md (file was NOT previously tracked in git — confirmed by `git log --oneline --all -- README.md` returning empty, and `git status --short README.md` showing `?? README.md`)
- **Drift output with README.md created:**
  ```
  [control:drift]
    - state-md-template: ...
    - uncommitted-state-mismatch: expected=clean working tree actual=19 uncommitted file(s) — .factory_state.json, …
  ```
- **Change detected:** Count went from 18 → 19 (README.md added) — PASS
- **Specific file named in output:** No — the drift message lists only the first 10 items then truncates with "…". README.md may or may not be in the truncated portion.
- **Exit code:** 1 — PASS
- **Rollback:** `git clean -f README.md` → `Removing README.md` (exit 0). README.md confirmed absent from git status afterward.
- **See:** Issue T5-5 (drift truncates file list; specific changed file may not appear)

#### T5.9 — Cost telemetry without daemon

- **Output:** `(daemon not running — start with \`conductor daemon start\`)`
- **Exit code:** 0 — notable: exits 0 even though no data is available
- **Error quality:** EXCELLENT — informative message with actionable guidance; does not crash
- **Note on exit code:** A "not running" state could arguably be exit 1 to signal the caller that cost data is unavailable. Current exit 0 is user-friendly but may confuse scripts checking for failure. See Issue T5-6.

#### T5.10 — Empty discover (skipped)

Skipped per plan — T2 documented that `conductor discover` crashes (JSON parse error, Issue T2-1). Re-running would repeat the same crash. Noting here as confirmed skip.

#### T5.11 — Card frontmatter verification

Full frontmatter of `2026-05-12-health-check-endpoint.md` as of end of T5:
```yaml
---
id: 2026-05-12-health-check-endpoint
title: Add /health endpoint to FastAPI app
kind: issue
column: approved
phase: unassigned
priority: 1
autonomy: inherit
model_overrides: {}
created: '2026-05-12T09:00:37.508Z'
source: user
labels: []
blocked_by: []
---
```

Checks:
- `id` matches filename `2026-05-12-health-check-endpoint` — PASS
- `column: approved` — PASS (not moved by any T5 operation)
- `created: '2026-05-12T09:00:37.508Z'` — original timestamp preserved — PASS
- `model_overrides: {}` — empty, no overrides applied — PASS
- All other fields intact — PASS

---

### Issue T5-1: `conductor work` creates a run directory before validating card existence
- **Severity:** quality
- **Phase:** T5
- **Command(s):** `conductor work 2026-01-01-does-not-exist`
- **Expected:** No run directory created; error returned immediately.
- **Actual:** Run directory `.conductor/runs/20260512T092450-2026-01-01-does-not-exist/` was created with a single `error`-kind event in `events.jsonl` before the work command exited with code 1. The error message itself is correct ("Card not found"), but the side effect of creating a run dir for a nonexistent card is unexpected and pollutes the run log.
- **Fix applied:** None
- **Notes:** The run directory should only be created after the card is validated as existing and parseable. The current implementation appears to initialize the run log before attempting to load the card, which inverts the correct ordering. `conductor run list` will show these phantom error runs, which could be confusing.

---

### Issue T5-2: `conductor scan` bails entirely on malformed card YAML, hiding all healthy cards
- **Severity:** bug
- **Phase:** T5
- **Command(s):** `conductor scan` (with one malformed card present)
- **Expected:** scan lists all valid cards, reports a warning for any malformed card (e.g., `[warn] broken-card.md: YAML parse error — skipping`), and exits 0.
- **Actual:** scan exits 1 with only the raw YAML parse error message. No cards are listed — including the healthy `2026-05-12-health-check-endpoint` card. One malformed card completely silences the board view.
- **Fix applied:** None
- **Notes:** This is a meaningful UX regression: a single accidentally corrupted card prevents the developer from seeing any of their work queue. The fix is to catch YAML parse errors per-file during card loading, log a warning, skip the malformed card, and continue listing the rest. The exit code should still be 0 (or a non-fatal "partial success" code) if at least some cards are readable.

---

### Issue T5-3: `conductor work <slug>` gives misleading "Card not found" when the file exists but has a YAML parse error
- **Severity:** bug
- **Phase:** T5
- **Command(s):** `conductor work broken-card` (card file exists, but YAML is malformed)
- **Expected:** Error message identifies the actual problem: "Failed to parse card: broken-card.md — YAML error at line 3: ..."
- **Actual:** `Card not found: broken-card (looked at G:\...\cards\broken-card.md)` — the file exists at that exact path, but the error says it wasn't found. The YAML parse failure internally returns null/undefined, which the work command interprets as a missing card.
- **Fix applied:** None
- **Notes:** This makes it impossible to distinguish "file genuinely absent" from "file exists but is corrupted." The fix is to catch YAML parse errors separately from "file not found" errors in the card loader and surface distinct messages.

---

### Issue T5-4: `conductor drift` does not distinguish staged vs. unstaged changes in `uncommitted-state-mismatch`
- **Severity:** observation
- **Phase:** T5
- **Command(s):** `conductor drift` (both before and after `git add .conductor/`)
- **Expected:** Drift might distinguish between "staged but not committed" and "unstaged modifications" — these have different risk profiles.
- **Actual:** Output is identical in both states: `uncommitted-state-mismatch: expected=clean working tree actual=18 uncommitted file(s)`. Staging `.conductor/` does not change the drift output.
- **Fix applied:** None
- **Notes:** Not a bug per se — "staged-but-uncommitted" is still uncommitted. But the message could be more informative: "18 uncommitted file(s) (5 staged, 13 unstaged)" would help the user understand exactly what needs to be committed vs. what hasn't been staged yet. Low priority enhancement.

---

### Issue T5-5: `conductor drift` truncates file list at 10 items with "…"; specific changed files may not be visible
- **Severity:** quality
- **Phase:** T5
- **Command(s):** `conductor drift` (with 18-19 uncommitted files)
- **Expected:** Either list all files or provide a way to see the full list.
- **Actual:** File list in `uncommitted-state-mismatch` is truncated after 10 entries with "…". When a specific targeted change (README.md) was made, it was not visible in the truncated output — only the count changed (18 → 19). A developer using drift to confirm their change is reflected would not see their specific file.
- **Fix applied:** None
- **Notes:** Could be addressed with: (1) a `--verbose` flag that shows all files, (2) sorting the list so recently modified files appear first, or (3) at minimum, stating the full count ("showing 10 of 19 — use --verbose for all"). Low priority, but affects usability when working in a dirty repo.

---

### Issue T5-6: `conductor cost show` exits 0 when daemon is not running
- **Severity:** observation
- **Phase:** T5
- **Command(s):** `conductor cost show` (daemon stopped)
- **Expected:** Either exit 1 (cost data unavailable) or exit 0 with clear "not running" message.
- **Actual:** Exit 0 with message `(daemon not running — start with \`conductor daemon start\`)`. Message is clear and helpful.
- **Fix applied:** None
- **Notes:** Exit 0 is user-friendly for interactive use. However, scripts checking `if conductor cost show` might incorrectly treat "daemon not running" as success. An argument could be made for exit 1 in this state, with the helpful message still printed to stderr. Current behavior is defensible; flagging as a scripting UX consideration only.

---

### T6 — Permutations + Advanced Ops

**Executed:** 2026-05-12  
**Card id:** `2026-05-12-health-check-endpoint`  
**Card state at start:** `approved`  
**Card state at end:** `building` (verify op crashed on JSON parse error; card not advanced)

#### T6.1 — Per-card model_overrides

- **Edit made:** `model_overrides: {}` → `model_overrides:\n  implement: claude-sub:sonnet` in card frontmatter
- **Verify:** Run log `20260512T093547-2026-05-12-health-check-endpoint/events.jsonl` event:
  ```
  {"kind":"op_start","op":"implement","payload":{"model":"claude-sub:sonnet"}}
  ```
- **model_overrides respected:** YES — `claude-sub:sonnet` used for implement, not the routing default
- **PASS**

#### T6.2 — Step identification

- Step `1.1` chosen: "Locate the FastAPI app instance and current router structure" — read-only verification step, no file writes
- This was the correct minimum-scope step per the plan

#### T6.3 — Manual transition approved → building

**NOTE: The test plan instructions were incorrect for this step.** The `building` column triggers the `verify` op, not `implement`. The `implement` op is triggered from the `approved` column with `--step`. Transitioning to `building` before running `conductor work --step 1.1` caused the first work attempt to run the verify op instead of implement. Corrected by resetting card to `approved` before the actual implement run.

- **Output:** `Card 2026-05-12-health-check-endpoint transitioned to building.` — transition itself works correctly
- **Column moved:** PASS  
- **Test plan error:** transition to `building` should NOT precede `conductor work --step` — implement is invoked from `approved`

#### T6.4 — Implement op via `conductor work --step 1.1`

- **Timing:** 70.3s (durationMs: 69530 in events.jsonl)
- **Column at start:** `approved` (corrected from building back to approved before run)
- **Outcome:** `Halted: Transition approved → building requires manual approval.`
  - The implement op ran successfully; the halt is the `approved → building` transition gate (autonomy policy = `manual`)
- **model:** `claude-sub:sonnet` (model_override respected — PASS)
- **Files the model requested:** `files: (none)` — Step 1.1 is a read-only verification step; the model correctly returned no file writes
- **Git commit made by conductor:** `5e83e6b` — `chore(unassigned.1.1): verify app structure before health endpoint implementation`
- **Scope of commit:** 32 files changed — **CRITICAL BUG (see Issue T6-1):** `commitStep()` runs `git add .` which staged ALL previously-uncommitted files in the working tree, including pre-existing `.factory_state.json`, `.gitignore`, ingestion source files, `.relay/` docs, and all prior `.conductor/` state. Zero health-endpoint source files were written.
- **Card section appended:** `## Implementation Guidelines` with Step 1.1 notes — PASS. Notes are substantive: confirm `app = create_app()` is correct attach point, confirm `_register_routes` is the right location, confirm `or request.url.path == "/health"` change needed in middleware, confirm imports (`get_session_factory`, `text`) needed, confirm `tests/api/test_health.py` is correct target path
- **`git diff --stat` scope (after run):** Only `.conductor/` changes — conductor already committed everything else into the step commit

#### T6.5 — Verify op

- **Setup:** Manually transitioned card from `approved` to `building` so verify op would trigger
- **Timing:** 8.3s
- **pytest ran:** YES — `pytest` was invoked but failed with exit code 1 because pytest is not installed in the Windows PATH for this session
- **LLM parsed pytest output:** YES — model (claude-sub:haiku) analyzed the failure and returned a structured JSON response, but wrapped it in a markdown code fence
- **Crash:** `Failed to parse verify JSON: Unexpected token '`', "```json\n{""... is not valid JSON` — same markdown-fence JSON parsing failure as T2-1 (discover) and (newly confirmed) verify
- **Column after:** `building` (unchanged — op crashed before completing)
- **Exit code:** 1
- **Events in run log:** Only `op_start verify` — op crashed before `op_complete` could be written
- **See:** Issue T6-2 (verify op suffers same JSON fence parsing crash as discover/order)

#### T6.6 — Different card kinds

```
conductor card new t6-feature --title "T6 feature card" --kind feature
  → Card created: .conductor/cards/2026-05-12-t6-feature.md
conductor card new t6-imported --title "T6 imported card" --kind imported
  → Card created: .conductor/cards/2026-05-12-t6-imported.md
```

- `2026-05-12-t6-feature.md` frontmatter: `kind: feature` — PASS
- `2026-05-12-t6-imported.md` frontmatter: `kind: imported` — PASS
- `--kind` flag wired and writing correctly — PASS

#### T6.7 — Quality assessment of implement output

The model's step 1.1 output was a read-only reconnaissance step, not a code-writing step. This is technically correct behavior: the plan's Step 1.1 explicitly says "read `src/api/routes.py`… confirm where the `FastAPI()` app object is defined" — it is a verification step with `ROLLBACK: None — read-only`. The model correctly returned `files: []` and wrote substantive notes confirming all 6 key facts (attach point, route registration location, middleware bypass pattern, session factory usage, import changes needed, test file path). The notes are accurate against the actual codebase (verified independently in T1). **The analysis written by the model in `## Implementation Guidelines` is production-quality documentation** — it would fully unblock a developer implementing Step 1.2 onward. However, conductor's `commitStep` swept it into a 32-file commit that includes unrelated pre-existing changes — a critical infrastructure failure that makes the commit unsalvageable as a PR unit.

**Assessment:** The model produced correct, grounded, production-quality output for a read-only step. The commit hygiene failure is entirely in conductor's `commitStep` (`git add .` with no scope limiting), not in the LLM output. A code-writing step (1.2+) was not tested because step 1.1 was chosen as the "smallest" step — however, given the `git add .` bug, any code-writing step would also produce an oversized commit.

#### T6.8 — Cleanup

- **Stash needed:** NO — conductor's `commitStep` (`git add .`) already committed all pre-existing working-tree changes into commit `5e83e6b`. No working-tree source changes remain to stash.
- **`git diff --stat -- ':!.conductor'`:** empty (no uncommitted non-conductor changes)
- **Source tree status:** CLEAN

---

### Issue T6-1: `commitStep()` runs `git add .` — stages and commits ALL working-tree changes, not just conductor-written files
- **Severity:** bug
- **Phase:** T6
- **Command(s):** `conductor work 2026-05-12-health-check-endpoint --step 1.1`
- **Expected:** The commit created by `commitStep` contains only files written by the implement op for that step.
- **Actual:** `src/engine/state/git.ts:32` runs `await g.add('.')` before committing. This stages every modified, created, and untracked file in the working tree — not just conductor's writes. In the T6 run, commit `5e83e6b` (`chore(unassigned.1.1): verify app structure...`) contains 32 files including pre-existing `.factory_state.json`, `.gitignore`, ingestion source changes, `.relay/` docs, and all `.conductor/` state. The model for step 1.1 correctly returned `files: []` (no writes) — conductor's own apply loop ran cleanly — but `commitStep` then included all of the pre-existing uncommitted work.
- **Fix applied:** None
- **Notes:** `commitStep` should only commit the specific files that the implement op's diff specified, not `git add .`. The fix is to pass `diff.files.map(f => f.path)` to `g.add(...)` so only conductor-touched files are staged. When `files` is empty (read-only step like 1.1), the commit should be skipped or marked as a notes-only commit. This is a high-severity correctness issue: in any repo with pre-existing uncommitted changes, every conductor implement commit will silently absorb all working-tree noise into the step commit, making the git history unusable and potentially committing secrets, build artifacts, or unrelated WIP. Source: `src/engine/state/git.ts:32`.

---

### Issue T6-2: `verify` op suffers same markdown-fence JSON parsing crash as `discover` (T2-1)
- **Severity:** bug
- **Phase:** T6
- **Command(s):** `conductor work 2026-05-12-health-check-endpoint` (card in `building`)
- **Expected:** Verify op runs pytest, parses the output report, updates card column to `verifying` or halts with FAIL report.
- **Actual:** Exit code 1 — `Failed to parse verify JSON: Unexpected token '`', "```json\n{""... is not valid JSON`. The claude-sub:haiku model returned the JSON report wrapped in a markdown code fence, same failure mode as T2-1 (`discover`). The verify op uses `JSON.parse(resp.text.trim())` with no fence-stripping.
- **Fix applied:** None
- **Notes:** The same `JSON.parse(resp.text.trim())` pattern exists in at least 4 ops: `discover`, `order`, `implement`, `verify`. The fix (strip markdown fences before parsing) should be applied globally via a shared utility. Issue T2-1 identified this for discover; T6-2 confirms it also affects verify. The model-override for verify is `claude-sub:haiku` (per routing.functions.verify in config.yaml), and haiku is more prone to adding fences than sonnet/opus. Source: `src/engine/ops/verify.ts:74`.

---

### Issue T6-3: Test plan sequence for T6.3+T6.4 is incorrect — `--step` requires `approved` column, not `building`
- **Severity:** observation
- **Phase:** T6
- **Command(s):** `conductor transition ... building` then `conductor work ... --step 1.1`
- **Expected (per test plan):** Implement op runs when card is transitioned to `building` first.
- **Actual:** The T6 test plan instructs "manually transition approved → building" (T6.3) THEN "run implement op via work with --step" (T6.4). But the TaskAgent's column dispatch (`task_agent.ts:148-172`) shows: `approved` column → runs implement with `--step`; `building` column → runs verify. Transitioning to `building` before `conductor work --step` causes the verify op to run, not implement. The test was corrected by resetting the card to `approved` before running implement.
- **Fix applied:** None (test plan issue, not a conductor bug)
- **Notes:** The correct sequence is: (1) keep card in `approved`, (2) run `conductor work --step 1.1` → implement runs and halts at `approved → building` gate, (3) manually transition to `building`, (4) run `conductor work` → verify triggers. Source: `src/agent/task_agent.ts:148-200`.

