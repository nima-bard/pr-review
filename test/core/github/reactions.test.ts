import { describe, expect, it } from 'vitest';
import { toggleReaction, toReactions } from '../../../src/core/github/reactions';

const group = (content: string, totalCount: number, viewerHasReacted = false) => ({ content, viewerHasReacted, reactors: { totalCount } });

describe('toReactions', () => {
  it('keeps used reactions in GitHub order and drops empty or unknown ones', () => {
    expect(toReactions([group('EYES', 1), group('THUMBS_UP', 2, true), group('LAUGH', 0), group('SPARKLES', 3)])).toEqual([
      { content: 'THUMBS_UP', count: 2, viewerHasReacted: true },
      { content: 'EYES', count: 1, viewerHasReacted: false },
    ]);
    expect(toReactions(undefined)).toEqual([]);
  });
});

describe('toggleReaction', () => {
  it('adds the viewer to an existing reaction or creates it', () => {
    expect(toggleReaction([{ content: 'HEART', count: 1, viewerHasReacted: false }], 'HEART', true)).toEqual([{ content: 'HEART', count: 2, viewerHasReacted: true }]);
    expect(toggleReaction([{ content: 'EYES', count: 1, viewerHasReacted: false }], 'THUMBS_UP', true)).toEqual([
      { content: 'THUMBS_UP', count: 1, viewerHasReacted: true },
      { content: 'EYES', count: 1, viewerHasReacted: false },
    ]);
  });

  it('removes the viewer and drops a reaction nobody has left', () => {
    expect(toggleReaction([{ content: 'ROCKET', count: 1, viewerHasReacted: true }], 'ROCKET', false)).toEqual([]);
    expect(toggleReaction([{ content: 'ROCKET', count: 3, viewerHasReacted: true }], 'ROCKET', false)).toEqual([{ content: 'ROCKET', count: 2, viewerHasReacted: false }]);
  });

  it('ignores a toggle that would not change anything', () => {
    const r = [{ content: 'HEART' as const, count: 1, viewerHasReacted: true }];
    expect(toggleReaction(r, 'HEART', true)).toEqual(r);
    expect(toggleReaction([], 'HEART', false)).toEqual([]);
  });
});
