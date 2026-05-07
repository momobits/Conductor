# Phase 3 — Multi-Model Adapters + Routing Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Extend the Phase 1+2 engine so a single Conductor run can route different operations to different model providers (Claude, OpenAI, Gemini, Local) based on the project config and per-card overrides. Operations remain provider-agnostic; only the adapter layer changes.

**Architecture:** Introduce a `RoutingAdapter` that implements `ModelAdapter` and dispatches to the right provider adapter based on the requested model id. Provider resolution is prefix-based (`claude-*` → Claude, `gpt-*` / `codex-*` / `o*` → OpenAI, `gemini-*` → Gemini, `local:*` / `ollama:*` / `local-*` → Local). Each provider adapter follows the Phase 1 ClaudeAdapter pattern: SDK client (or fetch wrapper) injected via constructor, `invoke()` returns a normalized `OperationResponse`, `capabilities()` reports the adapter's tier. The Local adapter speaks the OpenAI-compatible Chat Completions shape so it works with Ollama, vLLM, and llama.cpp without per-runtime forks. Routing precedence is honored end-to-end: card frontmatter `model_overrides[op]` > project YAML `routing.functions[op]` > project YAML `routing.default` > adapter-built-in default. All ops continue to call `adapter.invoke()` unaware of which provider services the call.

**Tech stack:** Same as Phase 1+2 (TypeScript 5.6+, Node 20+, Vitest, Commander.js, gray-matter, js-yaml, Zod, simple-git, execa, @anthropic-ai/sdk). New deps this phase: `openai` for the OpenAI adapter; `@google/genai` for the Gemini adapter. Local adapter uses Node's built-in `fetch` and adds no SDK dep.

**Spec reference:** `docs/superpowers/specs/2026-05-06-conductor-design1.md` § 4 (architecture: Model Adapter Layer), § 7 (Model adapter layer), § 12 (v1 phasing — Phase 3).

**Phase tag at completion:** `phase-3-multi-model-closed`.

---

## Sub-phase checkpoints

- **Sub-phase A (Tasks 1–2) — Foundation.** Provider taxonomy + model→provider resolver. The shared module every adapter and the router will import.
- **Sub-phase B (Tasks 3–5) — Provider adapters.** OpenAI, Gemini, Local. Each adapter is independent and unit-tested with an injected fake.
- **Sub-phase C (Tasks 6–8) — Routing integration.** `RoutingAdapter` that delegates per model id; per-card `model_overrides` plumbed through `runWork`; `init` template refreshed.
- **Sub-phase D (Tasks 9–10) — End-to-end + close.** Phase 3 integration test exercising mixed-provider routing through the work CLI; README refresh; phase tag.

After each sub-phase, run `npm test` and commit a milestone (e.g., `chore(3.A): sub-phase A foundation complete`).

---

## File Structure

```
conductor/
├── package.json                              # task 1: add openai, @google/genai
├── src/
│   ├── adapters/
│   │   ├── adapter.ts                        # (Phase 1 — unchanged)
│   │   ├── mock.ts                           # (Phase 1 — unchanged)
│   │   ├── claude.ts                         # (Phase 1 — unchanged in Phase 3)
│   │   ├── provider.ts                       # task 2: NEW — Provider taxonomy + resolveProvider
│   │   ├── openai.ts                         # task 3: NEW
│   │   ├── gemini.ts                         # task 4: NEW
│   │   ├── local.ts                          # task 5: NEW
│   │   └── routing.ts                        # task 6: NEW — RoutingAdapter
│   ├── cli/commands/
│   │   ├── work.ts                           # task 7: route through RoutingAdapter + card overrides
│   │   └── init.ts                           # task 8: refresh DEFAULT_CONFIG to showcase routing
│   └── engine/
│       └── (no changes — engine stays provider-agnostic)
├── tests/
│   ├── adapters/
│   │   ├── provider.test.ts                  # task 2
│   │   ├── openai.test.ts                    # task 3
│   │   ├── gemini.test.ts                    # task 4
│   │   ├── local.test.ts                     # task 5
│   │   └── routing.test.ts                   # task 6
│   ├── cli/
│   │   └── work-phase3.test.ts               # task 7 (routing precedence + card overrides)
│   └── integration/
│       └── phase3-end-to-end.test.ts         # task 9
└── README.md                                 # task 10: refresh
```

---

## Tasks

## Sub-phase A — Foundation

### Task 1: Add provider SDK dependencies

**Files:**
- Modify: `package.json`

- [ ] **Step 1: Add openai + @google/genai to dependencies**

Edit `package.json`'s `dependencies` block:

```json
    "@google/genai": "^1.0.0",
    "openai": "^4.70.0",
```

(Versions are floors; use the latest published 1.x / 4.x at install time.)

Then `npm install`.

Expected: install completes; `package-lock.json` updates with both packages.

**Verify:** `npm test` still passes (no behavior change). **Commit:** `feat(3.1): add openai + @google/genai dependencies`.

---

### Task 2: Provider taxonomy + resolveProvider utility

**Files:**
- Create: `src/adapters/provider.ts`
- Create: `tests/adapters/provider.test.ts`

- [ ] **Step 1: Define `Provider` type and `resolveProvider(modelId)`**

`src/adapters/provider.ts`:

```typescript
// src/adapters/provider.ts
//
// Provider taxonomy + model id → provider resolver. Used by RoutingAdapter
// to pick the correct adapter for a given model id. Prefix-based; v1
// favors simplicity. v2 may introduce capability tags ("reasoning-strong",
// "large-context") that resolve via this same module.

export const PROVIDERS = ['claude', 'openai', 'gemini', 'local', 'mock'] as const;
export type Provider = (typeof PROVIDERS)[number];

/** Resolve a model id (e.g. "claude-sonnet-4-6", "gpt-5", "gemini-2.5-pro",
 *  "local:llama-3.3-70b", "ollama:qwen2.5") to its provider family.
 *  Throws on unrecognized prefixes — Conductor's routing precedence ensures
 *  every call site has a non-null model id by the time we reach here. */
export function resolveProvider(modelId: string): Provider {
  const id = modelId.trim().toLowerCase();
  if (id.startsWith('claude-') || id.startsWith('claude:')) return 'claude';
  if (id.startsWith('gpt-') || id.startsWith('codex') || id.startsWith('o1') || id.startsWith('o3') || id.startsWith('o4')) return 'openai';
  if (id.startsWith('gemini-')) return 'gemini';
  if (id.startsWith('local:') || id.startsWith('local-') || id.startsWith('ollama:') || id.startsWith('vllm:')) return 'local';
  if (id === 'mock' || id.startsWith('mock-')) return 'mock';
  throw new Error(`Unknown provider for model id "${modelId}". Recognized prefixes: claude-, gpt-, codex, o1/o3/o4, gemini-, local:, local-, ollama:, vllm:, mock.`);
}
```

- [ ] **Step 2: Test resolveProvider for each prefix family + unknown**

`tests/adapters/provider.test.ts`:

```typescript
import { describe, it, expect } from 'vitest';
import { resolveProvider } from '../../src/adapters/provider.js';

describe('resolveProvider', () => {
  it.each([
    ['claude-sonnet-4-6', 'claude'],
    ['claude-opus-4-7', 'claude'],
    ['gpt-5', 'openai'],
    ['codex-mini', 'openai'],
    ['o1-preview', 'openai'],
    ['o3-mini', 'openai'],
    ['gemini-2.5-pro', 'gemini'],
    ['local:llama-3.3-70b', 'local'],
    ['local-qwen-2.5', 'local'],
    ['ollama:phi-4', 'local'],
    ['mock', 'mock'],
    ['mock-cheap', 'mock'],
  ])('%s → %s', (id, expected) => {
    expect(resolveProvider(id)).toBe(expected);
  });

  it('throws on unrecognized model id', () => {
    expect(() => resolveProvider('mistral-large')).toThrow(/Unknown provider/);
  });

  it('is case-insensitive', () => {
    expect(resolveProvider('CLAUDE-Sonnet-4-6')).toBe('claude');
  });
});
```

**Verify:** `npm test -- provider.test` passes. **Commit:** `feat(3.2): provider taxonomy + resolveProvider utility`.

---

## Sub-phase B — Provider adapters

### Task 3: OpenAIAdapter

**Files:**
- Create: `src/adapters/openai.ts`
- Create: `tests/adapters/openai.test.ts`

- [ ] **Step 1: Implement OpenAIAdapter**

Mirror `claude.ts` shape:
- Inject SDK client via constructor (`new OpenAI()` default).
- `invoke()` calls `client.chat.completions.create({ model, messages: [{role:'system',...},{role:'user',...}], max_tokens })`.
- Extract `choices[0].message.content` for `text`. Tool calls: `choices[0].message.tool_calls` → map to `ToolCall[]`. Usage: `usage.prompt_tokens` / `completion_tokens`.
- `capabilities()`: `tools: true`, `contextWindowTokens: 128_000` (GPT-5 baseline; pessimistic), `streaming: true`, `costTier: 'standard'`, `supportsExtendedThinking: false`, `supportsPromptCaching: true`.
- `estimateCost()`: same `(system+user)/4` placeholder Phase 1 used; Phase 7 hardens.
- `id = 'openai'`.

Key shape concerns:
- OpenAI SDK uses `max_tokens` (deprecated) or `max_completion_tokens` (newer). Use `max_tokens` for v1 compatibility; revisit if Phase 7 cost work needs reasoning-token accounting.
- `tools` parameter: OpenAI uses `tools: [{type:'function', function:{name, description, parameters}}]`. Convert from our `ToolSchema` (Anthropic-shaped `name/description/input_schema`) inside the adapter.

- [ ] **Step 2: Test with injected fake client**

Mirror `tests/adapters/claude.test.ts`:
- `FakeOpenAI` with `chat.completions.create` returning a canned response.
- One test: system+user prompt, returned text, token counts, model echo.
- One test: tool-call extraction (`choices[0].message.tool_calls = [{id,type:'function',function:{name,arguments:'{...}'}}]` → adapter parses arguments JSON → `ToolCall` with `input` as object).
- One test: `capabilities()` smoke.

**Verify:** `npm test -- openai.test` passes. **Commit:** `feat(3.3): OpenAI adapter wrapping chat.completions API`.

---

### Task 4: GeminiAdapter

**Files:**
- Create: `src/adapters/gemini.ts`
- Create: `tests/adapters/gemini.test.ts`

- [ ] **Step 1: Implement GeminiAdapter**

`@google/genai` SDK shape (current 1.x API):
- `import { GoogleGenAI } from '@google/genai'`.
- `client.models.generateContent({ model, contents, config: { systemInstruction, maxOutputTokens, tools } })`.
- Result: `response.text` is a getter returning the concatenated text. `response.usageMetadata.{promptTokenCount,candidatesTokenCount}` for tokens.
- Tool calls: `response.functionCalls` → `[{name, args}]` → map to `ToolCall[]`.

Adapter:
- `id = 'gemini'`.
- Inject SDK via constructor (default `new GoogleGenAI()`; reads `GOOGLE_API_KEY` / `GEMINI_API_KEY` from env).
- `capabilities()`: `tools: true`, `contextWindowTokens: 1_000_000`, `streaming: true`, `costTier: 'standard'`, `supportsExtendedThinking: false`, `supportsPromptCaching: true`.
- Translate our `ToolSchema` to Gemini's `FunctionDeclaration` (`{name, description, parameters}` — Gemini accepts JSON Schema directly).

- [ ] **Step 2: Test with injected fake client**

`FakeGenAI` with `models.generateContent(args)` returning a canned response. Test text extraction, token counts, tool-call extraction, capabilities.

**Verify:** `npm test -- gemini.test` passes. **Commit:** `feat(3.4): Gemini adapter wrapping generateContent API`.

---

### Task 5: LocalAdapter (OpenAI-compatible HTTP)

**Files:**
- Create: `src/adapters/local.ts`
- Create: `tests/adapters/local.test.ts`

- [ ] **Step 1: Implement LocalAdapter via fetch**

No SDK. Talks to any OpenAI-compatible Chat Completions endpoint:
- Default base URL: `http://localhost:11434/v1` (Ollama default). Configurable via `LocalAdapterOptions.baseUrl` and `CONDUCTOR_LOCAL_BASE_URL` env.
- Default API key: `'ollama'` (Ollama accepts any non-empty token). Configurable via `LocalAdapterOptions.apiKey` and `CONDUCTOR_LOCAL_API_KEY`.
- Inject a `fetch` impl (`globalThis.fetch` default) so tests can pass a fake.
- `invoke()` builds `{model, messages, max_tokens}` and POSTs to `${baseUrl}/chat/completions`. Parse the JSON response shape `{choices:[{message:{content,tool_calls?}}], usage:{prompt_tokens,completion_tokens}, model}` exactly like OpenAI.
- Strip the `local:` / `local-` / `ollama:` / `vllm:` prefix before sending the model id to the endpoint (so `local:llama-3.3-70b` → `llama-3.3-70b`).
- `id = 'local'`.
- `capabilities()`: `tools: false` (most local runtimes don't support tool use reliably yet — pessimistic default), `contextWindowTokens: 32_768`, `streaming: false`, `costTier: 'free'`, `supportsExtendedThinking: false`, `supportsPromptCaching: false`.
- `estimateCost()`: `dollars: 0` (local inference is free at the API layer).

- [ ] **Step 2: Test with injected fake fetch**

`tests/adapters/local.test.ts`:
- `fakeFetch` returns a canned `Response` (use `new Response(JSON.stringify({...}), {status:200})`).
- One test: prompt → `chat/completions` POST is made with stripped model id, response parsed.
- One test: model id without prefix passes through unchanged (`llama3` → POSTed as `llama3`).
- One test: error response (non-200) throws with body in message.
- One test: `capabilities()` smoke.

**Verify:** `npm test -- local.test` passes. **Commit:** `feat(3.5): Local adapter via OpenAI-compat HTTP fetch`.

After Sub-phase B: `chore(3.B): sub-phase B provider adapters complete` checkpoint commit (no code, summary message only — keeps a clean rerun cursor for the executor).

---

## Sub-phase C — Routing integration

### Task 6: RoutingAdapter

**Files:**
- Create: `src/adapters/routing.ts`
- Create: `tests/adapters/routing.test.ts`

- [ ] **Step 1: Implement RoutingAdapter**

```typescript
// src/adapters/routing.ts
//
// RoutingAdapter implements ModelAdapter by delegating each invoke() call to
// the provider adapter resolved from request.model. Constructed once per
// run and shared across ops; provider adapters are lazy-instantiated on
// first use to avoid touching env vars for unused providers.

export interface RoutingAdapterOptions {
  factories?: Partial<Record<Provider, () => ModelAdapter>>;
  // pre-instantiated adapters override factories; useful for tests.
  adapters?: Partial<Record<Provider, ModelAdapter>>;
}

export class RoutingAdapter implements ModelAdapter {
  readonly id = 'routing';
  private factories: Record<Provider, () => ModelAdapter>;
  private cache: Map<Provider, ModelAdapter> = new Map();

  constructor(opts: RoutingAdapterOptions = {}) {
    // default factories construct each provider adapter with no args
    this.factories = {
      claude: opts.factories?.claude ?? (() => new ClaudeAdapter()),
      openai: opts.factories?.openai ?? (() => new OpenAIAdapter()),
      gemini: opts.factories?.gemini ?? (() => new GeminiAdapter()),
      local:  opts.factories?.local  ?? (() => new LocalAdapter()),
      mock:   opts.factories?.mock   ?? (() => new MockAdapter()),
    };
    if (opts.adapters) {
      for (const [k, v] of Object.entries(opts.adapters)) {
        if (v) this.cache.set(k as Provider, v);
      }
    }
  }

  private adapterFor(modelId: string): ModelAdapter {
    const provider = resolveProvider(modelId);
    let cached = this.cache.get(provider);
    if (!cached) {
      cached = this.factories[provider]();
      this.cache.set(provider, cached);
    }
    return cached;
  }

  invoke(req: OperationRequest) { return this.adapterFor(req.model).invoke(req); }
  capabilities(): AdapterCapabilities { /* return a permissive default; real capabilities come from the resolved adapter */ }
  estimateCost(req: OperationRequest) { return this.adapterFor(req.model).estimateCost(req); }
}
```

`capabilities()` on the router returns a maximally permissive shape (`tools: true, contextWindowTokens: 1_000_000, streaming: true, costTier: 'standard', supportsExtendedThinking: true, supportsPromptCaching: true`). Engine code that needs accurate capabilities for a specific call should reach through to the resolved adapter — but no Phase 3 op does. Add a comment that this is a v1 simplification.

- [ ] **Step 2: Test routing precedence + lazy instantiation**

`tests/adapters/routing.test.ts`:
- Inject pre-instantiated `MockAdapter`s for two providers; verify each is invoked when a matching model id is requested.
- Verify a single instance is reused across calls with the same provider (cache).
- Verify factories are only called when a provider is first requested (track call counts).
- Verify unknown model id throws (delegates to `resolveProvider`'s error).

**Verify:** `npm test -- routing.test` passes. **Commit:** `feat(3.6): RoutingAdapter delegates per model id`.

---

### Task 7: Plumb routing precedence through `runWork`

**Files:**
- Modify: `src/cli/commands/work.ts`
- Create: `tests/cli/work-phase3.test.ts`

- [ ] **Step 1: Extend `modelFor` to honor card `model_overrides`**

In `runWork`:

```typescript
const modelFor = (op: string): string =>
  card.frontmatter.model_overrides[op]
    ?? config.routing.functions[op]
    ?? config.routing.default;
```

(The card here is the freshly-read card at the top of `runWork`; per-op calls re-read the card already, so the override is always current.)

Note: the existing code re-reads the card before each op (`await readCard(cardPath)`). That re-read returns a fresh `Card`; pass `updated.frontmatter.model_overrides[op]` rather than closing over the outer `card`. Consider extracting a helper `pickModel(card, op, config)` to keep the logic in one place.

- [ ] **Step 2: Default adapter to RoutingAdapter**

```typescript
const adapter: ModelAdapter = args.adapter ?? new RoutingAdapter();
```

(Existing tests pass an explicit `MockAdapter` via `args.adapter`, so this change is backwards compatible.)

- [ ] **Step 3: Test routing precedence end-to-end**

`tests/cli/work-phase3.test.ts`:
- Set up a card with `model_overrides: { plan: 'gpt-5' }` and config with `routing.default: 'claude-sonnet-4-6'`, `routing.functions.plan: 'claude-opus-4-7'`.
- Inject a `RoutingAdapter` whose four provider adapters are all `MockAdapter` instances; queue responses on each.
- Invoke `runWork` to drive `discovered → planned`. Verify that `analyze` hit the Claude mock (default), and `plan` hit the OpenAI mock (card override beats config function override).
- Add a second test: card with NO override, config function override `plan: 'gemini-2.5-pro'` → `plan` hits the Gemini mock.
- Add a third test: card AND config silent on `verify` op → falls back to `routing.default`.

**Verify:** `npm test -- work-phase3` passes. **Commit:** `feat(3.7): wire RoutingAdapter into work + card override precedence`.

---

### Task 8: Refresh `init` config template + `model_overrides` documentation

**Files:**
- Modify: `src/cli/commands/init.ts`
- Modify: `tests/cli/init.test.ts` (snapshot if any)

- [ ] **Step 1: Update `DEFAULT_CONFIG` in `init.ts`**

Showcase realistic multi-provider routing from spec § 7:

```yaml
routing:
  default: claude-sonnet-4-6
  functions:
    analyze: claude-opus-4-7         # heavy reasoning
    plan: claude-opus-4-7
    review: claude-opus-4-7          # adversarial; want best
    implement: gpt-5                 # rapid impl
    verify: claude-haiku-4-5         # cheap validation
    scan: gemini-2.5-pro             # large context
    discover: gemini-2.5-pro
    order: claude-haiku-4-5
    detect_drift: local:llama-3.3-70b   # deterministic; regex+git
```

(Document inline that each card may override these via `model_overrides:` in its frontmatter.)

- [ ] **Step 2: Update existing init test if it asserts config content**

Run `npm test -- init` and adjust assertions if any compare the generated YAML byte-for-byte. (Phase 1's init test is structural — checks for the existence of `routing` block — so this should pass without changes; double-check.)

**Verify:** `npm test -- init` passes. **Commit:** `feat(3.8): refresh init template with multi-provider routing`.

After Sub-phase C: `chore(3.C): sub-phase C routing integration complete` checkpoint commit.

---

## Sub-phase D — End-to-end + close

### Task 9: Phase 3 end-to-end integration test

**Files:**
- Create: `tests/integration/phase3-end-to-end.test.ts`

- [ ] **Step 1: Drive a card through discovered → archived with mixed providers**

Build on `tests/integration/phase2-end-to-end.test.ts` shape:
- Init a temp repo + `.conductor/`; write a config that routes `analyze`/`plan`/`review` to Claude, `implement` to OpenAI, `verify`/`notebook` (deterministic) and the rest unchanged.
- Construct a `RoutingAdapter` with `MockAdapter` instances injected for each provider.
- Queue canned responses on the right mock per op.
- Drive `runWork` step-by-step and assert at each step:
  - The right provider mock saw the call (via `lastRequest`).
  - The card transitions through every column.
  - The git log records `feat(3.x.y): …` style commits from `implement`.

**Verify:** Test passes. **Commit:** `test(3.9): Phase 3 end-to-end with mixed-provider routing`.

---

### Task 10: README refresh + Phase 3 close

**Files:**
- Modify: `README.md`

- [ ] **Step 1: Document the multi-model routing in README**

Add a "Routing" section under the existing "Configuration" content:
- The four-tier precedence (built-in → YAML default → YAML function → card override).
- Provider prefix table (`claude-*`, `gpt-*`/`codex`/`o1-3-4`, `gemini-*`, `local:*`/`ollama:*`).
- Pointer to `.conductor/config.yaml` for project-wide defaults; pointer to card frontmatter `model_overrides` for per-card.
- Note: env vars expected (`ANTHROPIC_API_KEY`, `OPENAI_API_KEY`, `GOOGLE_API_KEY`, plus optional `CONDUCTOR_LOCAL_BASE_URL` / `CONDUCTOR_LOCAL_API_KEY`).

- [ ] **Step 2: Run full test suite, commit, tag**

```bash
npm test                          # expect 145+ passing
git add README.md
git commit -m "docs(3.10): README routing section + Phase 3 close"
git tag phase-3-multi-model-closed
```

**Verify:** Working tree clean; tag listed in `git tag --list`; full test suite green.

**Final commit:** `docs(3.10): README routing section + Phase 3 close`.

---

## Risks & open questions

- **OpenAI tool-call argument shape.** OpenAI returns `function.arguments` as a JSON-encoded string; Gemini returns `args` as an object. The adapter normalizes to object — be careful with malformed JSON (catch and surface in the response's text rather than throwing).
- **GPT-5 / Codex model id surface.** Spec uses `codex` as a placeholder; check the actual model id at install time and prefer the published name. The prefix matcher handles `codex`, `gpt-`, `o1`, `o3`, `o4` — extend if a new family ships.
- **Gemini SDK churn.** `@google/genai` 1.x is the current generation; the older `@google/generative-ai` package is deprecated. Confirm the import surface at `npm install` time; the methods used (`models.generateContent`, `response.text`, `response.usageMetadata`) are stable on 1.x.
- **Local adapter limits.** Tools are off by default in capabilities; if a Phase 4 op needs tool use over local models, we'll either extend LocalAdapter or split it into per-runtime adapters (Ollama, vLLM) since their tool-use support diverges.
- **Capability reporting through router.** RoutingAdapter returns a generic capability shape rather than the resolved adapter's. No Phase 3 caller depends on accurate capabilities; if Phase 4 introduces a cost-aware caller, revisit by accepting an op name in `capabilities(op)` and resolving the model id from config.
- **Env var auth at construction time.** Each provider SDK reads its API key on construction. Lazy instantiation in `RoutingAdapter` ensures we only fail-fast when a provider is actually needed — a project that routes everything to Claude won't crash on a missing `OPENAI_API_KEY`.

---

## Success criteria

- All 134 Phase 2 tests still pass.
- ~15 new tests across `provider`, `openai`, `gemini`, `local`, `routing`, `work-phase3`, `phase3-end-to-end` (target ~145–150 total).
- A user with three API keys configured and a default Conductor project can run `conductor work <card>` and see different ops dispatch to different providers per the YAML routing.
- `phase-3-multi-model-closed` tag at HEAD; tree clean.

---

## Out of scope (deferred)

- **Cost ceilings.** Spec § 7 mentions `cost_ceilings:` block. Phase 7 hardening.
- **Cassette-based provider integration tests.** Spec § 13. Phase 7.
- **Capability-tag routing.** (`reasoning-strong`, `large-context`.) Phase 4+ once we have Conductor brain making routing decisions.
- **Streaming responses.** All adapters return `streaming: true/false` capability flags but `invoke()` is non-streaming v1. Phase 4 daemon will revisit.
- **Per-adapter cost models.** `estimateCost()` remains a `(chars/4)` placeholder across all adapters. Phase 7.
- **Run log of which adapter handled which call.** No journal/runs writes added in Phase 3. Phase 4 daemon adds run logs.
