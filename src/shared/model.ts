export type DiffSide = 'LEFT' | 'RIGHT';
export type AnchorTier = 'exact' | 'shifted' | 'manual' | 'fuzzy' | 'guess' | 'ai' | 'orphan';
export type OrphanReason = 'file-deleted' | 'anchor-text-unavailable' | 'no-confident-match' | 'file-level-comment';
export type ChangeType = 'added' | 'modified' | 'deleted' | 'renamed' | 'copied';
export type Role = 'author' | 'reviewer';
export type ReviewEvent = 'COMMENT' | 'APPROVE' | 'REQUEST_CHANGES';
export type ViewedState = 'VIEWED' | 'UNVIEWED' | 'DISMISSED';
export type TriageBucket = 'needs-reply' | 'likely-addressed' | 'waiting' | 'resolved';

export interface PrRef {
  host: string;
  owner: string;
  repo: string;
  number: number;
}

export function prKey(ref: PrRef): string {
  return `${ref.host}/${ref.owner}/${ref.repo}#${ref.number}`.toLowerCase();
}

export function repoSlug(ref: Pick<PrRef, 'owner' | 'repo'>): string {
  return `${ref.owner}/${ref.repo}`.toLowerCase();
}

export interface TrackedAnchor {
  tier: AnchorTier;
  path: string;
  line?: number;
  endLine?: number;
  score?: number;
  ambiguous?: boolean;
  changedAt?: string;
  changedAtTime?: string;
  locallyModified?: boolean;
  movedFrom?: string;
  reason?: OrphanReason;
}

export type ReactionContent = 'THUMBS_UP' | 'THUMBS_DOWN' | 'LAUGH' | 'HOORAY' | 'CONFUSED' | 'HEART' | 'ROCKET' | 'EYES';

/** One emoji on a comment; only reactions with at least one person are kept. */
export interface Reaction {
  content: ReactionContent;
  count: number;
  viewerHasReacted: boolean;
}

export interface CommentView {
  id: string;
  databaseId: number | null;
  author: string;
  avatarUrl: string | null;
  body: string;
  bodyHTML: string;
  createdAt: string;
  url: string;
  viewerDidAuthor: boolean;
  pending: boolean;
  edited: boolean;
  reactions: Reaction[];
  viewerCanUpdate: boolean;
}

/** What a comment id belongs to, which decides the GitHub mutation that edits it. */
export type EditableKind = 'thread' | 'comment' | 'review';

export interface ThreadView {
  id: string;
  path: string;
  side: DiffSide;
  fileLevel: boolean;
  isOutdated: boolean;
  isResolved: boolean;
  resolvedBy: string | null;
  viewerCanReply: boolean;
  viewerCanResolve: boolean;
  viewerCanUnresolve: boolean;
  line: number | null;
  startLine: number | null;
  originalLine: number | null;
  originalStartLine: number | null;
  originalCommit: string | null;
  diffHunk: string;
  comments: CommentView[];
  anchor: TrackedAnchor;
  triage: TriageBucket;
}

export interface FileEntry {
  path: string;
  oldPath: string | null;
  change: ChangeType;
  additions: number;
  deletions: number;
  binary: boolean;
  viewed: ViewedState;
  generated: boolean;
}

export interface FileDiffModel {
  path: string;
  oldPath: string;
  change: ChangeType;
  patch: string;
  binary: boolean;
  commentable: { LEFT: number[]; RIGHT: number[] };
}

export interface FileContent {
  path: string;
  contents: string;
  binary: boolean;
  missing: boolean;
}

export interface Draft {
  id: string;
  path: string;
  subject: 'line' | 'file';
  side: DiffSide;
  line: number;
  startLine?: number;
  body: string;
  headOid: string;
  createdAt: string;
  postedThreadId?: string;
  unplaceable?: boolean;
}

export interface Version {
  n: number;
  sha: string;
  seenAt: string;
  source: 'app' | 'timeline';
  forcePush: boolean;
}

export interface Label {
  name: string;
  color: string;
}

export interface ReviewerState {
  login: string;
  avatarUrl: string | null;
  state: 'APPROVED' | 'CHANGES_REQUESTED' | 'COMMENTED' | 'DISMISSED' | 'PENDING' | 'REQUESTED';
  submittedAt: string | null;
}

export interface CheckRun {
  name: string;
  state: 'success' | 'failure' | 'pending' | 'neutral';
  url: string | null;
}

export interface PrDetails {
  id: string;
  number: number;
  title: string;
  url: string;
  state: 'OPEN' | 'CLOSED' | 'MERGED';
  isDraft: boolean;
  author: string;
  authorAvatarUrl: string | null;
  bodyHTML: string;
  body: string;
  createdAt: string;
  updatedAt: string;
  baseRefName: string;
  baseRefOid: string;
  headRefName: string;
  headRefOid: string;
  headRepoOwner: string | null;
  isCrossRepository: boolean;
  maintainerCanModify: boolean;
  viewerDidAuthor: boolean;
  reviewDecision: 'APPROVED' | 'CHANGES_REQUESTED' | 'REVIEW_REQUIRED' | null;
  mergeable: 'MERGEABLE' | 'CONFLICTING' | 'UNKNOWN';
  mergeStateStatus: string;
  additions: number;
  deletions: number;
  changedFiles: number;
  commitCount: number;
  labels: Label[];
  reviewers: ReviewerState[];
  checks: CheckRun[];
  linkedIssues: { number: number; title: string; url: string }[];
  workItems: string[];
}

export interface ConversationItem {
  id: string;
  kind: 'comment' | 'review' | 'event';
  author: string;
  avatarUrl: string | null;
  createdAt: string;
  bodyHTML: string;
  reviewState?: ReviewerState['state'];
  text?: string;
  /** Comments and reviews; not force-push events. */
  reactions?: Reaction[];
  /** Markdown source, for editing. */
  body?: string;
  viewerCanUpdate?: boolean;
}

export interface WorktreeInfo {
  repoPath: string;
  slug: string | null;
  path: string;
  head: string | null;
  branch: string | null;
  detached: boolean;
  locked: string | null;
  owned: boolean;
  prNumber: number | null;
  isPrimary: boolean;
}

/** What the first-run setup finds on this machine. */
export interface SetupInfo {
  home: string;
  /** `git --version`, or null when git isn't installed. */
  git: string | null;
  /** `gh --version`, or null when the GitHub CLI isn't installed. */
  gh: string | null;
  /** Installed VS Code-style editors and the command that opens them. */
  editors: { label: string; command: string }[];
  /** Common code folders in the home folder that hold git clones, with how many. */
  folders: { path: string; repos: number }[];
}

/** A worktree whose pull request is merged or closed, for the New tab's clean-up. */
export interface StaleWorktree {
  worktree: WorktreeInfo;
  state: 'MERGED' | 'CLOSED';
  title: string;
  closedAt: string | null;
  /** Why it is left alone, if it is: not created here, locked, uncommitted changes, or its PR is open in a tab. */
  keep: string | null;
}

export interface CommitInfo {
  sha: string;
  subject: string;
  author: string;
  date: string;
}

export interface VersionGroup {
  version: Version;
  inHistory: boolean;
  commits: CommitInfo[];
  rangeDiff: { identical: number; changed: number; added: number; removed: number } | null;
}

export interface CommitsData {
  commits: CommitInfo[];
  groups: VersionGroup[];
}

export interface PrSnapshot {
  key: string;
  ref: PrRef;
  role: Role;
  viewer: string;
  details: PrDetails;
  clonePath: string;
  worktree: { path: string; mode: 'branch' | 'detached'; owned: boolean; behind: boolean };
  mergeBase: string;
  files: FileEntry[];
  threads: ThreadView[];
  conversation: ConversationItem[];
  drafts: Draft[];
  versions: Version[];
  lastReviewedOid: string | null;
  pendingReview: { id: string; commentCount: number } | null;
  compare: { from: string; label: string } | null;
  syncedAt: string;
}

/** Just enough of a PR to label a tab that hasn't been opened yet. */
export interface PrSummary {
  title: string;
  author: string;
  authorAvatarUrl: string | null;
  state: 'OPEN' | 'CLOSED' | 'MERGED';
  isDraft: boolean;
}

export type OpenPrResult =
  | { ok: true; key: string }
  | { ok: false; reason: 'bad-input' | 'no-clone' | 'error'; message: string; ref?: PrRef };

export type PrEvent =
  | { type: 'snapshot'; key: string; snapshot: PrSnapshot }
  | { type: 'progress'; key: string; message: string }
  | { type: 'error'; key: string; message: string }
  /** The periodic check found nothing new (a change triggers a refresh, and with it a snapshot). */
  | { type: 'checked'; key: string; at: string };

export interface SubmitInput {
  event: ReviewEvent;
  body: string;
}

export interface SearchItem {
  key: string;
  ref: PrRef;
  title: string;
  author: string;
  isDraft: boolean;
  state: 'OPEN' | 'CLOSED' | 'MERGED';
  createdAt: string;
  updatedAt: string;
  labels: Label[];
  reviewDecision: PrDetails['reviewDecision'];
  checks: 'success' | 'failure' | 'pending' | null;
  checkCounts: { passed: number; total: number } | null;
  comments: number;
  additions: number;
  deletions: number;
}

export interface SearchPage {
  items: SearchItem[];
  total: number;
  endCursor: string | null;
  hasNextPage: boolean;
}

/** Find in files: what to look for, like VS Code's search view. */
export interface CodeSearchQuery {
  pattern: string;
  matchCase: boolean;
  wholeWord: boolean;
  regex: boolean;
  /** Comma-separated globs; a name without "/" matches at any depth, and a folder matches everything in it. */
  include: string;
  exclude: string;
  /** The files in the current comparison (All changes, or a selected range), or every file in the worktree. */
  scope: 'changed' | 'all';
}

export interface CodeSearchMatch {
  line: number;
  /** The line, without its indentation and cut around the match when long. */
  text: string;
  /** [start, end) of each match within `text`. */
  ranges: [number, number][];
}

export interface CodeSearchResult {
  files: { path: string; matches: CodeSearchMatch[] }[];
  total: number;
  /** Stopped at the result limit. */
  truncated: boolean;
  /** Git's complaint, e.g. about an invalid regular expression. */
  error: string | null;
}

export interface RepoMapping {
  slug: string;
  path: string;
  source: 'scan' | 'manual';
}

export interface Settings {
  /** The first-run setup was finished (or skipped). Installs from before it existed count as done. */
  setupDone: boolean;
  scanRoots: string[];
  worktreeRoot: string | null;
  editorCommand: string;
  placeThreshold: number;
  guessThreshold: number;
  aiEnabled: boolean;
  aiModel: string;
  oauthClientId: string;
  /** App colour theme, an id from APP_THEMES (shared/themes.ts). */
  appTheme: string;
  codeTheme: string;
  /** How much of the add/remove colour is mixed into changed-line backgrounds, in percent (Pierre's own default is 20). */
  diffTint: number;
  /** Code line height in the diff and file views, in px (13px text; the library's default is 20). */
  diffLineHeight: number;
  /** Text size of review comments, replies and the comment editor, in px. */
  commentFontSize: number;
  /** Code text size in diffs, file views and code snippets, in px. */
  codeFontSize: number;
  /** Google Fonts family for the interface; empty uses the bundled Inter. */
  uiFont: string;
  /** Google Fonts family for code; empty uses the bundled JetBrains Mono. */
  codeFont: string;
}

export interface AuthStatus {
  via: 'gh' | 'device' | 'none';
  login: string | null;
  error: string | null;
}

export interface InboxSection {
  id: 'mine' | 'review-requested' | 'recent';
  title: string;
  items: SearchItem[];
  /** The search behind the section, so "Load more" can fetch the next page. */
  query: string;
  total: number;
  endCursor: string | null;
  hasNextPage: boolean;
}
