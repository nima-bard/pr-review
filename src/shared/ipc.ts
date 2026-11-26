import type {
  ActionRun,
  AgentRequest,
  ClaudeApp,
  ClaudeModelChoice,
  ClaudeModels,
  ClaudeView,
  AuthStatus,
  BrowserExtensionInfo,
  CodeSearchQuery,
  CodeSearchResult,
  CommitsData,
  Draft,
  EditableKind,
  FilterSuggestion,
  FileContent,
  FileDiffModel,
  InboxSection,
  McpStatus,
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
  SuggestionKind,
  UpdateInfo,
  WorktreeInfo,
  WorktreeRemoval,
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
  /** Deletes several drafts. */
  deleteDrafts(key: string, ids: string[]): Promise<void>;
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
  /** Suggestions for a search filter in `repo` ("owner/name"), matching what's typed. */
  filterSuggestions(repo: string, kind: SuggestionKind, query: string): Promise<FilterSuggestion[]>;
  inbox(): Promise<InboxSection[]>;
  listWorktrees(): Promise<WorktreeInfo[]>;
  /** Worktrees whose pull request is merged or closed, and whether each can be removed. */
  staleWorktrees(): Promise<StaleWorktree[]>;
  removeWorktree(repoPath: string, path: string): Promise<void>;
  /** The PR's worktree, if it's one that could go (not the clone itself), and why it stays if it does. */
  worktreeRemoval(key: string): Promise<WorktreeRemoval | null>;
  /**
   * Removes the worktree of the merged or closed PR `key` after checking again that nothing would be lost (or, with
   * `force`, losing its uncommitted changes or commits on no branch; never a locked one), then ends the PR's session,
   * which closes its tabs in every window.
   */
  removePrWorktree(repoPath: string, path: string, key: string, force?: boolean): Promise<void>;
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
  /** Asks Claude in the PR's session; it waits while Claude Desktop answers there or Claude Code has the session. */
  askClaude(key: string, request: AgentRequest): Promise<void>;
  /** Drops a question that hasn't reached the session yet. */
  cancelClaudeRequest(key: string, pendingId: string): Promise<void>;
  /** Sends a question that couldn't be sent again. */
  retryClaudeRequest(key: string, pendingId: string): Promise<void>;
  /** Ends the answer Claude is giving to a question from the app. */
  stopClaude(key: string): Promise<void>;
  /** OK on "close Claude Code there and send": takes the session from an idle Claude Code in a terminal, then sends. */
  takeClaudeSession(key: string): Promise<void>;
  /** The PR's Claude session as its conversation shows it (read from the session); null while Claude is off. */
  claudeView(key: string): Promise<ClaudeView | null>;
  /** Opens the PR's session in Claude Desktop or Claude Code (a terminal); the same session every time. */
  openClaudeIn(key: string, app: ClaudeApp): Promise<void>;
  /** Removes a line question's marker from the diff for good; the question stays in the session. */
  hideAskMarker(key: string, exchangeId: string): Promise<void>;
  /** Declines the choices Claude offered after an exchange (a choice that sends nothing, like "No"). */
  dismissClaudeOffer(key: string, exchangeId: string): Promise<void>;
  /** The model and effort for the PR's conversation from its next question; null goes back to Settings › Claude's. */
  chooseClaudeModel(key: string, choice: ClaudeModelChoice | null): Promise<void>;
  /** The models (and their effort levels) Settings › Claude offers: Claude Code's own list when it can be read. */
  claudeModels(): Promise<ClaudeModels>;
  /** The PR Review MCP server: whether it runs, its URL, and whether Claude Code has it registered. */
  mcpStatus(): Promise<McpStatus>;
  /** Registers the MCP server with Claude Code (user scope), after asking; Desktop's Code tab then sees it too. */
  connectClaudeCode(): Promise<void>;
  /** Copies the MCP settings for another client (URL and token, as JSON) to the clipboard; the token never reaches a page. */
  copyMcpClientConfig(): Promise<void>;
  /** A new token; clients registered with the old one must be connected again. */
  resetMcpToken(): Promise<void>;
  authStatus(): Promise<AuthStatus>;
  deviceLogin(): Promise<{ userCode: string; verificationUri: string }>;
  signOutDevice(): Promise<void>;
  onPrEvent(listener: (event: PrEvent) => void): () => void;
  onMenu(listener: (action: MenuAction) => void): () => void;
  onOpenPr(listener: (input: string) => void): () => void;
  /** PR links that arrived before this page listened (e.g. the one that launched the app); asking also starts delivery. */
  takePendingLinks(): Promise<string[]>;
  /** This window's PR tabs, for the Dock menu (macOS: right-click the app's icon in the Dock). */
  reportTabs(tabs: DockTab[]): void;
  /** The Dock menu asks this window to switch to tab `id`. */
  onActivateTab(listener: (id: string) => void): () => void;
}

/** A PR tab as the Dock menu lists it. */
export interface DockTab {
  id: string;
  label: string;
  active: boolean;
}

/**
 * `accelerator`: a shortcut shown next to the item (it isn't registered by the menu). `checked`: the item shows a check
 * mark when true (a setting that is on, or the chosen one of a group); leave it out for plain actions.
 */
export type ContextMenuItem = { id: string; label: string; enabled?: boolean; accelerator?: string; checked?: boolean } | 'separator';

export type MenuAction = 'new-tab' | 'close-tab' | 'settings' | 'toggle-word-wrap' | 'refresh' | 'toggle-tree' | 'layout-split' | 'layout-unified' | 'toggle-comments' | 'toggle-claude' | 'find-in-files' | 'show-files' | 'find' | 'find-next' | 'find-previous';

export type InvokeMethods = Exclude<keyof Api, 'onPrEvent' | 'onMenu' | 'onOpenPr' | 'takePendingLinks' | 'reportTabs' | 'onActivateTab'>;

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
  'deleteDrafts',
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
  'filterSuggestions',
  'inbox',
  'listWorktrees',
  'staleWorktrees',
  'removeWorktree',
  'worktreeRemoval',
  'removePrWorktree',
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
  'askClaude',
  'cancelClaudeRequest',
  'retryClaudeRequest',
  'stopClaude',
  'takeClaudeSession',
  'claudeView',
  'openClaudeIn',
  'hideAskMarker',
  'dismissClaudeOffer',
  'chooseClaudeModel',
  'claudeModels',
  'mcpStatus',
  'connectClaudeCode',
  'copyMcpClientConfig',
  'resetMcpToken',
  'authStatus',
  'deviceLogin',
  'signOutDevice',
] as const satisfies readonly InvokeMethods[];

type Missing = Exclude<InvokeMethods, (typeof API_METHODS)[number]>;
export const API_METHODS_COMPLETE: Missing extends never ? true : Missing = true;
