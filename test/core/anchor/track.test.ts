import { afterAll, describe, expect, it } from 'vitest';
import { anchorFromLines } from '../../../src/core/anchor/fuzzy';
import { createGitTrackIO } from '../../../src/core/anchor/gitIO';
import { trackLine, trackRange } from '../../../src/core/anchor/track';
import { DEFAULT_ANCHOR_CONFIG, type AnchorTier } from '../../../src/core/anchor/types';
import { BlobReader, splitLines } from '../../../src/core/git/blobs';
import { buildChain } from '../../../src/core/git/versions';
import { lines, tempRepo } from '../../helpers/gitRepo';

const ORIGINAL = lines(
  "import { compute } from './compute';",
  '',
  'export function process(items: string[]): number {',
  '  let total = 0;',
  '  for (const item of items) {',
  '    total += compute(item);',
  '  }',
  '  return total;',
  '}',
  '',
  "export const VERSION = '1.0.0';",
);

const repo = tempRepo();
const blobs = new BlobReader(repo.dir);
const io = createGitTrackIO(repo.dir, blobs);
afterAll(() => {
  blobs.dispose();
  repo.cleanup();
});

let n = 0;
async function track(original: string, next: string, line = 6, startLine: number | null = null) {
  const path = `f${n++}.ts`;
  const a = repo.commit(`orig ${path}`, { [path]: original });
  const b = repo.commit(`next ${path}`, { [path]: next });
  const origLines = splitLines(original);
  const anchor = anchorFromLines(origLines, line);
  if (startLine !== null) {
    return trackRange(io, [a, b], { path, startLine, line, startAnchor: anchorFromLines(origLines, startLine), anchor }, DEFAULT_ANCHOR_CONFIG);
  }
  return trackLine(io, [a, b], { path, line, anchor }, DEFAULT_ANCHOR_CONFIG);
}

const expectTier = (tier: AnchorTier, allowed: AnchorTier[]) => expect(allowed).toContain(tier);

describe('trackLine (single step, real git histogram hunks)', () => {
  it('unchanged file -> exact at the original line', async () => {
    expect(await track(ORIGINAL, ORIGINAL)).toMatchObject({ tier: 'exact', line: 6 });
  });

  it('three lines inserted at the top -> shifted', async () => {
    expect(await track(ORIGINAL, lines('// h1', '// h2', '// h3') + ORIGINAL)).toMatchObject({ tier: 'shifted', line: 9 });
  });

  it('insertion directly above the commented line -> shifted by one', async () => {
    const next = ORIGINAL.replace('    total += compute(item);', '    // NOTE: hot loop\n    total += compute(item);');
    expect(await track(ORIGINAL, next)).toMatchObject({ tier: 'shifted', line: 7 });
  });

  it('commented line edited in place -> fuzzy at the same line, changedAt set', async () => {
    const r = await track(ORIGINAL, ORIGINAL.replace('total += compute(item);', 'total += computeValue(item);'));
    expect(r).toMatchObject({ tier: 'fuzzy', line: 6 });
    expect(r.changedAt).toBeDefined();
  });

  it('function moved below VERSION -> lands on the moved line', async () => {
    const next = lines(
      "import { compute } from './compute';",
      '',
      "export const VERSION = '1.0.0';",
      '',
      'export function process(items: string[]): number {',
      '  let total = 0;',
      '  for (const item of items) {',
      '    total += compute(item);',
      '  }',
      '  return total;',
      '}',
    );
    const r = await track(ORIGINAL, next);
    expectTier(r.tier, ['exact', 'shifted', 'fuzzy']);
    expect(r.line).toBe(8);
  });

  it('commented line split in two -> never a confident wrong placement', async () => {
    const r = await track(ORIGINAL, ORIGINAL.replace('    total += compute(item);', '    const v = compute(item);\n    total += v;'));
    expectTier(r.tier, ['fuzzy', 'guess', 'orphan']);
    if (r.line !== undefined) expect([6, 7]).toContain(r.line);
  });

  it('commented line deleted, context remains -> orphan or guess', async () => {
    const r = await track(ORIGINAL, ORIGINAL.replace('    total += compute(item);\n', ''));
    expectTier(r.tier, ['orphan', 'guess']);
  });

  it('heavy rewrite -> orphan', async () => {
    const r = await track(ORIGINAL, lines('const sum = (xs: number[]) => xs.reduce((a, b) => a + b, 0);', 'export default sum;'));
    expect(r.tier).toBe('orphan');
  });

  it('multi-line thread, both endpoints survive', async () => {
    const r = await track(ORIGINAL, lines('// header') + ORIGINAL, 8, 4);
    expect(r).toMatchObject({ line: 5, endLine: 9 });
    expectTier(r.tier, ['exact', 'shifted']);
  });

  it('multi-line thread, start endpoint changes -> range keeps a fuzzy start or degrades to the end line', async () => {
    const r = await track(ORIGINAL, ORIGINAL.replace('  let total = 0;', '  let total = 0, count = 0;'), 8, 4);
    if (r.endLine === undefined) expect(r.line).toBe(8);
    else expect(r).toMatchObject({ line: 4, endLine: 8 });
  });
});

describe('trackLine across several versions', () => {
  it('shifts through early pushes, then matches fuzzily where the line changed; changedAt is that version', async () => {
    const path = 'multi.ts';
    const v1 = repo.commit('v1', { [path]: ORIGINAL });
    const v2 = repo.commit('v2', { [path]: lines('// a', '// b') + ORIGINAL });
    const v3 = repo.commit('v3', { [path]: (lines('// a', '// b') + ORIGINAL).replace('compute(item)', 'computeFast(item)') });
    const chain = await buildChain(repo.dir, v1, v3, []);
    expect(chain).toEqual([v1, v2, v3]);
    const r = await trackLine(io, chain, { path, line: 6, anchor: anchorFromLines(splitLines(ORIGINAL), 6) }, DEFAULT_ANCHOR_CONFIG);
    expect(r).toMatchObject({ tier: 'fuzzy', line: 8, changedAt: v3 });
  });

  it('follows a rename and reports deleted files as orphans', async () => {
    const v1 = repo.commit('r1', { 'old/name.ts': ORIGINAL });
    const v2 = repo.commit('r2', { 'old/name.ts': null, 'new/name.ts': ORIGINAL });
    const moved = await trackLine(io, [v1, v2], { path: 'old/name.ts', line: 6, anchor: anchorFromLines(splitLines(ORIGINAL), 6) }, DEFAULT_ANCHOR_CONFIG);
    expect(moved).toMatchObject({ tier: 'exact', line: 6, path: 'new/name.ts' });
    const v3 = repo.commit('r3', { 'new/name.ts': null });
    const gone = await trackLine(io, [v2, v3], { path: 'new/name.ts', line: 6, anchor: anchorFromLines(splitLines(ORIGINAL), 6) }, DEFAULT_ANCHOR_CONFIG);
    expect(gone).toMatchObject({ tier: 'orphan', reason: 'file-deleted' });
  });
});
