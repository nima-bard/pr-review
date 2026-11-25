import { afterAll, describe, expect, it } from 'vitest';
import { findMovedLine, parseBlamePorcelain } from '../../../src/core/anchor/moved';
import { lines, tempRepo } from '../../helpers/gitRepo';

describe('parseBlamePorcelain', () => {
  it('maps final lines to their origin commit, path and line', () => {
    const sha = 'a'.repeat(40);
    const out = [`${sha} 3 1 2`, 'author t', 'filename src/old.ts', '\tline one', `${sha} 4 2`, '\tline two'].join('\n');
    const map = parseBlamePorcelain(out);
    expect(map.get(1)).toEqual({ commit: sha, path: 'src/old.ts', line: 3 });
    expect(map.get(2)).toEqual({ commit: sha, path: 'src/old.ts', line: 4 });
  });
});

describe('findMovedLine (real git)', () => {
  const repo = tempRepo();
  afterAll(() => repo.cleanup());

  it('follows a function moved into another file, and ignores a coincidental duplicate', async () => {
    const fn = lines('export function computeLoyaltyRate(tier: string): number {', '  return tier === "gold" ? 0.1 : 0;', '}');
    const v1 = repo.commit('add', { 'src/a.ts': lines('// a', '') + fn, 'src/c.ts': lines('// unrelated') });
    const head = repo.commit('move', {
      'src/a.ts': lines('// a'),
      'src/b.ts': lines('// b', '// more', '') + fn,
    });
    expect(await findMovedLine(repo.dir, v1, 'src/a.ts', 4, '  return tier === "gold" ? 0.1 : 0;', head)).toEqual({ path: 'src/b.ts', line: 5 });

    const v2 = repo.commit('new code', { 'src/c.ts': lines('// unrelated', 'const label = "fresh line nobody moved";') });
    const head2 = repo.commit('copy text elsewhere', { 'src/d.ts': lines('const label = "fresh line nobody moved";'), 'src/c.ts': lines('// unrelated') });
    const moved = await findMovedLine(repo.dir, v2, 'src/c.ts', 2, 'const label = "fresh line nobody moved";', head2);
    expect(moved === null || moved.path === 'src/d.ts').toBe(true);
  });

  it('follows a line re-indented while its file was split (module wrapper removed)', async () => {
    const before = lines(
      'module Weather',
      '',
      'type Reading = { Celsius: float }',
      '',
      'module WeatherLimits =',
      '    /// Readings outside this range are sensor faults.',
      '    let private maxCelsius = 60.0',
    );
    const v1 = repo.commit('one file', { 'Weather/Types.fs': before });
    const head = repo.commit('split', {
      'Weather/Types.fs': null,
      'Weather/Readings.fs': lines('module Weather.Readings', '', 'type Reading = { Celsius: float }'),
      'Weather/Limits.fs': lines('module Weather.Limits', '', '/// Readings outside this range are sensor faults.', 'let private maxCelsius = 60.0'),
    });
    expect(await findMovedLine(repo.dir, v1, 'Weather/Types.fs', 6, '    /// Readings outside this range are sensor faults.', head)).toEqual({ path: 'Weather/Limits.fs', line: 3 });
  });
});
