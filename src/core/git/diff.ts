import type { ChangeType, DiffSide } from '../../shared/model';
import { parseHunkHeaders, type LineHunk } from '../anchor/hunks';
import { git, GitError } from './exec';

export interface ChangedFile {
  path: string;
  oldPath: string | null;
  change: ChangeType;
  additions: number;
  deletions: number;
  binary: boolean;
}

const DIFF_FLAGS = ['--no-ext-diff', '--no-color', '--histogram'];

const STATUS: Record<string, ChangeType> = { A: 'added', M: 'modified', D: 'deleted', R: 'renamed', C: 'copied', T: 'modified' };

export function parseNameStatus(out: string): { status: ChangeType; path: string; oldPath: string | null }[] {
  const fields = out.split('\0');
  const result: { status: ChangeType; path: string; oldPath: string | null }[] = [];
  let i = 0;
  while (i < fields.length) {
    const code = fields[i++];
    if (!code) continue;
    const kind = STATUS[code[0]!] ?? 'modified';
    if (code[0] === 'R' || code[0] === 'C') {
      const oldPath = fields[i++]!;
      const path = fields[i++]!;
      result.push({ status: kind, path, oldPath });
    } else {
      result.push({ status: kind, path: fields[i++]!, oldPath: null });
    }
  }
  return result;
}

export function parseNumstat(out: string): Map<string, { additions: number; deletions: number; binary: boolean }> {
  const map = new Map<string, { additions: number; deletions: number; binary: boolean }>();
  const fields = out.split('\0');
  let i = 0;
  while (i < fields.length) {
    const field = fields[i++];
    if (!field) continue;
    const parts = field.split('\t');
    const add = parts[0] ?? '-';
    const del = parts[1] ?? '-';
    let path = parts[2] ?? '';
    if (path === '') {
      i++;
      path = fields[i++] ?? '';
    }
    map.set(path, {
      additions: add === '-' ? 0 : Number(add),
      deletions: del === '-' ? 0 : Number(del),
      binary: add === '-' && del === '-',
    });
  }
  return map;
}

export async function changedFiles(repo: string, base: string, head: string): Promise<ChangedFile[]> {
  const [nameStatus, numstat] = await Promise.all([
    git(repo, ['diff', '--merge-base', '-M', '--name-status', '-z', ...DIFF_FLAGS, base, head]),
    git(repo, ['diff', '--merge-base', '-M', '--numstat', '-z', ...DIFF_FLAGS, base, head]),
  ]);
  const stats = parseNumstat(numstat);
  return parseNameStatus(nameStatus).map((f) => {
    const s = stats.get(f.path) ?? { additions: 0, deletions: 0, binary: false };
    return { path: f.path, oldPath: f.oldPath, change: f.status, ...s };
  });
}

export async function filePatch(repo: string, base: string, head: string, path: string, oldPath: string | null): Promise<string> {
  const paths = oldPath && oldPath !== path ? [oldPath, path] : [path];
  return git(repo, ['diff', '--merge-base', '-M', '-U3', ...DIFF_FLAGS, base, head, '--', ...paths]);
}

/** Lines that GitHub accepts review comments on: every line shown in a -U3 hunk, per side. */
export function commentableLines(patch: string): Record<DiffSide, number[]> {
  const left: number[] = [];
  const right: number[] = [];
  let l = 0;
  let r = 0;
  let inHunk = false;
  for (const raw of patch.split('\n')) {
    const m = /^@@ -(\d+)(?:,\d+)? \+(\d+)(?:,\d+)? @@/.exec(raw);
    if (m) {
      l = Number(m[1]);
      r = Number(m[2]);
      inHunk = true;
      continue;
    }
    if (!inHunk || raw.startsWith('\\')) continue;
    if (raw.startsWith('diff --git')) {
      inHunk = false;
      continue;
    }
    const c = raw[0];
    if (c === '+') right.push(r++);
    else if (c === '-') left.push(l++);
    else if (c === ' ') {
      left.push(l++);
      right.push(r++);
    }
  }
  return { LEFT: left, RIGHT: right };
}

export async function blobHunks(repo: string, from: string, to: string, fromPath: string, toPath: string): Promise<LineHunk[]> {
  try {
    const out = await git(repo, ['diff', '-U0', ...DIFF_FLAGS, `${from}:${fromPath}`, `${to}:${toPath}`]);
    return parseHunkHeaders(out);
  } catch (err) {
    if (err instanceof GitError) return [];
    throw err;
  }
}

export async function worktreeHunks(worktree: string, rev: string, path: string): Promise<LineHunk[]> {
  const out = await git(worktree, ['diff', '-U0', ...DIFF_FLAGS, rev, '--', path]);
  return parseHunkHeaders(out);
}

export async function dirtyFiles(worktree: string): Promise<string[]> {
  const out = await git(worktree, ['status', '--porcelain', '-z', '--untracked-files=no']);
  return out
    .split('\0')
    .filter((f) => f.length > 3)
    .map((f) => f.slice(3));
}

export async function renameMap(repo: string, from: string, to: string): Promise<Map<string, string | null>> {
  const out = await git(repo, ['diff', '-M', '--name-status', '-z', ...DIFF_FLAGS, from, to]);
  const map = new Map<string, string | null>();
  for (const f of parseNameStatus(out)) {
    if (f.status === 'renamed' && f.oldPath) map.set(f.oldPath, f.path);
    else if (f.status === 'deleted') map.set(f.path, null);
  }
  return map;
}

export async function mergeBase(repo: string, a: string, b: string): Promise<string | null> {
  try {
    return (await git(repo, ['merge-base', a, b])).trim() || null;
  } catch {
    return null;
  }
}

export async function listFilesAt(repo: string, rev: string): Promise<string[]> {
  const out = await git(repo, ['ls-tree', '-r', '-z', '--name-only', rev]);
  return out.split('\0').filter(Boolean);
}

export async function blobShas(repo: string, rev: string, paths: readonly string[]): Promise<Map<string, string>> {
  const map = new Map<string, string>();
  if (paths.length === 0) return map;
  const out = await git(repo, ['ls-tree', '-z', rev, '--', ...paths]);
  for (const entry of out.split('\0')) {
    const m = /^\d+ blob ([0-9a-f]+)\t(.*)$/.exec(entry);
    if (m) map.set(m[2]!, m[1]!);
  }
  return map;
}

export async function commitTime(repo: string, sha: string): Promise<string | null> {
  try {
    return (await git(repo, ['show', '-s', '--format=%cI', sha])).trim() || null;
  } catch {
    return null;
  }
}

export async function hasCommit(repo: string, sha: string): Promise<boolean> {
  try {
    await git(repo, ['cat-file', '-e', `${sha}^{commit}`]);
    return true;
  } catch {
    return false;
  }
}

const GENERATED = [/(^|\/)package-lock\.json$/, /(^|\/)pnpm-lock\.yaml$/, /(^|\/)yarn\.lock$/, /(^|\/)packages\.lock\.json$/, /\.lock$/, /(^|\/)go\.sum$/, /\.min\.(js|css)$/, /\.snap$/];

export async function generatedFiles(repo: string, rev: string, paths: readonly string[]): Promise<Set<string>> {
  const result = new Set(paths.filter((p) => GENERATED.some((re) => re.test(p))));
  if (paths.length === 0) return result;
  try {
    const out = await git(repo, ['check-attr', '-z', `--source=${rev}`, 'linguist-generated', '--', ...paths]);
    const f = out.split('\0');
    for (let i = 0; i + 2 < f.length; i += 3) {
      if (f[i + 2] === 'set' || f[i + 2] === 'true') result.add(f[i]!);
    }
  } catch {
    // older git without --source: heuristics only
  }
  return result;
}
