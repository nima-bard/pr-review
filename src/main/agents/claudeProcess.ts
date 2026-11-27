import { spawn } from 'node:child_process';
import { mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createInterface } from 'node:readline';
import type { ClaudeBackgroundTask } from '../../shared/model';

/** The Claude Code CLI: `claude` on the PATH, or PR_REVIEW_CLAUDE (automated runs use a stand-in). */
export const claudeBin = (): string => process.env.PR_REVIEW_CLAUDE || 'claude';

/**
 * An empty folder to run `claude` in when it isn't about a pull request (listing models, registering the MCP server).
 * Claude Code looks through the folder it starts in: started in your home folder it reaches into Documents, Desktop and
 * cloud drives, and macOS asks you to let PR Review in, again with each version of the app.
 */
export function claudeScratchDir(): string {
  const dir = join(tmpdir(), 'pr-review-claude');
  mkdirSync(dir, { recursive: true });
  return dir;
}

/** What Claude may use without asking: reading the code and the PR, and PR Review's tools (drafts, Viewed, showing). */
export const CLAUDE_ALLOWED = [
  'Read',
  'Grep',
  'Glob',
  'LS',
  'Skill',
  'ToolSearch',
  'TodoWrite',
  'Task',
  'mcp__pr-review__*',
  'Bash(git diff:*)',
  'Bash(git log:*)',
  'Bash(git show:*)',
  'Bash(git status:*)',
  'Bash(git blame:*)',
  'Bash(git rev-parse:*)',
  'Bash(gh pr view:*)',
  'Bash(gh pr diff:*)',
];

/**
 * Never from the app: posting to GitHub and editing files. `gh api` is denied as a whole: a rule matches a command's
 * start, so `gh api --method:*` would miss `gh api repos/… --method POST`, and `-f` alone makes it a POST. A deny
 * also beats the `Bash(gh api:*)` the code-review skill grants itself. Existing comments come from `get_pr`.
 * AskUserQuestion would wait for an answer only Claude Code's own screens can give; offer_choices shows buttons instead.
 */
export const CLAUDE_DENIED = ['Bash(gh api:*)', 'Bash(gh pr comment:*)', 'Bash(gh pr review:*)', 'Edit', 'Write', 'NotebookEdit', 'AskUserQuestion'];

/**
 * While you contribute (the pull request checked out on its branch, `CheckoutMode`): changing files, and committing
 * and pushing them, which Claude does only when you ask (its instructions say so).
 */
export const CLAUDE_EDIT_TOOLS = ['Edit', 'Write', 'NotebookEdit', 'Bash(git add:*)', 'Bash(git commit:*)', 'Bash(git push:*)'];

/** Never, even when contributing. Rules match a command's start, so these catch the usual spellings; the instructions do the rest. */
const CLAUDE_EDIT_DENIED = ['Bash(git push --force:*)', 'Bash(git push -f:*)', 'Bash(git push --force-with-lease:*)'];

export interface ClaudeProcessOptions {
  sessionId: string;
  /** Starts the session (with `--session-id` and its name) instead of resuming it. */
  isNew: boolean;
  /** The session's name in Claude Desktop's list, for a new one: "PR #12 · Title". */
  title: string | null;
  cwd: string;
  env: Record<string, string>;
  /** Empty uses Claude Code's default. */
  model: string;
  /** Empty uses the model's default. */
  effort: string;
  /** How to work with PR Review, given once for the session's run rather than in every prompt (see `claudeSystemPrompt`). */
  systemPrompt: string;
  /** The checkout is on the branch, for contributing: Claude may change files, and commit and push when asked. */
  editing?: boolean;
  /** PR Review's MCP server, with the headers that say who calls it. */
  mcp: { url: string; headers: Record<string, string> };
  /** Claude started a turn (for a prompt the app sent, or one it had queued). */
  onTurn(): void;
  /** Claude finished a turn: null, or why it failed; and the model's context window, when Claude Code says. */
  onResult(error: string | null, contextWindow?: number): void;
  /** What Claude has running in the background now, whenever that changes (empty when the last one ends). */
  onBackground(tasks: ClaudeBackgroundTask[]): void;
}

export interface ClaudeProcess {
  /** Adds a prompt; one sent while Claude is answering waits for its turn. */
  send(prompt: string): void;
  /** Ends the current turn (SIGINT); prompts not read yet still reach Claude. */
  interrupt(): void;
  /** No more prompts: Claude Code exits after the current turn. */
  close(): void;
  /** Stops it now, with what it started (the app is quitting). */
  kill(): void;
  /** Resolves when the process has exited: null, or why it failed. */
  readonly ended: Promise<string | null>;
}

const STDERR_LIMIT = 4000;

/**
 * The arguments for a long-running headless session: prompts arrive as stream-json lines on stdin (the Agent SDK's
 * `SDKUserMessage`), answers stream back as stream-json. No --bare: reviews need your skills, hooks and CLAUDE.md.
 */
export function claudeArgs(o: Omit<ClaudeProcessOptions, 'onTurn' | 'onResult' | 'onBackground' | 'cwd' | 'env'>): string[] {
  return [
    '-p',
    '--input-format',
    'stream-json',
    '--output-format',
    'stream-json',
    '--verbose',
    ...(o.isNew ? ['--session-id', o.sessionId, ...(o.title ? ['--name', o.title] : [])] : ['--resume', o.sessionId]),
    '--mcp-config',
    JSON.stringify({ mcpServers: { 'pr-review': { type: 'http', url: o.mcp.url, headers: o.mcp.headers } } }),
    '--permission-mode',
    'dontAsk',
    '--allowedTools',
    (o.editing ? [...CLAUDE_ALLOWED, ...CLAUDE_EDIT_TOOLS] : CLAUDE_ALLOWED).join(','),
    '--disallowedTools',
    (o.editing ? [...CLAUDE_DENIED.filter((t) => !CLAUDE_EDIT_TOOLS.includes(t)), ...CLAUDE_EDIT_DENIED] : CLAUDE_DENIED).join(','),
    ...(o.model ? ['--model', o.model] : []),
    ...(o.effort ? ['--effort', o.effort] : []),
    '--append-system-prompt',
    o.systemPrompt,
  ];
}

/** A background task as Claude Code lists it in `background_tasks_changed`. */
type ListedTask = { task_id: string; task_type?: string; description?: string; parent_task_id?: string; ambient?: boolean };

const KINDS: Record<string, ClaudeBackgroundTask['kind']> = { local_agent: 'agent', local_bash: 'command' };

/** One prompt as a stream-json input line. */
export const promptLine = (sessionId: string, prompt: string): string =>
  `${JSON.stringify({ type: 'user', message: { role: 'user', content: [{ type: 'text', text: prompt }] }, parent_tool_use_id: null, session_id: sessionId })}\n`;

/**
 * Starts your own Claude Code on a pull request's session, in its worktree, for as long as prompts keep coming: one
 * process takes them one after another, so nothing restarts between questions and Claude's prompt cache stays warm.
 */
export function startClaude(o: ClaudeProcessOptions): ClaudeProcess {
  const child = spawn(claudeBin(), claudeArgs(o), { cwd: o.cwd, env: { ...process.env, ...o.env }, detached: true, stdio: ['pipe', 'pipe', 'pipe'] });
  let stderr = '';
  // Background tasks a subagent started: their end goes to that subagent, not to a turn of the conversation.
  const nested = new Set<string>();
  createInterface({ input: child.stdout }).on('line', (line) => {
    let msg: {
      type?: string;
      subtype?: string;
      is_error?: boolean;
      result?: string;
      errors?: string[];
      modelUsage?: Record<string, { contextWindow?: unknown }>;
      tasks?: ListedTask[];
      task_id?: string;
      status?: string;
    };
    try {
      msg = JSON.parse(line) as typeof msg;
    } catch {
      return;
    }
    if (msg.type === 'system' && msg.subtype === 'init') o.onTurn();
    // The whole set each time it changes (Claude Code's level signal); ambient ones are watchers, not work.
    if (msg.type === 'system' && msg.subtype === 'background_tasks_changed' && Array.isArray(msg.tasks)) {
      for (const t of msg.tasks) if (t.parent_task_id) nested.add(t.task_id);
      o.onBackground(
        msg.tasks.filter((t) => !t.ambient).map((t) => ({ id: t.task_id, description: t.description ?? '', kind: KINDS[t.task_type ?? ''] ?? 'other' })),
      );
    }
    // Claude answers a task of its own that finished, in a turn it starts itself, without a prompt (or an init) from us.
    if (msg.type === 'system' && msg.subtype === 'task_notification' && (msg.status === 'completed' || msg.status === 'failed') && !nested.has(msg.task_id ?? '')) o.onTurn();
    if (msg.type !== 'result') return;
    const failed = msg.is_error === true || (msg.subtype !== undefined && msg.subtype !== 'success');
    const windows = Object.values(msg.modelUsage ?? {}).flatMap((u) => (typeof u.contextWindow === 'number' ? [u.contextWindow] : []));
    o.onResult(failed ? msg.result || msg.errors?.join('\n') || `Claude stopped (${msg.subtype ?? 'error'}).` : null, windows.length > 0 ? Math.max(...windows) : undefined);
  });
  child.stderr.on('data', (chunk: Buffer) => {
    stderr = (stderr + chunk.toString('utf8')).slice(-STDERR_LIMIT);
  });
  child.stdin.on('error', () => undefined);
  const ended = new Promise<string | null>((resolve) => {
    let done = false;
    const end = (error: string | null) => {
      if (done) return;
      done = true;
      resolve(error);
    };
    child.on('error', (err: NodeJS.ErrnoException) => end(err.code === 'ENOENT' ? 'Claude Code (the claude command) is not installed, or not on the PATH.' : err.message));
    child.on('close', (code, signal) => end(code === 0 || signal === 'SIGTERM' ? null : stderr.trim() || `Claude Code stopped with exit code ${code ?? signal ?? 'unknown'}.`));
  });
  return {
    send: (prompt) => void child.stdin.write(promptLine(o.sessionId, prompt)),
    interrupt: () => void child.kill('SIGINT'),
    close: () => void child.stdin.end(),
    kill: () => {
      if (!child.pid) return;
      try {
        process.kill(-child.pid, 'SIGTERM');
      } catch {
        child.kill('SIGTERM');
      }
    },
    ended,
  };
}
