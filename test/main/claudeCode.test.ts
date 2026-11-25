import { describe, expect, it } from 'vitest';
import { REVIEW_ALLOWED, REVIEW_DENIED } from '../../src/main/agents/claudeCode';

describe('review permissions', () => {
  it('denies every gh api call, since a rule only matches the start of a command', () => {
    expect(REVIEW_DENIED).toContain('Bash(gh api:*)');
    expect(REVIEW_ALLOWED.some((rule) => rule.startsWith('Bash(gh api'))).toBe(false);
  });

  it('denies posting comments and reviews, and editing files', () => {
    for (const rule of ['Bash(gh pr comment:*)', 'Bash(gh pr review:*)', 'Edit', 'Write', 'NotebookEdit']) expect(REVIEW_DENIED).toContain(rule);
  });

  it('allows nothing it also denies', () => {
    expect(REVIEW_ALLOWED.filter((rule) => REVIEW_DENIED.includes(rule))).toEqual([]);
  });
});
