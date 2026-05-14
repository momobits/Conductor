# Conductor Quickstart

A complete first-run walkthrough. Assumes you have Node 20+ and a project you want to use conductor on.

---

## 1. Install (one time)

From inside the conductor source tree:

```bash
cd <path-to-conductor>
npm install
npm run build
npm link
```

`npm link` registers `conductor` as a global command — you only do this once. After that, `conductor <subcommand>` works from any directory in any shell.

To uninstall later: `npm unlink -g conductor-workflow`.

---

## 2. Pick a provider

| Provider | Auth | When to use |
|---|---|---|
| `subscription` | `claude login` (one-time) | You have a Claude Pro/Max account and want flat-rate billing through your existing session. Recommended for individual use. |
| `openrouter` | `OPENROUTER_API_KEY` env var | You want to mix vendors (Claude/GPT/Gemini/Llama) behind a single API key. Per-token billing. |
| `lmstudio` | None (local server) | You want local, offline, private inference. Free, but model quality depends on what you run. |
| _no flag (default)_ | One or more of `ANTHROPIC_API_KEY`, `OPENAI_API_KEY`, `GEMINI_API_KEY` | Multi-provider routing, per-op model choice. |

See [providers.md](providers.md) for the full reference.

---

## 3. Initialize conductor in your project

```bash
cd <your-project>
conductor init --provider subscription
```

This creates `.conductor/` with subdirs (`cards/`, `runs/`, `archive/`, etc.), `state.md`, `ordering.md`, `journal.md`, and a `config.yaml` matching the provider you picked.

`init` also sniffs your project type and sets `verify_command`:

| If your project has... | `verify_command` becomes |
|---|---|
| `package.json` | `npm test` |
| `pyproject.toml` or `setup.py` | `pytest` |
| `Cargo.toml` | `cargo test` |
| `go.mod` | `go test ./...` |
| `Makefile` | `make test` |

Pass `--no-detect-verify` to skip the sniff and keep the example's default.

`init` is idempotent — re-running it never overwrites your existing config. To switch providers later, edit `.conductor/config.yaml` directly or delete it and re-run init.

---

## 4. File your first card

Two ways to get cards into the system:

```bash
# 4A — You know the specific issue. Create one card.
conductor card new my-bug --title "API returns 500 when X"
```

Then edit `.conductor/cards/<today>-my-bug.md` and replace the placeholder body with the real description, repro steps, and `file:line` references where you can. **The richer the body, the better the analyze + plan output.**

```bash
# 4B — Auto-find TODO/FIXME comments in your repo
conductor discover
```

Discover does one LLM call (~10–30s) and files a card per actionable TODO it finds.

---

## 5. Run the workflow

```bash
conductor work <card-id>     # one cycle: analyze + plan, then auto-transition
conductor scan               # see all cards by column
```

What `work` does depends on the card's current column:

| Column | Op(s) | LLM cost |
|---|---|---|
| `discovered` | analyze + plan + auto-transition to `planned` | 2 calls |
| `planned` | review op + autonomy gate | 1 call |
| `approved` | implement (requires `--step <id>` from the plan section) | 1 call per step |
| `building` | verify (runs `verify_command` — no LLM) | 0 |
| `verifying` | autonomy gate to `shipped` | 0 |

Read the appended `## Analysis` / `## Implementation Plan` / `## Adversarial Review` sections of the card markdown between cycles. Edit by hand whenever you disagree.

To manually push a card forward when you disagree with the LLM:

```bash
conductor transition <card-id> approved
```

---

## Latency expectations

A single `conductor work <card-id>` cycle takes one or two LLM calls (analyze + plan, or implement, depending on the card column). Per-op times vary by model class:

| Model class | Per-op latency | analyze + plan total |
|---|---|---|
| **Haiku / Sonnet / GPT-5 / Gemini 2.5 Pro** | 30–60s | 60–120s |
| **Opus subscription (`claude-sub:opus`)** | 50–150s | 100–300s |
| **Local (LM Studio, Ollama)** | varies — depends on hardware | varies |

Times scale with card body size. A 4-page analysis prompt sits at the upper end of each band. If your first `conductor work` cycle on Opus exceeds 120s, that's expected — let it finish. See [providers.md](providers.md) for routing.

---

## 6. Use the web UI (recommended for daily use)

```bash
conductor daemon start
# open the URL printed (http://127.0.0.1:7180 by default)
```

The UI gives you:

- **Board** — drag cards between columns; autonomy gates fire as confirm dialogs
- **Card detail** — markdown render + sidebar metadata, live op event stream when work is running, per-card chat
- **Monitor** — table of active TaskAgent sessions
- **Routing** — in-place editor for `.conductor/config.yaml` with server-side validation on save

Auth: the first visit gets a token via URL param; subsequent visits use `localStorage`.

When done: `conductor daemon stop`.

---

## 7. Autonomous mode (when you trust it)

The brain runs the queue end-to-end without manual intervention. Run it under supervision the first few times.

```bash
conductor daemon start       # brain runs inside the daemon
conductor brain start
conductor brain status       # watch progress
conductor brain stop         # ALWAYS stop before going AFK
conductor daemon stop
```

The brain respects `autonomy.default` / `autonomy.transitions` from your config, halts on `cost_ceilings.*` breach, and has built-in idle detection (it stops if the same card halts twice in a row with no progress).

**Don't run the brain unsupervised on a real project on day one.** Watch the first few cycles. Cancel anything you don't like. Cost ceilings are inert under subscription billing but apply under API providers — set them generously the first day.

---

## Common operations cheatsheet

```bash
conductor scan                          # board state
conductor card new <slug> --title "..." # new card
conductor discover                      # auto-find TODOs
conductor work <card-id>                # one cycle on a card
conductor work <card-id> --step <id>    # implement a specific plan step (for approved cards)
conductor transition <card-id> <column> # manual column move
conductor cost show                     # token + dollar telemetry (needs daemon)
conductor run list                      # all run logs
conductor run replay <run-id>           # stream a past run
conductor run prune                     # apply retention policy from config
conductor drift                         # detect uncommitted/unmarked changes
conductor daemon {start,status,stop}    # daemon lifecycle
conductor brain {start,status,stop}     # autonomous loop (needs daemon)
```

---

## First-time advice

1. Start with **one** real card on a project where you'd actually do the work yourself anyway. That way you can compare conductor's analyze/plan output to what you'd have done.
2. Keep the body of that card concrete: file paths, repro steps, what you've already ruled out.
3. Read the `## Analysis` section critically — it's the cheapest signal about whether conductor "gets" your codebase.
4. If something hurts, note it. Real-use friction is the next thing to fix in conductor itself.

---

## Troubleshooting

**`claude CLI exited 1: not logged in`** — run `claude login` and re-try.

**`Could not resolve authentication method`** — your config routes an op to a provider whose env var isn't set. Check `.conductor/config.yaml routing:` and confirm the relevant key (e.g. `ANTHROPIC_API_KEY`, `OPENROUTER_API_KEY`) is exported.

**`verify_command: npm test` fails because no `package.json`** — edit `.conductor/config.yaml` and set `verify_command:` to something appropriate (`exit 0` if you don't care during early testing).

**Daemon won't start (port in use)** — `conductor daemon start --port 7181` (or any free port).

**Brain spinning** — fixed in `105961c`. If on an older build, `conductor brain stop` and update.

**Card stuck in `planned` after review returned `NEEDS-CHANGES`** — either edit the card body to address the feedback and re-run `conductor work`, or override with `conductor transition <id> approved`.
