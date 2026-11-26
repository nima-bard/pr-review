import { afterAll, describe, expect, it } from 'vitest';
import { join } from 'node:path';
import { rmSync, writeFileSync } from 'node:fs';
import { listWorktrees, ownedWorktreePath, parseWorktreeList, planWorktree, removalBlocker, removeWorktree, type Worktree } from '../../../src/core/git/worktrees';
import { tempRepo } from '../../helpers/gitRepo';

const wt = (p: Partial<Worktree> & { path: string }): Worktree => ({
  head: null,
  branch: null,
  detached: false,
  bare: false,
  locked: null,
  prunable: null,
  ...p,
});

describe('parseWorktreeList', () => {
  it('parses branch, detached, locked (with and without reason) and prunable records', () => {
    const out = [
      'worktree /src/app', 'HEAD aaa', 'branch refs/heads/main', '',
      'worktree /src/app/.claude/worktrees/x', 'HEAD bbb', 'branch refs/heads/me/x', 'locked claude session x', '',
      'worktree /tmp/scratch', 'HEAD ccc', 'detached', 'locked', '',
      'worktree /gone', 'HEAD ddd', 'detached', 'prunable gitdir file points to non-existent location', '',
    ].join('\0');
    const list = parseWorktreeList(out);
    expect(list).toHaveLength(4);
    expect(list[0]).toMatchObject({ path: '/src/app', branch: 'main', detached: false, locked: null });
    expect(list[1]).toMatchObject({ branch: 'me/x', locked: 'claude session x' });
    expect(list[2]).toMatchObject({ detached: true, locked: '' });
    expect(list[3]?.prunable).toContain('non-existent');
  });
});

describe('planWorktree', () => {
  const owned = '/src/app.worktrees/pr-7';
  const base = { ownedPath: owned, headRefName: 'feature/x', headOid: 'h1' };

  it('author: reuses the worktree on the PR branch and never moves it', () => {
    const plan = planWorktree({ ...base, role: 'author', worktrees: [wt({ path: '/src/wt-x', branch: 'feature/x', head: 'old' })] });
    expect(plan).toEqual({ kind: 'reuse', path: '/src/wt-x', mode: 'branch', mayMove: false, owned: false });
  });

  it('author: creates a branch worktree when the branch is not checked out', () => {
    expect(planWorktree({ ...base, role: 'author', worktrees: [wt({ path: '/src/app', branch: 'main' })] })).toEqual({
      kind: 'create-branch',
      path: owned,
    });
  });

  it('reviewer: prefers the owned path and may move it when detached and unlocked', () => {
    const plan = planWorktree({ ...base, role: 'reviewer', worktrees: [wt({ path: owned, detached: true, head: 'old' })] });
    expect(plan).toMatchObject({ kind: 'reuse', path: owned, mode: 'detached', mayMove: true, owned: true });
  });

  it('reviewer: never moves a locked owned worktree', () => {
    const plan = planWorktree({ ...base, role: 'reviewer', worktrees: [wt({ path: owned, detached: true, locked: '' })] });
    expect(plan).toMatchObject({ kind: 'reuse', mayMove: false });
  });

  it('reviewer: reuses a foreign worktree at head, then one on the branch, read-only', () => {
    const atHead = planWorktree({ ...base, role: 'reviewer', worktrees: [wt({ path: '/tmp/a', detached: true, head: 'h1' })] });
    expect(atHead).toMatchObject({ kind: 'reuse', path: '/tmp/a', mayMove: false, owned: false });
    const onBranch = planWorktree({ ...base, role: 'reviewer', worktrees: [wt({ path: '/src/wt-x', branch: 'feature/x', head: 'old' })] });
    expect(onBranch).toMatchObject({ kind: 'reuse', path: '/src/wt-x', mode: 'branch', mayMove: false });
  });

  it('reviewer: ignores prunable worktrees and creates a detached one', () => {
    const plan = planWorktree({ ...base, role: 'reviewer', worktrees: [wt({ path: owned, prunable: 'gone' })] });
    expect(plan).toEqual({ kind: 'create-detached', path: owned });
  });

  it('matches paths case-insensitively (macOS)', () => {
    const plan = planWorktree({ ...base, role: 'reviewer', worktrees: [wt({ path: owned.toUpperCase(), detached: true })] });
    expect(plan.kind).toBe('reuse');
  });
});

describe('ownedWorktreePath', () => {
  it('defaults to a sibling <repo>.worktrees folder and honours a custom root', () => {
    expect(ownedWorktreePath('/Users/me/source/app', 12)).toBe('/Users/me/source/app.worktrees/pr-12');
    expect(ownedWorktreePath('/Users/me/source/app', 12, '/Users/me/source')).toBe('/Users/me/source/wt-pr-12');
  });
});

describe('worktrees against real git', () => {
  const repo = tempRepo();
  afterAll(() => repo.cleanup());

  it('lists worktrees and refuses to remove a locked one', async () => {
    repo.commit('init', { 'a.txt': 'a\n' });
    const path = join(repo.dir, '..', `${repo.dir.split('/').pop()}-wt`);
    repo.git('worktree', 'add', '--detach', path, 'HEAD');
    repo.git('worktree', 'lock', '--reason', 'claude session', path);
    const list = await listWorktrees(repo.dir);
    expect(list.find((w) => w.path.endsWith('-wt'))).toMatchObject({ detached: true, locked: 'claude session' });
    await expect(removeWorktree(repo.dir, path)).rejects.toThrow(/locked/);
    repo.git('worktree', 'unlock', path);
    await removeWorktree(repo.dir, path);
    expect((await listWorktrees(repo.dir)).some((w) => w.path.endsWith('-wt'))).toBe(false);
  });

  it('says what removing a worktree would lose', async () => {
    const base = `${repo.dir}-rb`;
    const find = async (path: string) => (await listWorktrees(repo.dir)).find((w) => w.path.endsWith(path.split('/').pop()!))!;

    // A branch worktree with commits of its own: the branch keeps them.
    const onBranch = `${base}-branch`;
    repo.git('worktree', 'add', '-q', '-b', 'feature', onBranch, 'HEAD');
    repo.git('-C', onBranch, 'commit', '-q', '--allow-empty', '-m', 'more');
    expect(await removalBlocker(await find(onBranch))).toBeNull();

    writeFileSync(join(onBranch, 'notes.txt'), 'untracked\n');
    expect(await removalBlocker(await find(onBranch))).toBe('dirty');
    await expect(removeWorktree(repo.dir, onBranch)).rejects.toThrow();
    rmSync(join(onBranch, 'notes.txt'));

    repo.git('worktree', 'lock', onBranch);
    expect(await removalBlocker(await find(onBranch))).toBe('locked');
    repo.git('worktree', 'unlock', onBranch);

    // A detached worktree at a commit that's on a branch, then one past it that isn't on any.
    const detached = `${base}-detached`;
    repo.git('worktree', 'add', '-q', '--detach', detached, 'HEAD');
    expect(await removalBlocker(await find(detached))).toBeNull();
    repo.git('-C', detached, 'commit', '-q', '--allow-empty', '-m', 'lost?');
    expect(await removalBlocker(await find(detached))).toBe('unreachable');

    // Force removes one with changes; the branch stays.
    writeFileSync(join(onBranch, 'notes.txt'), 'untracked\n');
    await removeWorktree(repo.dir, onBranch, true);
    expect((await listWorktrees(repo.dir)).some((w) => w.path.endsWith('-branch'))).toBe(false);
    expect(repo.git('branch', '--list', 'feature').trim()).toContain('feature');
    repo.git('worktree', 'remove', '--force', detached);
  });
});
