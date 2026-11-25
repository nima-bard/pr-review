import type {
  ActionRun,
  AuthStatus,
  BrowserExtensionInfo,
  CodeSearchQuery,
  CodeSearchResult,
  CommitsData,
  Draft,
  EditableKind,
  FileContent,
  FileDiffModel,
  InboxSection,
  MergeInfo,
  MergeInput,
  OpenPrResult,
  PrEvent,
  PrSnapshot,
  PrSummary,
  ReactionContent,
  RepoMapping,
  ReviewerOptions,
  SearchPage,
  Settings,
  SetupInfo,
  StaleWorktree,
  SubmitInput,
  UpdateInfo,
  WorktreeInfo,
} from './model';

export interface Api {
  openPr(input: string): Promise<OpenPrResult>;
  /** Title and author only (one small query, no checkout), for restored tabs that aren't open yet. */
  prSummary(input: string): Promise<PrSummary | null>;
  closePr(key: string): Promise<void>;
  getSnapshot(key: string): Promise<PrSnapshot | null>;
  /** Checks GitHub for changes to the PR now (it also happens every 45s); refreshes if there are any. */
  checkPr(key: string): Promise<void>;
  refreshPr(key: string): Promise<void>;
  getFileDiff(key: string, path: string): Promise<FileDiffModel | null>;
  readFile(key: string, rev: 'base' | 'head' | 'worktree', path: string): Promise<FileContent>;
  listAllFiles(key: string): Promise<string[]>;
  /** Find in files, in the PR's worktree; a newer search for the same PR cancels the running one. */
  searchCode(key: string, query: CodeSearchQuery): Promise<CodeSearchResult>;
  setViewed(key: string, paths: string[], viewed: boolean): Promise<void>;
  saveDraft(key: string, draft: Draft): Promise<void>;
  deleteDraft(key: string, draftId: string): Promise<void>;
  reply(key: string, threadId: string, body: string): Promise<void>;
  setResolved(key: string, threadId: string, resolved: boolean): Promise<void>;
  react(key: string, subjectId: string, content: ReactionContent, add: boolean): Promise<void>;
  editComment(key: string, kind: EditableKind, commentId: string, body: string): Promise<void>;
  submitReview(key: string, input: SubmitInput): Promise<void>;
  addPrComment(key: string, body: string): Promise<void>;
  requestReviews(key: string, logins: string[]): Promise<void>;
  /** The terminal apps installed that quick actions can open in. */
  terminalApps(): Promise<{ id: string; name: string }[]>;
  /** Runs quick action `actionId` (from Settings) on the PR, or on its `file` for a file action. */
  runQuickAction(key: string, actionId: string, file: string | null): Promise<void>;
  stopQuickAction(runId: string): Promise<void>;
  /** Forgets a finished background run. */
  dismissQuickActionRun(runId: string): Promise<void>;
  /** The PR's background runs, newest first (for a window opened while they run). */
  quickActionRuns(key: string): Promise<ActionRun[]>;
  /** What merging the PR takes: GitHub's merge settings, the rules' state and its proposed commit messages. */
  mergeInfo(key: string): Promise<MergeInfo>;
  mergePr(key: string, input: MergeInput): Promise<void>;
  disableAutoMerge(key: string): Promise<void>;
  /** Brings the PR's branch up to date with its base branch. */
  updateBranch(key: string, method: 'MERGE' | 'REBASE'): Promise<void>;
  /** Closes or reopens the PR, with a comment if `comment` isn't empty. */
  setPrOpen(key: string, open: boolean, comment: string): Promise<void>;
  /** Converts the PR to a draft, or marks it ready for review. */
  setPrDraft(key: string, draft: boolean): Promise<void>;
  /** Who can be asked to review (users matching `query`, GitHub's suggestions, teams). */
  reviewerOptions(key: string, query: string): Promise<ReviewerOptions>;
  /** Requests reviews from `add` and withdraws those to `remove` (logins, or teams as "org/slug"). */
  changeReviewRequests(key: string, add: string[], remove: string[]): Promise<void>;
  applySuggestion(key: string, threadId: string): Promise<void>;
  setThreadPlacement(key: string, threadId: string, line: number | null): Promise<void>;
  listCommits(key: string): Promise<CommitsData>;
  setCompare(key: string, from: string | null, label: string): Promise<void>;
  search(query: string, after?: string): Promise<SearchPage>;
  inbox(): Promise<InboxSection[]>;
  listWorktrees(): Promise<WorktreeInfo[]>;
  /** Worktrees whose pull request is merged or closed, and whether each can be removed. */
  staleWorktrees(): Promise<StaleWorktree[]>;
  removeWorktree(repoPath: string, path: string): Promise<void>;
  listRepos(): Promise<RepoMapping[]>;
  rescanRepos(): Promise<RepoMapping[]>;
  mapRepo(slug: string): Promise<RepoMapping | null>;
  getSettings(): Promise<Settings>;
  saveSettings(settings: Settings): Promise<void>;
  openInEditor(key: string, path: string, line: number): Promise<void>;
  openExternal(url: string): Promise<void>;
  getOpenTabs(): Promise<string[]>;
  saveOpenTabs(inputs: string[]): Promise<void>;
  popOut(key: string): Promise<void>;
  /** Shows a native context menu at the pointer; resolves with the chosen item's id, or null if dismissed. */
  contextMenu(items: ContextMenuItem[]): Promise<string | null>;
  /** What the first-run setup finds on this machine (tools, editors, code folders). */
  setupInfo(): Promise<SetupInfo>;
  /** A native folder picker; null when cancelled. */
  pickFolder(title: string): Promise<string | null>;
  /** Compares this version with the latest GitHub release. */
  checkForUpdate(): Promise<UpdateInfo>;
  /** Shows a file of the PR's worktree in Finder. */
  showInFinder(key: string, path: string): Promise<void>;
  /** The browser extension's folder, and the installed browsers that can load it. */
  browserExtensionInfo(): Promise<BrowserExtensionInfo>;
  /** Asks a browser to open its extensions page ("chrome://extensions"); false if it couldn't be started. */
  openExtensionsPage(page: string): Promise<boolean>;
  /** Shows the Chrome extension's folder in Finder. */
  revealBrowserExtension(): Promise<void>;
  authStatus(): Promise<AuthStatus>;
  deviceLogin(): Promise<{ userCode: string; verificationUri: string }>;
  signOutDevice(): Promise<void>;
  onPrEvent(listener: (event: PrEvent) => void): () => void;
  onMenu(listener: (action: MenuAction) => void): () => void;
  onOpenPr(listener: (input: string) => void): () => void;
  /** PR links that arrived before this page listened (e.g. the one that launched the app); asking also starts delivery. */
  takePendingLinks(): Promise<string[]>;
}

/** `accelerator`: a shortcut shown next to the item (it isn't registered by the menu). */
export type ContextMenuItem = { id: string; label: string; enabled?: boolean; accelerator?: string } | 'separator';

export type MenuAction = 'new-tab' | 'close-tab' | 'settings' | 'toggle-word-wrap' | 'refresh' | 'toggle-tree' | 'toggle-conversations' | 'find-in-files' | 'show-files' | 'find' | 'find-next' | 'find-previous';

export type InvokeMethods = Exclude<keyof Api, 'onPrEvent' | 'onMenu' | 'onOpenPr' | 'takePendingLinks'>;

export const API_METHODS = [
  'openPr',
  'prSummary',
  'closePr',
  'getSnapshot',
  'checkPr',
  'refreshPr',
  'getFileDiff',
  'readFile',
  'listAllFiles',
  'searchCode',
  'setViewed',
  'saveDraft',
  'deleteDraft',
  'reply',
  'setResolved',
  'react',
  'editComment',
  'submitReview',
  'addPrComment',
  'requestReviews',
  'terminalApps',
  'runQuickAction',
  'stopQuickAction',
  'dismissQuickActionRun',
  'quickActionRuns',
  'mergeInfo',
  'mergePr',
  'disableAutoMerge',
  'updateBranch',
  'setPrOpen',
  'setPrDraft',
  'reviewerOptions',
  'changeReviewRequests',
  'applySuggestion',
  'setThreadPlacement',
  'listCommits',
  'setCompare',
  'search',
  'inbox',
  'listWorktrees',
  'staleWorktrees',
  'removeWorktree',
  'listRepos',
  'rescanRepos',
  'mapRepo',
  'getSettings',
  'saveSettings',
  'openInEditor',
  'openExternal',
  'getOpenTabs',
  'saveOpenTabs',
  'popOut',
  'contextMenu',
  'revealBrowserExtension',
  'browserExtensionInfo',
  'openExtensionsPage',
  'showInFinder',
  'checkForUpdate',
  'setupInfo',
  'pickFolder',
  'authStatus',
  'deviceLogin',
  'signOutDevice',
] as const satisfies readonly InvokeMethods[];

type Missing = Exclude<InvokeMethods, (typeof API_METHODS)[number]>;
export const API_METHODS_COMPLETE: Missing extends never ? true : Missing = true;
