import { execFile, spawn } from 'node:child_process';
import { CLAUDE_APPS } from '../../shared/agents';
import type { ClaudeApp } from '../../shared/model';
import { openInTerminal } from '../quickActions';
import { claudeBin } from './claudeProcess';
import { endIdleClaude, openSession, type OpenSession } from './claudeSessions';
import { SESSION_GONE } from './prClaude';

/** What opening the PR's session in a Claude app does, given where it's open now (see `openStep`). */
export type OpenStep = { do: 'show' } | { do: 'launch'; closeDesktopFirst: boolean } | { do: 'refuse'; reason: string };

/**
 * One place at a time: Claude Code won't open a session that's open elsewhere. Desktop already having it means
 * switching to it there; Claude Code gets it once Desktop's copy is idle and closed; a terminal keeps it until you quit
 * it there. The app's own `claude` (an `sdk-…` entrypoint) is released before this is asked.
 */
export function openStep(app: ClaudeApp, holder: OpenSession | null): OpenStep {
  if (!holder || holder.entrypoint.startsWith('sdk')) return { do: 'launch', closeDesktopFirst: false };
  if (holder.inDesktop) {
    if (app === 'desktop') return { do: 'show' };
    if (holder.status === 'idle') return { do: 'launch', closeDesktopFirst: true };
    return { do: 'refuse', reason: 'Claude is answering in Claude Desktop, in this pull request’s session. Open it in Claude Code when that’s done.' };
  }
  return {
    do: 'refuse',
    reason:
      app === 'terminal'
        ? 'This pull request’s session is already open in Claude Code, in a terminal.'
        : 'This pull request’s session is open in Claude Code in a terminal. Run /desktop there to move it to Claude Desktop, or quit it there and try again.',
  };
}

export interface OpenContext {
  sessionId: string;
  worktree: string;
  /** PR_* variables, for the terminal. */
  env: Record<string, string>;
  /** The terminal's title: "Claude · PR #12 · Title". */
  name: string;
  /** Settings' terminal app (quick actions use the same one). */
  terminalApp: string;
}

/** The command Claude Code starts with in the terminal; the session id comes in a variable, never in the command text. */
export const TERMINAL_COMMAND = '"$PR_CLAUDE_BIN" --resume "$PR_CLAUDE_SESSION"';

/** Opens the PR's session in Claude Desktop or Claude Code (in your terminal), or switches Desktop to it. */
export async function openInClaude(app: ClaudeApp, ctx: OpenContext): Promise<void> {
  const holder = await openSession(ctx.sessionId);
  const step = openStep(app, holder);
  if (step.do === 'refuse') throw new Error(step.reason);
  if (step.do === 'show') return showInDesktop(holder!.desktopId!);
  if (step.closeDesktopFirst && !(await endIdleClaude(holder!))) throw new Error('Claude Desktop has this pull request’s session open, and PR Review couldn’t close it there. Close it in Desktop, then try again.');
  if (app === 'desktop') return openInDesktop(ctx);
  await openInTerminal(ctx.terminalApp, ctx.worktree, { ...ctx.env, PR_CLAUDE_BIN: claudeBin(), PR_CLAUDE_SESSION: ctx.sessionId }, TERMINAL_COMMAND, ctx.name);
}

/** `claude --desktop --resume`: hands the session to Claude Desktop, which then opens it. */
async function openInDesktop(ctx: OpenContext): Promise<void> {
  try {
    await runWithTerminal(claudeBin(), ['--desktop', '--resume', ctx.sessionId], ctx.worktree);
  } catch (err) {
    const detail = (err instanceof Error ? err.message : String(err)).replace(/\.$/, '');
    if (SESSION_GONE.test(detail)) throw new Error(`${CLAUDE_APPS.desktop.name} can’t find this pull request’s session: it was deleted. Your next question here starts a new one.`);
    throw new Error(`Could not open the session in Claude Desktop: ${detail}. It needs Claude Code 2.1.285 or later and a subscription sign-in.`);
  }
}

/** The link that switches Claude Desktop to its Code session `desktopId`. */
export const desktopSessionLink = (desktopId: string): string => `claude://code/continue?session=${encodeURIComponent(desktopId)}`;

/** Shows Claude Desktop's Code session `desktopId`, bringing Desktop to the front. */
function showInDesktop(desktopId: string): Promise<void> {
  return new Promise((resolve, reject) => execFile('open', [desktopSessionLink(desktopId)], (err) => (err ? reject(err) : resolve())));
}

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
