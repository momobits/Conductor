// src/engine/ops/notebook.ts
//
// Operation: produce a minimal Jupyter notebook documenting the card's
// verification. Deterministic — no LLM. Writes
// .conductor/archive/notebooks/<id>.ipynb. Reads the Verification Report
// from the per-run substrate (Phase 28.2 — replaces extractSection on
// card.body) and writes notebook metadata to the same substrate.

import { writeFile, mkdir } from 'node:fs/promises';
import { join, dirname } from 'node:path';
import type { Card } from '../types.js';
import { RunArtifactWriter, findLatestArtifactRunId } from '../../agent/run_artifact.js';

export interface NotebookArgs {
  repo: string;
  card: Card;
  command: string;
  runId: string;
}

export interface NotebookResult {
  path: string;
}

interface NbCell {
  cell_type: 'markdown' | 'code';
  metadata: Record<string, unknown>;
  source: string[];
  outputs?: unknown[];
  execution_count?: number | null;
}

export async function notebook(args: NotebookArgs): Promise<NotebookResult> {
  const { repo, card, command, runId } = args;

  if (typeof runId !== 'string' || runId.length === 0) {
    throw new Error(`notebook: runId arg required (received: ${JSON.stringify(runId)}).`);
  }

  // Phase 28.2: read Verification Report from per-run substrate (NOT card body).
  // Preserve the `?? '_(none)_'` soft-fail fallback so cards without prior
  // verify substrate (e.g., test fixtures that bootstrap directly to verifying
  // column, or manually-moved cards) still produce a notebook with placeholder
  // content. Matches pre-28.2 behavior.
  const found = await findLatestArtifactRunId(repo, card.frontmatter.id, 'verify');
  const verifySection = found?.text ?? '_(none)_';

  const cells: NbCell[] = [
    {
      cell_type: 'markdown',
      metadata: {},
      source: [
        `# ${card.frontmatter.title}\n`,
        `\n`,
        `Card: \`${card.frontmatter.id}\`  •  Phase: \`${card.frontmatter.phase}\`\n`,
        `\n`,
        `## Verification Report\n`,
        `\n`,
        verifySection,
        `\n`,
      ],
    },
    {
      cell_type: 'code',
      metadata: {},
      execution_count: null,
      outputs: [],
      source: [
        `# Re-run the verification command outside the Conductor session.\n`,
        `import subprocess\n`,
        `result = subprocess.run(${JSON.stringify(command)}, shell=True, capture_output=True, text=True)\n`,
        `print('exit', result.returncode)\n`,
        `print(result.stdout)\n`,
        `print(result.stderr)\n`,
      ],
    },
  ];

  const nb = {
    nbformat: 4,
    nbformat_minor: 5,
    metadata: {
      kernelspec: { name: 'python3', display_name: 'Python 3', language: 'python' },
      language_info: { name: 'python' },
    },
    cells,
  };

  const outPath = join(repo, '.conductor', 'archive', 'notebooks', `${card.frontmatter.id}.ipynb`);
  await mkdir(dirname(outPath), { recursive: true });
  await writeFile(outPath, JSON.stringify(nb, null, 2), 'utf8');

  // Phase 28.2: persist notebook metadata to per-run substrate (NOT card body).
  await new RunArtifactWriter({ repo, runId }).write(
    'notebook',
    `Generated: \`archive/notebooks/${card.frontmatter.id}.ipynb\``,
  );

  return { path: outPath };
}
