// src/importer/control.ts
import { readdir, readFile, writeFile, mkdir, copyFile, stat } from 'node:fs/promises';
import { join, dirname, basename } from 'node:path';
import matter from 'gray-matter';
import yaml from 'js-yaml';

export interface ImportControlArgs {
  from: string;
  into: string;
  dryRun: boolean;
}

export interface ControlPlanEntry {
  source: string;
  target: string;
  kind: 'card' | 'archive-card' | 'state' | 'journal' | 'decision' | 'phase' | 'snapshot';
}

export interface ImportControlResult {
  entries: ControlPlanEntry[];
}

const DATE_PREFIX = /^\d{4}-\d{2}-\d{2}-/;

function normalizeSlug(name: string): string {
  return name.replace(/_/g, '-').toLowerCase();
}

async function ensureDateAndDash(filename: string, source: string): Promise<string> {
  const ext = filename.endsWith('.md') ? '.md' : '';
  const base = filename.slice(0, filename.length - ext.length);
  const dashed = normalizeSlug(base);
  if (DATE_PREFIX.test(dashed)) return `${dashed}${ext}`;
  const st = await stat(source);
  const mtime = new Date(st.mtimeMs).toISOString().slice(0, 10);
  return `${mtime}-${dashed}${ext}`;
}

async function listMd(dir: string): Promise<string[]> {
  try {
    const entries = await readdir(dir);
    return entries.filter((n) => n.endsWith('.md'));
  } catch {
    return [];
  }
}

async function copyTree(src: string, dst: string, dryRun: boolean): Promise<void> {
  if (dryRun) return;
  await mkdir(dst, { recursive: true });
  const entries = await readdir(src, { withFileTypes: true });
  for (const e of entries) {
    const s = join(src, e.name);
    const d = join(dst, e.name);
    if (e.isDirectory()) await copyTree(s, d, false);
    else await copyFile(s, d);
  }
}

async function importIssueFile(args: {
  source: string;
  targetDir: string;
  archived: boolean;
  dryRun: boolean;
}): Promise<{ source: string; target: string }> {
  const { source, targetDir, archived, dryRun } = args;
  const text = await readFile(source, 'utf8');
  const parsed = matter(text);
  const fname = basename(source);
  const newName = await ensureDateAndDash(fname, source);
  const idFromName = newName.replace(/\.md$/, '');
  const fm: Record<string, unknown> = {
    id: idFromName,
    title: parsed.data.title ?? idFromName,
    kind: 'issue',
    column: archived ? 'archived' : 'building',
    phase: parsed.data.phase ?? 'unassigned',
    priority: parsed.data.priority ?? 1,
    autonomy: 'inherit',
    model_overrides: {},
    created: parsed.data.created ?? new Date().toISOString(),
    source: 'imported',
    labels: parsed.data.labels ?? [],
    blocked_by: parsed.data.blocked_by ?? [],
  };
  const target = join(targetDir, newName);
  if (!dryRun) {
    await mkdir(dirname(target), { recursive: true });
    const head = yaml.dump(fm, { lineWidth: 0, noRefs: true });
    await writeFile(target, `---\n${head}---\n\n${parsed.content.trimStart()}`, 'utf8');
  }
  return { source, target };
}

export async function importControl(args: ImportControlArgs): Promise<ImportControlResult> {
  const entries: ControlPlanEntry[] = [];
  const dst = join(args.into, '.conductor');

  try {
    const source = join(args.from, 'progress', 'STATE.md');
    await stat(source);
    const target = join(dst, 'state.md');
    if (!args.dryRun) {
      await mkdir(dirname(target), { recursive: true });
      await copyFile(source, target);
    }
    entries.push({ source, target, kind: 'state' });
  } catch { /* no STATE.md */ }

  try {
    const source = join(args.from, 'progress', 'journal.md');
    await stat(source);
    const target = join(dst, 'journal.md');
    if (!args.dryRun) {
      await mkdir(dirname(target), { recursive: true });
      await copyFile(source, target);
    }
    entries.push({ source, target, kind: 'journal' });
  } catch { /* no journal */ }

  const decisionsDir = join(args.from, 'architecture', 'decisions');
  for (const name of await listMd(decisionsDir)) {
    const source = join(decisionsDir, name);
    const target = join(dst, 'decisions', name);
    if (!args.dryRun) {
      await mkdir(dirname(target), { recursive: true });
      await copyFile(source, target);
    }
    entries.push({ source, target, kind: 'decision' });
  }

  const openDir = join(args.from, 'issues', 'OPEN');
  for (const name of await listMd(openDir)) {
    const r = await importIssueFile({
      source: join(openDir, name),
      targetDir: join(dst, 'cards'),
      archived: false,
      dryRun: args.dryRun,
    });
    entries.push({ ...r, kind: 'card' });
  }

  const resolvedDir = join(args.from, 'issues', 'RESOLVED');
  for (const name of await listMd(resolvedDir)) {
    const r = await importIssueFile({
      source: join(resolvedDir, name),
      targetDir: join(dst, 'archive', 'cards'),
      archived: true,
      dryRun: args.dryRun,
    });
    entries.push({ ...r, kind: 'archive-card' });
  }

  const phasesDir = join(args.from, 'phases');
  try {
    for (const phase of await readdir(phasesDir, { withFileTypes: true })) {
      if (!phase.isDirectory()) continue;
      const source = join(phasesDir, phase.name);
      const target = join(dst, 'phases', phase.name);
      await copyTree(source, target, args.dryRun);
      entries.push({ source, target, kind: 'phase' });
    }
  } catch { /* no phases */ }

  const snapshotsDir = join(args.from, 'snapshots');
  try {
    for (const name of await readdir(snapshotsDir)) {
      const source = join(snapshotsDir, name);
      const target = join(dst, 'snapshots', name);
      if (!args.dryRun) {
        await mkdir(dirname(target), { recursive: true });
        await copyFile(source, target);
      }
      entries.push({ source, target, kind: 'snapshot' });
    }
  } catch { /* no snapshots */ }

  return { entries };
}
