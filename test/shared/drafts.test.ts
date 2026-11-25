import { describe, expect, it } from 'vitest';
import { isSubmittable, isSuggestion, suggestionGroups } from '../../src/shared/drafts';
import type { Draft } from '../../src/shared/model';

const draft = (origin?: Draft['origin'], id = 'd'): Draft => ({
  id,
  path: 'a.ts',
  subject: 'line',
  side: 'RIGHT',
  line: 1,
  body: 'x',
  headOid: 'h',
  createdAt: '2026-01-01T00:00:00Z',
  ...(origin ? { origin } : {}),
});

describe('isSubmittable', () => {
  it('sends your own drafts and accepted suggestions, not suggestions you have not accepted', () => {
    expect(isSubmittable(draft())).toBe(true);
    expect(isSubmittable(draft({ agent: 'Claude', turnId: null, acceptedAt: '2026-01-02T00:00:00Z' }))).toBe(true);
    expect(isSubmittable(draft({ agent: 'Claude', turnId: 't', acceptedAt: null }))).toBe(false);
    expect(isSuggestion(draft({ agent: 'Claude', turnId: 't', acceptedAt: null }))).toBe(true);
  });
});

describe('suggestionGroups', () => {
  it('groups suggestions by the request that added them, leaving out your drafts and accepted ones', () => {
    const s = (id: string, turnId: string | null) => draft({ agent: 'Claude', turnId, acceptedAt: null }, id);
    const groups = suggestionGroups([s('a', 't1'), draft(undefined, 'own'), s('b', 't2'), draft({ agent: 'Claude', turnId: 't1', acceptedAt: 'x' }, 'acc'), s('c', 't1'), s('d', null)]);
    expect(groups.map((g) => [g.turnId, g.drafts.map((d) => d.id)])).toEqual([
      ['t1', ['a', 'c']],
      ['t2', ['b']],
      [null, ['d']],
    ]);
  });
});
