import { prKey, type InboxSection, type SearchItem, type SearchPage } from '../../shared/model';
import type { GitHubClient } from './client';
import { SEARCH_PRS, type CheckCounts, type SearchNode, type SearchResponse } from './queries';

const PASSING_CHECK_RUNS = new Set(['SUCCESS', 'NEUTRAL', 'SKIPPED']);

/** "2/2" like the github.com list: neutral and skipped check runs count as passing, as they do there. */
export function checkCounts(c: CheckCounts | undefined): { passed: number; total: number } | null {
  if (!c) return null;
  const total = c.checkRunCount + c.statusContextCount;
  if (total === 0) return null;
  const runs = (c.checkRunCountsByState ?? []).filter((s) => PASSING_CHECK_RUNS.has(s.state)).reduce((n, s) => n + s.count, 0);
  const statuses = (c.statusContextCountsByState ?? []).find((s) => s.state === 'SUCCESS')?.count ?? 0;
  return { passed: runs + statuses, total };
}

function toItem(n: SearchNode, host: string): SearchItem | null {
  if (n.__typename !== 'PullRequest' || !n.repository || n.number === undefined) return null;
  const ref = { host, owner: n.repository.owner.login, repo: n.repository.name, number: n.number };
  const rollupNode = n.commits?.nodes[0]?.commit.statusCheckRollup;
  const rollup = rollupNode?.state;
  const checks = rollup === 'SUCCESS' ? 'success' : rollup === 'FAILURE' || rollup === 'ERROR' ? 'failure' : rollup ? 'pending' : null;
  return {
    key: prKey(ref),
    ref,
    title: n.title ?? '',
    author: n.author?.login ?? 'ghost',
    authorAvatarUrl: n.author?.avatarUrl || null,
    isDraft: n.isDraft ?? false,
    state: n.state ?? 'OPEN',
    createdAt: n.createdAt ?? '',
    updatedAt: n.updatedAt ?? '',
    labels: n.labels?.nodes ?? [],
    reviewDecision: n.reviewDecision ?? null,
    checks,
    checkCounts: checkCounts(rollupNode?.contexts),
    comments: (n.comments?.totalCount ?? 0) + (n.reviewThreads?.totalCount ?? 0),
    additions: n.additions ?? 0,
    deletions: n.deletions ?? 0,
  };
}

/** Ensures the query only returns pull requests, like the github.com PR list does. */
export function normalizeQuery(query: string): string {
  const q = query.trim();
  return /\b(is|type):(pr|pull-request)\b/.test(q) ? q : `is:pr ${q}`.trim();
}

export async function searchPrs(client: GitHubClient, host: string, query: string, after?: string, first = 30): Promise<SearchPage> {
  const data = await client.graphql<SearchResponse>(SEARCH_PRS, { q: normalizeQuery(query), first, after: after ?? null });
  return {
    items: data.search.nodes.map((n) => toItem(n, host)).filter((i): i is SearchItem => i !== null),
    total: data.search.issueCount,
    endCursor: data.search.pageInfo.endCursor,
    hasNextPage: data.search.pageInfo.hasNextPage,
  };
}

const INBOX: { id: InboxSection['id']; title: string; query: string; first: number }[] = [
  { id: 'review-requested', title: 'Waiting for your review', query: 'is:pr is:open review-requested:@me archived:false sort:updated-desc', first: 20 },
  { id: 'recent', title: 'Recently reviewed', query: 'is:pr is:open reviewed-by:@me -author:@me archived:false sort:updated-desc', first: 10 },
  // Last, and one page at a time: your own open PRs can be a long list.
  { id: 'mine', title: 'Your pull requests', query: 'is:pr is:open author:@me archived:false sort:updated-desc', first: 10 },
];

export async function inbox(client: GitHubClient, host: string): Promise<InboxSection[]> {
  const pages = await Promise.all(INBOX.map((s) => searchPrs(client, host, s.query, undefined, s.first)));
  return INBOX.map((s, i) => ({ id: s.id, title: s.title, query: s.query, items: pages[i]!.items, total: pages[i]!.total, endCursor: pages[i]!.endCursor, hasNextPage: pages[i]!.hasNextPage }));
}
