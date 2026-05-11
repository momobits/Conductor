# Conductor Providers

Conductor's routing layer dispatches each operation to a provider adapter based on the model id prefix in `.conductor/config.yaml`. This document is the complete reference for every supported provider, including how to authenticate and which model id syntax to use.

## Quick reference

| Provider | Prefix(es) | Auth | Tool calls | Streaming | Cost |
|---|---|---|---|---|---|
| Claude API | `claude-` | `ANTHROPIC_API_KEY` | Yes | Yes (in adapter) | Per token |
| Claude subscription | `claude-sub:` | `claude login` (OAuth) | No (v1) | No (v1) | Flat-rate |
| OpenAI | `gpt-`, `o1`, `o3`, `o4`, `codex` | `OPENAI_API_KEY` | Yes | Yes | Per token |
| Gemini | `gemini-` | `GEMINI_API_KEY` or `GOOGLE_API_KEY` | Yes | Yes | Per token |
| OpenRouter | `openrouter:` | `OPENROUTER_API_KEY` | Yes | No (v1) | Per token |
| Local (OpenAI-compat) | `local:`, `local-`, `ollama:`, `vllm:`, `lmstudio:` | `CONDUCTOR_LOCAL_API_KEY` (often a dummy) | Depends on model | No | Free |
| Mock | `mock`, `mock-` | none | Configurable | n/a | $0 |

## Claude API

Standard Anthropic API. Per-token billing against `ANTHROPIC_API_KEY`.

```yaml
routing:
  default: claude-sonnet-4-6
  functions:
    plan: claude-opus-4-7
    verify: claude-haiku-4-5
```

## Claude subscription

Routes through your locally installed `claude` CLI (Claude Code) using your Pro/Max OAuth session. Flat-rate billing; no per-token cost. Adapter shells out via Node's `execFile` and parses `--output-format json`.

**Setup:**

1. Install Claude Code from https://claude.com/claude-code.
2. Run `claude login` once interactively.
3. Verify: `claude -p hello --output-format json` returns valid JSON.

**Model ids:** `claude-sub:sonnet`, `claude-sub:opus`, `claude-sub:haiku`, `claude-sub:default` (omits `--model`, lets the CLI choose).

**Constraints in v1:**

- **No custom tool calls.** The CLI has its own builtin tool set (Read, Write, Bash, etc.) which conflicts with conductor's per-op tool schemas. Tool-calling ops will throw — route them to the API adapter (`claude-*`) instead.
- **No streaming.** Adapter waits for the full JSON response, then returns.
- **Override the CLI path:** set `CONDUCTOR_CLAUDE_CLI` if the binary is not on PATH.

**Cost ceilings:** subscription is flat-rate, so cost telemetry will show $0 for these ops. Keep ceilings set anyway as a safety net for future API fallbacks.

## OpenAI

```yaml
routing:
  default: gpt-5
```

`OPENAI_API_KEY` required.

## Gemini

```yaml
routing:
  default: gemini-2.5-pro
```

`GEMINI_API_KEY` (or `GOOGLE_API_KEY` as fallback).

## OpenRouter

Unified gateway to many model vendors behind a single key. Useful when you want to mix vendors without managing separate accounts.

**Setup:**

1. Get a key at https://openrouter.ai/keys.
2. `$env:OPENROUTER_API_KEY = "sk-or-..."`.
3. (Optional) `$env:CONDUCTOR_OPENROUTER_REFERER` and `$env:CONDUCTOR_OPENROUTER_TITLE` are sent as `HTTP-Referer` and `X-Title` for the OpenRouter dashboard.

**Model ids:** prefix with `openrouter:` then use the slug from https://openrouter.ai/models, e.g.

- `openrouter:anthropic/claude-3.5-sonnet`
- `openrouter:openai/gpt-5`
- `openrouter:meta-llama/llama-3.3-70b-instruct`
- `openrouter:google/gemini-2.5-pro`

**Cost:** real; estimateCost returns $0 in v1 (no price table maintained). Actual usage comes from OpenRouter's response.

## Local: Ollama / vLLM / llama.cpp / LM Studio

Any server speaking OpenAI-compatible `/v1/chat/completions`. Single adapter, multiple prefixes for routing clarity.

| Prefix | Typical default port | Example model id |
|---|---|---|
| `ollama:` | 11434 | `ollama:llama-3.3-70b` |
| `vllm:` | 8000 | `vllm:mistral-7b-instruct` |
| `lmstudio:` | 1234 | `lmstudio:phi-4` |
| `local:` / `local-` | 11434 (default) | `local:custom-model` |

**Env vars:**

- `CONDUCTOR_LOCAL_BASE_URL` — default `http://localhost:11434/v1` (Ollama). Set to `http://localhost:1234/v1` for LM Studio.
- `CONDUCTOR_LOCAL_API_KEY` — default `ollama` (any non-empty string works for most local servers; LM Studio accepts `lm-studio`).

**Tool support:** the adapter reports `tools: false` by default because most local models have weak tool-calling. If your loaded model handles tools well, ops will work — the capability flag is advisory.

## Per-card overrides

Any model id syntax works in card frontmatter `model_overrides`:

```yaml
---
id: 2026-05-09-tricky-refactor
model_overrides:
  review: openrouter:openai/gpt-5
  verify: lmstudio:phi-4
---
```
