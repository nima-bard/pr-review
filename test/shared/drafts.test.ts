import { describe, expect, it } from 'vitest';
import { isAgentDraft } from '../../src/shared/drafts';
import type { Draft } from '../../src/shared/model';

const draft = (origin?: Draft['origin']): Draft => ({
  id: 'd',
  path: 'a.ts',
  subject: 'line',
  side: 'RIGHT',
  line: 1,
  body: 'x',
  headOid: 'h',
  createdAt: '2026-01-01T00:00:00Z',
  ...(origin ? { origin } : {}),
});

describe('isAgentDraft', () => {
  it('is an agent draft while it keeps the origin an agent gave it; your own drafts are not', () => {
    expect(isAgentDraft(draft({ agent: 'Claude' }))).toBe(true);
    expect(isAgentDraft(draft())).toBe(false);
  });
});
