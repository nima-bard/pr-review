import { spawn } from 'node:child_process';
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
  /** The MCP server's URL and the headers that tie this turn's calls to it. */
  mcp: { url: string; headers: Record<string, string> };
}

export interface RunningTurn {
  stop(): void;
  /** Resolves when the turn ends, with the session id it wrote to, if the agent reports it. */
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

/** Terminal output as plain text: without colour and cursor codes, the "^D" `script` echoes and its backspaces. */
export const terminalText = (output: string): string =>
  output
    .replace(/\u001b\[[0-9;?]*[A-Za-z]/g, '')
    .replace(/\^D/g, '')
    .replace(/[\u0000-\u0008\u000b-\u001f\u007f]/g, '')
    .trim();

/**
 * Runs a command that insists on a terminal (`claude --desktop` refuses to run with its output captured) under macOS's
 * `script`, which gives it a pseudo-terminal. Rejects with what the command printed when it fails.
 */
export function runWithTerminal(cmd: string, args: readonly string[], cwd: string | undefined, timeoutMs = 30_000): Promise<void> {
  return new Promise((resolve, reject) => {
    const child = spawn('/usr/bin/script', ['-q', '/dev/null', cmd, ...args], { cwd, stdio: ['ignore', 'pipe', 'pipe'] });
    let output = '';
    const collect = (chunk: Buffer) => {
      output = (output + chunk.toString('utf8')).slice(-4000);
    };
    child.stdout.on('data', collect);
    child.stderr.on('data', collect);
    const timer = setTimeout(() => child.kill('SIGTERM'), timeoutMs);
    child.on('error', (err) => {
      clearTimeout(timer);
      reject(err);
    });
    child.on('close', (code) => {
      clearTimeout(timer);
      if (code === 0) resolve();
      else reject(new Error(terminalText(output) || `${cmd} stopped with exit code ${code ?? 'unknown'}.`));
    });
  });
}
