export const VIEWER = /* GraphQL */ `
  query {
    viewer {
      login
    }
  }
`;

export interface ViewerResponse {
  viewer: { login: string };
}

export const PR_SUMMARY = /* GraphQL */ `
  query ($owner: String!, $repo: String!, $pr: Int!) {
    repository(owner: $owner, name: $repo) {
      pullRequest(number: $pr) {
        title
        state
        isDraft
        author {
          login
          avatarUrl
        }
      }
    }
  }
`;

export interface PrSummaryResponse {
  repository: { pullRequest: { title: string; state: 'OPEN' | 'CLOSED' | 'MERGED'; isDraft: boolean; author: { login: string; avatarUrl: string } | null } | null } | null;
}

export const PR_DETAILS = /* GraphQL */ `
  query ($owner: String!, $repo: String!, $pr: Int!) {
    repository(owner: $owner, name: $repo) {
      viewerPermission
      pullRequest(number: $pr) {
        id
        number
        title
        url
        state
        isDraft
        mergedAt
        mergedBy {
          login
        }
        viewerCanClose
        viewerCanReopen
        viewerCanUpdate
        createdAt
        updatedAt
        body
        bodyHTML
        author {
          login
          avatarUrl
        }
        baseRefName
        baseRefOid
        headRefName
        headRefOid
        headRepositoryOwner {
          login
        }
        isCrossRepository
        maintainerCanModify
        viewerDidAuthor
        reviewDecision
        mergeable
        mergeStateStatus
        additions
        deletions
        changedFiles
        commits {
          totalCount
        }
        labels(first: 20) {
          nodes {
            name
            color
          }
        }
        latestOpinionatedReviews(first: 30) {
          nodes {
            state
            submittedAt
            author {
              login
              avatarUrl
            }
          }
        }
        reviewRequests(first: 30) {
          nodes {
            requestedReviewer {
              __typename
              ... on User {
                login
                avatarUrl
              }
              ... on Team {
                slug
              }
            }
          }
        }
        closingIssuesReferences(first: 10) {
          nodes {
            number
            title
            url
          }
        }
        lastCommit: commits(last: 1) {
          nodes {
            commit {
              statusCheckRollup {
                state
                contexts(first: 50) {
                  nodes {
                    __typename
                    ... on CheckRun {
                      name
                      conclusion
                      status
                      detailsUrl
                    }
                    ... on StatusContext {
                      context
                      state
                      targetUrl
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

export interface Actor {
  login: string;
  avatarUrl: string;
}

export type CheckContextNode =
  | { __typename: 'CheckRun'; name: string; conclusion: string | null; status: string; detailsUrl: string | null; isRequired?: boolean }
  | { __typename: 'StatusContext'; context: string; state: string; targetUrl: string | null; isRequired?: boolean };

export interface PrDetailsNode {
  id: string;
  number: number;
  title: string;
  url: string;
  state: 'OPEN' | 'CLOSED' | 'MERGED';
  isDraft: boolean;
  mergedAt: string | null;
  mergedBy: { login: string } | null;
  viewerCanClose?: boolean;
  viewerCanReopen?: boolean;
  viewerCanUpdate?: boolean;
  createdAt: string;
  updatedAt: string;
  body: string;
  bodyHTML: string;
  author: Actor | null;
  baseRefName: string;
  baseRefOid: string;
  headRefName: string;
  headRefOid: string;
  headRepositoryOwner: { login: string } | null;
  isCrossRepository: boolean;
  maintainerCanModify: boolean;
  viewerDidAuthor: boolean;
  reviewDecision: 'APPROVED' | 'CHANGES_REQUESTED' | 'REVIEW_REQUIRED' | null;
  mergeable: 'MERGEABLE' | 'CONFLICTING' | 'UNKNOWN';
  mergeStateStatus: string;
  additions: number;
  deletions: number;
  changedFiles: number;
  commits: { totalCount: number };
  labels: { nodes: { name: string; color: string }[] };
  latestOpinionatedReviews: { nodes: { state: string; submittedAt: string | null; author: Actor | null }[] };
  reviewRequests: {
    nodes: { requestedReviewer: { __typename: 'User'; login: string; avatarUrl: string } | { __typename: 'Team'; slug: string } | { __typename: string } | null }[];
  };
  closingIssuesReferences: { nodes: { number: number; title: string; url: string }[] };
  lastCommit: { nodes: { commit: { statusCheckRollup: { state: string; contexts: { nodes: CheckContextNode[] } } | null } }[] };
}

export interface PrDetailsResponse {
  repository: { viewerPermission?: string | null; pullRequest: PrDetailsNode | null } | null;
}

const REACTION_FIELDS = /* GraphQL */ `
  reactionGroups {
    content
    viewerHasReacted
    reactors {
      totalCount
    }
  }
`;

export interface ReactionGroupNode {
  content: string;
  viewerHasReacted: boolean;
  reactors: { totalCount: number };
}

const COMMENT_FIELDS = /* GraphQL */ `
  ${REACTION_FIELDS}
  id
  databaseId
  url
  body
  bodyHTML
  diffHunk
  createdAt
  lastEditedAt
  viewerCanUpdate
  state
  viewerDidAuthor
  author {
    login
    avatarUrl
  }
  originalCommit {
    oid
  }
  commit {
    oid
  }
`;

export const REVIEW_THREADS = /* GraphQL */ `
  query ($owner: String!, $repo: String!, $pr: Int!, $after: String) {
    repository(owner: $owner, name: $repo) {
      pullRequest(number: $pr) {
        reviewThreads(first: 50, after: $after) {
          pageInfo {
            hasNextPage
            endCursor
          }
          nodes {
            id
            isOutdated
            isResolved
            resolvedBy {
              login
            }
            viewerCanReply
            viewerCanResolve
            viewerCanUnresolve
            path
            diffSide
            subjectType
            line
            startLine
            originalLine
            originalStartLine
            comments(first: 100) {
              nodes {
                ${COMMENT_FIELDS}
              }
            }
          }
        }
      }
    }
  }
`;

export interface ThreadCommentNode {
  id: string;
  databaseId: number | null;
  url: string;
  body: string;
  bodyHTML: string;
  diffHunk: string;
  createdAt: string;
  lastEditedAt?: string | null;
  reactionGroups?: ReactionGroupNode[] | null;
  viewerCanUpdate?: boolean;
  state: 'PENDING' | 'SUBMITTED';
  viewerDidAuthor: boolean;
  author: Actor | null;
  originalCommit: { oid: string } | null;
  commit: { oid: string } | null;
}

export interface ReviewThreadNode {
  id: string;
  isOutdated: boolean;
  isResolved: boolean;
  resolvedBy?: { login: string } | null;
  viewerCanReply: boolean;
  viewerCanResolve: boolean;
  viewerCanUnresolve: boolean;
  path: string;
  diffSide: 'LEFT' | 'RIGHT';
  subjectType: 'LINE' | 'FILE';
  line: number | null;
  startLine: number | null;
  originalLine: number | null;
  originalStartLine: number | null;
  comments: { nodes: ThreadCommentNode[] };
}

export interface ReviewThreadsResponse {
  repository: {
    pullRequest: {
      reviewThreads: { pageInfo: { hasNextPage: boolean; endCursor: string | null }; nodes: ReviewThreadNode[] };
    } | null;
  } | null;
}

export const PR_FILES_VIEWED = /* GraphQL */ `
  query ($owner: String!, $repo: String!, $pr: Int!, $after: String) {
    repository(owner: $owner, name: $repo) {
      pullRequest(number: $pr) {
        files(first: 100, after: $after) {
          pageInfo {
            hasNextPage
            endCursor
          }
          nodes {
            path
            viewerViewedState
          }
        }
      }
    }
  }
`;

export interface PrFilesViewedResponse {
  repository: {
    pullRequest: {
      files: {
        pageInfo: { hasNextPage: boolean; endCursor: string | null };
        nodes: { path: string; viewerViewedState: 'VIEWED' | 'UNVIEWED' | 'DISMISSED' }[];
      } | null;
    } | null;
  } | null;
}

export const VIEWER_REVIEWS = /* GraphQL */ `
  query ($owner: String!, $repo: String!, $pr: Int!, $author: String!) {
    repository(owner: $owner, name: $repo) {
      pullRequest(number: $pr) {
        pending: reviews(first: 1, states: [PENDING], author: $author) {
          nodes {
            id
            comments {
              totalCount
            }
          }
        }
        last: reviews(last: 1, author: $author, states: [APPROVED, CHANGES_REQUESTED, COMMENTED, DISMISSED]) {
          nodes {
            submittedAt
            commit {
              oid
            }
          }
        }
      }
    }
  }
`;

export interface ViewerReviewsResponse {
  repository: {
    pullRequest: {
      pending: { nodes: { id: string; comments: { totalCount: number } }[] };
      last: { nodes: { submittedAt: string | null; commit: { oid: string } | null }[] };
    } | null;
  } | null;
}

export const CONVERSATION = /* GraphQL */ `
  query ($owner: String!, $repo: String!, $pr: Int!) {
    repository(owner: $owner, name: $repo) {
      pullRequest(number: $pr) {
        comments(last: 100) {
          nodes {
            id
            createdAt
            body
            bodyHTML
            viewerCanUpdate
            ${REACTION_FIELDS}
            author {
              login
              avatarUrl
            }
          }
        }
        reviews(last: 100) {
          nodes {
            id
            state
            submittedAt
            createdAt
            body
            bodyHTML
            viewerCanUpdate
            ${REACTION_FIELDS}
            author {
              login
              avatarUrl
            }
          }
        }
        timelineItems(last: 100, itemTypes: [HEAD_REF_FORCE_PUSHED_EVENT]) {
          nodes {
            __typename
            ... on HeadRefForcePushedEvent {
              id
              createdAt
              actor {
                login
                avatarUrl
              }
              beforeCommit {
                oid
                committedDate
              }
              afterCommit {
                oid
              }
            }
          }
        }
      }
    }
  }
`;

export interface ConversationResponse {
  repository: {
    pullRequest: {
      comments: { nodes: { id: string; createdAt: string; body?: string; bodyHTML: string; viewerCanUpdate?: boolean; reactionGroups?: ReactionGroupNode[] | null; author: Actor | null }[] };
      reviews: {
        nodes: { id: string; state: string; submittedAt: string | null; createdAt: string; body: string; bodyHTML: string; viewerCanUpdate?: boolean; reactionGroups?: ReactionGroupNode[] | null; author: Actor | null }[];
      };
      timelineItems: {
        nodes: {
          __typename: string;
          id?: string;
          createdAt?: string;
          actor?: Actor | null;
          beforeCommit?: { oid: string; committedDate: string } | null;
          afterCommit?: { oid: string } | null;
        }[];
      };
    } | null;
  } | null;
}

export const ADD_REVIEW = /* GraphQL */ `
  mutation ($prId: ID!, $commitOID: GitObjectID!) {
    addPullRequestReview(input: { pullRequestId: $prId, commitOID: $commitOID }) {
      pullRequestReview {
        id
      }
    }
  }
`;

export interface AddReviewResponse {
  addPullRequestReview: { pullRequestReview: { id: string } };
}

export const ADD_REVIEW_THREAD = /* GraphQL */ `
  mutation (
    $reviewId: ID!
    $path: String!
    $body: String!
    $line: Int
    $side: DiffSide
    $startLine: Int
    $startSide: DiffSide
    $subjectType: PullRequestReviewThreadSubjectType
  ) {
    addPullRequestReviewThread(
      input: {
        pullRequestReviewId: $reviewId
        path: $path
        body: $body
        line: $line
        side: $side
        startLine: $startLine
        startSide: $startSide
        subjectType: $subjectType
      }
    ) {
      thread {
        id
      }
    }
  }
`;

export interface AddThreadResponse {
  addPullRequestReviewThread: { thread: { id: string } | null };
}

export const SUBMIT_REVIEW = /* GraphQL */ `
  mutation ($reviewId: ID!, $event: PullRequestReviewEvent!, $body: String) {
    submitPullRequestReview(input: { pullRequestReviewId: $reviewId, event: $event, body: $body }) {
      pullRequestReview {
        id
        state
      }
    }
  }
`;

export const ADD_REPLY = /* GraphQL */ `
  mutation ($threadId: ID!, $body: String!) {
    addPullRequestReviewThreadReply(input: { pullRequestReviewThreadId: $threadId, body: $body }) {
      comment {
        id
        state
      }
    }
  }
`;

export const RESOLVE_THREAD = /* GraphQL */ `
  mutation ($threadId: ID!) {
    resolveReviewThread(input: { threadId: $threadId }) {
      thread {
        id
        isResolved
      }
    }
  }
`;

export const UPDATE_REVIEW_COMMENT = /* GraphQL */ `
  mutation ($id: ID!, $body: String!) {
    updatePullRequestReviewComment(input: { pullRequestReviewCommentId: $id, body: $body }) {
      pullRequestReviewComment {
        bodyHTML
      }
    }
  }
`;

export const UPDATE_ISSUE_COMMENT = /* GraphQL */ `
  mutation ($id: ID!, $body: String!) {
    updateIssueComment(input: { id: $id, body: $body }) {
      issueComment {
        bodyHTML
      }
    }
  }
`;

export const UPDATE_REVIEW = /* GraphQL */ `
  mutation ($id: ID!, $body: String!) {
    updatePullRequestReview(input: { pullRequestReviewId: $id, body: $body }) {
      pullRequestReview {
        bodyHTML
      }
    }
  }
`;

export interface UpdateCommentResponse {
  updatePullRequestReviewComment?: { pullRequestReviewComment: { bodyHTML: string } };
  updateIssueComment?: { issueComment: { bodyHTML: string } };
  updatePullRequestReview?: { pullRequestReview: { bodyHTML: string } };
}

export const ADD_REACTION = /* GraphQL */ `
  mutation ($subjectId: ID!, $content: ReactionContent!) {
    addReaction(input: { subjectId: $subjectId, content: $content }) {
      reaction {
        content
      }
    }
  }
`;

export const REMOVE_REACTION = /* GraphQL */ `
  mutation ($subjectId: ID!, $content: ReactionContent!) {
    removeReaction(input: { subjectId: $subjectId, content: $content }) {
      reaction {
        content
      }
    }
  }
`;

export const UNRESOLVE_THREAD = /* GraphQL */ `
  mutation ($threadId: ID!) {
    unresolveReviewThread(input: { threadId: $threadId }) {
      thread {
        id
        isResolved
      }
    }
  }
`;

export const MARK_FILE_VIEWED = /* GraphQL */ `
  mutation ($prId: ID!, $path: String!) {
    markFileAsViewed(input: { pullRequestId: $prId, path: $path }) {
      clientMutationId
    }
  }
`;

export const UNMARK_FILE_VIEWED = /* GraphQL */ `
  mutation ($prId: ID!, $path: String!) {
    unmarkFileAsViewed(input: { pullRequestId: $prId, path: $path }) {
      clientMutationId
    }
  }
`;

export const ADD_COMMENT = /* GraphQL */ `
  mutation ($subjectId: ID!, $body: String!) {
    addComment(input: { subjectId: $subjectId, body: $body }) {
      clientMutationId
    }
  }
`;

export const REQUEST_REVIEWS = /* GraphQL */ `
  mutation ($prId: ID!, $logins: [String!]!) {
    requestReviewsByLogin(input: { pullRequestId: $prId, userLogins: $logins, union: true }) {
      clientMutationId
    }
  }
`;

export const SEARCH_PRS = /* GraphQL */ `
  query ($q: String!, $first: Int!, $after: String) {
    search(query: $q, type: ISSUE, first: $first, after: $after) {
      issueCount
      pageInfo {
        hasNextPage
        endCursor
      }
      nodes {
        __typename
        ... on PullRequest {
          number
          title
          isDraft
          state
          createdAt
          updatedAt
          additions
          deletions
          reviewDecision
          author {
            login
            avatarUrl
          }
          repository {
            name
            owner {
              login
            }
            url
          }
          labels(first: 10) {
            nodes {
              name
              color
            }
          }
          comments {
            totalCount
          }
          reviewThreads {
            totalCount
          }
          commits(last: 1) {
            nodes {
              commit {
                statusCheckRollup {
                  state
                  contexts(first: 0) {
                    checkRunCount
                    checkRunCountsByState {
                      state
                      count
                    }
                    statusContextCount
                    statusContextCountsByState {
                      state
                      count
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

export interface SearchNode {
  __typename: string;
  number?: number;
  title?: string;
  isDraft?: boolean;
  state?: 'OPEN' | 'CLOSED' | 'MERGED';
  createdAt?: string;
  updatedAt?: string;
  additions?: number;
  deletions?: number;
  reviewDecision?: 'APPROVED' | 'CHANGES_REQUESTED' | 'REVIEW_REQUIRED' | null;
  author?: { login: string; avatarUrl?: string } | null;
  repository?: { name: string; owner: { login: string }; url: string };
  labels?: { nodes: { name: string; color: string }[] };
  comments?: { totalCount: number };
  reviewThreads?: { totalCount: number };
  commits?: { nodes: { commit: { statusCheckRollup: { state: string; contexts?: CheckCounts } | null } }[] };
}

export interface CheckCounts {
  checkRunCount: number;
  checkRunCountsByState: { state: string; count: number }[] | null;
  statusContextCount: number;
  statusContextCountsByState: { state: string; count: number }[] | null;
}

export interface SearchResponse {
  search: { issueCount: number; pageInfo: { hasNextPage: boolean; endCursor: string | null }; nodes: SearchNode[] };
}
