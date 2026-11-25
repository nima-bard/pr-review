import { describe, expect, it } from 'vitest';
import { pickOriginalBlob, validateAgainstHunk } from '../../../src/core/anchor/validate';

const hunk = ['@@ -2,3 +2,3 @@', ' keep', '-old line', '+new line', ' tail'].join('\n');

describe('validateAgainstHunk', () => {
  it('accepts a blob containing the hunk side lines at their numbers', () => {
    expect(validateAgainstHunk(['first', 'keep', 'new line', 'tail'], hunk, 'RIGHT')).toBe(true);
    expect(validateAgainstHunk(['first', 'keep', 'old line', 'tail'], hunk, 'LEFT')).toBe(true);
  });

  it('rejects a shifted or different blob', () => {
    expect(validateAgainstHunk(['keep', 'new line', 'tail'], hunk, 'RIGHT')).toBe(false);
    expect(validateAgainstHunk(['first', 'keep', 'new line', 'tail'], hunk, 'LEFT')).toBe(false);
  });
});

describe('pickOriginalBlob', () => {
  it('returns the first candidate that validates', async () => {
    const blobs: Record<string, string[]> = { a: ['x', 'y'], b: ['first', 'keep', 'old line', 'tail'] };
    const picked = await pickOriginalBlob(['a', 'missing', 'b'], async (sha) => blobs[sha], hunk, 'LEFT');
    expect(picked?.sha).toBe('b');
  });
});
