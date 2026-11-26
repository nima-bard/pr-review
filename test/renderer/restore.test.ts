import { describe, expect, it } from 'vitest';
import { tabsToRestore } from '../../src/renderer/state/restore';

describe('tabsToRestore', () => {
  const saved = ['https://github.com/acme/demo/pull/1', 'acme/demo#2'];

  it('restores each saved pull request once, however it was written', () => {
    expect(tabsToRestore([...saved, 'acme/demo#1'], new Set())).toEqual([
      { key: 'github.com/acme/demo#1', input: 'https://github.com/acme/demo/pull/1' },
      { key: 'github.com/acme/demo#2', input: 'acme/demo#2' },
    ]);
  });

  it('skips pull requests that are already open, so running startup twice adds nothing the second time', () => {
    const first = tabsToRestore(saved, new Set());
    expect(tabsToRestore(saved, new Set(first.map((t) => t.key)))).toEqual([]);
    expect(tabsToRestore(saved, new Set(['github.com/acme/demo#2']))).toEqual([{ key: 'github.com/acme/demo#1', input: 'https://github.com/acme/demo/pull/1' }]);
  });

  it('ignores saved entries that are not pull requests', () => {
    expect(tabsToRestore(['not a pull request', ''], new Set())).toEqual([]);
  });
});
