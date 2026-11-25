import { afterAll, describe, expect, it } from 'vitest';
import { blobHunks, changedFiles, commentableLines, filePatch, parseNameStatus, parseNumstat, renameMap } from '../../../src/core/git/diff';
import { lines, tempRepo } from '../../helpers/gitRepo';

describe('parsers', () => {
  it('parses -z name-status including renames', () => {
    const out = ['M', 'src/a.ts', 'R087', 'old/b.ts', 'new/b.ts', 'A', 'c.ts', 'D', 'd.ts', ''].join('\0');
    expect(parseNameStatus(out)).toEqual([
      { status: 'modified', path: 'src/a.ts', oldPath: null },
      { status: 'renamed', path: 'new/b.ts', oldPath: 'old/b.ts' },
      { status: 'added', path: 'c.ts', oldPath: null },
      { status: 'deleted', path: 'd.ts', oldPath: null },
    ]);
  });

  it('parses -z numstat including renames and binary files', () => {
    const out = ['3\t1\tsrc/a.ts', '2\t2\t', 'old/b.ts', 'new/b.ts', '-\t-\timg.png', ''].join('\0');
    const map = parseNumstat(out);
    expect(map.get('src/a.ts')).toEqual({ additions: 3, deletions: 1, binary: false });
    expect(map.get('new/b.ts')).toEqual({ additions: 2, deletions: 2, binary: false });
    expect(map.get('img.png')).toEqual({ additions: 0, deletions: 0, binary: true });
  });

  it('computes commentable lines per side from a -U3 patch', () => {
    const patch = ['diff --git a/x b/x', '--- a/x', '+++ b/x', '@@ -3,4 +3,4 @@ fn', ' c', '-d', '+D', ' e', ' f'].join('\n');
    expect(commentableLines(patch)).toEqual({ LEFT: [3, 4, 5, 6], RIGHT: [3, 4, 5, 6] });
  });
});

describe('against real git', () => {
  const repo = tempRepo();
  afterAll(() => repo.cleanup());

  it('lists changed files relative to the merge-base, with renames and stats', async () => {
    const base = repo.commit('base', { 'src/a.ts': lines('a', 'b', 'c'), 'src/old.ts': lines('1', '2', '3', '4', '5', '6', '7', '8') });
    repo.git('checkout', '-q', '-b', 'feature');
    repo.git('mv', 'src/old.ts', 'src/new.ts');
    const head = repo.commit('change', { 'src/a.ts': lines('a', 'B', 'c', 'd') });
    repo.git('checkout', '-q', 'main');
    repo.commit('main moves on', { 'unrelated.txt': 'x\n' });

    const files = await changedFiles(repo.dir, 'main', head);
    expect(files).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ path: 'src/a.ts', change: 'modified', additions: 2, deletions: 1 }),
        expect.objectContaining({ path: 'src/new.ts', oldPath: 'src/old.ts', change: 'renamed' }),
      ]),
    );
    expect(files.some((f) => f.path === 'unrelated.txt')).toBe(false);

    const patch = await filePatch(repo.dir, 'main', head, 'src/a.ts', null);
    expect(patch).toContain('@@ -1,3 +1,4 @@');
    expect(commentableLines(patch).RIGHT).toEqual([1, 2, 3, 4]);

    expect((await renameMap(repo.dir, base, head)).get('src/old.ts')).toBe('src/new.ts');
    expect(await blobHunks(repo.dir, base, head, 'src/a.ts', 'src/a.ts')).toEqual([
      { oldStart: 2, oldLines: 1, newStart: 2, newLines: 1 },
      { oldStart: 3, oldLines: 0, newStart: 4, newLines: 1 },
    ]);
  });
});
