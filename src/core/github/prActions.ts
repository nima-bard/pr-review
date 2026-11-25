import type { CommitMessage, MergeInfo, MergeInput, MergeMethod, PrRef, ReviewerCandidate, ReviewerOptions } from '../../shared/model';
import type { GitHubClient } from './client';
import { canWrite, checkFromContext } from './pr';
import type { CheckContextNode } from './queries';

const vars = (ref: PrRef) => ({ owner: ref.owner, repo: ref.repo, pr: ref.number });

const MERGE_INFO = /* GraphQL */ `
  query ($owner: String!, $repo: String!, $pr: Int!) {
    repository(owner: $owner, name: $repo) {
      mergeCommitAllowed
      squashMergeAllowed
      rebaseMergeAllowed
      autoMergeAllowed
      deleteBranchOnMerge
      viewerDefaultMergeMethod
      viewerDefaultCommitEmail
      viewerPermission
      pullRequest(number: $pr) {
        state
        isDraft
        headRefOid
        headRefName
        baseRefName
        mergeable
        mergeStateStatus
        reviewDecision
        isMergeQueueEnabled
        isInMergeQueue
        viewerCanMergeAsAdmin
        viewerCanEnableAutoMerge
        viewerCanDisableAutoMerge
        viewerCanUpdateBranch
        isCrossRepository
        autoMergeRequest {
          mergeMethod
          enabledBy {
            login
          }
        }
        mergeHeadline: viewerMergeHeadlineText(mergeType: MERGE)
        mergeBody: viewerMergeBodyText(mergeType: MERGE)
        squashHeadline: viewerMergeHeadlineText(mergeType: SQUASH)
        squashBody: viewerMergeBodyText(mergeType: SQUASH)
        commits(last: 1) {
          nodes {
            commit {
              statusCheckRollup {
                contexts(first: 100) {
                  nodes {
                    __typename
                    ... on CheckRun {
                      name
                      conclusion
                      status
                      detailsUrl
                      isRequired(pullRequestNumber: $pr)
                    }
                    ... on StatusContext {
                      context
                      state
                      targetUrl
                      isRequired(pullRequestNumber: $pr)
                    }
                  }
                }
              }
            }
          }
        }
      }
    }
  }
`;

interface MergeInfoResponse {
  repository: {
    mergeCommitAllowed: boolean;
    squashMergeAllowed: boolean;
    rebaseMergeAllowed: boolean;
    autoMergeAllowed: boolean;
    deleteBranchOnMerge: boolean;
    viewerDefaultMergeMethod: MergeMethod;
    viewerDefaultCommitEmail: string | null;
    viewerPermission: string | null;
    pullRequest: {
      state: MergeInfo['state'];
      isDraft: boolean;
      headRefOid: string;
      headRefName: string;
      baseRefName: string;
      mergeable: MergeInfo['mergeable'];
      mergeStateStatus: string;
      reviewDecision: MergeInfo['reviewDecision'];
      isMergeQueueEnabled: boolean;
      isInMergeQueue: boolean;
      viewerCanMergeAsAdmin: boolean;
      viewerCanEnableAutoMerge: boolean;
      viewerCanDisableAutoMerge: boolean;
      viewerCanUpdateBranch: boolean;
      isCrossRepository: boolean;
      autoMergeRequest: { mergeMethod: MergeMethod; enabledBy: { login: string } | null } | null;
      mergeHeadline: string;
      mergeBody: string;
      squashHeadline: string;
      squashBody: string;
      commits: { nodes: { commit: { statusCheckRollup: { contexts: { nodes: CheckContextNode[] } } | null } }[] };
    } | null;
  } | null;
}

export async function fetchMergeInfo(client: GitHubClient, ref: PrRef): Promise<MergeInfo> {
  const repo = (await client.graphql<MergeInfoResponse>(MERGE_INFO, vars(ref))).repository;
  const pr = repo?.pullRequest;
  if (!repo || !pr) throw new Error(`Pull request ${ref.owner}/${ref.repo}#${ref.number} not found (or no access).`);
  const methods = (
    [
      ['MERGE', repo.mergeCommitAllowed],
      ['SQUASH', repo.squashMergeAllowed],
      ['REBASE', repo.rebaseMergeAllowed],
    ] as const
  ).flatMap(([m, allowed]) => (allowed ? [m] : []));
  const contexts = pr.commits.nodes[0]?.commit.statusCheckRollup?.contexts.nodes ?? [];
  return {
    state: pr.state,
    isDraft: pr.isDraft,
    headRefOid: pr.headRefOid,
    headRefName: pr.headRefName,
    baseRefName: pr.baseRefName,
    methods,
    defaultMethod: methods.includes(repo.viewerDefaultMergeMethod) ? repo.viewerDefaultMergeMethod : (methods[0] ?? 'MERGE'),
    messages: { MERGE: { headline: pr.mergeHeadline, body: pr.mergeBody }, SQUASH: { headline: pr.squashHeadline, body: pr.squashBody } },
    authorEmail: repo.viewerDefaultCommitEmail,
    mergeable: pr.mergeable,
    mergeStateStatus: pr.mergeStateStatus,
    reviewDecision: pr.reviewDecision,
    checks: contexts.flatMap((c) => {
      const check = checkFromContext(c);
      return check ? [{ ...check, required: c.isRequired === true }] : [];
    }),
    canMerge: canWrite(repo.viewerPermission),
    canBypass: pr.viewerCanMergeAsAdmin,
    autoMerge: {
      available: repo.autoMergeAllowed && pr.viewerCanEnableAutoMerge,
      enabled: pr.autoMergeRequest ? { method: pr.autoMergeRequest.mergeMethod, by: pr.autoMergeRequest.enabledBy?.login ?? null } : null,
      canDisable: pr.viewerCanDisableAutoMerge,
    },
    mergeQueue: { enabled: pr.isMergeQueueEnabled, queued: pr.isInMergeQueue },
    canUpdateBranch: pr.viewerCanUpdateBranch,
    // GitHub only says the viewer may delete the branch once it's merged: before, it's write access to the repository the branch is in.
    deleteBranch: repo.deleteBranchOnMerge ? 'automatic' : !pr.isCrossRepository && canWrite(repo.viewerPermission) ? 'optional' : 'no',
  };
}

const MERGE = /* GraphQL */ `
  mutation ($id: ID!, $method: PullRequestMergeMethod!, $headline: String, $body: String, $head: GitObjectID!) {
    mergePullRequest(input: { pullRequestId: $id, mergeMethod: $method, commitHeadline: $headline, commitBody: $body, expectedHeadOid: $head }) {
      clientMutationId
    }
  }
`;

const ENABLE_AUTO_MERGE = /* GraphQL */ `
  mutation ($id: ID!, $method: PullRequestMergeMethod!, $headline: String, $body: String, $head: GitObjectID!) {
    enablePullRequestAutoMerge(input: { pullRequestId: $id, mergeMethod: $method, commitHeadline: $headline, commitBody: $body, expectedHeadOid: $head }) {
      clientMutationId
    }
  }
`;

const ENQUEUE = /* GraphQL */ `
  mutation ($id: ID!, $head: GitObjectID!) {
    enqueuePullRequest(input: { pullRequestId: $id, expectedHeadOid: $head }) {
      clientMutationId
    }
  }
`;

/**
 * Merges the pull request, turns on auto-merge or adds it to the merge queue. `head` is the commit the viewer reviewed:
 * GitHub refuses if the branch has moved on since.
 */
export async function mergePullRequest(client: GitHubClient, prId: string, head: string, input: MergeInput): Promise<void> {
  const message: Partial<CommitMessage> = input.method === 'REBASE' || !input.message ? {} : input.message;
  const variables = { id: prId, head, method: input.method, headline: message.headline ?? null, body: message.body ?? null };
  if (input.action === 'queue') await client.graphql(ENQUEUE, { id: prId, head });
  else await client.graphql(input.action === 'auto-merge' ? ENABLE_AUTO_MERGE : MERGE, variables);
}

export async function disableAutoMerge(client: GitHubClient, prId: string): Promise<void> {
  await client.graphql(`mutation ($id: ID!) { disablePullRequestAutoMerge(input: { pullRequestId: $id }) { clientMutationId } }`, { id: prId });
}

/** Brings the head branch up to date with the base branch, with a merge commit or by rebasing. */
export async function updateBranch(client: GitHubClient, prId: string, head: string, method: 'MERGE' | 'REBASE'): Promise<void> {
  await client.graphql(
    `mutation ($id: ID!, $head: GitObjectID!, $method: PullRequestBranchUpdateMethod) {
      updatePullRequestBranch(input: { pullRequestId: $id, expectedHeadOid: $head, updateMethod: $method }) { clientMutationId }
    }`,
    { id: prId, head, method },
  );
}

/** Deletes the pull request's head branch on GitHub (after merging). */
export async function deleteHeadBranch(client: GitHubClient, ref: PrRef): Promise<void> {
  const data = await client.graphql<{ repository: { pullRequest: { headRef: { id: string } | null } | null } | null }>(
    `query ($owner: String!, $repo: String!, $pr: Int!) { repository(owner: $owner, name: $repo) { pullRequest(number: $pr) { headRef { id } } } }`,
    vars(ref),
  );
  const id = data.repository?.pullRequest?.headRef?.id;
  if (id) await client.graphql(`mutation ($id: ID!) { deleteRef(input: { refId: $id }) { clientMutationId } }`, { id });
}

export async function setPullRequestOpen(client: GitHubClient, prId: string, open: boolean): Promise<void> {
  const mutation = open ? 'reopenPullRequest' : 'closePullRequest';
  await client.graphql(`mutation ($id: ID!) { ${mutation}(input: { pullRequestId: $id }) { clientMutationId } }`, { id: prId });
}

/** Marks the pull request as a draft, or as ready for review. */
export async function setPullRequestDraft(client: GitHubClient, prId: string, draft: boolean): Promise<void> {
  const mutation = draft ? 'convertPullRequestToDraft' : 'markPullRequestReadyForReview';
  await client.graphql(`mutation ($id: ID!) { ${mutation}(input: { pullRequestId: $id }) { clientMutationId } }`, { id: prId });
}

const REVIEWER_OPTIONS = /* GraphQL */ `
  query ($owner: String!, $repo: String!, $pr: Int!, $q: String) {
    repository(owner: $owner, name: $repo) {
      pullRequest(number: $pr) {
        author {
          login
        }
        suggestedReviewers {
          isAuthor
          isCommenter
          reviewer {
            login
            name
            avatarUrl
          }
        }
        reviewRequests(first: 100) {
          nodes {
            requestedReviewer {
              __typename
              ... on User {
                login
                name
                avatarUrl
              }
              ... on Team {
                slug
                name
                avatarUrl
                organization {
                  login
                }
              }
            }
          }
        }
      }
      assignableUsers(first: 100, query: $q) {
        nodes {
          login
          name
          avatarUrl
        }
      }
    }
  }
`;

const TEAMS = /* GraphQL */ `
  query ($owner: String!, $q: String) {
    organization(login: $owner) {
      teams(first: 100, query: $q) {
        nodes {
          slug
          name
          avatarUrl
        }
      }
    }
  }
`;

interface Person {
  login: string;
  name: string | null;
  avatarUrl: string | null;
}

type Requested = ({ __typename: 'User' } & Person) | { __typename: 'Team'; slug: string; name: string; avatarUrl: string | null; organization: { login: string } } | { __typename: string };

interface ReviewerOptionsResponse {
  repository: {
    pullRequest: {
      author: { login: string } | null;
      suggestedReviewers: { isAuthor: boolean; isCommenter: boolean; reviewer: Person }[];
      reviewRequests: { nodes: { requestedReviewer: Requested | null }[] };
    } | null;
    assignableUsers: { nodes: Person[] };
  } | null;
}

const user = (p: Person, reason: string | null = null): ReviewerCandidate => ({ id: p.login, kind: 'user', name: p.name || null, avatarUrl: p.avatarUrl, reason });

/**
 * Who can be asked to review, the way github.com's reviewer picker lists them: GitHub's suggestions (people who
 * recently edited these files or commented), everyone else with access (matching `query`), and the organization's
 * teams. The author can't review their own pull request, so they're left out.
 */
export async function fetchReviewerOptions(client: GitHubClient, ref: PrRef, query: string): Promise<ReviewerOptions> {
  const q = query.trim() || null;
  const [data, teams] = await Promise.all([
    client.graphql<ReviewerOptionsResponse>(REVIEWER_OPTIONS, { ...vars(ref), q }),
    // Only organizations have teams: for a personal repository this fails, and there are none.
    client.graphql<{ organization: { teams: { nodes: { slug: string; name: string; avatarUrl: string | null }[] } } | null }>(TEAMS, { owner: ref.owner, q }).catch(() => null),
  ]);
  const pr = data.repository?.pullRequest;
  if (!data.repository || !pr) throw new Error(`Pull request ${ref.owner}/${ref.repo}#${ref.number} not found (or no access).`);
  const author = pr.author?.login;
  const requested: string[] = [];
  const requestedUsers: ReviewerCandidate[] = [];
  const requestedTeams: ReviewerCandidate[] = [];
  for (const { requestedReviewer: r } of pr.reviewRequests.nodes) {
    if (r && r.__typename === 'User' && 'login' in r) {
      requested.push(r.login);
      requestedUsers.push(user(r));
    } else if (r && r.__typename === 'Team' && 'slug' in r) {
      const id = `${r.organization.login}/${r.slug}`;
      requested.push(id);
      requestedTeams.push({ id, kind: 'team', name: r.name, avatarUrl: r.avatarUrl, reason: null });
    }
  }
  const suggestions = pr.suggestedReviewers
    .filter((s) => s.reviewer.login !== author)
    .map((s) => user(s.reviewer, s.isAuthor ? 'Recently edited these files' : s.isCommenter ? 'Commented on this pull request' : null));
  const seen = new Set(suggestions.map((s) => s.id));
  const users = [...requestedUsers, ...data.repository.assignableUsers.nodes.map((p) => user(p))].filter((u) => u.id !== author && !seen.has(u.id) && (seen.add(u.id), true));
  const teamList = [...requestedTeams, ...(teams?.organization?.teams.nodes ?? []).map((t): ReviewerCandidate => ({ id: `${ref.owner}/${t.slug}`, kind: 'team', name: t.name, avatarUrl: t.avatarUrl, reason: null }))].filter(
    (t) => !seen.has(t.id) && (seen.add(t.id), true),
  );
  return { suggestions, users, teams: teamList, requested };
}

/** Requests reviews from `add` and withdraws the requests to `remove` (user logins, or teams as "org/slug"). */
export async function changeReviewRequests(client: GitHubClient, ref: PrRef, prId: string, add: readonly string[], remove: readonly string[]): Promise<void> {
  const split = (ids: readonly string[]) => ({ users: ids.filter((i) => !i.includes('/')), teams: ids.filter((i) => i.includes('/')) });
  const adding = split(add);
  if (add.length > 0) {
    await client.graphql(
      `mutation ($id: ID!, $users: [String!], $teams: [String!]) {
        requestReviewsByLogin(input: { pullRequestId: $id, userLogins: $users, teamSlugs: $teams, union: true }) { clientMutationId }
      }`,
      { id: prId, users: adding.users, teams: adding.teams },
    );
  }
  const removing = split(remove);
  if (remove.length > 0) {
    await client.rest('DELETE', `/repos/${ref.owner}/${ref.repo}/pulls/${ref.number}/requested_reviewers`, {
      reviewers: removing.users,
      team_reviewers: removing.teams.map((t) => t.split('/')[1]),
    });
  }
}
