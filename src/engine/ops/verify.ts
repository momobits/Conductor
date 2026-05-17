// src/engine/ops/verify.ts
//
// Operation: run the project's verify command, ask the model to
// classify the outcome, write the formatted Verification Report to
// the per-run substrate (.conductor/runs/<runId>/verify.md). Phase 28.2
// migrated this op off card-body appends.

import type { ModelAdapter } from '../../adapters/adapter.js';
import type { Card, VerifyReport, VerifyOutcome } from '../types.js';
import { RunArtifactWriter } from '../../agent/run_artifact.js';
import { parseJsonResponse } from '../util/parse_json_response.js';

export interface RunnerResult {
  stdout: string;
  stderr: string;
  exitCode: number;
}

export type Runner = (command: string) => Promise<RunnerResult>;

export interface VerifyArgs {
  card: Card;
  adapter: ModelAdapter;
  model: string;
  command: string;
  runner: Runner;
  repo: string;
  runId: string;
}

const VALID_OUTCOMES: VerifyOutcome[] = ['PASS', 'FAIL', 'SKIP'];

const SYSTEM_PROMPT = `You are evaluating the output of a verification
command. Decide whether verification PASSed, FAILed, or was SKIPped, and
extract distinct failures.

Return ONLY a single JSON object on one line, no Markdown fence:

  {
    "outcome": "PASS" | "FAIL" | "SKIP",
    "summary": "<2-3 sentence narrative>",
    "failures": ["<one failure per item>", ...]
  }

PASS  — command exited 0 and all tests/checks succeeded.
FAIL  — command exited non-zero or output indicates failures.
SKIP  — no tests/checks were applicable (e.g. empty test suite).`.trim();

function truncate(s: string, max = 4000): string {
  return s.length <= max ? s : s.slice(0, max) + `\n... [truncated ${s.length - max} chars]`;
}

export async function verify(args: VerifyArgs): Promise<VerifyReport> {
  const { card, adapter, model, command, runner, repo, runId } = args;

  if (typeof repo !== 'string' || repo.length === 0) {
    throw new Error(`verify: repo arg required (received: ${JSON.stringify(repo)}).`);
  }
  if (typeof runId !== 'string' || runId.length === 0) {
    throw new Error(`verify: runId arg required (received: ${JSON.stringify(runId)}).`);
  }

  const result = await runner(command);

  const userPrompt = [
    `Card: ${card.frontmatter.id}`,
    `Verify command: ${command}`,
    `Exit code: ${result.exitCode}`,
    '',
    '--- stdout ---',
    truncate(result.stdout),
    '',
    '--- stderr ---',
    truncate(result.stderr),
  ].join('\n');

  const resp = await adapter.invoke({
    operation: 'verify',
    model,
    system: SYSTEM_PROMPT,
    user: userPrompt,
  });

  let parsed: { outcome: VerifyReport['outcome']; summary: string; failures: string[] };
  try {
    const raw = parseJsonResponse<{ outcome: string; summary?: string; failures?: unknown[] }>(resp.text, { op: 'verify' });
    if (!(VALID_OUTCOMES as readonly string[]).includes(raw.outcome)) {
      throw new Error(
        `Invalid outcome "${raw.outcome}" from model; expected one of ${VALID_OUTCOMES.join(', ')}.\n--- raw ---\n${resp.text}`,
      );
    }
    parsed = {
      outcome: raw.outcome as VerifyOutcome,
      summary: String(raw.summary ?? ''),
      failures: Array.isArray(raw.failures) ? raw.failures.map(String) : [],
    };
  } catch (e) {
    throw new Error(`Failed to parse verify JSON: ${(e as Error).message}\n--- raw ---\n${resp.text}`);
  }

  const report: VerifyReport = {
    outcome: parsed.outcome,
    command,
    exit_code: result.exitCode,
    summary: parsed.summary,
    failures: parsed.failures,
  };

  const sectionBody = [
    `**Outcome:** ${report.outcome}`,
    `**Command:** \`${report.command}\``,
    `**Exit code:** ${report.exit_code}`,
    '',
    `**Summary:** ${report.summary}`,
    '',
    report.failures.length > 0
      ? '**Failures:**\n' + report.failures.map((f) => `- ${f}`).join('\n')
      : '**Failures:** (none)',
  ].join('\n');

  // Phase 28.2: persist to per-run substrate (NOT to card body).
  await new RunArtifactWriter({ repo, runId }).write('verify', sectionBody);
  return report;
}

// Default runner — used by CLI invocations. Importable for production but
// not pulled into tests so we can keep test runs hermetic.
export async function defaultRunner(command: string): Promise<RunnerResult> {
  const { execa } = await import('execa');
  const proc = await execa(command, { shell: true, reject: false });
  return {
    stdout: proc.stdout ?? '',
    stderr: proc.stderr ?? '',
    exitCode: proc.exitCode ?? 0,
  };
}
