import { describe, expect, it } from 'vitest';
import { markStay, prFromAppUrl, prViewFromUrl } from '../../src/shared/prInput';

describe('prFromAppUrl', () => {
  it('reads the open?pr= form, with a URL or a short reference', () => {
    expect(prFromAppUrl('prreview://open?pr=https%3A%2F%2Fgithub.com%2Fo%2Fr%2Fpull%2F12')).toBe('https://github.com/o/r/pull/12');
    expect(prFromAppUrl('prreview://open/?pr=o%2Fr%2312')).toBe('o/r#12');
  });

  it('reads a GitHub URL with its scheme swapped', () => {
    expect(prFromAppUrl('prreview://github.com/o/r/pull/12/files')).toBe('https://github.com/o/r/pull/12/files');
    expect(prFromAppUrl('prreview://https://github.com/o/r/pull/12')).toBe('https://github.com/o/r/pull/12');
  });

  it('rejects anything that is not a pull request', () => {
    expect(prFromAppUrl('prreview://github.com/o/r/issues/12')).toBeNull();
    expect(prFromAppUrl('prreview://open?pr=%E0%A4%A')).toBeNull();
    expect(prFromAppUrl('https://github.com/o/r/pull/12')).toBeNull();
  });
});

describe('prViewFromUrl', () => {
  it('maps the GitHub tabs to the app views', () => {
    expect(prViewFromUrl('https://github.com/o/r/pull/12/files#diff-abc')).toBe('files');
    expect(prViewFromUrl('https://github.com/o/r/pull/12/changes')).toBe('files');
    expect(prViewFromUrl('https://github.com/o/r/pull/12/commits')).toBe('commits');
    expect(prViewFromUrl('https://github.com/o/r/pull/12')).toBeNull();
  });
});

describe('markStay', () => {
  it('marks pull request URLs and leaves other links alone', () => {
    expect(markStay('https://github.com/o/r/pull/12#discussion_r1')).toBe('https://github.com/o/r/pull/12?pr_review=stay#discussion_r1');
    expect(markStay('https://github.com/o/r/issues/3')).toBe('https://github.com/o/r/issues/3');
  });
});
