import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import { ownedWorktreePath } from '../../../src/core/git/worktrees';
import { expandHome } from '../../../src/core/paths';
import { scanRoots } from '../../../src/core/repos/registry';

/** A clone at `dir` whose origin is github.com/<slug>. */
function clone(dir: string, slug: string): void {
  mkdirSync(dir, { recursive: true });
  execFileSync('git', ['init', '-q', dir]);
  execFileSync('git', ['-C', dir, 'remote', 'add', 'origin', `https://github.com/${slug}.git`]);
}

describe('scanRoots', () => {
  const home = mkdtempSync(join(tmpdir(), 'prr-scan-'));
  const repos = join(home, 'Repos');
  clone(join(repos, 'platform'), 'acme/platform');
  clone(join(repos, 'web'), 'acme/web');
  // Something inside the platform clone that looks like a clone of its own.
  clone(join(repos, 'platform', 'worktrees'), 'acme/elsewhere');
  afterAll(() => rmSync(home, { recursive: true, force: true }));

  it('finds the clones in a folder that holds them', async () => {
    expect(await scanRoots([repos])).toEqual([
      { slug: 'acme/platform', path: join(repos, 'platform'), source: 'scan' },
      { slug: 'acme/web', path: join(repos, 'web'), source: 'scan' },
    ]);
  });

  it('takes a clone given where the folder holding it was meant, and nothing inside it', async () => {
    expect(await scanRoots([join(repos, 'platform')])).toEqual([{ slug: 'acme/platform', path: join(repos, 'platform'), source: 'scan' }]);
  });

  it('skips a folder that is not there', async () => {
    expect(await scanRoots([join(home, 'missing')])).toEqual([]);
  });
});

describe('"~/" in a folder from Settings', () => {
  it('means the home folder', () => {
    expect(expandHome('~/source')).toBe(join(homedir(), 'source'));
    expect(expandHome('~')).toBe(homedir());
    expect(expandHome('/abs/path')).toBe('/abs/path');
    expect(expandHome('a~/b')).toBe('a~/b');
  });

  it('for the worktree folder too, instead of a folder named "~" inside the clone', () => {
    const pr = { owner: 'acme', repo: 'app', number: 7 };
    expect(ownedWorktreePath('/r/app', pr, '~/worktrees')).toBe(join(homedir(), 'worktrees', 'acme', 'app', 'pr-7'));
    expect(ownedWorktreePath('/r/app', pr, null)).toBe('/r/app.worktrees/pr-7');
  });
});
