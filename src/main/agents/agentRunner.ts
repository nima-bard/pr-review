import { randomUUID } from 'node:crypto';
import type { AgentConnector, AgentRequest, AgentSession, AgentTurn } from '../../shared/model';
import type { AppState } from '../../core/store/appState';
import type { Connector, RunningTurn, TurnUpdate } from './connector';

/** Kinds that keep a Claude Code session across requests (the others start fresh each time). */
const SESSION_KINDS: readonly AgentConnector['kind'][] = ['claude-code', 'claude-terminal'];

/** The most requests one pull request runs at once, whatever Settings says. */
const MAX_PARALLEL = 8;

export interface AgentRunnerDeps {
  appState: AppState;
  emit(key: string, session: AgentSession): void;
  connector(kind: AgentConnector['kind']): Connector;
  /** The worktree, PR_* variables and prompt for a request; throws when the PR isn't loaded. */
  prepare(key: string, request: AgentRequest): Promise<{ worktree: string; env: Record<string, string>; prompt: string }>;
  /** The MCP server's URL and token, for the headers that tie a turn's calls to it. */
  mcp(): Promise<{ url: string; token: string }>;
}

interface PrAgent {
  session: AgentSession;
  /** Requests started or running, by turn id (null while one is still starting). */
  active: Map<string, RunningTurn | null>;
  /** The request using the PR's own session, if any: only one may write to it at a time. */
  mainTurnId: string | null;
  /** Stop was pressed while a request was still starting: it stops as soon as it has started. */
  stopRequested: Set<string>;
}

/**
 * The agent conversations, one per PR, persisted so they're still there after a restart. Requests run at once, up to
 * Settings' `agentParallel`: one at a time on the PR's own session (two writers on one Claude Code session can lose
 * messages), and the others beside it as side branches of that session, so asking never waits for the request before.
 */
export class AgentRunner {
  private readonly prs = new Map<string, Promise<PrAgent>>();

  constructor(private readonly deps: AgentRunnerDeps) {}

  private agent(key: string): Promise<PrAgent> {
    let pr = this.prs.get(key);
    if (!pr) {
      pr = this.load(key);
      this.prs.set(key, pr);
    }
    return pr;
  }

  /** The stored session; turns that were running when the app quit can't continue, so they end as stopped. */
  private async load(key: string): Promise<PrAgent> {
    const stored = await this.deps.appState.agentSession(key);
    const session = stored ?? (await this.newSession());
    for (const t of session.turns) {
      if (t.status === 'queued' || t.status === 'running') Object.assign(t, { status: 'stopped', endedAt: t.endedAt ?? t.startedAt, error: 'PR Review quit while this ran.' });
    }
    return { session, active: new Map(), mainTurnId: null, stopRequested: new Set() };
  }

  private async newSession(connectorId?: string, turns: AgentTurn[] = []): Promise<AgentSession> {
    const { agents } = await this.deps.appState.settings();
    const connector = agents.find((a) => a.id === connectorId) ?? agents[0];
    return { connectorId: connector?.id ?? '', sessionId: connector && SESSION_KINDS.includes(connector.kind) ? randomUUID() : null, started: false, turns };
  }

  private publish(key: string, pr: PrAgent, save = false): void {
    this.deps.emit(key, structuredClone(pr.session));
    if (save) void this.deps.appState.saveAgentSession(key, pr.session).catch(() => undefined);
  }

  /** The connector the PR's session uses, or the default when that one was removed from Settings. */
  private async connectorOf(pr: PrAgent): Promise<AgentConnector> {
    const { agents } = await this.deps.appState.settings();
    const connector = agents.find((a) => a.id === pr.session.connectorId);
    if (connector) return connector;
    const fallback = agents[0];
    if (!fallback) throw new Error('No agent is set up. Add one in Settings › Agents.');
    Object.assign(pr.session, await this.newSession(fallback.id, pr.session.turns));
    return fallback;
  }

  async session(key: string): Promise<AgentSession | null> {
    if (!this.prs.has(key) && !(await this.deps.appState.agentSession(key))) return null;
    return structuredClone((await this.agent(key)).session);
  }

  /** Adds a request; it starts at once unless the PR already runs as many as Settings allows. */
  async ask(key: string, request: AgentRequest): Promise<void> {
    const pr = await this.agent(key);
    const connector = await this.connectorOf(pr);
    const turn: AgentTurn = {
      id: randomUUID(),
      connectorId: connector.id,
      agent: connector.name,
      request,
      startedAt: new Date().toISOString(),
      endedAt: null,
      status: 'queued',
      reply: '',
      activity: [],
      draftIds: [],
      costUsd: null,
      error: null,
    };
    pr.session.turns.push(turn);
    this.publish(key, pr, true);
    void this.pump(key, pr);
  }

  /**
   * Starts waiting requests, oldest first, while there's room. The PR's own session takes one when it's free; the
   * others become side branches. A live terminal session takes one at a time, since it is a single conversation.
   */
  private async pump(key: string, pr: PrAgent): Promise<void> {
    const [{ agentParallel }, connector] = await Promise.all([this.deps.appState.settings(), this.connectorOf(pr).catch(() => null)]);
    const limit = connector?.kind === 'claude-terminal' ? 1 : Math.min(MAX_PARALLEL, Math.max(1, Math.round(agentParallel) || 1));
    for (const turn of pr.session.turns) {
      if (pr.active.size >= limit) return;
      if (turn.status !== 'queued' || pr.active.has(turn.id)) continue;
      // Claimed before anything is awaited, so two pumps never start the same request.
      const main = pr.mainTurnId === null;
      if (main) pr.mainTurnId = turn.id;
      pr.active.set(turn.id, null);
      void this.run(key, pr, turn, main);
    }
  }

  /** Runs one request, on the PR's session (`main`) or a side branch of it, and frees its place when it ends. */
  private async run(key: string, pr: PrAgent, turn: AgentTurn, main: boolean): Promise<void> {
    const update = (patch: TurnUpdate) => {
      Object.assign(turn, patch);
      this.publish(key, pr);
    };
    const release = () => {
      pr.active.delete(turn.id);
      pr.stopRequested.delete(turn.id);
      if (pr.mainTurnId === turn.id) pr.mainTurnId = null;
    };
    let running: RunningTurn;
    let side = false;
    try {
      const connector = await this.connectorOf(pr);
      const [prepared, mcp] = await Promise.all([this.deps.prepare(key, turn.request), this.deps.mcp()]);
      const { session } = pr;
      // A side branch knows the conversation so far (a fork of the session), or starts fresh if there's none yet.
      side = !main && connector.kind === 'claude-code';
      running = this.deps.connector(connector.kind).start(
        {
          turnId: turn.id,
          key,
          connector,
          request: turn.request,
          ...prepared,
          sessionId: side && !session.started ? randomUUID() : session.sessionId,
          resume: session.started,
          fork: side && session.started,
          main: !side,
          mcp: { url: mcp.url, headers: { Authorization: `Bearer ${mcp.token}`, 'X-PR-Review-Pr': key, 'X-PR-Review-Turn': turn.id, 'X-PR-Review-Agent': connector.name } },
        },
        update,
      );
    } catch (err) {
      release();
      Object.assign(turn, { status: 'failed', error: err instanceof Error ? err.message : String(err), endedAt: new Date().toISOString() });
      this.publish(key, pr, true);
      void this.pump(key, pr);
      return;
    }
    pr.active.set(turn.id, running);
    if (pr.stopRequested.has(turn.id)) running.stop();
    if (side) turn.branch = true;
    if (turn.status === 'queued') update({ status: 'running' });
    const { sessionId } = await running.done;
    release();
    turn.endedAt = new Date().toISOString();
    const { session } = pr;
    // The PR's session exists once the agent reported it (even if the turn failed later) or the turn went through.
    if (!side && session.sessionId && (sessionId || turn.status === 'done' || turn.status === 'handed-off')) {
      // Claude Code may report another id (it continued in a copy): the PR's conversation goes on there.
      if (sessionId && sessionId !== session.sessionId) session.sessionId = sessionId;
      session.started = true;
    }
    this.publish(key, pr, true);
    void this.pump(key, pr);
  }

  async stop(key: string, turnId: string): Promise<void> {
    const pr = await this.agent(key);
    if (pr.active.has(turnId)) {
      const running = pr.active.get(turnId);
      if (running) running.stop();
      else pr.stopRequested.add(turnId);
      return;
    }
    const turn = pr.session.turns.find((t) => t.id === turnId);
    if (turn?.status !== 'queued') return;
    Object.assign(turn, { status: 'stopped', endedAt: new Date().toISOString() });
    this.publish(key, pr, true);
  }

  /** A draft an agent added while `turnId` ran, so the turn can link to it. */
  async draftAdded(key: string, turnId: string, draftId: string): Promise<void> {
    const pr = await this.agent(key);
    const turn = pr.session.turns.find((t) => t.id === turnId);
    if (!turn) return;
    turn.draftIds.push(draftId);
    this.publish(key, pr, true);
  }

  /** A live terminal session answered request `turnId` (the MCP reply tool): the answer shows in the app. */
  async agentReply(key: string, turnId: string, text: string): Promise<void> {
    const pr = await this.agent(key);
    const turn = pr.session.turns.find((t) => t.id === turnId);
    if (!turn) throw new Error(`PR Review has no request ${turnId} for this pull request.`);
    turn.reply = text;
    if (turn.status === 'handed-off') turn.status = 'done';
    this.publish(key, pr, true);
  }

  /** Switches the PR to another connector: a new session (the conversation so far stays listed). */
  async setConnector(key: string, connectorId: string): Promise<void> {
    const pr = await this.agent(key);
    if (pr.active.size > 0) throw new Error('Wait for the running requests to finish, or stop them, before switching agents.');
    Object.assign(pr.session, await this.newSession(connectorId, pr.session.turns));
    this.publish(key, pr, true);
  }

  /** The PR's Claude Code session, for "Open in Claude Desktop": it must exist and no request may be writing to it. */
  async desktopSession(key: string): Promise<string> {
    const { session, mainTurnId } = await this.agent(key);
    if (!session.sessionId || !session.started) throw new Error('There is no Claude Code session for this pull request yet. Ask something first.');
    if (mainTurnId) throw new Error('Claude is still answering in this pull request’s session. Wait for it to finish, or stop it, then open the session in Claude Desktop.');
    return session.sessionId;
  }

  /** Removes a line ask's marker from the diff, saved with the conversation so it stays away after a restart. */
  async hideMarker(key: string, turnId: string): Promise<void> {
    const pr = await this.agent(key);
    const turn = pr.session.turns.find((t) => t.id === turnId);
    if (!turn) return;
    turn.markerHidden = true;
    this.publish(key, pr, true);
  }

  /** Stops every running turn (the app is quitting). */
  stopAll(): void {
    for (const pr of this.prs.values()) void pr.then((p) => p.active.forEach((running) => running?.stop()));
  }
}
