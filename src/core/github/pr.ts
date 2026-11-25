import type { CheckRun, ConversationItem, PrDetails, PrRef, PrSummary, ReviewerState, ViewedState } from '../../shared/model';
import type { GitHubClient } from './client';
import { toReactions } from './reactions';
import {
  CONVERSATION,
  PR_DETAILS,
  PR_FILES_VIEWED,
  REVIEW_THREADS,
  VIEWER,
  VIEWER_REVIEWS,
  type CheckContextNode,
  type ConversationResponse,
  type PrDetailsResponse,
  type PrFilesViewedResponse,
  type ReviewThreadNode,
  type ReviewThreadsResponse,
  type ViewerResponse,
  type ViewerReviewsResponse,
  PR_SUMMARY,
  type PrSummaryResponse,
} from './queries';

const vars = (ref: PrRef) => ({ owner: ref.owner, repo: ref.repo, pr: ref.number });

export async function fetchPrSummary(client: GitHubClient, ref: PrRef): Promise<PrSummary | null> {
  const pr = (await client.graphql<PrSummaryResponse>(PR_SUMMARY, vars(ref))).repository?.pullRequest;
  if (!pr) return null;
  return { title: pr.title, author: pr.author?.login ?? 'ghost', authorAvatarUrl: pr.author?.avatarUrl ?? null, state: pr.state, isDraft: pr.isDraft };
}

export async function fetchViewer(client: GitHubClient): Promise<string> {
  return (await client.graphql<ViewerResponse>(VIEWER)).viewer.login;
}

function checkFromContext(c: CheckContextNode): CheckRun | null {
  if (c.__typename === 'CheckRun' && 'name' in c) {
    const state: CheckRun['state'] =
      c.status !== 'COMPLETED'
        ? 'pending'
        : c.conclusion === 'SUCCESS'
          ? 'success'
          : c.conclusion === 'NEUTRAL' || c.conclusion === 'SKIPPED'
            ? 'neutral'
            : 'failure';
    return { name: c.name, state, url: c.detailsUrl };
  }
  if (c.__typename === 'StatusContext' && 'context' in c) {
    const state: CheckRun['state'] = c.state === 'SUCCESS' ? 'success' : c.state === 'PENDING' || c.state === 'EXPECTED' ? 'pending' : 'failure';
    return { name: c.context, state, url: c.targetUrl };
  }
  return null;
}

export function workItemsFrom(body: string): string[] {
  return [...new Set(body.match(/\bAB#\d+\b/g) ?? [])];
}

export async function fetchDetails(client: GitHubClient, ref: PrRef): Promise<PrDetails> {
  const data = await client.graphql<PrDetailsResponse>(PR_DETAILS, vars(ref));
  const pr = data.repository?.pullRequest;
  if (!pr) throw new Error(`Pull request ${ref.owner}/${ref.repo}#${ref.number} not found (or no access).`);

  const reviewers = new Map<string, ReviewerState>();
  for (const r of pr.latestOpinionatedReviews.nodes) {
    if (!r.author) continue;
    reviewers.set(r.author.login, {
      login: r.author.login,
      avatarUrl: r.author.avatarUrl,
      state: r.state as ReviewerState['state'],
      submittedAt: r.submittedAt,
    });
  }
  for (const n of pr.reviewRequests.nodes) {
    const rr = n.requestedReviewer;
    if (!rr) continue;
    if (rr.__typename === 'User' && 'login' in rr) {
      reviewers.set(rr.login, { login: rr.login, avatarUrl: rr.avatarUrl, state: 'REQUESTED', submittedAt: reviewers.get(rr.login)?.submittedAt ?? null });
    } else if (rr.__typename === 'Team' && 'slug' in rr) {
      reviewers.set(`team:${rr.slug}`, { login: `@${rr.slug}`, avatarUrl: null, state: 'REQUESTED', submittedAt: null });
    }
  }

  const rollup = pr.lastCommit.nodes[0]?.commit.statusCheckRollup;
  const checks = (rollup?.contexts.nodes ?? []).map(checkFromContext).filter((c): c is CheckRun => c !== null);

  return {
    id: pr.id,
    number: pr.number,
    title: pr.title,
    url: pr.url,
    state: pr.state,
    isDraft: pr.isDraft,
    author: pr.author?.login ?? 'ghost',
    authorAvatarUrl: pr.author?.avatarUrl ?? null,
    bodyHTML: pr.bodyHTML,
    body: pr.body,
    createdAt: pr.createdAt,
    updatedAt: pr.updatedAt,
    baseRefName: pr.baseRefName,
    baseRefOid: pr.baseRefOid,
    headRefName: pr.headRefName,
    headRefOid: pr.headRefOid,
    headRepoOwner: pr.headRepositoryOwner?.login ?? null,
    isCrossRepository: pr.isCrossRepository,
    maintainerCanModify: pr.maintainerCanModify,
    viewerDidAuthor: pr.viewerDidAuthor,
    reviewDecision: pr.reviewDecision,
    mergeable: pr.mergeable,
    mergeStateStatus: pr.mergeStateStatus,
    additions: pr.additions,
    deletions: pr.deletions,
    changedFiles: pr.changedFiles,
    commitCount: pr.commits.totalCount,
    labels: pr.labels.nodes,
    reviewers: [...reviewers.values()],
    checks,
    linkedIssues: pr.closingIssuesReferences.nodes,
    workItems: workItemsFrom(pr.body),
  };
}

export async function fetchThreads(client: GitHubClient, ref: PrRef): Promise<ReviewThreadNode[]> {
  const result: ReviewThreadNode[] = [];
  let after: string | null = null;
  for (let page = 0; page < 40; page++) {
    const data: ReviewThreadsResponse = await client.graphql<ReviewThreadsResponse>(REVIEW_THREADS, { ...vars(ref), after });
    const threads = data.repository?.pullRequest?.reviewThreads;
    if (!threads) break;
    result.push(...threads.nodes.filter((t) => t.comments.nodes.length > 0));
    if (!threads.pageInfo.hasNextPage || !threads.pageInfo.endCursor) break;
    after = threads.pageInfo.endCursor;
  }
  return result;
}

export async function fetchViewedStates(client: GitHubClient, ref: PrRef): Promise<Map<string, ViewedState>> {
  const map = new Map<string, ViewedState>();
  let after: string | null = null;
  for (let page = 0; page < 40; page++) {
    const data: PrFilesViewedResponse = await client.graphql<PrFilesViewedResponse>(PR_FILES_VIEWED, { ...vars(ref), after });
    const files = data.repository?.pullRequest?.files;
    if (!files) break;
    for (const f of files.nodes) map.set(f.path, f.viewerViewedState);
    if (!files.pageInfo.hasNextPage || !files.pageInfo.endCursor) break;
    after = files.pageInfo.endCursor;
  }
  return map;
}

export interface ViewerReviews {
  pending: { id: string; commentCount: number } | null;
  lastReviewedOid: string | null;
}

export async function fetchViewerReviews(client: GitHubClient, ref: PrRef, viewer: string): Promise<ViewerReviews> {
  const data = await client.graphql<ViewerReviewsResponse>(VIEWER_REVIEWS, { ...vars(ref), author: viewer });
  const pr = data.repository?.pullRequest;
  const pending = pr?.pending.nodes[0];
  return {
    pending: pending ? { id: pending.id, commentCount: pending.comments.totalCount } : null,
    lastReviewedOid: pr?.last.nodes[0]?.commit?.oid ?? null,
  };
}

export interface ConversationData {
  items: ConversationItem[];
  forcePushes: { sha: string; at: string; forcePush: boolean }[];
}

export async function fetchConversation(client: GitHubClient, ref: PrRef): Promise<ConversationData> {
  const data = await client.graphql<ConversationResponse>(CONVERSATION, vars(ref));
  const pr = data.repository?.pullRequest;
  if (!pr) return { items: [], forcePushes: [] };
  const items: ConversationItem[] = [];
  for (const c of pr.comments.nodes) {
    items.push({
      id: c.id,
      kind: 'comment',
      author: c.author?.login ?? 'ghost',
      avatarUrl: c.author?.avatarUrl ?? null,
      createdAt: c.createdAt,
      bodyHTML: c.bodyHTML,
      ...(c.body !== undefined ? { body: c.body } : {}),
      viewerCanUpdate: c.viewerCanUpdate ?? false,
      reactions: toReactions(c.reactionGroups),
    });
  }
  for (const r of pr.reviews.nodes) {
    if (r.state === 'PENDING') continue;
    if (r.state === 'COMMENTED' && r.body.trim() === '') continue;
    items.push({
      id: r.id,
      kind: 'review',
      author: r.author?.login ?? 'ghost',
      avatarUrl: r.author?.avatarUrl ?? null,
      createdAt: r.submittedAt ?? r.createdAt,
      bodyHTML: r.bodyHTML,
      reviewState: r.state as ReviewerState['state'],
      body: r.body,
      viewerCanUpdate: r.viewerCanUpdate ?? false,
      reactions: toReactions(r.reactionGroups),
    });
  }
  const forcePushes: ConversationData['forcePushes'] = [];
  for (const t of pr.timelineItems.nodes) {
    if (t.__typename !== 'HeadRefForcePushedEvent' || !t.createdAt) continue;
    items.push({
      id: t.id ?? `fp-${t.createdAt}`,
      kind: 'event',
      author: t.actor?.login ?? 'someone',
      avatarUrl: t.actor?.avatarUrl ?? null,
      createdAt: t.createdAt,
      bodyHTML: '',
      text: `force-pushed ${t.beforeCommit?.oid.slice(0, 7) ?? '?'} → ${t.afterCommit?.oid.slice(0, 7) ?? '?'}`,
    });
    if (t.beforeCommit) forcePushes.push({ sha: t.beforeCommit.oid, at: t.beforeCommit.committedDate, forcePush: false });
    if (t.afterCommit) forcePushes.push({ sha: t.afterCommit.oid, at: t.createdAt, forcePush: true });
  }
  items.sort((a, b) => a.createdAt.localeCompare(b.createdAt));
  return { items, forcePushes };
}
