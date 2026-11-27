import { randomUUID } from 'node:crypto';
import { buildConversation, contextTokens, type SessionLine } from '../../core/agents/conversation';
import type { ClaudePointer } from '../../core/store/claudePointer';
import type { AgentRequest, ClaudeApp, ClaudeBackgroundTask, ClaudeModelChoice, ClaudeSettings, ClaudeView, Exchange, PendingRequest } from '../../shared/model';
import type { ClaudeProcess, ClaudeProcessOptions } from './claudeProcess';

/** What Claude Code says when the session it's asked to resume no longer exists. */
export const SESSION_GONE = /No conversation found with session ID|No session found with ID/;

/** How long the app's Claude stays after its last answer before it lets Claude Desktop or Claude Code have the session. */
export const IDLE_MS = 60_000;

/** How often the session is read while nobody is answering in it (every tick while someone is). */
const QUIET_REFRESH_MS = 3000;

/** A context window to measure against until Claude Code names the model's (older models have this one). */
const DEFAULT_CONTEXT_WINDOW = 200_000;

/** What the app's `claude` is started with: a change starts it again for the next question. */
const runsWith = (c: ClaudeModelChoice): string => `${c.model}|${c.effort}`;

export interface PrClaudeDeps {
  /** The PR as loaded: its worktree, PR_* variables, the session's name, and the prompt for `request`. Throws while it loads. */
  prepare(request: AgentRequest): Promise<{ worktree: string; env: Record<string, string>; title: string | null; prompt: string; systemPrompt: string; editing: boolean }>;
  /** The PR's worktree, where its session lives, or null while it loads. */
  worktree(): string | null;
  settings(): Promise<ClaudeSettings>;
  /** PR Review's MCP server, with the headers that say who is calling. */
  mcp(): Promise<{ url: string; headers: Record<string, string> }>;
  pointer: { read(): Promise<ClaudePointer>; write(pointer: ClaudePointer): Promise<void> };
  /** The session as Claude Code has it: when it last changed (undefined when it's gone), and its messages. */
  session: { changedAt(id: string, dir: string): Promise<number | undefined>; messages(id: string, dir: string): Promise<SessionLine[]> };
  /** Where the session is open outside the app now. */
  elsewhere(id: string): Promise<{ app: ClaudeApp; busy: boolean } | null>;
  /** Readies the session for the app to write to (closing Claude Desktop's idle copy); where it stays open, or null. */
  claim(id: string): Promise<ClaudeApp | null>;
  /** Takes the session from Claude Code in a terminal, when you say so: false while Claude is answering there. */
  takeFromTerminal(id: string): Promise<boolean>;
  start(options: ClaudeProcessOptions): ClaudeProcess;
  /** How big a model's context is for your account, once Claude Code's list of models has been read; else null. */
  contextWindow(model: string): number | null;
  emit(view: ClaudeView): void;
}

type Pending = PendingRequest & {
  /** The exchanges the session had when it was sent: its own is a new one. */
  seenBefore?: Set<string>;
};

const sameRequest = (a: AgentRequest, b: AgentRequest) =>
  a.kind === b.kind &&
  a.prompt.trim() === b.prompt.trim() &&
  a.target?.path === b.target?.path &&
  a.target?.side === b.target?.side &&
  a.target?.startLine === b.target?.startLine &&
  a.target?.endLine === b.target?.endLine &&
  a.thread?.id === b.thread?.id;

const message = (err: unknown) => (err instanceof Error ? err.message : String(err));

/**
 * One pull request's Claude: its dedicated Claude Code session, which is the conversation. The view is read from the
 * session (nothing is copied); questions go into it through one `claude` process that stays while there's work, and
 * leaves the session to Claude Desktop or Claude Code after a minute idle. One writer at a time: Desktop's idle copy is
 * closed first, and while Desktop is answering or Claude Code has the session open, questions wait. Idle means with
 * nothing running in the background either: ending the process would end what Claude started there.
 */
export class PrClaude {
  private pointer: ClaudePointer | null = null;
  private exchanges: Exchange[] = [];
  private pending: Pending[] = [];
  private process: ClaudeProcess | null = null;
  /** Claude is answering a prompt the app sent (between a turn's start and its result). */
  private turnActive = false;
  /** What Claude started in the background in the app's `claude` and is still running. */
  private background: ClaudeBackgroundTask[] = [];
  private stopping = false;
  private idleTimer: NodeJS.Timeout | null = null;
  private changedAt: number | undefined;
  /** The session's last message as read, and as it was when the app's own `claude` last finished a turn. */
  private lastMessage: string | null = null;
  private lastOwnMessage: string | null = null;
  /** The model and effort the app's `claude` runs with, to start it again when Settings › Claude changes them. */
  private runsWith: string | null = null;
  /** Tokens in the session's context after its last answer, and the model's window as Claude Code last said. */
  private contextTokens: number | null = null;
  private contextWindow: number | null = null;
  /** The context window of the model chosen for the next answers, as Claude Code's list of models says. */
  private modelWindow: number | null = null;
  private outside: { app: ClaudeApp; busy: boolean } | null = null;
  private waitingFor: ClaudeApp | null = null;
  private error: string | null = null;
  private lastRefresh = 0;
  private pumping: Promise<void> | null = null;
  private published = '';
  private disposed = false;

  constructor(private readonly deps: PrClaudeDeps) {}

  view(): ClaudeView {
    return {
      sessionId: this.pointer?.sessionId ?? null,
      exchanges: this.exchanges,
      pending: this.pending.map(({ id, request, state, error }) => ({ id, request, state, error })),
      busy: this.process && this.turnActive ? 'app' : this.outside?.busy ? this.outside.app : null,
      background: this.process ? this.background : [],
      waitingFor: this.waitingFor,
      hiddenMarkers: this.pointer?.hiddenMarkers ?? [],
      dismissedOffers: this.pointer?.dismissedOffers ?? [],
      modelChoice: this.pointer?.modelChoice ?? null,
      context:
        this.contextTokens === null
          ? null
          : {
              tokens: this.contextTokens,
              window: Math.max(this.modelWindow ?? this.contextWindow ?? DEFAULT_CONTEXT_WINDOW, this.contextTokens > DEFAULT_CONTEXT_WINDOW ? 1_000_000 : 0),
            },
      error: this.error,
    };
  }

  /**
   * Adds a question. While Claude Code in a terminal has the session, the panel asks whether to take it (`takeOver`);
   * a new question then replaces the one waiting for that answer, rather than queueing behind it.
   */
  ask(request: AgentRequest): void {
    if (this.waitingFor === 'terminal') this.pending = this.pending.filter((p) => p.state !== 'waiting');
    this.pending.push({ id: randomUUID(), request, state: 'waiting', error: null });
    this.publish();
    void this.pump();
  }

  cancel(pendingId: string): void {
    this.pending = this.pending.filter((p) => p.id !== pendingId || p.state === 'sent');
    this.publish();
  }

  retry(pendingId: string): void {
    const p = this.pending.find((x) => x.id === pendingId && x.state === 'failed');
    if (!p) return;
    Object.assign(p, { state: 'waiting', error: null });
    this.error = null;
    void this.pump();
  }

  /** OK on "close Claude Code there and send": ends the idle Claude Code that has the session, then sends. */
  async takeOver(): Promise<void> {
    const { sessionId } = await this.loadPointer();
    if (this.waitingFor !== 'terminal' || !sessionId) return;
    if (!(await this.deps.takeFromTerminal(sessionId))) throw new Error('Claude is answering in Claude Code. Try OK again once it’s done.');
    this.waitingFor = null;
    await this.pump();
  }

  /** Ends the answer in progress; questions Claude hasn't read yet still reach it. */
  stop(): void {
    if (!this.process || !this.turnActive) return;
    this.stopping = true;
    this.process.interrupt();
  }

  async hideMarker(exchangeId: string): Promise<void> {
    const pointer = await this.loadPointer();
    if (pointer.hiddenMarkers.includes(exchangeId)) return;
    await this.savePointer({ ...pointer, hiddenMarkers: [...pointer.hiddenMarkers, exchangeId] });
    this.publish();
  }

  /** The model and effort for this conversation's next questions; null goes back to Settings › Claude's. */
  async chooseModel(choice: ClaudeModelChoice | null): Promise<void> {
    await this.savePointer({ ...(await this.loadPointer()), modelChoice: choice });
    this.modelWindow = this.deps.contextWindow((await this.modelChoice()).model);
    this.publish();
  }

  /** "No" on the choices Claude offered after exchange `exchangeId`: they stop showing. */
  async dismissOffer(exchangeId: string): Promise<void> {
    const pointer = await this.loadPointer();
    if (pointer.dismissedOffers.includes(exchangeId)) return;
    await this.savePointer({ ...pointer, dismissedOffers: [...pointer.dismissedOffers, exchangeId] });
    this.publish();
  }

  /**
   * Lets go of the session for Claude Desktop or Claude Code: the app's process ends if it's idle. False while Claude
   * is answering a question from the app, or has something running in the background.
   */
  async release(): Promise<boolean> {
    const proc = this.process;
    if (!proc) return true;
    if (this.turnActive || this.background.length > 0) return false;
    proc.close();
    await proc.ended;
    return true;
  }

  /** The session id, once the PR has one. */
  async sessionId(): Promise<string | null> {
    return (await this.loadPointer()).sessionId;
  }

  /**
   * Reads the session again when it changed, and where else it's open; retries waiting questions. Called on every
   * tick: it reads every time while anyone is answering, else every few seconds.
   */
  async refresh(force = false): Promise<void> {
    if (this.disposed) return;
    const active = this.turnActive || this.outside?.busy === true || this.waitingFor !== null || this.pending.some((p) => p.state === 'sent');
    if (!force && !active && Date.now() - this.lastRefresh < QUIET_REFRESH_MS) return;
    this.lastRefresh = Date.now();
    this.modelWindow = this.deps.contextWindow((await this.modelChoice()).model);
    const { sessionId } = await this.loadPointer();
    const dir = this.deps.worktree();
    if (sessionId && dir) {
      const changedAt = await this.deps.session.changedAt(sessionId, dir).catch(() => undefined);
      if (changedAt !== undefined && changedAt !== this.changedAt) {
        const messages = await this.deps.session.messages(sessionId, dir).catch(() => []);
        this.exchanges = buildConversation(messages);
        this.contextTokens = contextTokens(messages);
        this.lastMessage = messages.at(-1)?.uuid ?? null;
        this.changedAt = changedAt;
        this.dropRead();
      } else if (changedAt === undefined && !this.process) {
        // Deleted, or cleaned up by Claude Code: the next question starts a new session.
        this.exchanges = [];
        this.contextTokens = null;
        this.changedAt = undefined;
      }
      this.outside = this.process ? null : await this.deps.elsewhere(sessionId).catch(() => null);
    }
    if (this.waitingFor) void this.pump();
    this.publish();
  }

  /** The PR closed: the app's Claude finishes what it's answering, then exits. */
  dispose(): void {
    this.disposed = true;
    this.clearIdle();
    this.process?.close();
  }

  /** The app is quitting. */
  kill(): void {
    this.disposed = true;
    this.clearIdle();
    this.process?.kill();
  }

  /** The conversation's own model and effort, else Settings › Claude's. */
  private async modelChoice(): Promise<ClaudeModelChoice> {
    const [pointer, settings] = await Promise.all([this.loadPointer(), this.deps.settings()]);
    return pointer.modelChoice ?? { model: settings.model, effort: settings.effort };
  }

  private async loadPointer(): Promise<ClaudePointer> {
    this.pointer ??= await this.deps.pointer.read();
    return this.pointer;
  }

  private async savePointer(pointer: ClaudePointer): Promise<void> {
    this.pointer = pointer;
    await this.deps.pointer.write(pointer);
  }

  private publish(): void {
    if (this.disposed) return;
    const view = this.view();
    const text = JSON.stringify(view);
    if (text === this.published) return;
    this.published = text;
    this.deps.emit(view);
  }

  /** Questions that have reached the session show as its exchanges; they leave the waiting list. */
  private dropRead(): void {
    const used = new Set<string>();
    this.pending = this.pending.filter((p) => {
      if (p.state !== 'sent') return true;
      const found = this.exchanges.find((e) => e.asked === 'app' && !used.has(e.id) && !p.seenBefore?.has(e.id) && sameRequest(e.request, p.request));
      if (found) used.add(found.id);
      return !found;
    });
  }

  private pump(): Promise<void> {
    this.pumping ??= this.sendWaiting().finally(() => {
      this.pumping = null;
    });
    return this.pumping;
  }

  private async sendWaiting(): Promise<void> {
    const waiting = () => this.pending.filter((p) => p.state === 'waiting');
    if (waiting().length === 0 || this.disposed) return;
    try {
      // Not with work in the background, which ending the process would end: the question goes to it as it is.
      if (this.process && !this.turnActive && this.background.length === 0 && ((await this.writtenElsewhere()) || runsWith(await this.modelChoice()) !== this.runsWith)) await this.closeProcess();
      if (!this.process && !(await this.startProcess(waiting()[0]!))) {
        this.publish();
        return;
      }
      for (const p of waiting()) {
        const { prompt } = await this.deps.prepare(p.request);
        Object.assign(p, { state: 'sent', seenBefore: new Set(this.exchanges.map((e) => e.id)) });
        this.turnActive = true;
        this.process!.send(prompt);
      }
      this.clearIdle();
    } catch (err) {
      this.error = message(err);
      for (const p of waiting()) Object.assign(p, { state: 'failed', error: this.error });
    }
    this.publish();
  }

  /**
   * Whether someone else wrote to the session since the app's `claude` last answered, or has it open now (Claude
   * Desktop or Claude Code, while the app's was idle). That process still has the conversation as it was, and writing
   * on from there would split it, so it must start again, reading the session as it is.
   */
  private async writtenElsewhere(): Promise<boolean> {
    const { sessionId } = await this.loadPointer();
    if (!sessionId) return false;
    await this.refresh(true);
    return this.lastMessage !== this.lastOwnMessage || (await this.deps.elsewhere(sessionId).catch(() => null)) !== null;
  }

  /** Ends the app's idle `claude` and waits until it has exited. */
  private async closeProcess(): Promise<void> {
    const proc = this.process;
    if (!proc) return;
    this.process = null;
    this.clearIdle();
    proc.close();
    await proc.ended;
  }

  /** Starts the app's Claude on the session (a new one when there's none yet, or it's gone); false when it must wait. */
  private async startProcess(first: Pending): Promise<boolean> {
    const ctx = await this.deps.prepare(first.request);
    const pointer = await this.loadPointer();
    let id = pointer.sessionId;
    const exists = id !== null && (await this.deps.session.changedAt(id, ctx.worktree).catch(() => undefined)) !== undefined;
    if (id && exists) {
      this.waitingFor = await this.deps.claim(id);
      if (this.waitingFor) return false;
    } else {
      id = randomUUID();
      await this.savePointer({ ...pointer, sessionId: id });
      this.exchanges = [];
      this.contextTokens = null;
      this.changedAt = undefined;
    }
    this.error = null;
    const [choice, mcp] = await Promise.all([this.modelChoice(), this.deps.mcp()]);
    const proc = this.deps.start({
      sessionId: id,
      isNew: !exists,
      title: ctx.title,
      cwd: ctx.worktree,
      env: ctx.env,
      model: choice.model,
      effort: choice.effort,
      systemPrompt: ctx.systemPrompt,
      editing: ctx.editing,
      mcp,
      onTurn: () => {
        this.turnActive = true;
        this.clearIdle();
      },
      onResult: (error, contextWindow) => {
        if (contextWindow) this.contextWindow = contextWindow;
        this.answered(error);
      },
      onBackground: (tasks) => {
        if (this.process !== proc) return;
        this.background = tasks;
        // The idle minute counts from when the last one ends.
        if (tasks.length > 0) this.clearIdle();
        else if (!this.turnActive) this.armIdle();
        this.publish();
      },
    });
    this.process = proc;
    this.background = [];
    this.runsWith = runsWith(choice);
    this.outside = null;
    // It starts from the session as it is now.
    this.lastOwnMessage = exists ? this.lastMessage : null;
    void proc.ended.then((error) => this.ended(proc, error));
    return true;
  }

  private answered(error: string | null): void {
    this.turnActive = false;
    if (error && !this.stopping) this.error = error;
    this.stopping = false;
    this.armIdle();
    // What the session ends with now is the app's own writing: anything after it comes from someone else.
    void this.refresh(true).then(() => {
      if (!this.turnActive) this.lastOwnMessage = this.lastMessage;
    });
  }

  private async ended(proc: ClaudeProcess, error: string | null): Promise<void> {
    if (this.process !== proc) return;
    this.process = null;
    this.turnActive = false;
    this.background = [];
    this.clearIdle();
    const stopped = this.stopping;
    this.stopping = false;
    await this.refresh(true);
    const unread = this.pending.filter((p) => p.state === 'sent');
    if (error && SESSION_GONE.test(error)) {
      // The session went away (deleted in Claude Desktop, say): a new one takes the questions not answered yet.
      await this.savePointer({ ...(await this.loadPointer()), sessionId: null });
      for (const p of unread) p.state = 'waiting';
      void this.pump();
    } else if (error && !stopped) {
      this.error = error;
      for (const p of unread) Object.assign(p, { state: 'failed', error });
    } else {
      // Ended after its questions were answered: they're in the session.
      this.pending = this.pending.filter((p) => p.state !== 'sent');
    }
    this.publish();
    if (this.pending.some((p) => p.state === 'waiting')) void this.pump();
  }

  /** The app's `claude` lets the session go a minute from now, if it's idle then: no turn, nothing waiting or running. */
  private armIdle(): void {
    this.clearIdle();
    this.idleTimer = setTimeout(() => {
      if (!this.turnActive && this.background.length === 0 && !this.pending.some((p) => p.state === 'waiting')) this.process?.close();
    }, IDLE_MS);
  }

  private clearIdle(): void {
    if (this.idleTimer) clearTimeout(this.idleTimer);
    this.idleTimer = null;
  }
}
