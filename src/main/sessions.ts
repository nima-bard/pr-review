import { execFile } from 'node:child_process';
import { join } from 'node:path';
import { pollDeviceToken, startDeviceFlow } from '../core/github/deviceFlow';
import { TokenStore } from './tokenStore';
import type { Api, InvokeMethods, ContextMenuItem } from '../shared/ipc';
import { prKey, repoSlug, type AgentRequest, type ClaudeApp, type CodeSearchQuery, type CodeSearchResult, type Draft, type DraftOrigin, type FileDiffModel, type McpStatus, type PrSnapshot, type PrEvent, type PrRef, type BrowserExtensionInfo, type RepoMapping, type RevealTarget, type StaleWorktree, type WorktreeInfo } from '../shared/model';
import { parsePrInput } from '../shared/prInput';
import { GhTokenProvider } from '../core/github/auth';
import { endpointsFor, GitHubClient } from '../core/github/client';
import { fetchPrSummary, fetchViewer } from '../core/github/pr';
import type { ViewedFailure } from '../core/github/reviews';
import { inbox, searchPrs } from '../core/github/search';
import { filterSuggestions } from '../core/github/suggestions';
import { canonicalPath, listWorktrees, removalBlocker, removeWorktree, samePath } from '../core/git/worktrees';
import { closedPrsFor, type ClosedPr, type PrLookup } from '../core/github/closedPrs';
import { mergeMappings, remotesOf, scanRoots } from '../core/repos/registry';
import { AppState } from '../core/store/appState';
import { DraftStore } from '../core/store/drafts';
import { openInEditor } from './editor';
import { setupInfo } from './setup';
import { checkForUpdate } from './updates';
import { PrSession, type SessionEvent } from './session';
import { ActionRunner, installedTerminals, openInTerminal } from './quickActions';
import { actionEnv } from '../shared/quickActions';
import { BLOCKER_LABEL, canForceRemove } from '../shared/labels';
import type { AgentDraftInput, ReviewBridge } from '../core/agents/reviewBridge';
import { claudePointerFile, readClaudePointer, writeClaudePointer } from '../core/store/claudePointer';
import { findTool } from '../core/env';
import { claudeModels } from './agents/claudeModels';
import { startMcpServer, type RunningMcpServer } from './mcpServer';
import { McpTokenStore } from './mcpToken';
import { claudePrompt, claudeSystemPrompt, sessionTitle, type LineContext } from '../shared/agents';
import { claimSession, openElsewhere, sessionChangedAt, sessionMessages, takeFromTerminal } from './agents/claudeSessions';
import { claudeBin, startClaude } from './agents/claudeProcess';
import { openInClaude } from './agents/openClaude';
import { PrClaude } from './agents/prClaude';

export interface RegistryHost {
  userDataDir: string;
  emit(event: PrEvent): void;
  pickFolder(title: string): Promise<string | null>;
  openExternal(url: string): Promise<void>;
  popOut(key: string): void;
  contextMenu(items: ContextMenuItem[]): Promise<string | null>;
  /** Native parts (menus, window background) follow the app theme. */
  applyAppTheme(id: string): void;
  /** Shows the Chrome extension's folder in Finder, for "Load unpacked". */
  revealBrowserExtension(): void;
  /** The extension's folder and the installed browsers' extensions pages. */
  browserExtensionInfo(): Promise<BrowserExtensionInfo>;
  /** Asks a browser to open its extensions page. */
  openExtensionsPage(page: string): Promise<boolean>;
  /** Shows a file or folder in Finder. */
  showItemInFolder(path: string): void;
  /** Asks in a native dialog; true to go ahead. */
  confirm(message: string, detail: string, button: string): Promise<boolean>;
  /** A system notification while the app isn't in front; clicking it shows the pull request `url`. */
  notify(title: string, body: string, url: string): void;
  /** Puts text on the clipboard (for secrets the page mustn't see). */
  copyText(text: string): void;
  /** Brings the window showing PR `key` to the front (its own window, or the main one). */
  showPr(key: string): void;
}

/** How often open PRs' Claude sessions are looked at (each reads every few seconds unless someone is answering). */
const CLAUDE_TICK_MS = 1000;

const errorMessage = (err: unknown) => (err instanceof Error ? err.message : String(err));

/** Runs the claude CLI; resolves with its output, or rejects with what it printed. */
function claude(args: string[]): Promise<string> {
  return new Promise((resolve, reject) =>
    execFile(claudeBin(), args, { timeout: 30_000 }, (err, out, stderr) => (err ? reject(new Error(stderr.trim() || err.message)) : resolve(out))),
  );
}

export class SessionRegistry implements ReviewBridge {
  readonly appState: AppState;
  private readonly drafts: DraftStore;
  private readonly sessions = new Map<string, PrSession>();
  private readonly opening = new Map<string, Promise<void>>();
  private readonly clients = new Map<string, GitHubClient>();
  private readonly viewers = new Map<string, Promise<{ login: string; avatarUrl: string | null }>>();
  private scanned = false;

  private readonly tokens: TokenStore;
  private readonly mcpTokens: McpTokenStore;
  private mcp: RunningMcpServer | null = null;

  /** Each open PR's Claude: its dedicated Claude Code session (Settings › Claude). */
  private readonly claude = new Map<string, PrClaude>();

  /** Background quick actions. When one ends: a notification, and a sync, since it may have changed the PR on GitHub. */
  private readonly actions = new ActionRunner(
    (key, run) => this.host.emit({ type: 'action', key, run }),
    (key, run) => {
      const snap = this.sessions.get(key)?.current;
      const outcome = run.status === 'succeeded' ? 'finished' : run.status === 'stopped' ? 'was stopped' : `failed${run.exitCode !== null ? ` (exit ${run.exitCode})` : ''}`;
      if (snap) this.host.notify(`${run.name} ${outcome}`, `${snap.ref.owner}/${snap.ref.repo} #${snap.ref.number}: ${snap.details.title}`, snap.details.url);
      void this.sessions.get(key)?.refresh().catch(() => undefined);
    },
  );

  constructor(private readonly host: RegistryHost) {
    this.appState = new AppState(host.userDataDir);
    this.drafts = new DraftStore((key) => this.appState.draftsFile(key));
    this.tokens = new TokenStore(host.userDataDir);
    this.mcpTokens = new McpTokenStore(host.userDataDir);
    // Open PRs' Claude sessions: what's asked here, in Claude Desktop or in Claude Code shows as it happens.
    this.claudeTimer = setInterval(() => {
      for (const c of this.claude.values()) void c.refresh().catch(() => undefined);
    }, CLAUDE_TICK_MS);
    this.claudeTimer.unref();
  }

  private readonly claudeTimer: NodeJS.Timeout;

  /** Starts the PR Review MCP server (again, after the port or token changed). */
  async startMcp(): Promise<void> {
    this.mcp?.close();
    const { mcpPort } = await this.appState.settings();
    this.mcp = startMcpServer(this, mcpPort, await this.mcpTokens.get());
  }

  stopMcp(): void {
    this.mcp?.close();
    this.mcp = null;
  }

  private async mcpUrl(): Promise<string> {
    return this.mcp?.url ?? `http://127.0.0.1:${(await this.appState.settings()).mcpPort}/mcp`;
  }

  /** What a line ask carries: the asked lines (from the head, or the base for old lines) and the threads on them. */
  private async lineContext(session: PrSession, target: NonNullable<AgentRequest['target']>): Promise<LineContext> {
    const file = await session.readFile(target.side === 'LEFT' ? 'base' : 'head', target.path);
    const code = file.missing || file.binary ? null : file.contents.split('\n').slice(target.startLine - 1, target.endLine).join('\n');
    const threads = (session.current?.threads ?? []).filter((t) => {
      const start = t.anchor.line;
      const end = t.anchor.endLine ?? start;
      return t.path === target.path && t.side === target.side && start !== undefined && end !== undefined && start <= target.endLine && end >= target.startLine;
    });
    return { code, threads: threads.flatMap((t) => t.comments.map((c) => ({ author: c.author, body: c.body }))) };
  }

  /** What a question carries: a line ask its lines and their threads; a thread ask that whole thread and its lines' code. */
  private async requestContext(session: PrSession, request: AgentRequest): Promise<LineContext | null> {
    if (request.kind === 'lines' && request.target) return this.lineContext(session, request.target);
    if (request.kind !== 'thread' || !request.thread) return null;
    const thread = session.current?.threads.find((t) => t.id === request.thread?.id);
    const code = request.target ? (await this.lineContext(session, request.target)).code : null;
    return { code, threads: (thread?.comments ?? []).map((c) => ({ author: c.author, body: c.body })) };
  }

  /** The PR's Claude, made when first needed: the PR must be loaded, since its session lives in the worktree. */
  private claudeFor(key: string): PrClaude {
    const existing = this.claude.get(key);
    if (existing) return existing;
    const session = this.session(key);
    if (!session.current) throw new Error('The pull request is still loading.');
    const pointerFile = () => claudePointerFile(session.current?.worktree.path ?? '', key);
    const claude: PrClaude = new PrClaude({
      prepare: async (request) => {
        const snap = session.current;
        if (!snap) throw new Error('The pull request is still loading.');
        const context = await this.requestContext(session, request);
        return {
          worktree: snap.worktree.path,
          env: actionEnv(snap),
          title: sessionTitle(String(snap.ref.number), snap.details.title),
          prompt: claudePrompt(request, context),
          systemPrompt: claudeSystemPrompt(snap),
        };
      },
      worktree: () => session.current?.worktree.path ?? null,
      settings: async () => (await this.appState.settings()).claude,
      mcp: async () => ({ url: await this.mcpUrl(), headers: { Authorization: `Bearer ${await this.mcpTokens.get()}`, 'X-PR-Review-Agent': 'Claude' } }),
      pointer: { read: async () => readClaudePointer(await pointerFile()), write: async (pointer) => writeClaudePointer(await pointerFile(), pointer) },
      session: { changedAt: sessionChangedAt, messages: sessionMessages },
      elsewhere: (id) => openElsewhere(id),
      claim: (id) => claimSession(id),
      takeFromTerminal: (id) => takeFromTerminal(id),
      start: (options) => startClaude(options),
      emit: (view) => {
        if (this.claude.get(key) === claude) this.host.emit({ type: 'claude', key, view });
      },
    });
    this.claude.set(key, claude);
    void claude.refresh(true);
    return claude;
  }

  /**
   * Opens the PR's Claude session in Claude Desktop or Claude Code: always the same one, named after the PR. The
   * app's own Claude lets go of it first; it takes it back for the next question.
   */
  private async openClaudeIn(key: string, app: ClaudeApp): Promise<void> {
    const snap = this.session(key).current;
    if (!snap) throw new Error('The pull request is still loading.');
    const claude = this.claudeFor(key);
    const sessionId = await claude.sessionId();
    if (!sessionId || (await sessionChangedAt(sessionId, snap.worktree.path)) === undefined) throw new Error('This pull request has no Claude session yet. Ask Claude something here first; that starts it.');
    if (!(await claude.release())) throw new Error('Claude is answering a question from PR Review. Open the session when it’s done, or stop it.');
    const title = sessionTitle(String(snap.ref.number), snap.details.title) ?? key;
    await openInClaude(app, { sessionId, worktree: snap.worktree.path, env: actionEnv(snap), name: `Claude · ${title}`, terminalApp: (await this.appState.settings()).terminalApp });
    void claude.refresh(true);
  }

  private async mcpStatus(): Promise<McpStatus> {
    const { mcpPort } = await this.appState.settings();
    const installed = process.env.PR_REVIEW_CLAUDE !== undefined || (await findTool('claude')) !== null;
    const registered = installed && (await claude(['mcp', 'get', 'pr-review']).then(() => true, () => false));
    const error = this.mcp ? this.mcp.error() : 'The MCP server is not running.';
    return { running: this.mcp !== null && error === null, url: this.mcp?.url ?? `http://127.0.0.1:${mcpPort}/mcp`, error, claudeInstalled: installed, claudeCodeRegistered: registered };
  }

  /**
   * Registers the MCP server with Claude Code for every project (user scope), replacing an older registration. The
   * Connect Claude Code click in Settings › Claude is the go-ahead.
   */
  private async connectClaudeCode(): Promise<void> {
    if (!process.env.PR_REVIEW_CLAUDE && !(await findTool('claude'))) throw new Error('Claude Code is not installed. Install it from https://code.claude.com, then try again.');
    const url = await this.mcpUrl();
    await claude(['mcp', 'remove', '-s', 'user', 'pr-review']).catch(() => undefined);
    await claude(['mcp', 'add', '--transport', 'http', '-s', 'user', 'pr-review', url, '-H', `Authorization: Bearer ${await this.mcpTokens.get()}`]);
  }

  /** The PR for an MCP tool's `pr` argument (a key, URL or owner/repo#n), loaded. */
  private bridgeSession(pr: string): PrSession {
    const ref = parsePrInput(pr);
    const session = ref ? this.sessions.get(prKey(ref)) : undefined;
    if (!session?.current) throw new Error(`Open ${pr} in PR Review first (list_open_prs shows the open pull requests).`);
    return session;
  }

  openPrs(): { key: string; url: string; title: string; worktree: string }[] {
    return [...this.sessions.values()].flatMap((s) => (s.current ? [{ key: s.key, url: s.current.details.url, title: s.current.details.title, worktree: s.current.worktree.path }] : []));
  }

  snapshot(pr: string): PrSnapshot {
    return this.bridgeSession(pr).current!;
  }

  fileDiff(pr: string, path: string): Promise<FileDiffModel | null> {
    return this.bridgeSession(pr).getFileDiff(path);
  }

  async addDraft(pr: string, input: AgentDraftInput, origin: DraftOrigin): Promise<Draft> {
    const session = this.bridgeSession(pr);
    return session.addAgentDraft(input, origin);
  }

  updateDraft(pr: string, id: string, body: string): Promise<Draft> {
    return this.bridgeSession(pr).updateAgentDraft(id, body);
  }

  deleteDraft(pr: string, id: string): Promise<void> {
    return this.bridgeSession(pr).deleteDraft(id);
  }

  setViewed(pr: string, paths: string[], viewed: boolean): Promise<ViewedFailure[]> {
    return this.bridgeSession(pr).setViewed(paths, viewed);
  }

  searchCode(pr: string, query: CodeSearchQuery): Promise<CodeSearchResult> {
    return this.bridgeSession(pr).searchCode(query);
  }

  allFiles(pr: string): Promise<string[]> {
    return this.bridgeSession(pr).listAllFiles();
  }

  reveal(pr: string, target: RevealTarget): void {
    const { key } = this.bridgeSession(pr);
    this.host.emit({ type: 'reveal', key, target });
    this.host.showPr(key);
  }

  /** Stops the background quick actions and the PRs' Claude (the app is quitting). */
  stopActions(): void {
    clearInterval(this.claudeTimer);
    this.actions.stopAll();
    for (const c of this.claude.values()) c.kill();
    this.claude.clear();
  }

  private resetAuth(host: string): void {
    this.clients.delete(host);
    this.viewers.delete(host);
  }

  private async ghWorks(host: string): Promise<boolean> {
    return new Promise((resolve) => execFile('gh', ['auth', 'token', '--hostname', host], { timeout: 10_000 }, (err, out) => resolve(!err && out.trim() !== '')));
  }

  private client(host: string): GitHubClient {
    let c = this.clients.get(host);
    if (!c) {
      const mockApi = process.env.PR_REVIEW_API;
      const endpoints = mockApi ? { graphql: `${mockApi}/graphql`, rest: mockApi, web: mockApi } : endpointsFor(host);
      c = new GitHubClient(new GhTokenProvider(host, process.env.PR_REVIEW_TOKEN, () => this.tokens.get(host)), endpoints);
      this.clients.set(host, c);
    }
    return c;
  }

  private viewer(host: string): Promise<{ login: string; avatarUrl: string | null }> {
    let v = this.viewers.get(host);
    if (!v) {
      v = fetchViewer(this.client(host)).catch((err: unknown) => {
        this.viewers.delete(host);
        throw err;
      });
      this.viewers.set(host, v);
    }
    return v;
  }

  async repoMappings(rescan = false): Promise<RepoMapping[]> {
    const current = await this.appState.repos();
    if (!rescan && this.scanned) return current;
    const settings = await this.appState.settings();
    const merged = mergeMappings(
      current.filter((m) => m.source === 'manual'),
      await scanRoots(settings.scanRoots),
    );
    await this.appState.saveRepos(merged);
    this.scanned = true;
    return merged;
  }

  private async clonePathFor(ref: PrRef): Promise<string | null> {
    const slug = repoSlug(ref);
    let mapping = (await this.appState.repos()).find((m) => m.slug === slug);
    if (!mapping) mapping = (await this.repoMappings(true)).find((m) => m.slug === slug);
    return mapping?.path ?? null;
  }

  /**
   * Passes a session's events on with its PR's key, while it's the open session for that PR: a closed one can still
   * be loading, and its late snapshot would bring the closed PR back (and show it, stale, if it's opened again).
   */
  private emitFor(key: string, session: () => PrSession) {
    return (e: SessionEvent) => {
      if (this.sessions.get(key) === session()) this.host.emit({ ...e, key } as PrEvent);
    };
  }

  private session(key: string): PrSession {
    const s = this.sessions.get(key);
    if (!s) throw new Error('This pull request is not open.');
    return s;
  }

  disposeAll(): void {
    for (const s of this.sessions.values()) s.dispose();
    this.sessions.clear();
    for (const c of this.claude.values()) c.dispose();
    this.claude.clear();
  }

  /** Every worktree of the mapped repositories (each clone's own checkout first, as `isPrimary`). */
  private async allWorktrees(): Promise<WorktreeInfo[]> {
        const repos = await this.repoMappings();
        const owned = await this.appState.ownedWorktrees();
        const byPath = new Map<string, RepoMapping[]>();
        for (const r of repos) byPath.set(r.path, [...(byPath.get(r.path) ?? []), r]);
        const result: WorktreeInfo[] = [];
        for (const [repoPath, mappings] of byPath) {
          let list;
          try {
            list = await listWorktrees(repoPath);
          } catch {
            continue;
          }
          list.forEach((w, i) => {
            const pr = /pr-(\d+)$/.exec(w.path);
            result.push({
              repoPath,
              slug: mappings[0]?.slug ?? null,
              path: w.path,
              head: w.head,
              branch: w.branch,
              detached: w.detached,
              locked: w.locked,
              owned: owned.some((o) => samePath(o, w.path)),
              prNumber: pr ? Number(pr[1]) : null,
              isPrimary: i === 0,
            });
          });
        }
        return result;
      }

  /**
   * Worktrees whose pull request is merged or closed (one GraphQL query per repository), for the New tab's clean-up.
   * PR Review's own are matched by the number in their name, any other by the PR branch it has checked out; the
   * clone itself never. `keep` says why one can't simply be removed (`removalBlocker`).
   */
  private async staleWorktrees(): Promise<StaleWorktree[]> {
    const lookupOf = (w: WorktreeInfo): PrLookup | null =>
      w.owned && w.prNumber !== null ? { number: w.prNumber } : w.branch ? { branch: w.branch } : w.prNumber !== null ? { number: w.prNumber } : null;
    const candidates = (await this.allWorktrees()).filter((w) => !w.isPrimary && w.slug !== null && lookupOf(w) !== null);
    const bySlug = new Map<string, WorktreeInfo[]>();
    for (const w of candidates) bySlug.set(w.slug!, [...(bySlug.get(w.slug!) ?? []), w]);
    const out: StaleWorktree[] = [];
    for (const [slug, list] of bySlug) {
      const [owner = '', repo = ''] = slug.split('/');
      let prs: (ClosedPr | null)[];
      try {
        prs = await closedPrsFor(this.client('github.com'), owner, repo, list.map((w) => lookupOf(w)!));
      } catch {
        continue;
      }
      for (const [i, w] of list.entries()) {
        const pr = prs[i];
        if (!pr) continue;
        const key = prKey({ host: 'github.com', owner, repo, number: pr.number });
        out.push({ worktree: w, key, ...pr, keep: await removalBlocker(w), open: this.sessions.has(key) });
      }
    }
    return out;
  }

  /** Ends the sessions of `key` and of any PR shown from the worktree at `path`, and tells every window to close their tabs. */
  private closeSessionsAt(path: string, key: string): void {
    for (const [k, s] of [...this.sessions]) {
      if (k !== key && !(s.worktreePath && samePath(s.worktreePath, path))) continue;
      s.dispose();
      this.sessions.delete(k);
      this.host.emit({ type: 'closed', key: k });
    }
    this.host.emit({ type: 'closed', key });
  }

  api(): Pick<Api, InvokeMethods> {
    return {
      openPr: async (input) => {
        const ref = parsePrInput(input);
        if (!ref) return { ok: false, reason: 'bad-input', message: 'Paste a pull request URL or owner/repo#number.' };
        const key = prKey(ref);
        if (this.sessions.has(key)) return { ok: true, key };
        const clonePath = await this.clonePathFor(ref);
        if (!clonePath) {
          return { ok: false, reason: 'no-clone', message: `No local clone of ${ref.owner}/${ref.repo} found.`, ref };
        }
        try {
          const viewer = await this.viewer(ref.host);
          const session = new PrSession(ref, {
            appState: this.appState,
            drafts: this.drafts,
            client: this.client(ref.host),
            viewer: viewer.login,
            viewerAvatarUrl: viewer.avatarUrl,
            clonePath,
            emit: this.emitFor(key, () => session),
          });
          this.sessions.set(key, session);
          const opening = session.open().catch((err: unknown) => {
            this.host.emit({ type: 'error', key, message: errorMessage(err) });
          });
          this.opening.set(key, opening);
          void opening.finally(() => this.opening.delete(key));
          return { ok: true, key };
        } catch (err) {
          return { ok: false, reason: 'error', message: errorMessage(err), ref };
        }
      },
      prSummary: async (input) => {
        const ref = parsePrInput(input);
        if (!ref) return null;
        try {
          return await fetchPrSummary(this.client(ref.host), ref);
        } catch {
          return null;
        }
      },
      closePr: async (key) => {
        this.sessions.get(key)?.dispose();
        this.sessions.delete(key);
        this.claude.get(key)?.dispose();
        this.claude.delete(key);
      },
      getSnapshot: async (key) => this.sessions.get(key)?.current ?? null,
      checkPr: async (key) => {
        await this.sessions
          .get(key)
          ?.check()
          .catch(() => undefined);
      },
      refreshPr: async (key) => {
        await this.session(key)
          .refresh()
          .catch((err: unknown) => this.host.emit({ type: 'error', key, message: errorMessage(err) }));
      },
      getFileDiff: (key, path) => this.session(key).getFileDiff(path),
      readFile: (key, rev, path) => this.session(key).readFile(rev, path),
      listAllFiles: (key) => this.session(key).listAllFiles(),
      searchCode: (key, query) => this.session(key).searchCode(query),
      setViewed: async (key, paths, viewed) => {
        const failed = await this.session(key).setViewed(paths, viewed);
        if (failed.length > 0) throw new Error(`GitHub didn’t mark ${failed.map((f) => f.path).join(', ')}: ${failed[0]!.error}`);
      },
      saveDraft: (key, draft) => this.session(key).saveDraft(draft),
      deleteDraft: (key, id) => this.session(key).deleteDraft(id),
      deleteDrafts: (key, ids) => this.session(key).deleteDrafts(ids),
      reply: (key, threadId, body) => this.session(key).reply(threadId, body),
      setResolved: (key, threadId, resolved) => this.session(key).setResolved(threadId, resolved),
      react: (key, subjectId, content, add) => this.session(key).react(subjectId, content, add),
      editComment: (key, kind, commentId, body) => this.session(key).editComment(kind, commentId, body),
      submitReview: (key, input) => this.session(key).submitReview(input),
      addPrComment: (key, body) => this.session(key).addPrComment(body),
      requestReviews: (key, logins) => this.session(key).requestReviews(logins),
      terminalApps: () => installedTerminals(),
      runQuickAction: async (key, actionId, file) => {
        const settings = await this.appState.settings();
        const action = settings.quickActions.find((a) => a.id === actionId);
        if (!action) throw new Error('This quick action no longer exists. Check Settings › Quick actions.');
        const snap = this.session(key).current;
        if (!snap) throw new Error('The pull request is still loading.');
        if (action.mode === 'background' && !action.command.trim()) throw new Error(`“${action.name}” has no command to run.`);
        const where = action.mode === 'terminal' ? 'in a terminal' : 'in the background';
        if (action.confirm && !(await this.host.confirm(`Run “${action.name}” ${where}?`, `${action.command || '(opens a shell)'}\n\nIn ${snap.worktree.path}`, 'Run'))) return;
        const env = actionEnv(snap, file);
        if (action.mode === 'terminal') await openInTerminal(settings.terminalApp, snap.worktree.path, env, action.command, action.name);
        else this.actions.start(key, action, snap.worktree.path, env, file);
      },
      stopQuickAction: async (runId) => this.actions.stop(runId),
      dismissQuickActionRun: async (runId) => this.actions.dismiss(runId),
      quickActionRuns: async (key) => this.actions.list(key),
      mergeInfo: (key) => this.session(key).mergeInfo(),
      mergePr: (key, input) => this.session(key).merge(input),
      disableAutoMerge: (key) => this.session(key).disableAutoMerge(),
      updateBranch: (key, method) => this.session(key).updateBranch(method),
      setPrOpen: (key, open, comment) => this.session(key).setOpen(open, comment),
      setPrDraft: (key, draft) => this.session(key).setDraft(draft),
      reviewerOptions: (key, query) => this.session(key).reviewerOptions(query),
      changeReviewRequests: (key, add, remove) => this.session(key).changeReviewRequests(add, remove),
      applySuggestion: (key, threadId) => this.session(key).applySuggestion(threadId),
      setThreadPlacement: (key, threadId, line) => this.session(key).setThreadPlacement(threadId, line),
      listCommits: (key) => this.session(key).listCommits(),
      setCompare: (key, from, label) => this.session(key).setCompare(from, label),
      search: (query, after) => searchPrs(this.client('github.com'), 'github.com', query, after),
      filterSuggestions: async (repo, kind, query) => {
        const [owner, name] = repo.split('/');
        return owner && name ? filterSuggestions(this.client('github.com'), owner, name, kind, query) : [];
      },
      inbox: () => inbox(this.client('github.com'), 'github.com'),
      listWorktrees: () => this.allWorktrees(),
      staleWorktrees: () => this.staleWorktrees(),
      removeWorktree: async (repoPath, path) => {
        await removeWorktree(repoPath, path);
        await this.appState.removeOwnedWorktree(path);
      },
      worktreeRemoval: async (key) => {
        const snap = this.sessions.get(key)?.current;
        if (!snap) return null;
        const list = await listWorktrees(snap.clonePath).catch(() => []);
        const index = list.findIndex((w) => samePath(w.path, canonicalPath(snap.worktree.path)));
        const wt = list[index];
        if (!wt || index === 0) return null;
        const owned = (await this.appState.ownedWorktrees()).some((p) => samePath(p, wt.path));
        return { repoPath: snap.clonePath, path: wt.path, owned, branch: wt.branch, blocker: await removalBlocker(wt) };
      },
      removePrWorktree: async (repoPath, path, key, force = false) => {
        const list = await listWorktrees(repoPath);
        const index = list.findIndex((w) => samePath(w.path, canonicalPath(path)));
        const wt = list[index];
        if (!wt) throw new Error(`There’s no worktree at ${path} any more.`);
        if (index === 0) throw new Error(`${path} is the clone itself, not a worktree.`);
        const blocker = await removalBlocker(wt);
        if (blocker && !(force && canForceRemove(blocker))) throw new Error(`${path} can’t be removed: ${BLOCKER_LABEL[blocker].toLowerCase()}.`);
        await removeWorktree(repoPath, wt.path, blocker !== null);
        await this.appState.removeOwnedWorktree(path);
        if (!samePath(path, wt.path)) await this.appState.removeOwnedWorktree(wt.path);
        this.closeSessionsAt(wt.path, key);
      },
      listRepos: () => this.repoMappings(),
      rescanRepos: () => this.repoMappings(true),
      mapRepo: async (slug) => {
        const dir = await this.host.pickFolder(`Select your local clone of ${slug}`);
        if (!dir) return null;
        const remotes = await remotesOf(dir);
        if (!remotes.some((r) => `${r.info.owner}/${r.info.repo}`.toLowerCase() === slug.toLowerCase())) {
          throw new Error(`${dir} has no remote pointing at ${slug}.`);
        }
        const mapping: RepoMapping = { slug: slug.toLowerCase(), path: dir, source: 'manual' };
        const repos = (await this.appState.repos()).filter((m) => m.slug !== mapping.slug);
        await this.appState.saveRepos([mapping, ...repos]);
        return mapping;
      },
      getSettings: () => this.appState.settings(),
      saveSettings: async (settings) => {
        const { mcpPort } = await this.appState.settings();
        await this.appState.saveSettings(settings);
        this.host.applyAppTheme(settings.appTheme);
        if (settings.mcpPort !== mcpPort) await this.startMcp();
      },
      openInEditor: async (key, path, line) => {
        const s = this.session(key);
        const settings = await this.appState.settings();
        await openInEditor(settings.editorCommand, s.worktreePath ?? s.current?.clonePath ?? '', path, line);
      },
      openExternal: (url) => this.host.openExternal(url),
      revealBrowserExtension: async () => this.host.revealBrowserExtension(),
      browserExtensionInfo: () => this.host.browserExtensionInfo(),
      openExtensionsPage: (page) => this.host.openExtensionsPage(page),
      showInFinder: async (key, path) => {
        const root = this.session(key).current?.worktree.path;
        if (root) this.host.showItemInFolder(join(root, path));
      },
      setupInfo: () => setupInfo(),
      checkForUpdate: () => checkForUpdate(),
      pickFolder: (title) => this.host.pickFolder(title),
      getOpenTabs: () => this.appState.openTabs(),
      saveOpenTabs: (inputs) => this.appState.saveOpenTabs(inputs),
      popOut: async (key) => {
        this.session(key);
        this.host.popOut(key);
      },
      contextMenu: (items) => this.host.contextMenu(items),
      askClaude: async (key, request) => this.claudeFor(key).ask(request),
      cancelClaudeRequest: async (key, pendingId) => this.claudeFor(key).cancel(pendingId),
      retryClaudeRequest: async (key, pendingId) => this.claudeFor(key).retry(pendingId),
      stopClaude: async (key) => this.claudeFor(key).stop(),
      takeClaudeSession: (key) => this.claudeFor(key).takeOver(),
      claudeView: async (key) => (this.session(key).current && (await this.appState.settings()).claude.enabled ? this.claudeFor(key).view() : null),
      openClaudeIn: (key, app) => this.openClaudeIn(key, app),
      hideAskMarker: (key, exchangeId) => this.claudeFor(key).hideMarker(exchangeId),
      dismissClaudeOffer: (key, exchangeId) => this.claudeFor(key).dismissOffer(exchangeId),
      chooseClaudeModel: (key, choice) => this.claudeFor(key).chooseModel(choice),
      claudeModels: () => claudeModels(),
      mcpStatus: () => this.mcpStatus(),
      connectClaudeCode: () => this.connectClaudeCode(),
      copyMcpClientConfig: async () => {
        const server = { type: 'http', url: await this.mcpUrl(), headers: { Authorization: `Bearer ${await this.mcpTokens.get()}` } };
        this.host.copyText(JSON.stringify({ mcpServers: { 'pr-review': server } }, null, 2));
      },
      resetMcpToken: async () => {
        await this.mcpTokens.reset();
        await this.startMcp();
      },
      authStatus: async () => {
        const host = 'github.com';
        const via = (await this.ghWorks(host)) ? 'gh' : (await this.tokens.get(host)) ? 'device' : 'none';
        if (via === 'none') return { via, login: null, error: null };
        try {
          return { via, login: (await this.viewer(host)).login, error: null };
        } catch (err) {
          return { via, login: null, error: errorMessage(err) };
        }
      },
      deviceLogin: async () => {
        const host = 'github.com';
        const { oauthClientId } = await this.appState.settings();
        if (!oauthClientId) throw new Error('Add the client ID of your GitHub OAuth App (with device flow enabled) first.');
        const code = await startDeviceFlow(host, oauthClientId);
        await this.host.openExternal(code.verificationUri);
        void pollDeviceToken(host, oauthClientId, code)
          .then(async (token) => {
            await this.tokens.set(host, token);
            this.resetAuth(host);
          })
          .catch(() => undefined);
        return { userCode: code.userCode, verificationUri: code.verificationUri };
      },
      signOutDevice: async () => {
        await this.tokens.clear('github.com');
        this.resetAuth('github.com');
      },
    };
  }
}

export const userDataSubdir = (base: string) => join(base, 'pr-review');
