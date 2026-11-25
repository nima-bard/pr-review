import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { expandBraces, filterPaths, globPathspecs, RESULT_LIMIT, searchWorktree, shownLine, matcher, splitGlobs } from '../../../src/core/search/codeSearch';
import type { CodeSearchQuery } from '../../../src/shared/model';
import { tempRepo, type TempRepo } from '../../helpers/gitRepo';

const q = (pattern: string, more: Partial<CodeSearchQuery> = {}): CodeSearchQuery => ({ pattern, matchCase: false, wholeWord: false, regex: false, include: '', exclude: '', scope: 'all', ...more });
const hits = async (repo: TempRepo, query: CodeSearchQuery, paths: string[] | null = null) =>
  (await searchWorktree(repo.dir, query, paths)).files.map((f) => `${f.path}:${f.matches.map((m) => m.line).join(',')}`);

describe('searchWorktree', () => {
  let repo: TempRepo;
  beforeAll(() => {
    repo = tempRepo();
    repo.commit('files', {
      'src/a.ts': 'const fooBar = 1;\n  foo(bar);\n',
      'src/b.fs': 'let foo = 2\n',
      'docs/readme.md': 'Foo here\n',
      'web/app.tsx': 'export const x = 1;\n',
      'big.txt': 'x\n'.repeat(RESULT_LIMIT + 50),
    });
    repo.write('src/untracked.ts', 'foo again\n');
  });
  afterAll(() => repo.cleanup());

  it('finds plain text in tracked and untracked files, ignoring case by default', async () => {
    expect(await hits(repo, q('foo'))).toEqual(['docs/readme.md:1', 'src/a.ts:1,2', 'src/b.fs:1', 'src/untracked.ts:1']);
  });

  it('honours match case, whole word and regular expressions', async () => {
    expect(await hits(repo, q('Foo', { matchCase: true }))).toEqual(['docs/readme.md:1']);
    expect(await hits(repo, q('foo', { wholeWord: true }))).toEqual(['docs/readme.md:1', 'src/a.ts:2', 'src/b.fs:1', 'src/untracked.ts:1']);
    expect(await hits(repo, q('fo+\\(', { regex: true }))).toEqual(['src/a.ts:2']);
  });

  it('filters by include and exclude globs, folders included', async () => {
    expect(await hits(repo, q('foo', { include: '*.ts' }))).toEqual(['src/a.ts:1,2', 'src/untracked.ts:1']);
    expect(await hits(repo, q('foo', { include: 'docs' }))).toEqual(['docs/readme.md:1']);
    expect(await hits(repo, q('foo', { exclude: 'src' }))).toEqual(['docs/readme.md:1']);
    expect(await hits(repo, q('const', { include: '*.{ts,tsx}' }))).toEqual(['src/a.ts:1', 'web/app.tsx:1']);
  });

  it('searches only the given files when there are some', async () => {
    expect(await hits(repo, q('foo'), ['src/b.fs', 'docs/readme.md'])).toEqual(['docs/readme.md:1', 'src/b.fs:1']);
    expect(await hits(repo, q('foo'), [])).toEqual([]);
  });

  it('reports an invalid regular expression and stops at the result limit', async () => {
    expect((await searchWorktree(repo.dir, q('(', { regex: true }), null)).error).toMatch(/parenthes/);
    const big = await searchWorktree(repo.dir, q('x', { include: 'big.txt' }), null);
    expect(big.total).toBe(RESULT_LIMIT);
    expect(big.truncated).toBe(true);
  });
});

describe('globs', () => {
  it('splits on commas outside braces and anchors bare names at any depth', () => {
    expect(splitGlobs(' *.ts, ./src/a ,lib/, *.{ts,tsx}')).toEqual(['**/*.ts', 'src/a', 'lib/**', '**/*.{ts,tsx}']);
    expect(globPathspecs('*.ts', 'dist')).toEqual([':(glob,icase)**/*.ts', ':(glob,icase)**/*.ts/**', ':(exclude,glob,icase)**/dist', ':(exclude,glob,icase)**/dist/**']);
  });

  it('expands braces for git', () => {
    expect(expandBraces('**/*.{ts,tsx}')).toEqual(['**/*.ts', '**/*.tsx']);
    expect(expandBraces('{a,b}/{x,y}')).toEqual(['a/x', 'a/y', 'b/x', 'b/y']);
  });

  it('matches files and everything inside matched folders', () => {
    const paths = ['src/a.ts', 'src/deep/b.tsx', 'test/a.test.ts', 'README.md'];
    expect(filterPaths(paths, '*.ts', '')).toEqual(['src/a.ts', 'test/a.test.ts']);
    expect(filterPaths(paths, 'src', '')).toEqual(['src/a.ts', 'src/deep/b.tsx']);
    expect(filterPaths(paths, '', '*.test.ts, readme.md')).toEqual(['src/a.ts', 'src/deep/b.tsx']);
  });
});

describe('shownLine', () => {
  it('drops indentation and marks every match', () => {
    expect(shownLine('    foo + foo;', matcher(q('foo')))).toEqual({ text: 'foo + foo;', ranges: [[0, 3], [6, 9]] });
  });

  it('starts a line a little before a match further in, like VS Code', () => {
    const { text, ranges } = shownLine('"Feature_Flag_Default_With_A_Long_Key": "DarkMode",', matcher(q('darkmode')));
    expect(text).toBe('…ault_With_A_Long_Key": "DarkMode",');
    expect(text.slice(ranges[0]![0], ranges[0]![1])).toBe('DarkMode');
    expect(shownLine('value: "DarkMode"', matcher(q('darkmode'))).text).toBe('value: "DarkMode"');
  });

  it('cuts long lines around the first match', () => {
    const line = `${'a'.repeat(500)}needle${'b'.repeat(500)}`;
    const { text, ranges } = shownLine(line, matcher(q('needle')));
    expect(text.startsWith('…') && text.endsWith('…')).toBe(true);
    expect(text.slice(ranges[0]![0], ranges[0]![1])).toBe('needle');
  });
});
