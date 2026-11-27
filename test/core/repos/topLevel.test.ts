import { mkdirSync, mkdtempSync, rmSync, symlinkSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import { changedFiles, filePatch } from '../../../src/core/git/diff';
import { repoTopLevel } from '../../../src/core/repos/registry';
import { tempRepo } from '../../helpers/gitRepo';

describe('repoTopLevel', () => {
  const repo = tempRepo('prr-top-');
  const base = repo.commit('base', { 'code/app.sh': 'echo one\n' });
  const head = repo.commit('change', { 'code/app.sh': 'echo two\n' });
  mkdirSync(join(repo.dir, 'worktrees'), { recursive: true });
  const elsewhere = mkdtempSync(join(tmpdir(), 'prr-not-a-repo-'));
  afterAll(() => {
    repo.cleanup();
    rmSync(elsewhere, { recursive: true, force: true });
  });

  it('is why a clone picked one folder too deep showed "No textual changes": paths are read from that folder', async () => {
    const sub = join(repo.dir, 'worktrees');
    // The file list has no paths in it, so it still works from the subfolder…
    expect((await changedFiles(sub, base, head)).map((f) => f.path)).toEqual(['code/app.sh']);
    // …but a file's diff looks for worktrees/code/app.sh, and finds nothing.
    expect(await filePatch(sub, base, head, 'code/app.sh', null)).toBe('');
    expect(await filePatch(await repoTopLevel(sub), base, head, 'code/app.sh', null)).toContain('+echo two');
  });

  it('gives the top folder for a folder inside the repository', async () => {
    expect(await repoTopLevel(join(repo.dir, 'worktrees'))).toBe(repo.dir);
    expect(await repoTopLevel(join(repo.dir, 'code'))).toBe(repo.dir);
  });

  it('keeps the folder as it was given when it is the top already, symlinked or not', async () => {
    expect(await repoTopLevel(repo.dir)).toBe(repo.dir);
    const link = join(elsewhere, 'link');
    symlinkSync(repo.dir, link);
    expect(await repoTopLevel(link)).toBe(link);
  });

  it('leaves a folder that is not a repository alone', async () => {
    const plain = join(elsewhere, 'plain');
    mkdirSync(plain);
    expect(await repoTopLevel(plain)).toBe(plain);
  });
});
