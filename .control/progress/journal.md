# Journal

Append-only, newest on top. One entry per session, short. Minor fixes land here as one-line entries (see Issue flow in `.control/PROJECT_PROTOCOL.md`).

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
