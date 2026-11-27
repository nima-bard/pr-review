import { realpathSync } from 'node:fs';
import { basename, dirname, join } from 'node:path';
import type { RemovalBlocker } from '../../shared/model';
import { expandHome } from '../paths';
import { gh, git } from './exec';

/** Resolves symlinks (macOS /var -> /private/var) for the longest existing prefix of `p`. */
export function canonicalPath(p: string): string {
  try {
    return realpathSync.native(p);
  } catch {
    const parent = dirname(p);
    return parent === p ? p : join(canonicalPath(parent), basename(p));
  }
}

export interface Worktree {
  path: string;
  head: string | null;
  branch: string | null;
  detached: boolean;
  bare: boolean;
  locked: string | null;
  prunable: string | null;
}

/** Parses `git worktree list --porcelain -z`: NUL-terminated fields, an empty field ends a record. */
export function parseWorktreeList(out: string): Worktree[] {
  const result: Worktree[] = [];
  let cur: Worktree | null = null;
  for (const field of out.split('\0')) {
    if (field === '') {
      if (cur) result.push(cur);
      cur = null;
      continue;
    }
    const sp = field.indexOf(' ');
    const key = sp === -1 ? field : field.slice(0, sp);
    const val = sp === -1 ? '' : field.slice(sp + 1);
    if (key === 'worktree') {
      cur = { path: val, head: null, branch: null, detached: false, bare: false, locked: null, prunable: null };
      continue;
    }
    if (!cur) continue;
    if (key === 'HEAD') cur.head = val;
    else if (key === 'branch') cur.branch = val.replace(/^refs\/heads\//, '');
    else if (key === 'detached') cur.detached = true;
    else if (key === 'bare') cur.bare = true;
    else if (key === 'locked') cur.locked = val;
    else if (key === 'prunable') cur.prunable = val;
  }
  if (cur) result.push(cur);
  return result;
}

export async function listWorktrees(repo: string): Promise<Worktree[]> {
  await git(repo, ['worktree', 'prune']);
  return parseWorktreeList(await git(repo, ['worktree', 'list', '--porcelain', '-z']));
}

/**
 * Where the app checks a pull request out: next to its clone (`<clone>.worktrees/pr-123`), or with a worktree folder
 * set, `<folder>/<owner>/<repo>/pr-123`, so the same number in two repositories gets two folders (lowercase: GitHub
 * names ignore case, and links don't always agree on it).
 */
export function ownedWorktreePath(clonePath: string, pr: { owner: string; repo: string; number: number }, root?: string | null): string {
  return root
    ? join(expandHome(root), pr.owner.toLowerCase(), pr.repo.toLowerCase(), `pr-${pr.number}`)
    : join(dirname(clonePath), `${basename(clonePath)}.worktrees`, `pr-${pr.number}`);
}

/**
 * Where earlier versions put it in a worktree folder: `<folder>/wt-pr-123`, for every repository alike. A worktree there
 * that belongs to this pull request's clone is still the app's own (another repository's never shows in its list).
 */
export function legacyWorktreePath(prNumber: number, root?: string | null): string | null {
  return root ? join(expandHome(root), `wt-pr-${prNumber}`) : null;
}

export type WorktreePlan =
  | { kind: 'reuse'; path: string; mode: 'branch' | 'detached'; mayMove: boolean; owned: boolean }
  | { kind: 'create-detached'; path: string }
  | { kind: 'create-branch'; path: string };

export function samePath(a: string, b: string): boolean {
  const norm = (p: string) => p.replace(/\/+$/, '').toLowerCase();
  return norm(a) === norm(b);
}

export function planWorktree(input: {
  worktrees: readonly Worktree[];
  ownedPath: string;
  /** Where an earlier version put the app's own worktree for this pull request (still its own if it's there). */
  legacyPath?: string | null;
  headRefName: string;
  headOid: string;
  role: 'author' | 'reviewer';
}): WorktreePlan {
  const live = input.worktrees.filter((w) => w.prunable === null && !w.bare);
  const ours = (path: string) => samePath(path, input.ownedPath) || (!!input.legacyPath && samePath(path, input.legacyPath));
  const onBranch = live.find((w) => w.branch === input.headRefName);
  if (input.role === 'author') {
    return onBranch
      ? { kind: 'reuse', path: onBranch.path, mode: 'branch', mayMove: false, owned: ours(onBranch.path) }
      : { kind: 'create-branch', path: input.ownedPath };
  }
  const owned = live.find((w) => samePath(w.path, input.ownedPath)) ?? live.find((w) => ours(w.path));
  if (owned) {
    return {
      kind: 'reuse',
      path: owned.path,
      mode: owned.detached ? 'detached' : 'branch',
      mayMove: owned.detached && owned.locked === null,
      owned: true,
    };
  }
  const atHead = live.find((w) => w.head === input.headOid);
  if (atHead) {
    return { kind: 'reuse', path: atHead.path, mode: atHead.detached ? 'detached' : 'branch', mayMove: false, owned: false };
  }
  if (onBranch) return { kind: 'reuse', path: onBranch.path, mode: 'branch', mayMove: false, owned: false };
  return { kind: 'create-detached', path: input.ownedPath };
}

export function pullRefspec(prNumber: number): string {
  return `+refs/pull/${prNumber}/head:refs/review/pr-${prNumber}/head`;
}

export async function fetchPullHead(repo: string, remote: string, prNumber: number): Promise<void> {
  await git(repo, ['fetch', '--no-tags', remote, pullRefspec(prNumber)]);
}

export async function createDetached(repo: string, path: string, headOid: string): Promise<void> {
  await git(repo, ['worktree', 'add', '--detach', path, headOid]);
}

export async function createBranchWorktree(repo: string, prNumber: number, path: string): Promise<void> {
  await gh(repo, ['pr', 'checkout', String(prNumber), '--worktree', path]);
}

/** Moves an app-owned detached worktree to a new head, only when it has no local changes. */
export async function moveOwnedDetached(path: string, headOid: string): Promise<'moved' | 'dirty' | 'same'> {
  const head = (await git(path, ['rev-parse', 'HEAD'])).trim();
  if (head === headOid) return 'same';
  const status = await git(path, ['status', '--porcelain', '--untracked-files=no']);
  if (status.trim() !== '') return 'dirty';
  await git(path, ['checkout', '--quiet', '--detach', headOid]);
  return 'moved';
}

/** A worktree's own git folder (`.git/worktrees/<name>` for a linked one): never committed, and removed with it. */
export async function gitDir(worktree: string): Promise<string> {
  return (await git(worktree, ['rev-parse', '--absolute-git-dir'])).trim();
}

/**
 * Why removing this worktree would lose something, or null when it wouldn't: it's locked (another tool is using it),
 * it has uncommitted changes (untracked files too), or its detached HEAD is on no branch or other ref. A branch
 * outlives its worktree, so commits on one are never lost. Files git ignores are not checked: they go with it.
 */
export async function removalBlocker(wt: Pick<Worktree, 'path' | 'head' | 'detached' | 'locked'>): Promise<RemovalBlocker | null> {
  if (wt.locked !== null) return 'locked';
  const status = await git(wt.path, ['status', '--porcelain', '--untracked-files=normal']).catch(() => null);
  if (status === null) return 'unreadable';
  if (status.trim() !== '') return 'dirty';
  if (wt.detached && wt.head) {
    const refs = await git(wt.path, ['for-each-ref', '--contains', wt.head, '--count=1', '--format=%(refname)']).catch(() => '');
    if (refs.trim() === '') return 'unreachable';
  }
  return null;
}

/** Removes a worktree; `force` also when it has changes (they're lost). Never a locked one. */
export async function removeWorktree(repo: string, path: string, force = false): Promise<void> {
  const target = canonicalPath(path);
  const wt = (await listWorktrees(repo)).find((w) => samePath(w.path, target));
  if (!wt) throw new Error(`No worktree at ${path}`);
  if (wt.locked !== null) throw new Error(`Worktree is locked${wt.locked ? ` (${wt.locked})` : ''}; unlock it first.`);
  await git(repo, ['worktree', 'remove', ...(force ? ['--force'] : []), path]);
}
