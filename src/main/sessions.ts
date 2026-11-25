import { execFile } from 'node:child_process';
import { join } from 'node:path';
import { pollDeviceToken, startDeviceFlow } from '../core/github/deviceFlow';
import { TokenStore } from './tokenStore';
import type { Api, InvokeMethods, ContextMenuItem } from '../shared/ipc';
import { prKey, repoSlug, type PrEvent, type PrRef, type BrowserExtensionInfo, type RepoMapping, type StaleWorktree, type WorktreeInfo } from '../shared/model';
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
}

const errorMessage = (err: unknown) => (err instanceof Error ? err.message : String(err));

export class SessionRegistry {
  readonly appState: AppState;
  private readonly drafts: DraftStore;
  private readonly sessions = new Map<string, PrSession>();
  private readonly opening = new Map<string, Promise<void>>();
  private readonly clients = new Map<string, GitHubClient>();
  private readonly viewers = new Map<string, Promise<string>>();
  private scanned = false;

  private readonly tokens: TokenStore;

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
  }

  /** Stops the background quick actions (the app is quitting). */
  stopActions(): void {
    this.actions.stopAll();
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
        await this.appState.saveSettings(settings);
        this.host.applyAppTheme(settings.appTheme);
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
