// src/engine/ops/implement.ts
//
// Operation: apply ONE step of the implementation plan to the working
// tree, then commit with Control's commit-per-step format.

import { writeFile, mkdir, rm, access } from 'node:fs/promises';
import { resolve, relative, dirname, isAbsolute } from 'node:path';
import type { ModelAdapter } from '../../adapters/adapter.js';
import { COMMIT_TYPES, type Card, type CommitType, type Diff, type DiffFile } from '../types.js';
import { appendSection } from '../state/card.js';
import { commitStep } from '../state/git.js';
import { parseJsonResponse } from '../util/parse_json_response.js';

export interface ImplementArgs {
  repo: string;
  card: Card;
  adapter: ModelAdapter;
  model: string;
  step: string; // e.g. '1.1'
}

const SYSTEM_PROMPT = `You are an experienced software engineer applying ONE
step of an implementation plan. Read the plan carefully, identify the
requested step, and produce a concrete diff.

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
  const { repo, card, adapter, model, step } = args;

  const userPrompt = [
    `Card: ${card.frontmatter.id}`,
    `Phase: ${card.frontmatter.phase}`,
    `Step requested: ${step}`,
    '',
    '--- Card body (Analysis + Plan) ---',
    card.body.trim(),
  ].join('\n');

  const resp = await adapter.invoke({
    operation: 'implement',
    model,
    system: SYSTEM_PROMPT,
    user: userPrompt,
  });

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

  // Append the implementation guideline BEFORE committing so the card body
  // update is part of the same step commit as the code changes.
  const guideline = [
    `### Step ${diff.step} — ${diff.commit_subject}`,
    '',
    `Files: ${diff.files.map((f) => `${f.action} ${f.path}`).join(', ') || '(none)'}`,
    '',
    diff.notes || '_(no notes)_',
  ].join('\n');

  await appendSection(card.path, 'Implementation Guidelines', guideline);

  // Stage only what this step touched: the diff files + the card markdown.
  // Critical: commitStep no longer accepts an empty list and no longer
  // runs `git add .` (T6-1 fix). Anything else in the working tree must
  // be handled by the user outside conductor's scope.
  const cardRelative = relative(repo, card.path).replace(/\\/g, '/');
  const filesToCommit = [...diff.files.map((f) => f.path), cardRelative];

  await commitStep(repo, {
    type: diff.commit_type,
    phase: card.frontmatter.phase,
    step: diff.step,
    subject: diff.commit_subject,
    files: filesToCommit,
  });

  return diff;
}
