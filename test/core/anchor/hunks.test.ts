import { execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import { parseHunkHeaders, shiftLine, touchedNewLines } from '../../../src/core/anchor/hunks';

const dir = mkdtempSync(join(tmpdir(), 'prr-hunks-'));
afterAll(() => rmSync(dir, { recursive: true, force: true }));

/** Real git -U0 histogram hunks between two texts. */
function gitHunks(a: string, b: string) {
  writeFileSync(join(dir, 'a'), a);
  writeFileSync(join(dir, 'b'), b);
  let out = '';
  try {
    execFileSync('git', ['diff', '--no-index', '-U0', '--histogram', '--no-color', 'a', 'b'], { cwd: dir, encoding: 'utf8' });
  } catch (err) {
    out = (err as { stdout: string }).stdout;
  }
  return parseHunkHeaders(out);
}

const L = (...ls: string[]) => `${ls.join('\n')}\n`;
const original = L('a', 'b', 'c', 'd', 'e');

describe('shiftLine with real git hunks', () => {
  it('identity', () => {
    expect(shiftLine(gitHunks(original, original), 3)).toEqual({ kind: 'mapped', line: 3, delta: 0 });
  });

  it('insertion at the very top shifts every line (-0,0 convention)', () => {
    const h = gitHunks(original, L('X', 'a', 'b', 'c', 'd', 'e'));
    expect(h[0]).toEqual({ oldStart: 0, oldLines: 0, newStart: 1, newLines: 1 });
    expect(shiftLine(h, 1)).toEqual({ kind: 'mapped', line: 2, delta: 1 });
  });

  it('insertion directly above the target shifts it; directly below does not', () => {
    expect(shiftLine(gitHunks(original, L('a', 'b', 'X', 'c', 'd', 'e')), 3)).toMatchObject({ kind: 'mapped', line: 4 });
    expect(shiftLine(gitHunks(original, L('a', 'b', 'c', 'X', 'd', 'e')), 3)).toMatchObject({ kind: 'mapped', line: 3 });
  });

  it('append at the end leaves earlier lines alone', () => {
    expect(shiftLine(gitHunks(original, L('a', 'b', 'c', 'd', 'e', 'X')), 5)).toMatchObject({ kind: 'mapped', line: 5 });
  });

  it('deletion above shifts up; deleting the target is inHunk at the deletion site', () => {
    expect(shiftLine(gitHunks(original, L('a', 'c', 'd', 'e')), 4)).toMatchObject({ kind: 'mapped', line: 3 });
    expect(shiftLine(gitHunks(original, L('a', 'b', 'd', 'e')), 3)).toEqual({ kind: 'inHunk', predictedLine: 3 });
    expect(shiftLine(gitHunks(original, L('b', 'c', 'd', 'e')), 1)).toEqual({ kind: 'inHunk', predictedLine: 1 });
  });

  it('edited target is inHunk', () => {
    expect(shiftLine(gitHunks(original, L('a', 'b', 'C', 'd', 'e')), 3)).toEqual({ kind: 'inHunk', predictedLine: 3 });
  });

  it('accumulates delta across hunks', () => {
    const h = gitHunks(L('1', '2', '3', '4', '5', '6', '7', '8'), L('1', 'A', '2', '3', '5', '6', 'B', '7', '8'));
    expect(shiftLine(h, 8)).toMatchObject({ kind: 'mapped', line: 9 });
    expect(shiftLine(h, 3)).toMatchObject({ kind: 'mapped', line: 4 });
    expect(shiftLine(h, 4).kind).toBe('inHunk');
  });

  it('missing trailing newline', () => {
    expect(shiftLine(gitHunks('a\nb\nc', 'a\nX\nb\nc'), 2)).toMatchObject({ kind: 'mapped', line: 3 });
  });
});

describe('touchedNewLines', () => {
  it('detects edits overlapping a range', () => {
    const h = gitHunks(original, L('a', 'b', 'C', 'd', 'e'));
    expect(touchedNewLines(h, 3, 3)).toBe(true);
    expect(touchedNewLines(h, 4, 5)).toBe(false);
  });
});
