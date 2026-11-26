import { execFileSync } from 'node:child_process';
import { existsSync, realpathSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import { claudePointerFile, readClaudePointer, writeClaudePointer } from '../../../src/core/store/claudePointer';
import { tempRepo } from '../../helpers/gitRepo';

const repo = tempRepo('prr-pointer-');
repo.commit('base', { 'a.ts': 'a\n' });
const worktree = `${repo.dir}.worktrees/pr-7`;
repo.git('worktree', 'add', '-q', '--detach', worktree);
afterAll(() => {
  repo.cleanup();
  rmSync(`${repo.dir}.worktrees`, { recursive: true, force: true });
});

describe("a PR's Claude pointer", () => {
  it("lives in the worktree's own git folder, where git never sees it", async () => {
    const file = await claudePointerFile(worktree, 'github.com/o/r#7');
    expect(file).toBe(join(realpathSync(repo.dir), '.git', 'worktrees', 'pr-7', 'pr-review', 'github.com__o__r__7.json'));
    await writeClaudePointer(file, { sessionId: 's1', hiddenMarkers: ['e1'], dismissedOffers: ['e2'] });
    expect(await readClaudePointer(file)).toEqual({ sessionId: 's1', hiddenMarkers: ['e1'], dismissedOffers: ['e2'] });
    expect(execFileSync('git', ['status', '--porcelain', '--ignored'], { cwd: worktree, encoding: 'utf8' })).toBe('');
  });

  it('goes away with the worktree', async () => {
    const file = await claudePointerFile(worktree, 'github.com/o/r#7');
    repo.git('worktree', 'remove', '--force', worktree);
    expect(existsSync(file)).toBe(false);
  });

  it('is empty before the first question, or when the file is unreadable', async () => {
    expect(await readClaudePointer(join(repo.dir, 'missing.json'))).toEqual({ sessionId: null, hiddenMarkers: [], dismissedOffers: [] });
  });
});
