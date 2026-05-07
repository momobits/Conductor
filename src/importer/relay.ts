// src/importer/relay.ts
import { readdir, readFile, writeFile, mkdir, copyFile, stat } from 'node:fs/promises';
import { join, dirname, basename } from 'node:path';
import matter from 'gray-matter';
import yaml from 'js-yaml';

export interface ImportRelayArgs {
  from: string;
  into: string;
  dryRun: boolean;
}

export interface RelayPlanEntry {
  source: string;
  target: string;
  kind: 'card' | 'archive-card' | 'archive-implemented' | 'archive-exercise' | 'ordering';
}

export interface ImportRelayResult {
  entries: RelayPlanEntry[];
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

function deriveColumn(body: string): 'discovered' | 'planned' | 'approved' | 'building' | 'verifying' {
  const has = (h: string): boolean => body.includes(`## ${h}`);
  if (has('Verification Report')) return 'verifying';
  if (has('Implementation Guidelines')) return 'building';
  if (has('Adversarial Review')) return 'approved';
  if (has('Implementation Plan')) return 'planned';
  return 'discovered';
}

async function importCardFile(args: {
  source: string;
  targetDir: string;
  kind: 'issue' | 'feature';
  archived: boolean;
  dryRun: boolean;
}): Promise<{ source: string; target: string }> {
  const { source, targetDir, kind, archived, dryRun } = args;
  const text = await readFile(source, 'utf8');
  const parsed = matter(text);
  const fname = basename(source);
  const newName = await ensureDateAndDash(fname, source);
  const idFromName = newName.replace(/\.md$/, '');
  const created = parsed.data.created ?? new Date().toISOString();
  const fm: Record<string, unknown> = {
    id: idFromName,
    title: parsed.data.title ?? idFromName,
    kind,
    column: archived ? 'archived' : deriveColumn(parsed.content),
    phase: parsed.data.phase ?? 'unassigned',
    priority: parsed.data.priority ?? 1,
    autonomy: 'inherit',
    model_overrides: {},
    created,
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

export async function importRelay(args: ImportRelayArgs): Promise<ImportRelayResult> {
  const entries: RelayPlanEntry[] = [];
  const dst = join(args.into, '.conductor');

  const issuesDir = join(args.from, 'issues');
  for (const name of await listMd(issuesDir)) {
    const r = await importCardFile({
      source: join(issuesDir, name),
      targetDir: join(dst, 'cards'),
      kind: 'issue',
      archived: false,
      dryRun: args.dryRun,
    });
    entries.push({ ...r, kind: 'card' });
  }

  const featuresDir = join(args.from, 'features');
  for (const name of await listMd(featuresDir)) {
    const r = await importCardFile({
      source: join(featuresDir, name),
      targetDir: join(dst, 'cards'),
      kind: 'feature',
      archived: false,
      dryRun: args.dryRun,
    });
    entries.push({ ...r, kind: 'card' });
  }

  const archIssuesDir = join(args.from, 'archive', 'issues');
  for (const name of await listMd(archIssuesDir)) {
    const r = await importCardFile({
      source: join(archIssuesDir, name),
      targetDir: join(dst, 'archive', 'cards'),
      kind: 'issue',
      archived: true,
      dryRun: args.dryRun,
    });
    entries.push({ ...r, kind: 'archive-card' });
  }

  const implementedDir = join(args.from, 'implemented');
  for (const name of await listMd(implementedDir)) {
    const source = join(implementedDir, name);
    const target = join(dst, 'archive', 'implemented', name);
    if (!args.dryRun) {
      await mkdir(dirname(target), { recursive: true });
      await copyFile(source, target);
    }
    entries.push({ source, target, kind: 'archive-implemented' });
  }

  const exerciseDir = join(args.from, 'exercise');
  try {
    for (const session of await readdir(exerciseDir, { withFileTypes: true })) {
      if (!session.isDirectory()) continue;
      const source = join(exerciseDir, session.name);
      const target = join(dst, 'exercise', session.name);
      await copyTree(source, target, args.dryRun);
      entries.push({ source, target, kind: 'archive-exercise' });
    }
  } catch { /* no exercise dir */ }

  try {
    const source = join(args.from, 'relay-ordering.md');
    const target = join(dst, 'ordering.md');
    await stat(source);
    if (!args.dryRun) {
      await mkdir(dirname(target), { recursive: true });
      await copyFile(source, target);
    }
    entries.push({ source, target, kind: 'ordering' });
  } catch { /* no ordering */ }

  return { entries };
}
