import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import type { GitHubClient } from '../../../src/core/github/client';
import { setViewed, submitReview, threadInput, transientGitHubError } from '../../../src/core/github/reviews';
import { GitHubError } from '../../../src/core/github/client';
import { normalizeQuery } from '../../../src/core/github/search';
import { DraftStore } from '../../../src/core/store/drafts';
import type { Draft } from '../../../src/shared/model';
import { getQualifier, setQualifier, setState } from '../../../src/shared/query';
import { buildPrompt, parsePlacements } from '../../../src/core/ai/batch';

const dir = mkdtempSync(join(tmpdir(), 'prr-reviews-'));
afterAll(() => rmSync(dir, { recursive: true, force: true }));

function fakeClient(opts: { failThreadAt?: number } = {}) {
  const calls: { query: string; vars: Record<string, unknown> }[] = [];
  let threads = 0;
  const client = {
    async graphql<T>(query: string, vars: Record<string, unknown> = {}): Promise<T> {
      calls.push({ query, vars });
      if (query.includes('addPullRequestReview(')) return { addPullRequestReview: { pullRequestReview: { id: 'R_new' } } } as T;
      if (query.includes('addPullRequestReviewThread(')) {
        threads++;
        if (opts.failThreadAt === threads) throw new Error('secondary rate limit');
        return { addPullRequestReviewThread: { thread: { id: `T${threads}` } } } as T;
      }
      return {} as T;
    },
  } as unknown as GitHubClient;
  return { client, calls };
}

const draft = (id: string, extra: Partial<Draft> = {}): Draft => ({
  id,
  path: 'src/a.ts',
  subject: 'line',
  side: 'RIGHT',
  line: 10,
  body: `comment ${id}`,
  headOid: 'h1',
  createdAt: '2026-01-01T00:00:00Z',
  ...extra,
});

describe('submitReview', () => {
  it('creates a pending review when none exists, posts each draft, submits and clears drafts', async () => {
    const drafts = new DraftStore((k) => join(dir, `${k}.json`));
    await drafts.saveAll('pr1', [draft('a'), draft('b', { startLine: 8 })]);
    const { client, calls } = fakeClient();
    await submitReview({ client, drafts, prKey: 'pr1', pullRequestId: 'PR_1', headOid: 'h1', pendingReviewId: null, event: 'APPROVE', body: 'LGTM', spacingMs: 0 });
    expect(calls.map((c) => /mutation[^{]*\{\s*(\w+)/.exec(c.query)?.[1])).toEqual([
      'addPullRequestReview',
      'addPullRequestReviewThread',
      'addPullRequestReviewThread',
      'submitPullRequestReview',
    ]);
    expect(calls[2]?.vars).toMatchObject({ reviewId: 'R_new', startLine: 8, startSide: 'RIGHT', line: 10 });
    expect(calls[3]?.vars).toMatchObject({ reviewId: 'R_new', event: 'APPROVE', body: 'LGTM' });
    expect(await drafts.list('pr1')).toEqual([]);
  });

  it('adopts an existing pending review and resumes after a partial failure without double-posting', async () => {
    const drafts = new DraftStore((k) => join(dir, `${k}.json`));
    await drafts.saveAll('pr2', [draft('a'), draft('b'), draft('c')]);
    const first = fakeClient({ failThreadAt: 2 });
    await expect(
      submitReview({ client: first.client, drafts, prKey: 'pr2', pullRequestId: 'PR_2', headOid: 'h1', pendingReviewId: 'R_web', event: 'COMMENT', body: '', spacingMs: 0 }),
    ).rejects.toThrow(/rate limit/);
    expect(first.calls.some((c) => c.query.includes('addPullRequestReview('))).toBe(false);
    expect((await drafts.list('pr2')).filter((d) => d.postedThreadId).map((d) => d.id)).toEqual(['a']);

    const second = fakeClient();
    await submitReview({ client: second.client, drafts, prKey: 'pr2', pullRequestId: 'PR_2', headOid: 'h1', pendingReviewId: 'R_web', event: 'COMMENT', body: '', spacingMs: 0 });
    const posted = second.calls.filter((c) => c.query.includes('addPullRequestReviewThread(')).map((c) => c.vars.body);
    expect(posted).toEqual(['comment b', 'comment c']);
  });

  it('posts the drafts an agent wrote with your own, with nothing to accept first, and clears them all', async () => {
    const drafts = new DraftStore((k) => join(dir, `${k}.json`));
    await drafts.saveAll('pr3', [draft('own'), draft('claude', { origin: { agent: 'Claude' } })]);
    const { client, calls } = fakeClient();
    await submitReview({ client, drafts, prKey: 'pr3', pullRequestId: 'PR_3', headOid: 'h1', pendingReviewId: 'R', event: 'COMMENT', body: '', spacingMs: 0 });
    expect(calls.filter((c) => c.query.includes('addPullRequestReviewThread(')).map((c) => c.vars.body)).toEqual(['comment own', 'comment claude']);
    expect(await drafts.list('pr3')).toEqual([]);
  });

  it('file comments use subjectType FILE without a line', () => {
    expect(threadInput('R', draft('f', { subject: 'file' }))).toEqual({ reviewId: 'R', path: 'src/a.ts', body: 'comment f', subjectType: 'FILE' });
  });
});

describe('search query helpers', () => {
  it('always searches pull requests', () => {
    expect(normalizeQuery('author:@me')).toBe('is:pr author:@me');
    expect(normalizeQuery('is:pr label:x')).toBe('is:pr label:x');
  });

  it('reads, replaces and removes qualifiers like the github.com filter menus', () => {
    const q = 'is:pr is:open label:"needs review" repo:a/b';
    expect(getQualifier(q, 'label')).toBe('needs review');
    expect(setQualifier(q, 'label', 'bug')).toBe('is:pr is:open repo:a/b label:bug');
    expect(setQualifier(q, 'repo', '')).toBe('is:pr is:open label:"needs review"');
    expect(setState(q, 'closed')).toBe('is:pr label:"needs review" repo:a/b is:closed');
  });
});

describe('Claude batch placement', () => {
  const items = [
    { id: 'T1', path: 'a.ts', side: 'RIGHT' as const, originalLine: 5, diffHunk: '@@ -1 +1 @@\n+x', comment: 'why?', predicted: 3, current: ['a', 'b', 'c', 'd'] },
  ];

  it('numbers the window lines in the prompt', () => {
    expect(buildPrompt(items)).toContain('3: c');
  });

  it('keeps only valid placements for known ids', () => {
    const reply = 'Sure:\n[{"id":"T1","line":3,"confidence":0.8},{"id":"T1","line":99},{"id":"nope","line":1}]';
    expect(parsePlacements(reply, items)).toEqual([{ id: 'T1', line: 3, confidence: 0.8 }]);
    expect(parsePlacements('no json here', items)).toEqual([]);
  });
});

describe('setViewed', () => {
  /** GitHub failing `failures[path]` times for each file, with `error`, then marking it. */
  function flaky(failures: Record<string, number>, error: () => Error) {
    const calls: string[] = [];
    const client = {
      async graphql(_query: string, vars: Record<string, unknown>) {
        const path = String(vars.path);
        calls.push(path);
        if ((failures[path] ?? 0) > 0) {
          failures[path]!--;
          throw error();
        }
        return {};
      },
    } as unknown as GitHubClient;
    return { client, calls };
  }
  const noWait = async () => undefined;

  it("tries GitHub's passing failures again, and carries on past a file it keeps refusing", async () => {
    const { client, calls } = flaky({ 'b.kusto': 1, 'c.kusto': 9 }, () => new Error('GitHub: Something went wrong while executing your query'));
    const failed = await setViewed(client, 'PR_1', ['a.kusto', 'b.kusto', 'c.kusto', 'd.kusto'], true, noWait);
    expect(failed).toEqual([{ path: 'c.kusto', error: 'GitHub: Something went wrong while executing your query' }]);
    // b once more; c three times in all; d still marked after c gave up.
    expect(calls).toEqual(['a.kusto', 'b.kusto', 'b.kusto', 'c.kusto', 'c.kusto', 'c.kusto', 'd.kusto']);
  });

  it('does not try again what GitHub refuses for good', async () => {
    const { client, calls } = flaky({ 'a.kusto': 1 }, () => new Error('GitHub: Resource not accessible by integration'));
    expect(await setViewed(client, 'PR_1', ['a.kusto'], true, noWait)).toHaveLength(1);
    expect(calls).toEqual(['a.kusto']);
  });

  it('counts server errors and dropped connections as passing', () => {
    expect(transientGitHubError(new GitHubError('GitHub GraphQL request failed: HTTP 502', 502))).toBe(true);
    expect(transientGitHubError(new Error('read ECONNRESET'))).toBe(true);
    expect(transientGitHubError(new GitHubError('GitHub GraphQL request failed: HTTP 401', 401))).toBe(false);
  });
});
