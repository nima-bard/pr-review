import type { Draft, EditableKind, ReviewEvent } from '../../shared/model';
import type { DraftStore } from '../store/drafts';
import { GitHubError, type GitHubClient } from './client';
import {
  ADD_COMMENT,
  ADD_REPLY,
  ADD_REVIEW,
  ADD_REVIEW_THREAD,
  MARK_FILE_VIEWED,
  REQUEST_REVIEWS,
  RESOLVE_THREAD,
  SUBMIT_REVIEW,
  UNMARK_FILE_VIEWED,
  UNRESOLVE_THREAD,
  UPDATE_ISSUE_COMMENT,
  UPDATE_REVIEW,
  UPDATE_REVIEW_COMMENT,
  type UpdateCommentResponse,
  type AddReviewResponse,
  type AddThreadResponse,
  type ResolvedThread,
} from './queries';

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

export function threadInput(reviewId: string, d: Draft): Record<string, unknown> {
  if (d.subject === 'file') return { reviewId, path: d.path, body: d.body, subjectType: 'FILE' };
  const input: Record<string, unknown> = { reviewId, path: d.path, body: d.body, line: d.line, side: d.side };
  if (d.startLine !== undefined && d.startLine !== d.line) {
    input.startLine = d.startLine;
    input.startSide = d.side;
  }
  return input;
}

export interface SubmitArgs {
  client: GitHubClient;
  drafts: DraftStore;
  prKey: string;
  pullRequestId: string;
  headOid: string;
  pendingReviewId: string | null;
  event: ReviewEvent;
  body: string;
  spacingMs?: number;
}

/**
 * Adopts the viewer's pending review (or creates one), posts every unposted draft (yours and the ones an agent wrote),
 * then submits. Resumable.
 */
export async function submitReview(args: SubmitArgs): Promise<void> {
  const { client, drafts } = args;
  let reviewId = args.pendingReviewId;
  if (!reviewId) {
    const created = await client.graphql<AddReviewResponse>(ADD_REVIEW, { prId: args.pullRequestId, commitOID: args.headOid });
    reviewId = created.addPullRequestReview.pullRequestReview.id;
  }
  for (const d of await drafts.list(args.prKey)) {
    if (d.postedThreadId) continue;
    const res = await client.graphql<AddThreadResponse>(ADD_REVIEW_THREAD, threadInput(reviewId, d));
    const threadId = res.addPullRequestReviewThread.thread?.id;
    if (!threadId) throw new Error(`GitHub rejected the comment on ${d.path}:${d.line}.`);
    await drafts.markPosted(args.prKey, d.id, threadId);
    await sleep(args.spacingMs ?? 1000);
  }
  await client.graphql(SUBMIT_REVIEW, { reviewId, event: args.event, body: args.body });
  await drafts.clear(args.prKey);
}

export async function reply(client: GitHubClient, threadId: string, body: string): Promise<'SUBMITTED' | 'PENDING'> {
  const res = await client.graphql<{ addPullRequestReviewThreadReply: { comment: { state: 'SUBMITTED' | 'PENDING' } } }>(ADD_REPLY, { threadId, body });
  return res.addPullRequestReviewThreadReply.comment.state;
}

/** Edits a review-thread comment, PR comment or review summary; returns GitHub's rendered HTML. */
export async function editComment(client: GitHubClient, kind: EditableKind, id: string, body: string): Promise<string> {
  const mutation = kind === 'thread' ? UPDATE_REVIEW_COMMENT : kind === 'comment' ? UPDATE_ISSUE_COMMENT : UPDATE_REVIEW;
  const data = await client.graphql<UpdateCommentResponse>(mutation, { id, body });
  const html = data.updatePullRequestReviewComment?.pullRequestReviewComment.bodyHTML ?? data.updateIssueComment?.issueComment.bodyHTML ?? data.updatePullRequestReview?.pullRequestReview.bodyHTML;
  if (html === undefined) throw new Error('GitHub did not return the edited comment.');
  return html;
}

/** Resolves or unresolves a thread and returns its new state, with what the viewer may do with it now. */
export async function setResolved(client: GitHubClient, threadId: string, resolved: boolean): Promise<ResolvedThread> {
  type Response = Record<'resolveReviewThread' | 'unresolveReviewThread', { thread: ResolvedThread } | undefined>;
  const data = await client.graphql<Response>(resolved ? RESOLVE_THREAD : UNRESOLVE_THREAD, { threadId });
  const thread = (resolved ? data.resolveReviewThread : data.unresolveReviewThread)?.thread;
  if (!thread) throw new Error('GitHub did not return the conversation.');
  return thread;
}

/** GitHub's passing failures (a 5xx, “Something went wrong”, a dropped connection): worth trying again shortly. */
export function transientGitHubError(err: unknown): boolean {
  if (err instanceof GitHubError && err.status !== undefined && err.status >= 500) return true;
  return err instanceof Error && /Something went wrong|HTTP 5\d\d|timed? ?out|ECONNRESET|ETIMEDOUT|socket hang up/i.test(err.message);
}

/** A file GitHub didn't mark, and why. */
export interface ViewedFailure {
  path: string;
  error: string;
}

/**
 * Ticks (or unticks) each file's Viewed checkbox, one call per file as GitHub requires. A passing failure is tried
 * again twice, a little later each time; a file that still fails is skipped, so one refusal doesn't stop the rest.
 * Returns the files GitHub refused.
 */
export async function setViewed(client: GitHubClient, prId: string, paths: readonly string[], viewed: boolean, wait = (ms: number) => new Promise((r) => setTimeout(r, ms))): Promise<ViewedFailure[]> {
  const failed: ViewedFailure[] = [];
  for (const path of paths) {
    for (let attempt = 0; ; attempt++) {
      try {
        await client.graphql(viewed ? MARK_FILE_VIEWED : UNMARK_FILE_VIEWED, { prId, path });
        break;
      } catch (err) {
        if (attempt < 2 && transientGitHubError(err)) {
          await wait(1000 * 3 ** attempt);
          continue;
        }
        failed.push({ path, error: err instanceof Error ? err.message : String(err) });
        break;
      }
    }
  }
  return failed;
}

export async function addPrComment(client: GitHubClient, prId: string, body: string): Promise<void> {
  await client.graphql(ADD_COMMENT, { subjectId: prId, body });
}

export async function requestReviews(client: GitHubClient, prId: string, logins: readonly string[]): Promise<void> {
  await client.graphql(REQUEST_REVIEWS, { prId, logins });
}
