import { execFileSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, writeFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeAll, describe, expect, it } from 'vitest';
import { aheadBehind, attachBranch, commitAll, currentBranch, detachAt, discard, localChanges, localPatch, newFilePatch, pullOnto, pushBranch, uncommitted } from '../../../src/core/git/checkout';
import { lines, tempRepo, type TempRepo } from '../../helpers/gitRepo';

beforeAll(() => {
  // Commits made through the app's git use the environment's identity.
  Object.assign(process.env, { GIT_AUTHOR_NAME: 't', GIT_AUTHOR_EMAIL: 't@example.com', GIT_COMMITTER_NAME: 't', GIT_COMMITTER_EMAIL: 't@example.com' });
});

/**
 * GitHub as a repository with a pull request's branch `feature`, a clone of it, and PR Review's detached worktree of
 * the clone at the branch's head.
 */
function setup() {
  const origin = tempRepo('prr-origin-');
  origin.commit('base', { 'a.ts': lines('one', 'two', 'three') });
  origin.git('checkout', '-q', '-b', 'feature');
  const head = origin.commit('feature', { 'a.ts': lines('one', 'TWO', 'three') });
  origin.git('checkout', '-q', 'main');
  const root = mkdtempSync(join(tmpdir(), 'prr-checkout-'));
  const clone = join(root, 'clone');
  const run = (cwd: string, ...args: string[]) => execFileSync('git', args, { cwd, encoding: 'utf8' });
  run(root, 'clone', '-q', origin.dir, clone);
  run(clone, 'config', 'commit.gpgsign', 'false');
  run(clone, 'fetch', '-q', 'origin', 'feature');
  const wt = join(root, 'pr-1');
  run(clone, 'worktree', 'add', '-q', '--detach', wt, head);
  return {
    origin,
    head,
    wt,
    git: (...args: string[]) => run(wt, ...args),
    write: (path: string, text: string) => writeFileSync(join(wt, path), text),
    read: (path: string) => readFileSync(join(wt, path), 'utf8'),
    cleanup: () => {
      origin.cleanup();
      rmSync(root, { recursive: true, force: true });
    },
  };
}

let env: ReturnType<typeof setup> | null = null;
afterEach(() => env?.cleanup());

/** Someone else pushes to the pull request's branch on GitHub. */
function pushElsewhere(origin: TempRepo, files: Record<string, string>): string {
  origin.git('checkout', '-q', 'feature');
  const sha = origin.commit('theirs', files);
  origin.git('checkout', '-q', 'main');
  return sha;
}

describe('checkout', () => {
  it('lists what changed since the latest push: commits not pushed, edits, and new files, with their patches', async () => {
    env = setup();
    const { wt, head } = env;
    await attachBranch(wt, 'origin', 'feature');
    env.write('b.ts', lines('new'));
    await commitAll(wt, 'add b');
    env.write('a.ts', lines('one', 'TWO', 'three', 'four'));
    env.write('c.ts', 'fresh');
    const files = await localChanges(wt, head);
    expect(files.map((f) => [f.path, f.change, f.additions, f.deletions])).toEqual([
      ['a.ts', 'modified', 1, 0],
      ['b.ts', 'added', 1, 0],
      ['c.ts', 'added', 1, 0],
    ]);
    expect(await localPatch(wt, head, 'a.ts', null)).toContain('+four');
    expect(await localPatch(wt, head, 'c.ts', null)).toBe(newFilePatch('c.ts', 'fresh'));
    expect(newFilePatch('c.ts', 'fresh')).toContain('@@ -0,0 +1,1 @@\n+fresh\n\\ No newline at end of file');
    expect(await uncommitted(wt)).toEqual(['a.ts', 'c.ts']);
    expect(await aheadBehind(wt, head)).toEqual({ ahead: 1, behind: 0 });
  });

  it('goes onto the branch for editing, keeping edits, and back to following only once they are committed', async () => {
    env = setup();
    const { wt, head } = env;
    env.write('a.ts', lines('edited'));
    await attachBranch(wt, 'origin', 'feature');
    expect(await currentBranch(wt)).toBe('feature');
    expect(env.read('a.ts')).toBe(lines('edited'));
    await expect(detachAt(wt, head)).rejects.toThrow('1 file has uncommitted changes. Commit or discard them first.');
    const mine = await commitAll(wt, 'mine');
    await detachAt(wt, head);
    expect(await currentBranch(wt)).toBeNull();
    // The commit stays on the local branch, and comes back with it.
    await attachBranch(wt, 'origin', 'feature');
    expect(env.git('rev-parse', 'HEAD').trim()).toBe(mine);
  });

  it('pushes to the pull request’s branch, never over a push made since, and pulls that in under its own commits', async () => {
    env = setup();
    const { wt, origin } = env;
    await attachBranch(wt, 'origin', 'feature');
    env.write('a.ts', lines('one', 'TWO', 'three', 'mine'));
    const mine = await commitAll(wt, 'mine');
    await pushBranch(wt, { remote: 'origin', branch: 'feature' });
    expect(origin.git('rev-parse', 'feature').trim()).toBe(mine);

    env.write('b.ts', lines('more'));
    await commitAll(wt, 'more');
    const theirs = pushElsewhere(origin, { 'c.ts': lines('theirs') });
    await expect(pushBranch(wt, { remote: 'origin', branch: 'feature' })).rejects.toThrow('The branch has new commits on GitHub. Pull first, then push.');
    env.git('fetch', '-q', 'origin', 'feature');
    expect(await aheadBehind(wt, theirs)).toEqual({ ahead: 1, behind: 1 });
    await pullOnto(wt, theirs);
    expect(await aheadBehind(wt, theirs)).toEqual({ ahead: 1, behind: 0 });
    await pushBranch(wt, { remote: 'origin', branch: 'feature' });
    expect(origin.git('rev-parse', 'feature').trim()).toBe(env.git('rev-parse', 'HEAD').trim());
  });

  it('pulls nothing over edits not committed, and changes nothing on a conflict', async () => {
    env = setup();
    const { wt, origin } = env;
    await attachBranch(wt, 'origin', 'feature');
    env.write('a.ts', lines('one', 'mine', 'three'));
    await expect(pullOnto(wt, env.head)).rejects.toThrow('Commit or discard them, then pull.');
    const before = await commitAll(wt, 'mine');
    const theirs = pushElsewhere(origin, { 'a.ts': lines('one', 'theirs', 'three') });
    env.git('fetch', '-q', 'origin', 'feature');
    await expect(pullOnto(wt, theirs)).rejects.toThrow('Your commits conflict with the new ones on GitHub. Nothing was changed');
    expect(env.git('rev-parse', 'HEAD').trim()).toBe(before);
    expect(await uncommitted(wt)).toEqual([]);
  });

  it('discards edits and deletes new files, leaving commits alone', async () => {
    env = setup();
    const { wt } = env;
    await attachBranch(wt, 'origin', 'feature');
    env.write('a.ts', lines('edited'));
    env.write('new.ts', lines('new'));
    await discard(wt, ['a.ts', 'new.ts']);
    expect(env.read('a.ts')).toBe(lines('one', 'TWO', 'three'));
    expect(existsSync(join(wt, 'new.ts'))).toBe(false);
    expect(await uncommitted(wt)).toEqual([]);
  });
});
