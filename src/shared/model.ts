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
  mergedAt: string | null;
  mergedBy: string | null;
  /** What the viewer may do with the pull request on GitHub (merge: write access to the repository). */
  viewerCan: { merge: boolean; close: boolean; reopen: boolean; update: boolean };
}

export type MergeMethod = 'MERGE' | 'SQUASH' | 'REBASE';

export interface CommitMessage {
  headline: string;
  body: string;
}

/**
 * What merging takes, as github.com's merge box sees it: the repository's merge settings, the state of the branch's
 * rules (required checks and reviews, conflicts, an out-of-date branch) and the commit messages GitHub proposes.
 */
export interface MergeInfo {
  state: PrDetails['state'];
  isDraft: boolean;
  headRefOid: string;
  headRefName: string;
  baseRefName: string;
  /** The methods the repository allows, and the one the viewer last used there. */
  methods: MergeMethod[];
  defaultMethod: MergeMethod;
  /** GitHub's proposed commit for each method that makes one (a rebase keeps the commits as they are). */
  messages: Record<'MERGE' | 'SQUASH', CommitMessage>;
  /** The address the merge commit is authored with. */
  authorEmail: string | null;
  mergeable: PrDetails['mergeable'];
  mergeStateStatus: string;
  reviewDecision: PrDetails['reviewDecision'];
  checks: (CheckRun & { required: boolean })[];
  /** Write access to the repository. */
  canMerge: boolean;
  /** May merge before the rules are met (an administrator, or allowed to bypass the rules). */
  canBypass: boolean;
  autoMerge: { available: boolean; enabled: { method: MergeMethod; by: string | null } | null; canDisable: boolean };
  mergeQueue: { enabled: boolean; queued: boolean };
  canUpdateBranch: boolean;
  /** The head branch after the merge: GitHub deletes it (a repository setting), the viewer may, or neither. */
  deleteBranch: 'automatic' | 'optional' | 'no';
}

export interface MergeInput {
  /** Merge now, merge automatically once the rules are met, or add it to the merge queue. */
  action: 'merge' | 'auto-merge' | 'queue';
  method: MergeMethod;
  /** Null for a rebase. */
  message: CommitMessage | null;
  deleteBranch: boolean;
}

export interface ReviewerCandidate {
  /** A user's login, or a team as "org/slug". */
  id: string;
  kind: 'user' | 'team';
  name: string | null;
  avatarUrl: string | null;
  /** Why GitHub suggests them. */
  reason: string | null;
}

export interface ReviewerOptions {
  suggestions: ReviewerCandidate[];
  users: ReviewerCandidate[];
  teams: ReviewerCandidate[];
  /** Ids (as in `ReviewerCandidate`) with a review requested now. */
  requested: string[];
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

/** Where the browser extension is, and the installed browsers' extensions pages ("chrome://extensions"). */
export interface BrowserExtensionInfo {
  path: string;
  browsers: { name: string; page: string }[];
}

/** This version against the latest GitHub release. */
export interface UpdateInfo {
  current: string;
  /** The latest release's version, or null when there's none (or the check failed). */
  latest: string | null;
  available: boolean;
  /** The release page, to download it from. */
  url: string | null;
  error: string | null;
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

/**
 * A worktree whose pull request is merged or closed, for the New tab's clean-up: one PR Review made (named after the
 * PR), or any other with the PR's branch checked out.
 */
export interface StaleWorktree {
  worktree: WorktreeInfo;
  /** The pull request's key (`prKey`): removing the worktree closes its tabs. */
  key: string;
  number: number;
  state: 'MERGED' | 'CLOSED';
  title: string;
  closedAt: string | null;
  /** Why it can't simply be removed, if it can't: see `removalBlocker`. */
  keep: RemovalBlocker | null;
  /** Its pull request has a session (a tab here or in another window). */
  open: boolean;
}

/** Which list a search filter suggests from: people who can be mentioned (author), assigned (reviewers, assignee), or labels. */
export type SuggestionKind = 'author' | 'assignee' | 'reviewer' | 'label';

/** One suggestion in a search filter's menu. */
export interface FilterSuggestion {
  /** What goes into the query (a login, a label name). */
  value: string;
  label: string;
  /** A person's name, a label's description. */
  detail: string | null;
  avatarUrl: string | null;
  /** A label's colour ("#d73a4a"). */
  color: string | null;
}

/** The PR page's offer to remove its worktree once the pull request is merged or closed. */
export interface WorktreeRemoval {
  repoPath: string;
  path: string;
  /** PR Review made it (else it's one of yours, with your branch, which stays). */
  owned: boolean;
  branch: string | null;
  /** Why it can't simply be removed, if it can't: see `removalBlocker`. */
  blocker: RemovalBlocker | null;
}

/**
 * What removing a worktree would lose: uncommitted changes (`dirty`), commits on no branch (`unreachable`), or it's
 * `locked` (another tool, like a Claude Code session, is using it) or git can't read it (`unreadable`).
 */
export type RemovalBlocker = 'dirty' | 'unreachable' | 'locked' | 'unreadable';


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
  /** The viewer's GitHub profile picture, for their own drafts. */
  viewerAvatarUrl: string | null;
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

/**
 * A pull request while it first loads: its details from GitHub, and its conversation once that's fetched. The app
 * shows it (the Overview) until the snapshot is ready, since the git side (fetching, the worktree, the diff) takes longer.
 */
export interface PrPreview {
  key: string;
  ref: PrRef;
  role: Role;
  viewer: string;
  /** The viewer's GitHub profile picture, for their own drafts. */
  viewerAvatarUrl: string | null;
  details: PrDetails;
  conversation: ConversationItem[] | null;
}

export type PrEvent =
  | { type: 'snapshot'; key: string; snapshot: PrSnapshot }
  | { type: 'preview'; key: string; preview: PrPreview }
  | { type: 'progress'; key: string; message: string }
  | { type: 'error'; key: string; message: string }
  /** The periodic check found nothing new (a change triggers a refresh, and with it a snapshot). */
  | { type: 'checked'; key: string; at: string }
  /** A background quick action started, printed something or finished. */
  | { type: 'action'; key: string; run: ActionRun }
  /** The session ended because its worktree was removed: every window closes the PR's tabs. */
  | { type: 'closed'; key: string };

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
  /** Commands to run on a pull request or one of its files (see `QuickAction`). */
  quickActions: QuickAction[];
  /** The terminal app quick actions open in, an id from TERMINALS; empty picks the first one installed. */
  terminalApp: string;
}

/**
 * A command the viewer runs on a pull request (its Actions menu) or on one of its files (the file's menu): in the PR's
 * worktree, with the PR's details in environment variables (`PR_NUMBER`, `PR_URL`, `PR_FILE`… see shared/quickActions.ts).
 */
export interface QuickAction {
  id: string;
  name: string;
  /** Run by the login shell; empty (in a terminal) just opens one in the worktree. */
  command: string;
  /** In a new terminal window or tab, or in the background with its output in the app. */
  mode: 'terminal' | 'background';
  scope: 'pr' | 'file';
  /** The repositories it's offered for: "owner/repo" or "owner/*", separated by commas or spaces; empty for all. */
  repos: string;
  /** Ask before it runs. */
  confirm: boolean;
}

/** A quick action running (or run) in the background. */
export interface ActionRun {
  id: string;
  actionId: string;
  name: string;
  command: string;
  /** The file it ran on, for a file action. */
  file: string | null;
  startedAt: string;
  endedAt: string | null;
  status: 'running' | 'succeeded' | 'failed' | 'stopped';
  exitCode: number | null;
  /** Its output, stdout and stderr together; the last 200,000 characters. */
  output: string;
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
