import { describe, expect, it } from 'vitest';
import { anchorFromHunk, anchorFromLines, contentWeight, findAnchor, lineSimilarity, parseHunkSide } from '../../../src/core/anchor/fuzzy';

const CFG = { radius: 250, ambiguityMargin: 0.05 };

describe('parseHunkSide', () => {
  it('numbers RIGHT-side lines from the +header, skipping deletions', () => {
    const hunk = ['@@ -10,3 +20,3 @@', ' ctx1', '-oldOnly', '+newOnly', ' ctx2'].join('\n');
    expect(parseHunkSide(hunk, 'RIGHT')).toEqual([
      { num: 20, text: 'ctx1' },
      { num: 21, text: 'newOnly' },
      { num: 22, text: 'ctx2' },
    ]);
  });

  it('numbers LEFT-side lines from the -header, skipping additions', () => {
    const hunk = ['@@ -10,3 +20,3 @@', ' ctx1', '-oldOnly', '+newOnly', ' ctx2'].join('\n');
    expect(parseHunkSide(hunk, 'LEFT')).toEqual([
      { num: 10, text: 'ctx1' },
      { num: 11, text: 'oldOnly' },
      { num: 12, text: 'ctx2' },
    ]);
  });

  it('returns empty for a malformed hunk and ignores the no-newline marker', () => {
    expect(parseHunkSide('not a hunk', 'RIGHT')).toEqual([]);
    expect(parseHunkSide(['@@ -1,1 +1,1 @@', '+only', '\\ No newline at end of file'].join('\n'), 'RIGHT')).toEqual([{ num: 1, text: 'only' }]);
  });
});

describe('anchor text', () => {
  const blob = ['l1', 'l2', 'l3', 'l4', 'l5', 'l6', 'l7'];

  it('takes context on both sides from the blob', () => {
    expect(anchorFromLines(blob, 4, 2)).toEqual({ target: 'l4', contextBefore: ['l2', 'l3'], contextAfter: ['l5', 'l6'] });
  });

  it('a real GitHub hunk (ending at the commented line) yields no context after', () => {
    const hunk = ['@@ -3,2 +3,3 @@ fn', ' a', ' b', '+commented'].join('\n');
    expect(anchorFromHunk(hunk, 'RIGHT', 5)).toEqual({ target: 'commented', contextBefore: ['a', 'b'], contextAfter: [] });
    expect(anchorFromHunk(hunk, 'RIGHT', 99)).toBeUndefined();
  });
});

describe('lineSimilarity', () => {
  it('is whitespace-insensitive, 1 for equal lines and blank pairs', () => {
    expect(lineSimilarity('  foo();', 'foo();')).toBe(1);
    expect(lineSimilarity('', '   ')).toBe(1);
  });

  it('survives an identifier rename better than an unrelated line', () => {
    const renamed = lineSimilarity('total += compute(item);', 'total += computeValue(item);');
    const unrelated = lineSimilarity('total += compute(item);', 'return cache.get(key);');
    expect(renamed).toBeGreaterThan(0.6);
    expect(renamed).toBeLessThan(1);
    expect(unrelated).toBeLessThan(0.4);
  });
});

describe('contentWeight', () => {
  it('leans on context for low-information lines', () => {
    expect(contentWeight('}')).toBe(0.25);
    expect(contentWeight('  return;')).toBe(0.25);
    expect(contentWeight('const answer = compute(42);')).toBe(0.6);
  });
});

describe('findAnchor', () => {
  const anchor = { target: 'const answer = compute(42);', contextBefore: ['function main() {'], contextAfter: ['  return answer;'] };

  it('finds an exact line at the predicted position', () => {
    const hit = findAnchor(['function main() {', 'const answer = compute(42);', '  return answer;'], anchor, 2, CFG);
    expect(hit?.line).toBe(2);
    expect(hit?.score).toBeGreaterThanOrEqual(0.95);
    expect(hit?.ambiguous).toBe(false);
  });

  it('finds a moved line away from the predicted position', () => {
    const buffer = [...Array.from({ length: 40 }, (_, i) => `// filler ${i}`), 'function main() {', 'const answer = compute(42);', '  return answer;'];
    expect(findAnchor(buffer, anchor, 2, CFG)?.line).toBe(42);
  });

  it('prefers the candidate with matching context among identical lines', () => {
    const buffer = ['function other() {', 'const answer = compute(42);', '  return 0;', 'function main() {', 'const answer = compute(42);', '  return answer;'];
    expect(findAnchor(buffer, anchor, 3, CFG)?.line).toBe(5);
  });

  it('flags two equally good candidates as ambiguous', () => {
    const block = ['function main() {', 'const answer = compute(42);', '  return answer;'];
    const filler = Array.from({ length: 21 }, (_, i) => `// filler ${i}`);
    const buffer = [...block, ...filler, ...block];
    const hit = findAnchor(buffer, anchor, 14, CFG);
    expect(hit?.ambiguous).toBe(true);
  });

  it('scores an unrelated buffer low', () => {
    const hit = findAnchor(['alpha', 'beta', 'gamma'], anchor, 2, CFG);
    expect(hit && hit.score).toBeLessThan(0.5);
  });
});
