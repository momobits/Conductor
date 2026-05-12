# Journal

Append-only, newest on top. One entry per session, short. Minor fixes land here as one-line entries (see Issue flow in `.control/PROJECT_PROTOCOL.md`).

## 2026-05-12 — Phase 9 closed; Phase 10 kicked off

- Phase 9 (malformed-yaml-error-surface) closed via `/phase-close`. Tag: `phase-9-malformed-yaml-error-surface-closed` at commit `159387d`. All done criteria verified: 497/497 tests pass; typecheck clean; `.control/issues/OPEN/` empty; all three step commits follow `<type>(9.<step>):` convention. Phase 10 (quick-wins) scaffolded; STATE.md cursor advanced to step 10.1.
- Steps 9.2 and 9.3 walked end-to-end via the Relay pipeline:
  - **9.2** (`scan-bails-entirely-on-one-malformed-card`) — `/relay-analyze` (scope `keep narrow`, 4 findings including F1 engine/RPC scan shape divergence as deferable companion) → `/relay-plan` (5 atomic steps, M-complexity) → `/relay-review` (APPROVED, 3 LOW absorbed inline) → implementation → `/relay-verify` (COMPLETE, 496/496) → `/relay-resolve` at commit `a374f8a`. Added `listCardsLenient(cardsDir): Promise<{cards, errors}>` parallel to strict `listCards`; routed engine `scan` op + RPC scan handler through lenient variant; extended `Status` with optional `errors?:`; CLI renders warnings to stderr and exits 0 on partial success.
  - **9.3** (`work-creates-run-dir-before-validating-card`) — `/relay-analyze` → `/relay-plan` (3 atomic steps, S-complexity) → `/relay-review` returned **APPROVED WITH CHANGES** (HIGH: Analysis's claim that the autonomy loop's `runOneCard` had try/catch was factually wrong; verified by source read — no catch around the for-await). Plan revised in-place to add Step 4 (wrap `runOneCard` for-await in try/catch; route thrown errors through the same `classifyHalt + publish conductor-halt` branch as yielded errors). Two LOW deviations also absorbed (single-capture try/catch test pattern). Implementation landed; one Verification Fix recorded (`work.test.ts` assertion shape: `readdirSync().length === 0` instead of `!existsSync(...)`, because `runInit` pre-creates `.conductor/runs/`). `/relay-resolve` at commit `159387d`.
- Decisions captured durably in `.relay/relay-config.md § Edge Cases > Data Boundaries`: lenient-vs-strict `listCards` selection rule; `TaskAgent.run()` pre-run-throws / mid-run-yields contract; autonomy loop catches and converges on the halt classifier. Not yet promoted to formal ADRs (`.control/architecture/decisions/`) — promote if a downstream phase needs explicit reference.
- Issues closed: `scan-bails-entirely-on-one-malformed-card.md` and `work-creates-run-dir-before-validating-card.md` archived to `.relay/archive/issues/`. Impl docs filed at `.relay/implemented/`. Relay Phase 1 marked **COMPLETE** in `relay-ordering.md`.
- Minor fixes: none.
- Blockers hit: one HIGH from the 9.3 adversarial review (autonomy loop silent-death regression). Resolved in the revised plan (Step 4) rather than escalated; ASK-ME gate honored.
- Sessions's lift: 488 → 497 tests (+9: 8 for 9.2, 1 for 9.3); two phase commits; one phase tag.

## 2026-05-12 — Session sid-2026-05-12-phase9-step91-close
- Phase 9 step 9.1 (`misleading-card-not-found-for-malformed-yaml`) closed: `485944d..1fb8561` (one fix commit on top of the phase bootstrap).
- Walked full Relay pipeline: `/relay-analyze` (scope `keep narrow`, 5 Related-Work findings logged) → `/relay-superplan` (5-agent synthesis: Minimal/Performance/Safety/Refactor/TDD; base = Refactor-Forward + cherry-picks from the other four) → `/relay-review` (APPROVED with 1 MEDIUM + 4 LOW notes folded into Implementation Guidelines) → implementation → `/relay-verify` (verdict COMPLETE, 488/488 tests pass) → `/relay-resolve` (issue archived, impl doc filed, deps 9.2/9.3 annotated, relay-config and relay-ordering updated).
- Decisions: typed-error pattern `CardNotFoundError` / `CardParseError` (with `reason: 'yaml' | 'schema'` discriminator and `code` discriminator) in `src/engine/state/card.ts`; exported `messageForReadCardError()` helper as single source of truth for the user-facing message contract; module-private `truncate(s, 500)` for log-bloat protection. Documented inline in `.relay/implemented/misleading-card-not-found-for-malformed-yaml.md` and in `.relay/relay-config.md § Edge Cases`. Not yet promoted to a formal ADR — promote if 9.2 or 9.3 require explicit reference.
- Issues closed: `misleading-card-not-found-for-malformed-yaml.md` → `.relay/archive/issues/`.
- Issues annotated (not closed): `scan-bails-entirely-on-one-malformed-card.md` and `work-creates-run-dir-before-validating-card.md` — both received a "Note from step 9.1" section linking to the impl doc and showing the import shape they should use.
- Minor fixes: none filed (this session's work was the full pipeline on one phase-9 step).
- Blockers hit: none. Adversarial Review surfaced 5 issues (1 MEDIUM + 4 LOW), all resolved by Implementation Guidelines rather than plan rewrite.
- Session bootstrap context: Control framework v2.2.3 had been freshly installed (commit `7df08b1`); STATE.md was the install template (drift `state-md-template`). Operator chose path 2 (defer `/bootstrap`, derive Control phases from `.relay/relay-ordering.md`). Phase 9 scaffolded from Relay Phase 1 (3 items, sequential, one branch).

## YYYY-MM-DD — Session bootstrap (initial template — never run)
- Control framework installed (commit `<short-sha>`).
- Next: define phase plan before any implementation.
