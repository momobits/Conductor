// src/engine/ops/implement.ts
//
// Operation: apply ONE step of the implementation plan to the working
// tree, then commit with Control's commit-per-step format. Phase 28.3
// migrated this op off card-body appends: implement reads the plan from
// the per-run substrate (.conductor/runs/<latestPlanRunId>/plan.md) and
// writes its guideline to the per-run substrate (.conductor/runs/<runId>/
// implement.md). Card body is no longer mutated.

import { writeFile, mkdir, rm, access } from 'node:fs/promises';
import { resolve, relative, dirname, isAbsolute } from 'node:path';
import type { ModelAdapter } from '../../adapters/adapter.js';
import { COMMIT_TYPES, type Card, type CommitType, type Diff, type DiffFile } from '../types.js';
import { RunArtifactWriter, findLatestArtifactRunId } from '../../agent/run_artifact.js';
import { commitStep } from '../state/git.js';
import { parseJsonResponse } from '../util/parse_json_response.js';
import { runAgenticReadLoop } from '../agentic_read.js';
import type { OperationResponse } from '../operation.js';

export interface ImplementArgs {
  repo: string;
  card: Card;
  adapter: ModelAdapter;
  model: string;
  step: string; // e.g. '1.1'
  runId: string;
}

const SYSTEM_PROMPT = `You are an experienced software engineer applying ONE
step of an implementation plan. Read the plan carefully, identify the
requested step, and produce a concrete diff.

You have READ-ONLY tools to inspect the working tree before you write anything:
- read_file: read a file's current content (repo-relative path)
- grep_codebase: search the repo for a regex pattern
- glob_files: list files matching a glob pattern

CRITICAL: Before you emit a diff with action "modify", you MUST first call
read_file on that file to see its CURRENT content. You cannot reproduce an
existing file from memory — read it, then produce the COMPLETE new content
based on what you read. Use these tools as many times as you need. When you
have everything you need, STOP calling tools and reply with ONLY the final
JSON object.

Return ONLY a single JSON object on one line, no Markdown fence, matching:

  {
    "step": "<step id, e.g. 1.1>",
    "commit_type": "feat" | "fix" | "test" | "docs" | "refactor" | "chore",
    "commit_subject": "<imperative, <70 chars>",
    "files": [
      { "path": "<repo-relative path>", "action": "create" | "modify" | "delete", "content": "<full file content for create/modify; empty for delete>" }
    ],
    "notes": "<freeform; mirrors the plan's HOW>"
  }

Rules:
- Use full file content (not patches) so the apply step is deterministic.
- For "modify", read the file FIRST, then return the complete updated content.
- Paths MUST be repo-relative POSIX (no leading slash, no '..').
- Do NOT include files outside what this single step requires.`.trim();

function ensureSafePath(repo: string, p: string): string {
  if (isAbsolute(p) || p.includes('\0')) {
    throw new Error(`Invalid file path (absolute or null byte): ${p}`);
  }
  const abs = resolve(repo, p);
  const rel = relative(repo, abs);
  if (rel.startsWith('..') || isAbsolute(rel)) {
    throw new Error(`Invalid file path (escapes repo): ${p}`);
  }
  return abs;
}

async function fileExists(abs: string): Promise<boolean> {
  try {
    await access(abs);
    return true;
  } catch (e: unknown) {
    if ((e as NodeJS.ErrnoException)?.code === 'ENOENT') return false;
    throw e;
  }
}

async function applyDiffFile(repo: string, file: DiffFile): Promise<void> {
  const abs = ensureSafePath(repo, file.path);
  if (file.action === 'delete') {
    try {
      await rm(abs);
    } catch (e: unknown) {
      if ((e as NodeJS.ErrnoException)?.code !== 'ENOENT') throw e;
    }
    return;
  }
  if (file.action === 'create' && (await fileExists(abs))) {
    throw new Error(`create requested but file exists: ${file.path}`);
  }
  if (file.action === 'modify' && !(await fileExists(abs))) {
    throw new Error(`modify requested but file does not exist: ${file.path}`);
  }
  await mkdir(dirname(abs), { recursive: true });
  await writeFile(abs, file.content, 'utf8');
}

export async function implement(args: ImplementArgs): Promise<Diff> {
  const { repo, card, adapter, model, step, runId } = args;

  if (typeof repo !== 'string' || repo.length === 0) {
    throw new Error(`implement: repo arg required (received: ${JSON.stringify(repo)}).`);
  }
  if (typeof runId !== 'string' || runId.length === 0) {
    throw new Error(`implement: runId arg required (received: ${JSON.stringify(runId)}).`);
  }

  // Phase 28.3: read plan from per-run substrate (fixes the latent prompt
  // bug introduced when 28.1 + 28.2 removed Analysis + Plan sections from
  // card.body). Pre-28.3 implement spliced card.body.trim() into the prompt
  // under a "Card body (Analysis + Plan)" label, but body has neither
  // section post-28.1 + 28.2 — the prompt was near-empty in production.
  const found = await findLatestArtifactRunId(repo, card.frontmatter.id, 'plan');
  if (!found) {
    throw new Error(
      `Card ${card.frontmatter.id} has no Implementation Plan in any prior run; run plan first.`,
    );
  }
  const { runId: planRunId, text: plan } = found;

  const userPrompt = [
    `Card: ${card.frontmatter.id}`,
    `Phase: ${card.frontmatter.phase}`,
    `Step requested: ${step}`,
    `Plan run: ${planRunId}`,
    '',
    '--- Card body (user description) ---',
    card.body.trim(),
    '',
    '--- Implementation Plan (from substrate) ---',
    plan,
  ].join('\n');

  // Cohort 3.2: drive an agentic READ-tool loop so the model can read the
  // files it will modify BEFORE emitting its diff. Previously implement made
  // ONE contextless invoke demanding full-file JSON; a real model had to
  // reproduce existing files from memory (corruption/truncation). The loop
  // returns the model's FINAL response once it stops calling read tools — and
  // a model that returns the diff immediately with zero tool calls (the
  // scripted MockAdapter in these tests + full-lifecycle-sweep) still works on
  // round 1, unchanged. Adapters without tool support fall back to a single
  // tool-less invoke (the model loses file-reading context but the contract is
  // preserved end-to-end).
  let resp: OperationResponse;
  if (adapter.capabilities().tools) {
    const loop = await runAgenticReadLoop({
      repo,
      adapter,
      operation: 'implement',
      model,
      system: SYSTEM_PROMPT,
      user: userPrompt,
    });
    resp = loop.response;
  } else {
    resp = await adapter.invoke({
      operation: 'implement',
      model,
      system: SYSTEM_PROMPT,
      user: userPrompt,
    });
  }

  let diff: Diff;
  try {
    const parsed = parseJsonResponse<{ step?: string; commit_type?: string; commit_subject?: string; files?: unknown[]; notes?: string }>(resp.text, { op: 'implement' });
    if (!parsed.commit_type || !(COMMIT_TYPES as readonly string[]).includes(parsed.commit_type)) {
      throw new Error(
        `Invalid commit_type "${parsed.commit_type}" from model; expected one of ${COMMIT_TYPES.join(', ')}.`,
      );
    }
    diff = {
      step: String(parsed.step ?? step),
      commit_type: parsed.commit_type as CommitType,
      commit_subject: String(parsed.commit_subject ?? ''),
      files: Array.isArray(parsed.files) ? (parsed.files as DiffFile[]) : [],
      notes: String(parsed.notes ?? ''),
    };
  } catch (e) {
    throw new Error(`Failed to parse implement JSON: ${(e as Error).message}\n--- raw ---\n${resp.text}`);
  }

  for (const f of diff.files) {
    await applyDiffFile(repo, f);
  }

  // Phase 28.3: persist implementation guideline to per-run substrate (NOT
  // to card body). Write BEFORE commitStep so the substrate file is part of
  // the step's run-dir state at the moment of commit (mirrors the pre-28.3
  // ordering where appendSection ran before commitStep).
  const guideline = [
    `### Step ${diff.step} — ${diff.commit_subject}`,
    '',
    `Files: ${diff.files.map((f) => `${f.action} ${f.path}`).join(', ') || '(none)'}`,
    '',
    diff.notes || '_(no notes)_',
  ].join('\n');

  await new RunArtifactWriter({ repo, runId }).write('implement', guideline);

  // Stage only what this step touched: the diff files. Phase 28.3 removed
  // the card.md from filesToCommit because implement no longer mutates the
  // card body (substrate is the single writer). commitStep no longer
  // accepts an empty list and no longer runs `git add .` (T6-1 fix);
  // anything else in the working tree must be handled by the user outside
  // conductor's scope.
  const filesToCommit = diff.files.map((f) => f.path);

  await commitStep(repo, {
    type: diff.commit_type,
    phase: card.frontmatter.phase,
    step: diff.step,
    subject: diff.commit_subject,
    files: filesToCommit,
  });

  return diff;
}
