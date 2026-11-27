import { watch, type FSWatcher } from 'node:fs';
import { readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import {
  prKey,
  type CommitInfo,
  type CommitsData,
  type VersionGroup,
  type CommentView,
  type DiffSide,
  type Draft,
  type DraftOrigin,
  type FileContent,
  type FileDiffModel,
  type FileEntry,
  type PrDetails,
  type PrRef,
  type EditableKind,
  type MergeInfo,
  type MergeInput,
  type PrEvent,
  type ReviewerOptions,
  type PrPreview,
  type PrSnapshot,
  type ReactionContent,
  type Role,
  type SubmitInput,
  type ThreadView,
  type TrackedAnchor,
  type Version,
  type ViewedState,
  type CodeSearchQuery,
  type CodeSearchResult,
  type CheckoutMode,
  LOCAL_CHANGES,
} from '../shared/model';
import { filterPaths, searchWorktree } from '../core/search/codeSearch';
import { triage } from '../shared/triage';
import {
  changeReviewRequests,
  deleteHeadBranch,
  disableAutoMerge,
  fetchMergeInfo,
  fetchReviewerOptions,
  mergePullRequest,
  setPullRequestDraft,
  setPullRequestOpen,
  updateBranch,
} from '../core/github/prActions';
import { setReaction, toggleReaction, toReactions } from '../core/github/reactions';
import { anchorFromHunk, anchorFromLines, findAnchor } from '../core/anchor/fuzzy';
import { createGitTrackIO } from '../core/anchor/gitIO';
import { shiftLine, touchedNewLines } from '../core/anchor/hunks';
import { trackLine, trackRange } from '../core/anchor/track';
import { placeWithClaude, type AiCandidate } from '../core/ai/batch';
import { DEFAULT_ANCHOR_CONFIG, type AnchorConfig } from '../core/anchor/types';
import { pickOriginalBlob } from '../core/anchor/validate';
import { recoverMoved } from '../core/anchor/moved';
import { BlobReader, isBinary } from '../core/git/blobs';
import {
  blobShas,
  changedFiles,
  commentableLines,
  commitTime,
  dirtyFiles,
  filePatch,
  generatedFiles,
  hasCommit,
  listFilesAt,
  mergeBase,
  parseNumstat,
  worktreeHunks,
  type ChangedFile,
} from '../core/git/diff';
import { gh, git } from '../core/git/exec';
import { aheadBehind, attachBranch, commitAll, currentBranch, detachAt, discard, localChanges, localPatch, pullOnto, pushBranch, uncommitted } from '../core/git/checkout';
import { appendVersion, buildChain, commitsBetween, mergeVersions, pinVersion, rangeDiffSummary } from '../core/git/versions';
import {
  canonicalPath,
  createBranchWorktree,
  createDetached,
  fetchPullHead,
  listWorktrees,
  moveOwnedDetached,
  legacyWorktreePath,
  ownedWorktreePath,
  planWorktree,
  type WorktreePlan,
} from '../core/git/worktrees';
import type { GitHubClient } from '../core/github/client';
import { fetchConversation, fetchDetails, fetchThreads, fetchViewedStates, fetchViewerReviews } from '../core/github/pr';
import type { ReviewThreadNode } from '../core/github/queries';
import * as reviews from '../core/github/reviews';
import { remoteNameFor } from '../core/repos/registry';
import type { AppState, ManualPlacement } from '../core/store/appState';
import type { DraftStore } from '../core/store/drafts';

export interface SessionDeps {
  appState: AppState;
  drafts: DraftStore;
  client: GitHubClient;
  viewer: string;
  viewerAvatarUrl: string | null;
  clonePath: string;
  emit(event: SessionEvent): void;
}

type WithoutKey<E> = E extends unknown ? Omit<E, 'key'> : never;
/** A session's events, as the app gets them but without the PR's key (the sessions add it). */
export type SessionEvent = WithoutKey<PrEvent>;

interface WorktreeState {
  path: string;
  mode: 'branch' | 'detached';
  owned: boolean;
}

/**
 * Whether you can push to the pull request's branch: with write access to its repository, or for a fork, when it's
 * yours or it lets maintainers edit (and you are one).
 */
function canPushTo(details: PrDetails, viewer: string): boolean {
  if (!details.isCrossRepository) return details.viewerCan.merge;
  return details.headRepoOwner?.toLowerCase() === viewer.toLowerCase() || (details.maintainerCanModify && details.viewerCan.merge);
}

/** How often a checkout being edited is checked for changes when it can't be watched. */
const WORKTREE_POLL_MS = 5000;

export class PrSession {
  readonly key: string;
  private snapshot: PrSnapshot | null = null;
  private readonly blobs: BlobReader;
  private remote = 'origin';
  private worktree: WorktreeState | null = null;
  private files: ChangedFile[] = [];
  private prFiles: ChangedFile[] = [];
  /** GitHub's viewed states from the last refresh (kept in step by setViewed), so the file list can be rebuilt locally. */
  private viewedStates = new Map<string, ViewedState>();
  private searchAbort: AbortController | null = null;
  private readonly headAnchors = new Map<string, TrackedAnchor>();
  private watcher: FSWatcher | null = null;
  private watchTimer: NodeJS.Timeout | null = null;
  /** Checks the worktree for edits every few seconds when it can't be watched (see `startWatching`). */
  private worktreePoll: NodeJS.Timeout | null = null;
  private pollTimer: NodeJS.Timeout | null = null;
  private etag: string | null = null;
  private readonly aiCache = new Map<string, { line: number; confidence: number } | null>();
  private headBlobs = new Map<string, string>();
  private compareFrom: { from: string; label: string } | null = null;
  /** Read only (the app's own worktree follows each push) or editing (on the branch); set on the first load. */
  private checkout: CheckoutMode | null = null;
  private refreshing: Promise<void> | null = null;
  private anchorConfig: AnchorConfig = DEFAULT_ANCHOR_CONFIG;

  constructor(
    readonly ref: PrRef,
    private readonly deps: SessionDeps,
  ) {
    this.key = prKey(ref);
    this.blobs = new BlobReader(deps.clonePath);
  }

  get current(): PrSnapshot | null {
    return this.snapshot;
  }

  async open(): Promise<void> {
    const settings = await this.deps.appState.settings();
    this.anchorConfig = { ...DEFAULT_ANCHOR_CONFIG, placeThreshold: settings.placeThreshold, guessThreshold: settings.guessThreshold };
    this.remote = (await remoteNameFor(this.deps.clonePath, this.ref.owner, this.ref.repo)) ?? 'origin';
    await this.refresh();
    this.startPolling();
    if (this.checkout === 'editing') this.startWatching();
  }

  /** Checks GitHub every 45s (see `check`). */
  private startPolling(intervalMs = 45_000): void {
    this.pollTimer = setInterval(() => void this.check().catch(() => undefined), intervalMs);
  }

  /**
   * Whether the PR changed on GitHub (an ETag request: a 304 costs nothing). A new head commit or update time (pushes,
   * comments, reviews) triggers a full refresh; otherwise the check is reported, so the app can show it happened.
   */
  async check(): Promise<void> {
    if (this.refreshing) return;
    const res = await this.deps.client.getIfChanged<{ head: { sha: string }; updated_at: string }>(
      `/repos/${this.ref.owner}/${this.ref.repo}/pulls/${this.ref.number}`,
      this.etag,
    );
    const snap = this.snapshot;
    if (res.changed) {
      this.etag = res.etag;
      if (snap && (res.data.head.sha !== snap.details.headRefOid || res.data.updated_at !== snap.details.updatedAt)) {
        await this.refresh();
        return;
      }
    }
    // Commits and pushes made outside the app (in a terminal) change nothing the file watcher sees.
    if (this.checkout === 'editing') await this.remapWorktree().catch(() => undefined);
    this.deps.emit({ type: 'checked', at: new Date().toISOString() });
  }

  /**
   * While editing: threads follow uncommitted edits in the checkout, and what changed there shows as it happens. A watcher can fail, at the start or later
   * (macOS gives an app started from a terminal 256 open files, and a big checkout can use them up): then the
   * worktree is checked every few seconds instead, rather than the error taking down the app.
   */
  private startWatching(): void {
    const root = this.worktree?.path;
    if (!root || this.watcher || this.worktreePoll) return;
    const ignored = /(^|\/)(\.git|node_modules|out|dist|bin|obj|\.next|coverage)(\/|$)/;
    const poll = () => {
      this.watcher?.close();
      this.watcher = null;
      this.worktreePoll ??= setInterval(() => void this.remapWorktree().catch(() => undefined), WORKTREE_POLL_MS);
    };
    try {
      this.watcher = watch(root, { recursive: true }, (_event, file) => {
        if (!file || ignored.test(file.toString())) return;
        if (this.watchTimer) clearTimeout(this.watchTimer);
        this.watchTimer = setTimeout(() => void this.remapWorktree().catch(() => undefined), 400);
      });
      this.watcher.on('error', poll);
    } catch {
      poll();
    }
  }

  private stopWatching(): void {
    if (this.watchTimer) clearTimeout(this.watchTimer);
    if (this.worktreePoll) clearInterval(this.worktreePoll);
    this.watcher?.close();
    this.watcher = null;
    this.watchTimer = null;
    this.worktreePoll = null;
  }

  /**
   * After the checkout changed (an edit, a commit, a discard): where it stands now, the Local changes list when it
   * shows, and while editing, the threads placed in the edited files.
   */
  async remapWorktree(): Promise<void> {
    const snap = this.snapshot;
    if (!snap || !this.worktree) return;
    let threads: ThreadView[] | null = null;
    if (this.checkout === 'editing') {
      const dirty = new Set(await dirtyFiles(this.worktree.path).catch(() => []));
      threads = [];
      for (const t of snap.threads) {
        const base = this.headAnchors.get(t.id);
        let anchor = base ?? t.anchor;
        if (base && dirty.has(base.path) && base.line !== undefined && t.side === 'RIGHT') anchor = await this.composeWorktree(base, snap.details.headRefOid);
        threads.push({ ...t, anchor, triage: triage({ isResolved: t.isResolved, comments: t.comments, anchor, viewerIsAuthor: snap.role === 'author' }) });
      }
    }
    const local = await this.localState(snap.details);
    const files = this.compareFrom?.from === LOCAL_CHANGES ? await this.fileEntries(snap.details.headRefOid) : null;
    this.update((s) => {
      if (threads) s.threads = threads;
      s.worktree = { ...s.worktree, ...local };
      if (files) s.files = files;
    });
  }

  /** Where the checkout stands: its branch, files changed and not committed, and on a branch, commits to push and to pull. */
  private async localState(details: PrDetails): Promise<Pick<PrSnapshot['worktree'], 'branch' | 'uncommitted' | 'sync' | 'canPush' | 'checkedAt'>> {
    const path = this.worktree?.path;
    const push = canPushTo(details, this.deps.viewer);
    const checkedAt = Date.now();
    if (!path) return { branch: null, uncommitted: [], sync: null, canPush: push, checkedAt };
    const [branch, changed] = await Promise.all([currentBranch(path).catch(() => null), uncommitted(path).catch(() => [])]);
    const sync = branch ? await aheadBehind(path, details.headRefOid).catch(() => null) : null;
    return { branch, uncommitted: changed, sync, canPush: push, checkedAt };
  }

  /**
   * Switches between reading (the app's own worktree, following each push) and editing (on the pull request's branch,
   * yours if you have it checked out). Leaving the branch needs its changes committed or discarded; its commits stay.
   */
  async setCheckout(mode: CheckoutMode): Promise<void> {
    if (this.refreshing) await this.refreshing.catch(() => undefined);
    const snap = this.snapshot;
    if (!snap) throw new Error('The pull request is still loading.');
    if (mode === this.checkout) return;
    const before = this.checkout;
    this.checkout = mode;
    try {
      this.progress(mode === 'editing' ? 'Switching to the branch…' : 'Switching back to reviewing…');
      this.worktree = await this.prepareWorktree(snap.details, true);
    } catch (err) {
      this.checkout = before;
      throw err;
    }
    await this.deps.appState.saveCheckoutMode(this.key, mode);
    if (mode === 'reading' && this.compareFrom?.from === LOCAL_CHANGES) this.compareFrom = null;
    this.stopWatching();
    if (mode === 'editing') this.startWatching();
    await this.refresh();
  }

  /** Where the pull request goes for `checkout` (see `planWorktree`); nothing changes yet. */
  private async planFor(details: PrDetails, checkout: CheckoutMode): Promise<WorktreePlan> {
    const { clonePath, appState } = this.deps;
    const settings = await appState.settings();
    const legacy = legacyWorktreePath(this.ref.number, settings.worktreeRoot);
    return planWorktree({
      worktrees: await listWorktrees(clonePath),
      ownedPath: canonicalPath(ownedWorktreePath(clonePath, this.ref, settings.worktreeRoot)),
      legacyPath: legacy ? canonicalPath(legacy) : null,
      headRefName: details.headRefName,
      headOid: details.headRefOid,
      checkout,
    });
  }

  /** Where switching to `mode` would check the pull request out, and whether that's a checkout of yours: said before switching. */
  async checkoutPlan(mode: CheckoutMode): Promise<{ path: string; yours: boolean }> {
    const snap = this.snapshot;
    if (!snap) throw new Error('The pull request is still loading.');
    const plan = await this.planFor(snap.details, mode);
    return { path: plan.path, yours: plan.kind === 'reuse' && !plan.owned };
  }

  /** The checkout while editing on the branch; anything else is refused. */
  private editingPath(): string {
    if (this.checkout !== 'editing' || !this.worktree || this.worktree.mode !== 'branch') throw new Error('Switch to Contribute first.');
    return this.worktree.path;
  }

  /** Commits every change in the checkout (new files too) while editing. */
  async commitLocal(message: string): Promise<void> {
    await commitAll(this.editingPath(), message);
    await this.remapWorktree();
  }

  /** Brings in what was pushed since, under your own commits (see `pullOnto`). */
  async pullLocal(): Promise<void> {
    const path = this.editingPath();
    await this.refresh();
    const head = this.snapshot?.details.headRefOid;
    if (!head) return;
    await pullOnto(path, head);
    await this.remapWorktree();
  }

  /** Pushes your commits to the pull request's branch; never forced. */
  async pushLocal(): Promise<void> {
    const snap = this.snapshot;
    const path = this.editingPath();
    if (!snap || !canPushTo(snap.details, this.deps.viewer)) throw new Error('You can’t push to this pull request’s branch.');
    await pushBranch(path, { remote: this.remote, branch: snap.details.headRefName });
    await this.refresh();
  }

  /** Throws away changes not committed to `paths`: edits go back, new files are deleted. */
  async discardLocal(paths: string[]): Promise<void> {
    if (!this.worktree) throw new Error('The pull request isn’t checked out yet.');
    await discard(this.worktree.path, paths);
    await this.remapWorktree();
  }

  refresh(): Promise<void> {
    this.refreshing ??= this.doRefresh().finally(() => {
      this.refreshing = null;
    });
    return this.refreshing;
  }

  private progress(message: string): void {
    this.deps.emit({ type: 'progress', message });
  }

  private async doRefresh(): Promise<void> {
    const { client, clonePath } = this.deps;
    this.progress('Loading pull request…');
    const details = await fetchDetails(client, this.ref);
    const role: Role = details.viewerDidAuthor ? 'author' : 'reviewer';

    // GitHub's side doesn't need git, so it loads while the commits are fetched and the worktree is prepared.
    const conversationLoad = fetchConversation(client, this.ref);
    const fromGitHub = Promise.all([fetchViewedStates(client, this.ref), fetchThreads(client, this.ref), conversationLoad, fetchViewerReviews(client, this.ref, this.deps.viewer)]);
    // It's awaited below; this only keeps a failure while git runs from counting as unhandled.
    fromGitHub.catch(() => undefined);
    if (!this.snapshot) {
      // The first load: the app can show the Overview now, and the conversation when it's in.
      const preview: PrPreview = { key: this.key, ref: this.ref, role, viewer: this.deps.viewer, viewerAvatarUrl: this.deps.viewerAvatarUrl, details, conversation: null };
      this.deps.emit({ type: 'preview', preview });
      conversationLoad.then(
        (c) => !this.snapshot && this.deps.emit({ type: 'preview', preview: { ...preview, conversation: c.items } }),
        () => undefined,
      );
    }

    this.progress('Fetching commits…');
    await fetchPullHead(clonePath, this.remote, this.ref.number);
    await this.ensureCommit(details.baseRefOid);
    await this.ensureCommit(details.headRefOid);

    this.checkout ??= (await this.deps.appState.checkoutMode(this.key)) ?? (role === 'author' ? 'editing' : 'reading');
    if (!this.worktree || this.snapshot?.details.headRefOid !== details.headRefOid) {
      this.progress('Preparing worktree…');
      this.worktree = await this.prepareWorktree(details);
    }

    const [viewedStates, threadNodes, conversation, viewerReviews] = await fromGitHub;

    const versions = await this.recordVersions(details.headRefOid, conversation.forcePushes);
    const base = (await mergeBase(clonePath, details.baseRefOid, details.headRefOid)) ?? details.baseRefOid;

    this.progress('Computing diff…');
    this.prFiles = await changedFiles(clonePath, details.baseRefOid, details.headRefOid);
    this.viewedStates = viewedStates;
    const files = await this.fileEntries(details.headRefOid);

    this.progress('Placing comments…');
    const io = createGitTrackIO(clonePath, this.blobs);
    const threads = this.applyAiCache(await this.anchorThreads(threadNodes, details, base, versions, role, io), details.headRefOid, role);

    const drafts = await this.reanchorDrafts(await this.deps.drafts.list(this.key), details, versions, io);
    const headAtCheckout = this.worktree ? await this.worktreeHead(this.worktree.path) : null;
    this.snapshot = {
      key: this.key,
      ref: this.ref,
      role,
      viewer: this.deps.viewer,
      viewerAvatarUrl: this.deps.viewerAvatarUrl,
      details,
      clonePath,
      worktree: {
        path: this.worktree?.path ?? clonePath,
        mode: this.worktree?.mode ?? 'detached',
        owned: this.worktree?.owned ?? false,
        behind: headAtCheckout !== null && headAtCheckout !== details.headRefOid,
        checkout: this.checkout,
        ...(await this.localState(details)),
      },
      mergeBase: base,
      files,
      threads,
      conversation: conversation.items,
      drafts,
      versions,
      lastReviewedOid: viewerReviews.lastReviewedOid,
      pendingReview: viewerReviews.pending,
      compare: this.compareFrom,
      syncedAt: new Date().toISOString(),
    };
    this.deps.emit({ type: 'snapshot', snapshot: this.snapshot });
    const settings = await this.deps.appState.settings();
    if (settings.aiEnabled) void this.runAi(details.headRefOid, settings.aiModel).catch(() => undefined);
  }

  /** The file list for the current comparison (all changes, or since an earlier version), with viewed states. */
  private async fileEntries(head: string): Promise<FileEntry[]> {
    const { clonePath } = this.deps;
    const local = this.compareFrom?.from === LOCAL_CHANGES;
    if (this.compareFrom && !local && !(await hasCommit(clonePath, this.compareFrom.from))) this.compareFrom = null;
    if (local) this.files = this.worktree ? await localChanges(this.worktree.path, head) : [];
    else this.files = this.compareFrom ? await this.filesSince(this.compareFrom.from, head) : this.prFiles;
    const paths = this.files.map((f) => f.path);
    const generated = await generatedFiles(clonePath, head, paths);
    const headBlobs = await blobShas(clonePath, head, paths).catch(() => new Map<string, string>());
    const viewedBlobs = await this.deps.appState.viewedBlobs(this.key);
    this.headBlobs = headBlobs;
    return this.files.map((f) => {
      let viewed: ViewedState = this.viewedStates.get(f.path) ?? 'UNVIEWED';
      const seen = viewedBlobs[f.path];
      if (viewed === 'VIEWED' && seen && headBlobs.get(f.path) && seen !== headBlobs.get(f.path)) viewed = 'DISMISSED';
      return {
        path: f.path,
        oldPath: f.oldPath,
        change: f.change,
        additions: f.additions,
        deletions: f.deletions,
        binary: f.binary,
        viewed,
        generated: generated.has(f.path),
      };
    });
  }

  private aiCacheKey(threadId: string, head: string): string {
    return `${threadId}@${head}`;
  }

  private applyAiCache(threads: ThreadView[], head: string, role: Role): ThreadView[] {
    return threads.map((t) => {
      const hit = this.aiCache.get(this.aiCacheKey(t.id, head));
      if (!hit) return t;
      const anchor: TrackedAnchor = { ...t.anchor, tier: 'ai', line: hit.line, score: hit.confidence };
      delete anchor.reason;
      delete anchor.endLine;
      return { ...t, anchor, triage: triage({ isResolved: t.isResolved, comments: t.comments, anchor, viewerIsAuthor: role === 'author' }) };
    });
  }

  /** Opt-in: one local Claude Code CLI call per refresh for outdated threads the engine could not place confidently. */
  private async runAi(head: string, model: string): Promise<void> {
    const snap = this.snapshot;
    if (!snap) return;
    const pending = snap.threads.filter(
      (t) =>
        t.isOutdated &&
        !t.fileLevel &&
        t.side === 'RIGHT' &&
        (t.anchor.tier === 'guess' || (t.anchor.tier === 'orphan' && t.anchor.reason === 'no-confident-match')) &&
        !this.aiCache.has(this.aiCacheKey(t.id, head)),
    );
    if (pending.length === 0) return;
    const candidates: AiCandidate[] = [];
    for (const t of pending.slice(0, 15)) {
      const current = await this.blobs.readLines(head, t.anchor.path);
      if (!current) continue;
      candidates.push({
        id: t.id,
        path: t.anchor.path,
        side: t.side,
        originalLine: t.originalLine ?? 1,
        diffHunk: t.diffHunk,
        comment: t.comments[0]?.body ?? '',
        predicted: Math.min(t.anchor.line ?? t.originalLine ?? 1, current.length),
        current,
      });
    }
    const placements = await placeWithClaude(candidates, model);
    for (const c of candidates) this.aiCache.set(this.aiCacheKey(c.id, head), null);
    for (const p of placements) this.aiCache.set(this.aiCacheKey(p.id, head), { line: p.line, confidence: p.confidence });
    if (this.snapshot?.details.headRefOid !== head) return;
    this.update((s) => {
      s.threads = this.applyAiCache(s.threads, head, s.role);
    });
  }

  async setThreadPlacement(threadId: string, line: number | null): Promise<void> {
    const snap = this.snapshot;
    const thread = snap?.threads.find((t) => t.id === threadId);
    if (!snap || !thread) return;
    await this.deps.appState.savePlacement(
      this.key,
      threadId,
      line === null ? null : { headOid: snap.details.headRefOid, path: thread.anchor.path, line },
    );
    await this.refresh();
  }

  private async applyPlacement(p: ManualPlacement, head: string, versions: Version[], io: ReturnType<typeof createGitTrackIO>): Promise<TrackedAnchor | null> {
    if (p.headOid === head) return { tier: 'manual', path: p.path, line: p.line };
    const lines = (await this.ensureCommit(p.headOid)) ? await this.blobs.readLines(p.headOid, p.path) : undefined;
    if (!lines) return null;
    const chain = await buildChain(this.deps.clonePath, p.headOid, head, versions);
    const r = await trackLine(io, chain, { path: p.path, line: p.line, anchor: anchorFromLines(lines, p.line, this.anchorConfig.contextLines) }, this.anchorConfig);
    if (r.tier === 'orphan') return null;
    return r.tier === 'exact' || r.tier === 'shifted' ? { ...r, tier: 'manual' } : r;
  }

  /** Files changed between an earlier version and head, limited to files the PR itself touches (hides rebase noise). */
  private async filesSince(from: string, head: string): Promise<ChangedFile[]> {
    const prPaths = new Set(this.prFiles.flatMap((f) => [f.path, ...(f.oldPath ? [f.oldPath] : [])]));
    const out = await git(this.deps.clonePath, ['diff', '-M', '--numstat', '-z', '--no-ext-diff', '--histogram', from, head]);
    const stats = parseNumstat(out);
    return this.prFiles
      .filter((f) => stats.has(f.path) || (f.oldPath !== null && stats.has(f.oldPath)))
      .map((f) => ({ ...f, ...(stats.get(f.path) ?? stats.get(f.oldPath ?? '') ?? {}) }))
      .filter((f) => prPaths.has(f.path));
  }

  /** Only the file list depends on the comparison, so switching rebuilds it locally instead of refreshing from GitHub. */
  async setCompare(from: string | null, label: string): Promise<void> {
    this.compareFrom = from ? { from, label } : null;
    // A refresh already running may have built its file list before the switch; let it finish, then rebuild.
    if (this.refreshing) await this.refreshing.catch(() => undefined);
    const snap = this.snapshot;
    if (!snap) return this.refresh();
    this.progress('Computing diff…');
    const files = await this.fileEntries(snap.details.headRefOid);
    this.update((s) => {
      s.files = files;
      s.compare = this.compareFrom;
    });
  }

  async listCommits(): Promise<CommitsData> {
    const snap = this.snapshot;
    if (!snap) return { commits: [], groups: [] };
    const { clonePath } = this.deps;
    const head = snap.details.headRefOid;
    const commits = await commitsBetween(clonePath, snap.mergeBase, head);
    const inHistory = new Set(commits.map((c) => c.sha));
    const groups: VersionGroup[] = [];
    let prev: Version | null = null;
    for (const v of snap.versions) {
      const reachable = inHistory.has(v.sha);
      let own: CommitInfo[] = [];
      let rangeDiff: VersionGroup['rangeDiff'] = null;
      if (reachable) {
        const prevInHistory = prev !== null && inHistory.has(prev.sha);
        own = (await commitsBetween(clonePath, prevInHistory ? prev!.sha : snap.mergeBase, v.sha).catch(() => [])).filter((c) => inHistory.has(c.sha));
        if (prev && !prevInHistory && (await hasCommit(clonePath, prev.sha))) rangeDiff = await rangeDiffSummary(clonePath, prev.sha, v.sha, snap.details.baseRefOid);
      }
      groups.push({ version: v, inHistory: reachable, commits: own, rangeDiff });
      prev = v;
    }
    return { commits, groups };
  }

  private async worktreeHead(path: string): Promise<string | null> {
    try {
      return (await git(path, ['rev-parse', 'HEAD'])).trim();
    } catch {
      return null;
    }
  }

  private async ensureCommit(sha: string): Promise<boolean> {
    if (await hasCommit(this.deps.clonePath, sha)) return true;
    try {
      await git(this.deps.clonePath, ['fetch', '--no-tags', this.remote, sha]);
      return await hasCommit(this.deps.clonePath, sha);
    } catch {
      return false;
    }
  }

  /**
   * Checks the pull request out as the checkout state says (see `planWorktree`). `switching`: the user asked for the
   * change, so a refusal (changes not committed, leaving the branch) is theirs to see; on a refresh the checkout stays.
   */
  private async prepareWorktree(details: PrDetails, switching = false): Promise<WorktreeState> {
    const { clonePath, appState } = this.deps;
    const plan = await this.planFor(details, this.checkout ?? 'reading');
    if (plan.kind === 'create-detached') {
      await createDetached(clonePath, plan.path, details.headRefOid);
      await appState.addOwnedWorktree(plan.path);
      return { path: plan.path, mode: 'detached', owned: true };
    }
    if (plan.kind === 'create-branch') {
      await createBranchWorktree(clonePath, this.ref.number, plan.path);
      await appState.addOwnedWorktree(plan.path);
      return { path: plan.path, mode: 'branch', owned: true };
    }
    if (plan.kind === 'attach') {
      // A fork's branch needs its remote set up for pulling and pushing, which the GitHub CLI does.
      if (details.isCrossRepository) await gh(plan.path, ['pr', 'checkout', String(this.ref.number)]);
      else await attachBranch(plan.path, this.remote, details.headRefName);
      return { path: plan.path, mode: 'branch', owned: true };
    }
    if (plan.kind === 'detach') {
      try {
        await detachAt(plan.path, details.headRefOid);
        return { path: plan.path, mode: 'detached', owned: true };
      } catch (err) {
        if (switching) throw err;
        return { path: plan.path, mode: 'branch', owned: true };
      }
    }
    if (plan.mayMove) await moveOwnedDetached(plan.path, details.headRefOid);
    return { path: plan.path, mode: plan.mode, owned: plan.owned };
  }

  private async recordVersions(headOid: string, forcePushes: { sha: string; at: string; forcePush: boolean }[]): Promise<Version[]> {
    const { appState, clonePath } = this.deps;
    const recorded = await appState.versions(this.key);
    const merged = appendVersion(mergeVersions(recorded, forcePushes), headOid, 'app', false);
    for (const v of merged) {
      if (recorded.some((r) => r.sha === v.sha && r.n === v.n)) continue;
      if (await hasCommit(clonePath, v.sha)) await pinVersion(clonePath, this.ref.number, v).catch(() => undefined);
    }
    await appState.saveVersions(this.key, merged);
    return merged;
  }

  private comments(node: ReviewThreadNode): CommentView[] {
    return node.comments.nodes.map((c) => ({
      id: c.id,
      databaseId: c.databaseId,
      author: c.author?.login ?? 'ghost',
      avatarUrl: c.author?.avatarUrl ?? null,
      body: c.body,
      bodyHTML: c.bodyHTML,
      createdAt: c.createdAt,
      url: c.url,
      viewerDidAuthor: c.viewerDidAuthor,
      pending: c.state === 'PENDING',
      edited: c.lastEditedAt != null,
      reactions: toReactions(c.reactionGroups),
      viewerCanUpdate: c.viewerCanUpdate ?? false,
    }));
  }

  /** Drafts written on an older head follow the code like threads do; ones that can't be placed block submit. */
  private async reanchorDrafts(drafts: Draft[], details: PrDetails, versions: Version[], io: ReturnType<typeof createGitTrackIO>): Promise<Draft[]> {
    const head = details.headRefOid;
    let changed = false;
    const patches = new Map<string, Record<'LEFT' | 'RIGHT', number[]>>();
    const commentable = async (path: string) => {
      if (!patches.has(path)) {
        const file = this.prFiles.find((f) => f.path === path);
        patches.set(path, file ? commentableLines(await filePatch(this.deps.clonePath, details.baseRefOid, head, file.path, file.oldPath)) : { LEFT: [], RIGHT: [] });
      }
      return patches.get(path)!;
    };
    const result: Draft[] = [];
    for (const d of drafts) {
      if (d.postedThreadId || d.headOid === head || d.subject === 'file' || d.side === 'LEFT') {
        result.push(d);
        continue;
      }
      changed = true;
      const lines = (await this.ensureCommit(d.headOid)) ? await this.blobs.readLines(d.headOid, d.path) : undefined;
      if (!lines) {
        result.push({ ...d, unplaceable: true });
        continue;
      }
      const chain = await buildChain(this.deps.clonePath, d.headOid, head, versions);
      const tracked = await trackRange(
        io,
        chain,
        {
          path: d.path,
          line: d.line,
          startLine: d.startLine ?? null,
          anchor: anchorFromLines(lines, d.line, this.anchorConfig.contextLines),
          ...(d.startLine !== undefined ? { startAnchor: anchorFromLines(lines, d.startLine, this.anchorConfig.contextLines) } : {}),
        },
        this.anchorConfig,
      );
      const end = tracked.endLine ?? tracked.line;
      const ok = tracked.tier !== 'orphan' && tracked.line !== undefined && end !== undefined && (await commentable(tracked.path)).RIGHT.includes(end);
      if (!ok) {
        result.push({ ...d, unplaceable: true });
        continue;
      }
      const next: Draft = { ...d, path: tracked.path, line: end!, headOid: head, unplaceable: false };
      if (tracked.endLine !== undefined) next.startLine = tracked.line;
      else delete next.startLine;
      result.push(next);
    }
    if (changed) await this.deps.drafts.saveAll(this.key, result);
    return result;
  }

  private async anchorThreads(nodes: ReviewThreadNode[], details: PrDetails, base: string, versions: Version[], role: Role, io: ReturnType<typeof createGitTrackIO>): Promise<ThreadView[]> {
    const dirty = this.checkout === 'editing' && this.worktree ? new Set(await dirtyFiles(this.worktree.path).catch(() => [])) : new Set<string>();
    const times = new Map<string, string | null>();
    const placements = await this.deps.appState.placements(this.key);
    const result: ThreadView[] = [];
    for (const node of nodes) {
      let anchor: TrackedAnchor;
      try {
        const placed = placements[node.id];
        anchor = (placed && (await this.applyPlacement(placed, details.headRefOid, versions, io))) || (await this.anchorFor(node, details, base, versions, io));
      } catch {
        anchor = { tier: 'orphan', reason: 'no-confident-match', path: node.path };
      }
      if (anchor.changedAt) {
        if (!times.has(anchor.changedAt)) times.set(anchor.changedAt, await commitTime(this.deps.clonePath, anchor.changedAt));
        const t = times.get(anchor.changedAt);
        if (t) anchor.changedAtTime = t;
      }
      this.headAnchors.set(node.id, anchor);
      if (dirty.has(anchor.path) && anchor.line !== undefined && node.diffSide === 'RIGHT' && this.worktree) {
        anchor = await this.composeWorktree(anchor, details.headRefOid);
      }
      const comments = this.comments(node);
      result.push({
        id: node.id,
        path: node.path,
        side: node.diffSide,
        fileLevel: node.subjectType === 'FILE' || node.originalLine === null,
        isOutdated: node.isOutdated,
        isResolved: node.isResolved,
        resolvedBy: node.resolvedBy?.login ?? null,
        viewerCanReply: node.viewerCanReply,
        viewerCanResolve: node.viewerCanResolve,
        viewerCanUnresolve: node.viewerCanUnresolve,
        line: node.line,
        startLine: node.startLine,
        originalLine: node.originalLine,
        originalStartLine: node.originalStartLine,
        originalCommit: node.comments.nodes[0]?.originalCommit?.oid ?? null,
        diffHunk: node.comments.nodes[0]?.diffHunk ?? '',
        comments,
        anchor,
        triage: triage({ isResolved: node.isResolved, comments, anchor, viewerIsAuthor: role === 'author' }),
      });
    }
    return result;
  }

  private async anchorFor(node: ReviewThreadNode, details: PrDetails, base: string, versions: Version[], io: ReturnType<typeof createGitTrackIO>): Promise<TrackedAnchor> {
    if (node.subjectType === 'FILE' || node.originalLine === null) {
      return { tier: 'orphan', reason: 'file-level-comment', path: node.path };
    }
    if (!node.isOutdated && node.line !== null) {
      const a: TrackedAnchor = { tier: 'exact', path: node.path, line: node.startLine ?? node.line };
      if (node.startLine !== null && node.startLine !== node.line) a.endLine = node.line;
      return a;
    }
    const first = node.comments.nodes[0];
    const original = first?.originalCommit?.oid ?? null;
    const diffHunk = first?.diffHunk ?? '';
    const line = node.originalLine;
    const startLine = node.originalStartLine;
    const side = node.diffSide;
    const target = side === 'RIGHT' ? details.headRefOid : base;

    let origin: { sha: string; lines: string[] } | undefined;
    if (original && (await this.ensureCommit(original))) {
      if (side === 'RIGHT') {
        origin = await pickOriginalBlob([original], (sha) => this.blobs.readLines(sha, node.path), diffHunk, side);
        if (!origin) {
          const lines = await this.blobs.readLines(original, node.path);
          if (lines) origin = { sha: original, lines };
        }
      } else {
        const candidates = [await mergeBase(this.deps.clonePath, original, details.baseRefOid), base, details.baseRefOid].filter((s): s is string => !!s);
        origin = await pickOriginalBlob([...new Set(candidates)], (sha) => this.blobs.readLines(sha, node.path), diffHunk, side);
      }
    }

    if (!origin) {
      const anchorText = anchorFromHunk(diffHunk, side, line, this.anchorConfig.contextLines);
      const lines = await this.blobs.readLines(target, node.path);
      if (!anchorText || !lines) return { tier: 'orphan', reason: 'anchor-text-unavailable', path: node.path };
      const hit = findAnchor(lines, anchorText, Math.min(line, lines.length), this.anchorConfig);
      if (!hit || hit.score < this.anchorConfig.guessThreshold) return { tier: 'orphan', reason: 'no-confident-match', path: node.path };
      const a: TrackedAnchor = { tier: hit.ambiguous || hit.score < this.anchorConfig.placeThreshold ? 'guess' : 'fuzzy', path: node.path, line: hit.line, score: hit.score };
      if (hit.ambiguous) a.ambiguous = true;
      return a;
    }

    const chain = side === 'RIGHT' ? await buildChain(this.deps.clonePath, origin.sha, target, versions) : origin.sha === target ? [target] : [origin.sha, target];
    const tracked = await trackRange(
      io,
      chain,
      {
        path: node.path,
        line,
        startLine,
        anchor: anchorFromLines(origin.lines, line, this.anchorConfig.contextLines),
        ...(startLine !== null ? { startAnchor: anchorFromLines(origin.lines, startLine, this.anchorConfig.contextLines) } : {}),
      },
      this.anchorConfig,
    );
    if (side !== 'RIGHT') return tracked;
    return recoverMoved(this.deps.clonePath, tracked, { sha: origin.sha, path: node.path, line, text: origin.lines[line - 1] ?? '' }, target);
  }

  private async composeWorktree(anchor: TrackedAnchor, headOid: string): Promise<TrackedAnchor> {
    if (!this.worktree || anchor.line === undefined) return anchor;
    const hunks = await worktreeHunks(this.worktree.path, headOid, anchor.path).catch(() => []);
    if (hunks.length === 0) return anchor;
    const end = anchor.endLine ?? anchor.line;
    const touched = touchedNewLines(hunks, anchor.line, end);
    const s = shiftLine(hunks, anchor.line);
    const e = shiftLine(hunks, end);
    const next: TrackedAnchor = { ...anchor, line: s.kind === 'mapped' ? s.line : s.predictedLine };
    if (anchor.endLine !== undefined) next.endLine = e.kind === 'mapped' ? e.line : e.predictedLine;
    if (touched) next.locallyModified = true;
    return next;
  }

  async getFileDiff(path: string): Promise<FileDiffModel | null> {
    const snap = this.snapshot;
    if (snap && this.worktree && this.compareFrom?.from === LOCAL_CHANGES) {
      // Local changes aren't on GitHub: nothing to comment on.
      const local = this.files.find((f) => f.path === path);
      if (!local) return null;
      const patch = await localPatch(this.worktree.path, snap.details.headRefOid, local.path, local.oldPath);
      return { path: local.path, oldPath: local.oldPath ?? local.path, change: local.change, patch, binary: local.binary, commentable: { LEFT: [], RIGHT: [] } };
    }
    const file = this.prFiles.find((f) => f.path === path);
    if (!snap || !file) return null;
    const prPatch = await filePatch(this.deps.clonePath, snap.details.baseRefOid, snap.details.headRefOid, file.path, file.oldPath);
    const commentable = commentableLines(prPatch);
    if (!this.compareFrom) {
      return { path: file.path, oldPath: file.oldPath ?? file.path, change: file.change, patch: prPatch, binary: file.binary, commentable };
    }
    const paths = file.oldPath && file.oldPath !== file.path ? [file.oldPath, file.path] : [file.path];
    const patch = await git(this.deps.clonePath, ['diff', '-M', '-U3', '--no-ext-diff', '--no-color', '--histogram', this.compareFrom.from, snap.details.headRefOid, '--', ...paths]);
    return { path: file.path, oldPath: file.oldPath ?? file.path, change: file.change, patch, binary: file.binary, commentable: { LEFT: [], RIGHT: commentable.RIGHT } };
  }

  async readFile(rev: 'base' | 'head' | 'worktree', path: string): Promise<FileContent> {
    const snap = this.snapshot;
    if (!snap) return { path, contents: '', binary: false, missing: true };
    if (rev === 'worktree' && this.worktree) {
      try {
        const buf = await readFile(join(this.worktree.path, path));
        const binary = isBinary(buf);
        return { path, contents: binary ? '' : buf.toString('utf8'), binary, missing: false };
      } catch {
        return { path, contents: '', binary: false, missing: true };
      }
    }
    const sha = rev === 'base' ? snap.mergeBase : snap.details.headRefOid;
    const res = await this.blobs.readText(sha, path);
    if (!res) return { path, contents: '', binary: false, missing: true };
    return { path, contents: res.text, binary: res.binary, missing: false };
  }

  /**
   * Find in files: the worktree's files on disk (the PR head, plus an author's local edits). "changed" searches the
   * files in the current comparison (All changes, or a selected range). A new search cancels the one still running.
   */
  async searchCode(query: CodeSearchQuery): Promise<CodeSearchResult> {
    this.searchAbort?.abort();
    const abort = new AbortController();
    this.searchAbort = abort;
    if (!this.worktree) return { files: [], total: 0, truncated: false, error: "The pull request's worktree isn't ready yet." };
    const paths = query.scope === 'changed' ? filterPaths(this.files.filter((f) => f.change !== 'deleted').map((f) => f.path), query.include, query.exclude) : null;
    return searchWorktree(this.worktree.path, query, paths, abort.signal);
  }

  async listAllFiles(): Promise<string[]> {
    const snap = this.snapshot;
    if (!snap) return [];
    return listFilesAt(this.deps.clonePath, snap.details.headRefOid);
  }

  private update(mutator: (s: PrSnapshot) => void): void {
    if (!this.snapshot) return;
    mutator(this.snapshot);
    this.deps.emit({ type: 'snapshot', snapshot: this.snapshot });
  }

  /**
   * Ticks (or unticks) the files' Viewed checkboxes, on screen at once and then on GitHub. Files GitHub refused go
   * back to how they were, and are returned; the others stay marked.
   */
  async setViewed(paths: string[], viewed: boolean): Promise<reviews.ViewedFailure[]> {
    const snap = this.snapshot;
    if (!snap) return [];
    const previous = new Map<string, ViewedState>(snap.files.map((f) => [f.path, f.viewed]));
    const previousStates = new Map(this.viewedStates);
    for (const p of paths) this.viewedStates.set(p, viewed ? 'VIEWED' : 'UNVIEWED');
    this.update((s) => {
      for (const f of s.files) if (paths.includes(f.path)) f.viewed = viewed ? 'VIEWED' : 'UNVIEWED';
    });
    let failed: reviews.ViewedFailure[];
    try {
      failed = await reviews.setViewed(this.deps.client, snap.details.id, paths, viewed);
    } catch (err) {
      failed = paths.map((path) => ({ path, error: err instanceof Error ? err.message : String(err) }));
    }
    const refused = new Set(failed.map((f) => f.path));
    if (refused.size > 0) {
      for (const p of refused) {
        const before = previousStates.get(p);
        if (before) this.viewedStates.set(p, before);
        else this.viewedStates.delete(p);
      }
      this.update((s) => {
        for (const f of s.files) if (refused.has(f.path)) f.viewed = previous.get(f.path) ?? f.viewed;
      });
    }
    const blobs = await this.deps.appState.viewedBlobs(this.key);
    for (const p of paths.filter((x) => !refused.has(x))) {
      const sha = this.headBlobs.get(p);
      if (viewed && sha) blobs[p] = sha;
      else delete blobs[p];
    }
    await this.deps.appState.saveViewedBlobs(this.key, blobs);
    return failed;
  }

  /** Saves a draft from the app (yours: an agent's draft you edited comes without its origin). */
  async saveDraft(draft: Draft): Promise<void> {
    await this.deps.drafts.save(this.key, draft);
    await this.showDrafts();
  }

  async deleteDraft(draftId: string): Promise<void> {
    await this.deps.drafts.remove(this.key, draftId);
    await this.showDrafts();
  }

  /** Puts the stored drafts into the snapshot. */
  private async showDrafts(): Promise<void> {
    const drafts = await this.deps.drafts.list(this.key);
    this.update((s) => {
      s.drafts = drafts;
    });
  }

  /** A draft an agent wrote (through the MCP server), on the current head; it goes out with your review. */
  async addAgentDraft(input: { path: string; side: DiffSide; line: number; startLine: number | null; body: string }, origin: DraftOrigin): Promise<Draft> {
    const snap = this.loaded();
    const draft: Draft = {
      id: randomUUID(),
      path: input.path,
      subject: 'line',
      side: input.side,
      line: input.line,
      ...(input.startLine !== null && input.startLine !== input.line ? { startLine: input.startLine } : {}),
      body: input.body,
      headOid: snap.details.headRefOid,
      createdAt: new Date().toISOString(),
      origin,
    };
    await this.deps.drafts.save(this.key, draft);
    await this.showDrafts();
    return draft;
  }

  /** Changes the text of an agent's draft (an agent revising its own comment; it keeps its origin). */
  async updateAgentDraft(id: string, body: string): Promise<Draft> {
    const draft = (await this.deps.drafts.list(this.key)).find((d) => d.id === id);
    if (!draft) throw new Error(`There is no draft ${id}.`);
    const next = { ...draft, body };
    await this.deps.drafts.save(this.key, next);
    await this.showDrafts();
    return next;
  }

  async deleteDrafts(ids: string[]): Promise<void> {
    await this.deps.drafts.saveAll(
      this.key,
      (await this.deps.drafts.list(this.key)).filter((d) => !ids.includes(d.id)),
    );
    await this.showDrafts();
  }

  /** The stored drafts (an agent's update or delete checks it may touch the draft). */
  listDrafts(): Promise<Draft[]> {
    return this.deps.drafts.list(this.key);
  }

  async reply(threadId: string, body: string): Promise<void> {
    await reviews.reply(this.deps.client, threadId, body);
    await this.refresh();
  }

  /** Edits one of the viewer's comments on GitHub and shows the result right away (triage may change with the text). */
  async editComment(kind: EditableKind, commentId: string, body: string): Promise<void> {
    const bodyHTML = await reviews.editComment(this.deps.client, kind, commentId, body);
    this.update((s) => {
      for (const t of s.threads) {
        const c = t.comments.find((x) => x.id === commentId);
        if (!c) continue;
        Object.assign(c, { body, bodyHTML, edited: true });
        t.triage = triage({ isResolved: t.isResolved, comments: t.comments, anchor: t.anchor, viewerIsAuthor: s.role === 'author' });
      }
      const item = s.conversation.find((x) => x.id === commentId);
      if (item) Object.assign(item, { body, bodyHTML });
    });
  }

  /** Toggles the viewer's reaction on a thread comment, PR comment or review, and shows it right away. */
  async react(subjectId: string, content: ReactionContent, add: boolean): Promise<void> {
    await setReaction(this.deps.client, subjectId, content, add);
    this.update((s) => {
      for (const t of s.threads) {
        const c = t.comments.find((x) => x.id === subjectId);
        if (c) c.reactions = toggleReaction(c.reactions, content, add);
      }
      const item = s.conversation.find((x) => x.id === subjectId);
      if (item) item.reactions = toggleReaction(item.reactions ?? [], content, add);
    });
  }

  async setResolved(threadId: string, resolved: boolean): Promise<void> {
    const now = await reviews.setResolved(this.deps.client, threadId, resolved);
    this.update((s) => {
      const t = s.threads.find((x) => x.id === threadId);
      if (t) {
        t.isResolved = now.isResolved;
        t.resolvedBy = now.resolvedBy?.login ?? (now.isResolved ? s.viewer : null);
        // GitHub only lets you unresolve a resolved thread (and the other way round), so these change too.
        t.viewerCanResolve = now.viewerCanResolve;
        t.viewerCanUnresolve = now.viewerCanUnresolve;
        t.triage = triage({ isResolved: now.isResolved, comments: t.comments, anchor: t.anchor, viewerIsAuthor: s.role === 'author' });
      }
    });
  }

  async submitReview(input: SubmitInput): Promise<void> {
    const snap = this.snapshot;
    if (!snap) throw new Error('PR not loaded');
    if (snap.drafts.some((d) => d.unplaceable)) {
      throw new Error('Some draft comments sit on lines that changed in a newer push. Move or delete them before submitting.');
    }
    await reviews.submitReview({
      client: this.deps.client,
      drafts: this.deps.drafts,
      prKey: this.key,
      pullRequestId: snap.details.id,
      headOid: snap.details.headRefOid,
      pendingReviewId: snap.pendingReview?.id ?? null,
      event: input.event,
      body: input.body,
    });
    await this.refresh();
  }

  async addPrComment(body: string): Promise<void> {
    const snap = this.snapshot;
    if (!snap) return;
    await reviews.addPrComment(this.deps.client, snap.details.id, body);
    await this.refresh();
  }

  /** The loaded snapshot, for changes on GitHub that need the PR's id and the head the viewer has seen. */
  private loaded(): PrSnapshot {
    if (!this.snapshot) throw new Error('The pull request is still loading.');
    return this.snapshot;
  }

  /** Syncs after a change on GitHub: after any sync already running, which may have read GitHub before the change. */
  private async resync(): Promise<void> {
    await this.refreshing?.catch(() => undefined);
    await this.refresh();
  }

  /** What merging takes (see `MergeInfo`); asks again while GitHub is still working out whether the branch merges cleanly. */
  async mergeInfo(): Promise<MergeInfo> {
    for (let attempt = 1; ; attempt++) {
      const info = await fetchMergeInfo(this.deps.client, this.ref);
      if (info.mergeable !== 'UNKNOWN' || attempt === 4) return info;
      await new Promise((resolve) => setTimeout(resolve, 1500));
    }
  }

  /**
   * Merges (or turns on auto-merge, or joins the merge queue) at the head the viewer has seen: GitHub refuses if new
   * commits came in since. Then deletes the branch if asked, and syncs.
   */
  async merge(input: MergeInput): Promise<void> {
    const snap = this.loaded();
    await mergePullRequest(this.deps.client, snap.details.id, snap.details.headRefOid, input);
    let branchError: unknown = null;
    if (input.action === 'merge' && input.deleteBranch) await deleteHeadBranch(this.deps.client, this.ref).catch((err: unknown) => (branchError = err));
    await this.resync();
    if (branchError) throw new Error(`Merged, but the branch couldn't be deleted: ${branchError instanceof Error ? branchError.message : String(branchError)}`);
  }

  async disableAutoMerge(): Promise<void> {
    await disableAutoMerge(this.deps.client, this.loaded().details.id);
    await this.resync();
  }

  async updateBranch(method: 'MERGE' | 'REBASE'): Promise<void> {
    const snap = this.loaded();
    await updateBranch(this.deps.client, snap.details.id, snap.details.headRefOid, method);
    await this.resync();
  }

  /** Closes or reopens the pull request, with a comment if there is one (before closing, after reopening). */
  async setOpen(open: boolean, comment: string): Promise<void> {
    const id = this.loaded().details.id;
    if (!open && comment.trim()) await reviews.addPrComment(this.deps.client, id, comment);
    await setPullRequestOpen(this.deps.client, id, open);
    if (open && comment.trim()) await reviews.addPrComment(this.deps.client, id, comment);
    await this.resync();
  }

  async setDraft(draft: boolean): Promise<void> {
    await setPullRequestDraft(this.deps.client, this.loaded().details.id, draft);
    await this.resync();
  }

  reviewerOptions(query: string): Promise<ReviewerOptions> {
    return fetchReviewerOptions(this.deps.client, this.ref, query);
  }

  async changeReviewRequests(add: string[], remove: string[]): Promise<void> {
    await changeReviewRequests(this.deps.client, this.ref, this.loaded().details.id, add, remove);
    await this.resync();
  }

  async requestReviews(logins: string[]): Promise<void> {
    const snap = this.snapshot;
    if (!snap) return;
    await reviews.requestReviews(this.deps.client, snap.details.id, logins);
    await this.refresh();
  }

  /** While editing: writes the last ```suggestion block of a thread into the file in the checkout. */
  async applySuggestion(threadId: string): Promise<void> {
    const snap = this.snapshot;
    const thread = snap?.threads.find((t) => t.id === threadId);
    if (!snap || !thread || !this.worktree || this.checkout !== 'editing') throw new Error('Suggestions can only be applied while you contribute on the branch.');
    if (thread.anchor.line === undefined) throw new Error('The commented lines could not be located in the current code.');
    const body = [...thread.comments].reverse().find((c) => /```suggestion/.test(c.body))?.body;
    const match = body ? /```suggestion[^\n]*\n([\s\S]*?)```/.exec(body) : null;
    if (!match) throw new Error('No suggestion found in this thread.');
    const replacement = match[1]!.replace(/\n$/, '');
    const file = join(this.worktree.path, thread.anchor.path);
    const text = await readFile(file, 'utf8');
    const lines = text.split('\n');
    const start = thread.anchor.line - 1;
    const end = (thread.anchor.endLine ?? thread.anchor.line) - 1;
    lines.splice(start, end - start + 1, ...(replacement === '' ? [] : replacement.split('\n')));
    await writeFile(file, lines.join('\n'));
    await this.refresh();
  }

  get worktreePath(): string | null {
    return this.worktree?.path ?? null;
  }

  dispose(): void {
    if (this.pollTimer) clearInterval(this.pollTimer);
    this.stopWatching();
    this.blobs.dispose();
  }
}
