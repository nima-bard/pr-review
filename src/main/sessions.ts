import { execFile } from 'node:child_process';
import { join } from 'node:path';
import { pollDeviceToken, startDeviceFlow } from '../core/github/deviceFlow';
import { TokenStore } from './tokenStore';
import type { Api, InvokeMethods, ContextMenuItem } from '../shared/ipc';
import { prKey, repoSlug, type AgentConnector, type AgentRequest, type Draft, type DraftOrigin, type FileDiffModel, type McpStatus, type PrSnapshot, type PrEvent, type PrRef, type BrowserExtensionInfo, type RepoMapping, type StaleWorktree, type WorktreeInfo } from '../shared/model';
import { parsePrInput } from '../shared/prInput';
import { GhTokenProvider } from '../core/github/auth';
import { endpointsFor, GitHubClient } from '../core/github/client';
import { fetchPrSummary, fetchViewer } from '../core/github/pr';
import { inbox, searchPrs } from '../core/github/search';
import { git } from '../core/git/exec';
import { listWorktrees, removeWorktree, samePath } from '../core/git/worktrees';
import { mergeMappings, remotesOf, scanRoots } from '../core/repos/registry';
import { AppState } from '../core/store/appState';
import { DraftStore } from '../core/store/drafts';
import { openInEditor } from './editor';
import { setupInfo } from './setup';
import { checkForUpdate } from './updates';
import { PrSession, type SessionEvent } from './session';
import { ActionRunner, installedTerminals, openInTerminal } from './quickActions';
import { actionEnv } from '../shared/quickActions';
import type { AgentDraftInput, ReviewBridge } from '../core/agents/reviewBridge';
import { findTool } from '../core/env';
import { startMcpServer, type ChannelBridge, type RunningMcpServer } from './mcpServer';
import { McpTokenStore } from './mcpToken';
import { agentPrompt, type LineContext } from '../shared/agents';
import { AgentRunner } from './agents/agentRunner';
import { claudeCode } from './agents/claudeCode';
import { claudeDesktop } from './agents/claudeDesktop';
import { claudeTerminal } from './agents/claudeTerminal';
import { commandConnector } from './agents/command';
import { claudeBin, type Connector } from './agents/connector';

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
  /** Opens a Claude Desktop link; only `claude://code/new?…` links are accepted. */
  openClaudeLink(url: string): Promise<void>;
}

const errorMessage = (err: unknown) => (err instanceof Error ? err.message : String(err));

/** Runs the claude CLI; resolves with its output, or rejects with what it printed. */
function claude(args: string[]): Promise<string> {
  return new Promise((resolve, reject) =>
    execFile(claudeBin(), args, { timeout: 30_000 }, (err, out, stderr) => (err ? reject(new Error(stderr.trim() || err.message)) : resolve(out))),
  );
}

export class SessionRegistry implements ChannelBridge {
  readonly appState: AppState;
  private readonly drafts: DraftStore;
  private readonly sessions = new Map<string, PrSession>();
  private readonly opening = new Map<string, Promise<void>>();
  private readonly clients = new Map<string, GitHubClient>();
  private readonly viewers = new Map<string, Promise<string>>();
  private scanned = false;

  private readonly tokens: TokenStore;
  private readonly mcpTokens: McpTokenStore;
  private mcp: RunningMcpServer | null = null;

  /** Each PR's agent conversation (Settings › Agents). */
  private readonly agents: AgentRunner;

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
    this.agents = new AgentRunner({
      appState: this.appState,
      emit: (key, session) => this.host.emit({ type: 'agent', key, session }),
      connector: (kind) => this.connector(kind),
      prepare: async (key, request) => {
        const session = this.session(key);
        const snap = session.current;
        if (!snap) throw new Error('The pull request is still loading.');
        const context = request.kind === 'lines' && request.target ? await this.lineContext(session, request.target) : null;
        return { worktree: snap.worktree.path, env: actionEnv(snap), prompt: agentPrompt(snap, request, context) };
      },
      mcp: async () => ({ url: await this.mcpUrl(), token: await this.mcpTokens.get() }),
    });
  }

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

  private connector(kind: AgentConnector['kind']): Connector {
    switch (kind) {
      case 'claude-code':
        return claudeCode;
      case 'claude-desktop':
        return claudeDesktop((url) => this.host.openClaudeLink(url));
      case 'claude-terminal':
        return claudeTerminal({
          openTerminal: async (cwd, env, command, name) => openInTerminal((await this.appState.settings()).terminalApp, cwd, env, command, name),
          channelConnected: (key) => this.mcp?.channelConnected(key) ?? false,
          push: async (key, turnId, content, meta) => {
            if (!this.mcp) throw new Error('The MCP server is not running. Check Settings › Agents.');
            await this.mcp.push(key, turnId, content, meta);
          },
        });
      case 'command':
        return commandConnector;
    }
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

  agentReply(pr: string, turnId: string, text: string): Promise<void> {
    return this.agents.agentReply(this.bridgeSession(pr).key, turnId, text);
  }

  /** Opens the PR's Claude Code session in Claude Desktop; the app's next request then starts a branch (--fork-session). */
  private async openAgentInDesktop(key: string): Promise<void> {
    const cwd = this.session(key).current?.worktree.path;
    const id = await this.agents.desktopSession(key);
    await new Promise<void>((resolve, reject) =>
      execFile(claudeBin(), ['--desktop', '--resume', id], { cwd, timeout: 30_000 }, (err, _out, stderr) =>
        err ? reject(new Error(`Could not open the session in Claude Desktop: ${stderr.trim() || err.message}. Claude Desktop needs Claude Code 2.1.285 or later and a subscription sign-in.`)) : resolve(),
      ),
    );
    await this.agents.markContinuedInDesktop(key);
  }

  private async mcpStatus(): Promise<McpStatus> {
    const { mcpPort } = await this.appState.settings();
    const installed = process.env.PR_REVIEW_CLAUDE !== undefined || (await findTool('claude')) !== null;
    const registered = installed && (await claude(['mcp', 'get', 'pr-review']).then(() => true, () => false));
    const error = this.mcp ? this.mcp.error() : 'The MCP server is not running.';
    return { running: this.mcp !== null && error === null, url: this.mcp?.url ?? `http://127.0.0.1:${mcpPort}/mcp`, error, claudeInstalled: installed, claudeCodeRegistered: registered };
  }

  /** Registers the MCP server with Claude Code for every project (user scope), replacing an older registration. */
  private async connectClaudeCode(): Promise<void> {
    if (!process.env.PR_REVIEW_CLAUDE && !(await findTool('claude'))) throw new Error('Claude Code is not installed. Install it from https://code.claude.com, then try again.');
    const url = await this.mcpUrl();
    const ok = await this.host.confirm(
      'Connect Claude Code to PR Review?',
      `Adds the MCP server "pr-review" (${url}) to your Claude Code settings for all projects. Claude Code and Claude Desktop's Code tab can then read the pull requests open here and add draft comments. Nothing is posted to GitHub without you.`,
      'Connect',
    );
    if (!ok) return;
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

  async addDraft(pr: string, input: AgentDraftInput, origin: Omit<DraftOrigin, 'acceptedAt'>): Promise<Draft> {
    const session = this.bridgeSession(pr);
    const draft = await session.addAgentDraft(input, { ...origin, acceptedAt: null });
    if (origin.turnId) await this.agents.draftAdded(session.key, origin.turnId, draft.id).catch(() => undefined);
    return draft;
  }

  updateDraft(pr: string, id: string, body: string): Promise<Draft> {
    return this.bridgeSession(pr).updateAgentDraft(id, body);
  }

  deleteDraft(pr: string, id: string): Promise<void> {
    return this.bridgeSession(pr).deleteDraft(id);
  }

  /** Stops the background quick actions and agent requests (the app is quitting). */
  stopActions(): void {
    this.actions.stopAll();
    this.agents.stopAll();
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

  private viewer(host: string): Promise<string> {
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
   * `keep` says why one stays: only worktrees PR Review created are removed, never locked ones, ones with
   * uncommitted changes, or ones whose PR is open in a tab.
   */
  private async staleWorktrees(): Promise<StaleWorktree[]> {
    const candidates = (await this.allWorktrees()).filter((w) => !w.isPrimary && w.prNumber !== null && w.slug !== null);
    const bySlug = new Map<string, WorktreeInfo[]>();
    for (const w of candidates) bySlug.set(w.slug!, [...(bySlug.get(w.slug!) ?? []), w]);
    const out: StaleWorktree[] = [];
    for (const [slug, list] of bySlug) {
      const [owner, repo] = slug.split('/');
      const numbers = [...new Set(list.map((w) => w.prNumber!))];
      // issueOrPullRequest: a worktree named after a number that isn't a pull request just comes back empty.
      const fields = numbers.map((n) => `n${n}: issueOrPullRequest(number: ${n}) { ... on PullRequest { state title closedAt } }`).join('\n');
      type Pr = { state?: string; title?: string; closedAt?: string | null } | null;
      let found: Record<string, Pr>;
      try {
        const data = await this.client('github.com').graphql<{ repository: Record<string, Pr> | null }>(
          `query { repository(owner: ${JSON.stringify(owner)}, name: ${JSON.stringify(repo)}) { ${fields} } }`,
        );
        found = data.repository ?? {};
      } catch {
        continue;
      }
      for (const w of list) {
        const pr = found[`n${w.prNumber}`];
        if (!pr || (pr.state !== 'MERGED' && pr.state !== 'CLOSED')) continue;
        const dirty = await git(w.path, ['status', '--porcelain']).then(
          (o) => o.trim() !== '',
          () => false,
        );
        const keep = !w.owned
          ? 'not created by PR Review'
          : w.locked !== null
            ? 'locked'
            : this.sessions.has(`github.com/${slug}#${w.prNumber}`.toLowerCase())
              ? 'open in a tab'
              : dirty
                ? 'has uncommitted changes'
                : null;
        out.push({ worktree: w, state: pr.state, title: pr.title ?? '', closedAt: pr.closedAt ?? null, keep });
      }
    }
    return out;
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
            viewer,
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
      setViewed: (key, paths, viewed) => this.session(key).setViewed(paths, viewed),
      saveDraft: (key, draft) => this.session(key).saveDraft(draft),
      deleteDraft: (key, id) => this.session(key).deleteDraft(id),
      acceptDrafts: (key, ids) => this.session(key).acceptDrafts(ids),
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
      inbox: () => inbox(this.client('github.com'), 'github.com'),
      listWorktrees: () => this.allWorktrees(),
      staleWorktrees: () => this.staleWorktrees(),
      removeWorktree: async (repoPath, path) => {
        await removeWorktree(repoPath, path);
        await this.appState.removeOwnedWorktree(path);
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
      askAgent: async (key, request) => {
        this.session(key);
        await this.agents.ask(key, request);
      },
      stopAgentTurn: (key, turnId) => this.agents.stop(key, turnId),
      agentSession: (key) => this.agents.session(key),
      setAgentConnector: (key, connectorId) => this.agents.setConnector(key, connectorId),
      openAgentInDesktop: (key) => this.openAgentInDesktop(key),
      deleteTurnDrafts: async (key, turnId) => {
        const session = this.session(key);
        const ids = (await session.listDrafts()).filter((d) => d.origin?.turnId === turnId && d.origin.acceptedAt === null).map((d) => d.id);
        await session.deleteDrafts(ids);
      },
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
          return { via, login: await this.viewer(host), error: null };
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
