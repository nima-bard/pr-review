import { afterAll, describe, expect, it } from 'vitest';
import { join } from 'node:path';
import { rmSync, writeFileSync } from 'node:fs';
import { legacyWorktreePath, listWorktrees, ownedWorktreePath, parseWorktreeList, planWorktree, removalBlocker, removeWorktree, type Worktree } from '../../../src/core/git/worktrees';
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

  it('editing: uses the checkout on the PR branch, yours too, and never moves it', () => {
    const plan = planWorktree({ ...base, checkout: 'editing', worktrees: [wt({ path: '/src/wt-x', branch: 'feature/x', head: 'old' })] });
    expect(plan).toEqual({ kind: 'reuse', path: '/src/wt-x', mode: 'branch', mayMove: false, owned: false });
  });

  it('editing: creates a worktree on the branch when neither it nor the app’s own is there', () => {
    expect(planWorktree({ ...base, checkout: 'editing', worktrees: [wt({ path: '/src/app', branch: 'main' })] })).toEqual({
      kind: 'create-branch',
      path: owned,
    });
  });

  it('reading: uses the app’s own worktree and may move it when detached and unlocked', () => {
    const plan = planWorktree({ ...base, checkout: 'reading', worktrees: [wt({ path: owned, detached: true, head: 'old' })] });
    expect(plan).toMatchObject({ kind: 'reuse', path: owned, mode: 'detached', mayMove: true, owned: true });
  });

  it('reading: never moves a locked owned worktree', () => {
    const plan = planWorktree({ ...base, checkout: 'reading', worktrees: [wt({ path: owned, detached: true, locked: '' })] });
    expect(plan).toMatchObject({ kind: 'reuse', mayMove: false });
  });

  it('reading: never borrows a checkout of yours, at the head or on the branch, but makes its own', () => {
    const yours = [wt({ path: '/tmp/a', detached: true, head: 'h1' }), wt({ path: '/src/wt-x', branch: 'feature/x', head: 'old' })];
    expect(planWorktree({ ...base, checkout: 'reading', worktrees: yours })).toEqual({ kind: 'create-detached', path: owned });
  });

  it('switches the app’s own worktree between them: onto the branch to edit, back off it to read', () => {
    expect(planWorktree({ ...base, checkout: 'editing', worktrees: [wt({ path: owned, detached: true, head: 'h1' })] })).toEqual({ kind: 'attach', path: owned });
    expect(planWorktree({ ...base, checkout: 'reading', worktrees: [wt({ path: owned, branch: 'feature/x', head: 'h1' })] })).toEqual({ kind: 'detach', path: owned });
  });

  it('reading: ignores prunable worktrees and creates a detached one', () => {
    const plan = planWorktree({ ...base, checkout: 'reading', worktrees: [wt({ path: owned, prunable: 'gone' })] });
    expect(plan).toEqual({ kind: 'create-detached', path: owned });
  });

  it('matches paths case-insensitively (macOS)', () => {
    const plan = planWorktree({ ...base, checkout: 'reading', worktrees: [wt({ path: owned.toUpperCase(), detached: true })] });
    expect(plan.kind).toBe('reuse');
  });

  it('still takes a worktree where an earlier version put it as its own, reading or editing', () => {
    const legacyPath = '/wt/wt-pr-7';
    const reviewer = planWorktree({ ...base, legacyPath, checkout: 'reading', worktrees: [wt({ path: legacyPath, detached: true, head: 'old' })] });
    expect(reviewer).toMatchObject({ kind: 'reuse', path: legacyPath, owned: true, mayMove: true });
    const author = planWorktree({ ...base, legacyPath, checkout: 'editing', worktrees: [wt({ path: legacyPath, branch: 'feature/x' })] });
    expect(author).toMatchObject({ kind: 'reuse', path: legacyPath, owned: true });
    // Without one, a new worktree goes to the new place.
    expect(planWorktree({ ...base, legacyPath, checkout: 'reading', worktrees: [] })).toEqual({ kind: 'create-detached', path: owned });
  });
});

describe('ownedWorktreePath', () => {
  const pr = { owner: 'acme', repo: 'app', number: 12 };

  it('defaults to a sibling <repo>.worktrees folder', () => {
    expect(ownedWorktreePath('/Users/me/source/app', pr)).toBe('/Users/me/source/app.worktrees/pr-12');
  });

  it('with a worktree folder, gives each repository its own place, so the same number in two can’t clash', () => {
    expect(ownedWorktreePath('/Users/me/source/app', pr, '/Users/me/wt')).toBe('/Users/me/wt/acme/app/pr-12');
    expect(ownedWorktreePath('/Users/me/source/web', { owner: 'acme', repo: 'web', number: 12 }, '/Users/me/wt')).toBe('/Users/me/wt/acme/web/pr-12');
    // GitHub names ignore case, so a link in other case is the same place.
    expect(ownedWorktreePath('/x', { owner: 'Acme', repo: 'App', number: 12 }, '/Users/me/wt')).toBe('/Users/me/wt/acme/app/pr-12');
  });

  it('knows where earlier versions put it in a worktree folder', () => {
    expect(legacyWorktreePath(12, '/Users/me/wt')).toBe('/Users/me/wt/wt-pr-12');
    expect(legacyWorktreePath(12, null)).toBeNull();
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
