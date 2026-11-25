import type { AgentConnector, AgentRequest, AgentTurn } from '../../shared/model';

/** What a connector needs to run one turn. */
export interface TurnContext {
  turnId: string;
  key: string;
  connector: AgentConnector;
  request: AgentRequest;
  worktree: string;
  /** PR_* variables (actionEnv), for command connectors with PR_PROMPT and PR_REQUEST_FILE added. */
  env: Record<string, string>;
  prompt: string;
  sessionId: string | null;
  /** The session exists: continue it (--resume) instead of starting it (--session-id). */
  resume: boolean;
  /** Resume as a new branch (after the session was continued in Claude Desktop); the new id comes back in `result`. */
  fork: boolean;
  /** The MCP server's URL and the headers that tie this turn's calls to it. */
  mcp: { url: string; headers: Record<string, string> };
}

export interface RunningTurn {
  stop(): void;
  /** Resolves when the turn ends, with the session id it wrote to (a fork's new one), if the agent reports it. */
  done: Promise<{ sessionId: string | null }>;
}

export type TurnUpdate = Partial<Pick<AgentTurn, 'status' | 'reply' | 'activity' | 'costUsd' | 'error'>>;

export interface Connector {
  start(ctx: TurnContext, update: (patch: TurnUpdate) => void): RunningTurn;
}

/** A turn that ended before it started, e.g. a hand-off. */
export const finished = (sessionId: string | null = null): RunningTurn => ({ stop: () => undefined, done: Promise.resolve({ sessionId }) });

/** Stops a detached child and what it started (its process group). */
export function killGroup(pid: number | undefined, kill: () => void): void {
  if (!pid) return;
  try {
    process.kill(-pid, 'SIGTERM');
  } catch {
    kill();
  }
}

/** The Claude Code CLI: `claude` on the PATH, or PR_REVIEW_CLAUDE (automated runs use a stand-in). */
export const claudeBin = (): string => process.env.PR_REVIEW_CLAUDE || 'claude';
