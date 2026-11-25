import { spawn } from 'node:child_process';
import { createInterface } from 'node:readline';
import { EMPTY_STREAM, parseClaudeLine } from '../../core/agents/claudeStream';
import { sessionTitle } from '../../shared/agents';
import { claudeBin, killGroup, type Connector } from './connector';

/** What a request may use without asking: reading the code and the PR, and PR Review's tools (drafts, Viewed, showing). */
export const REVIEW_ALLOWED = [
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
 * Never in a review: posting to GitHub and editing files. `gh api` is denied as a whole: a rule matches a command's
 * start, so `gh api --method:*` would miss `gh api repos/… --method POST`, and `-f` alone makes it a POST. A deny
 * also beats the `Bash(gh api:*)` the code-review skill grants itself. The review reads existing comments with `get_pr`.
 */
export const REVIEW_DENIED = ['Bash(gh api:*)', 'Bash(gh pr comment:*)', 'Bash(gh pr review:*)', 'Edit', 'Write', 'NotebookEdit'];

const STDERR_LIMIT = 4000;

/**
 * Claude Code, headless: one `claude -p` per turn in the PR's worktree, on the PR's one session (`--session-id` the
 * first time, `--resume` after), named after the PR so Claude Desktop lists it as "PR #12 · Title"; or, while that
 * session is busy, on a side branch of it (`--resume … --fork-session`). No --bare: the review needs your skills, hooks
 * and CLAUDE.md. The prompt goes in on stdin; the answer streams back as stream-json.
 */
export const claudeCode: Connector = {
  start(ctx, update) {
    const { connector } = ctx;
    // Only the PR's own session carries its name; a side branch stays unnamed, so Desktop's list doesn't repeat it.
    const title = ctx.main ? sessionTitle(ctx.env.PR_NUMBER, ctx.env.PR_TITLE) : null;
    const args = [
      '-p',
      '--output-format',
      'stream-json',
      '--verbose',
      ...(ctx.resume ? ['--resume', ctx.sessionId!, ...(ctx.fork ? ['--fork-session'] : [])] : ['--session-id', ctx.sessionId!]),
      ...(title ? ['--name', title] : []),
      '--mcp-config',
      JSON.stringify({ mcpServers: { 'pr-review': { type: 'http', url: ctx.mcp.url, headers: ctx.mcp.headers } } }),
      '--permission-mode',
      'dontAsk',
      '--allowedTools',
      REVIEW_ALLOWED.join(','),
      '--disallowedTools',
      REVIEW_DENIED.join(','),
      ...(connector.model ? ['--model', connector.model] : []),
    ];
    let state = EMPTY_STREAM;
    let stderr = '';
    let stopped = false;
    const child = spawn(claudeBin(), args, { cwd: ctx.worktree, env: { ...process.env, ...ctx.env }, detached: true, stdio: ['pipe', 'pipe', 'pipe'] });
    update({ status: 'running' });
    createInterface({ input: child.stdout }).on('line', (line) => {
      const next = parseClaudeLine(state, line);
      if (next === state) return;
      state = next;
      update({ reply: state.reply, activity: state.activity, costUsd: state.costUsd });
    });
    child.stderr.on('data', (chunk: Buffer) => {
      stderr = (stderr + chunk.toString('utf8')).slice(-STDERR_LIMIT);
    });
    child.stdin.on('error', () => undefined);
    child.stdin.end(ctx.prompt);
    const done = new Promise<{ sessionId: string | null }>((resolve) => {
      let ended = false;
      const end = (code: number | null, error: string | null) => {
        if (ended) return;
        ended = true;
        if (stopped) update({ status: 'stopped' });
        else if (state.error || error || code !== 0) update({ status: 'failed', error: state.error ?? error ?? (stderr.trim() || `Claude Code exited with code ${code}.`) });
        else update({ status: 'done' });
        resolve({ sessionId: state.sessionId });
      };
      child.on('error', (err: NodeJS.ErrnoException) => end(null, err.code === 'ENOENT' ? 'Claude Code (the claude command) is not installed, or not on the PATH.' : err.message));
      child.on('close', (code) => end(code, null));
    });
    return {
      stop: () => {
        stopped = true;
        killGroup(child.pid, () => child.kill('SIGTERM'));
      },
      done,
    };
  },
};
