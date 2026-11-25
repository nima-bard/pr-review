import { spawn } from 'node:child_process';
import { mkdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { killGroup, type Connector } from './connector';

const SHELL = process.env.SHELL || '/bin/zsh';
const OUTPUT_LIMIT = 200_000;

/**
 * Any agent with a command line (`codex exec "$PR_PROMPT"`, `gemini -p "$PR_PROMPT"`…): run by the login shell in the
 * worktree, in its own process group, with the PR_* variables, PR_PROMPT (the request) and PR_REQUEST_FILE (the
 * request as JSON). Its output, stdout and stderr together, is the reply. Session reuse is up to the command.
 */
export const commandConnector: Connector = {
  start(ctx, update) {
    let stopped = false;
    let pid: number | undefined;
    let kill: () => void = () => undefined;
    const dir = join(tmpdir(), 'pr-review-agents');
    const file = join(dir, `${ctx.turnId}.json`);
    const done = (async () => {
      if (!ctx.connector.command.trim()) {
        update({ status: 'failed', error: `“${ctx.connector.name}” has no command. Set one in Settings › Agents.` });
        return { sessionId: null };
      }
      await mkdir(dir, { recursive: true });
      await writeFile(file, JSON.stringify({ pr: ctx.key, request: ctx.request, prompt: ctx.prompt, mcp: { url: ctx.mcp.url } }, null, 2), { mode: 0o600 });
      update({ status: 'running' });
      let output = '';
      let timer: NodeJS.Timeout | null = null;
      const report = () => {
        timer = null;
        update({ reply: output });
      };
      await new Promise<void>((resolve) => {
        const child = spawn(SHELL, ['-lc', ctx.connector.command], {
          cwd: ctx.worktree,
          env: { ...process.env, ...ctx.env, PR_PROMPT: ctx.prompt, PR_REQUEST_FILE: file },
          detached: true,
          stdio: ['ignore', 'pipe', 'pipe'],
        });
        pid = child.pid;
        kill = () => void child.kill('SIGTERM');
        const append = (chunk: Buffer) => {
          output = (output + chunk.toString('utf8')).slice(-OUTPUT_LIMIT);
          timer ??= setTimeout(report, 250);
        };
        child.stdout.on('data', append);
        child.stderr.on('data', append);
        const end = (status: 'done' | 'failed' | 'stopped', error: string | null) => {
          if (timer) clearTimeout(timer);
          update({ status, reply: output, error });
          resolve();
        };
        child.on('error', (err) => end('failed', err.message));
        child.on('close', (code) => (stopped ? end('stopped', null) : code === 0 ? end('done', null) : end('failed', `The command exited with code ${code}.`)));
      });
      return { sessionId: null };
    })().finally(() => rm(file, { force: true }).catch(() => undefined));
    return {
      stop: () => {
        stopped = true;
        killGroup(pid, kill);
      },
      done,
    };
  },
};
