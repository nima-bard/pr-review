import { describe, expect, it } from 'vitest';
import { mergeRules, mergeVerdict } from '../../src/shared/mergeRules';
import type { MergeInfo } from '../../src/shared/model';

const info = (over: Partial<MergeInfo> = {}): MergeInfo => ({
  state: 'OPEN',
  isDraft: false,
  headRefOid: 'abc',
  headRefName: 'feature',
  baseRefName: 'main',
  methods: ['MERGE', 'SQUASH', 'REBASE'],
  defaultMethod: 'SQUASH',
  messages: { MERGE: { headline: 'Merge pull request #1', body: '' }, SQUASH: { headline: 'Feature (#1)', body: '' } },
  authorEmail: null,
  mergeable: 'MERGEABLE',
  mergeStateStatus: 'CLEAN',
  reviewDecision: null,
  checks: [],
  canMerge: true,
  canBypass: false,
  autoMerge: { available: false, enabled: null, canDisable: false },
  mergeQueue: { enabled: false, queued: false },
  canUpdateBranch: false,
  deleteBranch: 'optional',
  ...over,
});

const check = (state: 'success' | 'failure' | 'pending', required: boolean) => ({ name: `${state}-${required}`, state, url: null, required });

describe('mergeVerdict', () => {
  it('merges a clean pull request, and one where only optional checks failed', () => {
    expect(mergeVerdict(info())).toBe('ready');
    expect(mergeVerdict(info({ mergeStateStatus: 'UNSTABLE' }))).toBe('ready');
  });

  it('says why it can not merge', () => {
    expect(mergeVerdict(info({ state: 'MERGED' }))).toBe('closed');
    expect(mergeVerdict(info({ isDraft: true }))).toBe('draft');
    expect(mergeVerdict(info({ canMerge: false }))).toBe('no-access');
    expect(mergeVerdict(info({ mergeable: 'CONFLICTING', mergeStateStatus: 'DIRTY' }))).toBe('conflicts');
    expect(mergeVerdict(info({ mergeable: 'UNKNOWN', mergeStateStatus: 'UNKNOWN' }))).toBe('checking');
  });

  it('is blocked by the rules (reviews, checks, an out-of-date branch), and goes through a merge queue', () => {
    expect(mergeVerdict(info({ mergeStateStatus: 'BLOCKED' }))).toBe('blocked');
    expect(mergeVerdict(info({ mergeStateStatus: 'BEHIND' }))).toBe('blocked');
    expect(mergeVerdict(info({ mergeQueue: { enabled: true, queued: false } }))).toBe('queue');
    expect(mergeVerdict(info({ mergeQueue: { enabled: true, queued: true } }))).toBe('queued');
  });
});

describe('mergeRules', () => {
  it('lists conflicts, reviews and checks', () => {
    const rules = mergeRules(info({ mergeStateStatus: 'BLOCKED', reviewDecision: 'REVIEW_REQUIRED', checks: [check('pending', true), check('failure', false)] }));
    expect(rules).toEqual([
      { tone: 'ok', text: 'No conflicts with main' },
      { tone: 'bad', text: 'A review is required' },
      { tone: 'pending', text: '1 required check still running' },
      { tone: 'warn', text: '1 check failed (not required)' },
    ]);
  });

  it('counts required checks apart from the others', () => {
    expect(mergeRules(info({ checks: [check('success', true), check('success', true), check('success', false)] })).map((r) => r.text)).toContain('All 2 required checks passed');
    expect(mergeRules(info({ checks: [check('success', false)] })).map((r) => r.text)).toContain('The check passed');
  });

  it('names an unnamed rule when GitHub blocks the merge for a reason it does not list', () => {
    expect(mergeRules(info({ mergeStateStatus: 'BLOCKED', reviewDecision: 'APPROVED' })).at(-1)).toEqual({ tone: 'bad', text: 'Blocked by a rule for main (see the pull request on GitHub)' });
  });
});
