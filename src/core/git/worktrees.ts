import { realpathSync } from 'node:fs';
import { basename, dirname, join } from 'node:path';
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

export function ownedWorktreePath(clonePath: string, prNumber: number, root?: string | null): string {
  return root
    ? join(root, `wt-pr-${prNumber}`)
    : join(dirname(clonePath), `${basename(clonePath)}.worktrees`, `pr-${prNumber}`);
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
  headRefName: string;
  headOid: string;
  role: 'author' | 'reviewer';
}): WorktreePlan {
  const live = input.worktrees.filter((w) => w.prunable === null && !w.bare);
  const onBranch = live.find((w) => w.branch === input.headRefName);
  if (input.role === 'author') {
    return onBranch
      ? { kind: 'reuse', path: onBranch.path, mode: 'branch', mayMove: false, owned: samePath(onBranch.path, input.ownedPath) }
      : { kind: 'create-branch', path: input.ownedPath };
  }
  const owned = live.find((w) => samePath(w.path, input.ownedPath));
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

export async function removeWorktree(repo: string, path: string): Promise<void> {
  const target = canonicalPath(path);
  const wt = (await listWorktrees(repo)).find((w) => samePath(w.path, target));
  if (!wt) throw new Error(`No worktree at ${path}`);
  if (wt.locked !== null) throw new Error(`Worktree is locked${wt.locked ? ` (${wt.locked})` : ''}; unlock it first.`);
  await git(repo, ['worktree', 'remove', path]);
}
