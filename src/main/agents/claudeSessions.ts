import { execFile } from 'node:child_process';
import { readdir, readFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join } from 'node:path';
import type { SessionLine } from '../../core/agents/conversation';
import type { ClaudeApp } from '../../shared/model';

/** A Claude Code process that has a session open, as Claude Code registers it in `~/.claude/sessions/<pid>.json`. */
export interface OpenSession {
  pid: number;
  /** How it was started: `claude-desktop`, `cli` (a terminal), `sdk-cli` (`claude -p`, as the app runs it)… */
  entrypoint: string;
  /** Claude Desktop runs it. */
  inDesktop: boolean;
  /** Claude Desktop's id for it ("local_…"), when Desktop runs it. */
  desktopId: string | null;
  /** `idle` between turns, `busy` while Claude answers… */
  status: string;
  /** When the process started (ms), which is when it loaded the conversation. */
  startedAt: number | null;
  /** The process's start time as `ps` gives it in UTC, to tell it from a later process with the same pid. */
  procStart: string | null;
}

/** Where Claude Code registers its running sessions (in its own folder, `~/.claude` or CLAUDE_CONFIG_DIR). */
export const sessionsDir = (): string => join(process.env.CLAUDE_CONFIG_DIR || join(homedir(), '.claude'), 'sessions');

/** Whether process `pid` still runs (EPERM: it does, as another user). */
function alive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    return (err as NodeJS.ErrnoException).code === 'EPERM';
  }
}

/** Claude Desktop's own ids for Code sessions, the only form its links take. */
const DESKTOP_ID = /^local_[A-Za-z0-9-]{1,64}$/;

/**
 * The running process that has Claude Code session `sessionId` open, if any. Claude Code refuses to open a session
 * in a second place ("is open in another terminal"), so Open in Claude Desktop checks here first. Entries of processes
 * that have ended are left behind, so only live ones count. When the app's own `claude -p` and another (Claude Desktop,
 * a terminal) both have it, the other one is the one that matters, and is returned.
 */
export async function openSession(sessionId: string, dir = sessionsDir()): Promise<OpenSession | null> {
  const names = await readdir(dir).catch(() => [] as string[]);
  let own: OpenSession | null = null;
  for (const name of names.filter((n) => /^\d+\.json$/.test(n))) {
    const entry = await readFile(join(dir, name), 'utf8')
      .then((text) => JSON.parse(text) as Record<string, unknown>)
      .catch(() => null);
    if (entry?.sessionId !== sessionId || typeof entry.pid !== 'number' || !alive(entry.pid)) continue;
    const entrypoint = typeof entry.entrypoint === 'string' ? entry.entrypoint : '';
    const inDesktop = entrypoint === 'claude-desktop';
    const host = typeof entry.hostSessionId === 'string' && DESKTOP_ID.test(entry.hostSessionId) ? entry.hostSessionId : null;
    const found: OpenSession = {
      pid: entry.pid,
      entrypoint,
      inDesktop,
      desktopId: inDesktop ? (host ?? `local_${sessionId}`) : null,
      status: typeof entry.status === 'string' ? entry.status : '',
      startedAt: typeof entry.startedAt === 'number' ? entry.startedAt : null,
      procStart: typeof entry.procStart === 'string' ? entry.procStart : null,
    };
    if (!entrypoint.startsWith('sdk')) return found;
    own ??= found;
  }
  return own;
}

/** Whether `pid` is still the Claude Code process that started at `procStart` (pids are reused). */
export function sameProcess(pid: number, procStart: string): Promise<boolean> {
  const squash = (t: string) => t.trim().replace(/\s+/g, ' ');
  return new Promise((resolve) =>
    execFile('ps', ['-p', String(pid), '-o', 'lstart=', '-o', 'comm='], { env: { ...process.env, TZ: 'UTC' } }, (err, out) => {
      if (err) return resolve(false);
      const text = squash(out);
      const start = squash(procStart);
      resolve(text.startsWith(`${start} `) && /(^|\/)claude$/.test(text.slice(start.length + 1)));
    }),
  );
}

export interface ReleaseOptions {
  dir?: string;
  /** How a process is checked to be the registered one (tests stand in for `ps`). */
  check?: (pid: number, procStart: string) => Promise<boolean>;
  /** How long to wait for the process to end. */
  waitMs?: number;
}

/**
 * Ends the Claude process that has a session open while it's idle, so the session can be written to from the app.
 * Claude Code saves as it goes, and between turns there's nothing in flight. Claude Desktop starts a new process (with
 * what the app added) when the session is used again; a terminal drops back to its shell, where `claude --resume`
 * continues. A busy session, or a process that can't be confirmed to be the registered one, is left alone (false).
 */
export async function endIdleClaude(holder: OpenSession, { check = sameProcess, waitMs = 5000 }: ReleaseOptions = {}): Promise<boolean> {
  if (holder.status !== 'idle' || !holder.procStart || !(await check(holder.pid, holder.procStart))) return false;
  try {
    process.kill(holder.pid, 'SIGTERM');
  } catch {
    return !alive(holder.pid);
  }
  for (const until = Date.now() + waitMs; Date.now() < until; ) {
    if (!alive(holder.pid)) return true;
    await new Promise((r) => setTimeout(r, 100));
  }
  return !alive(holder.pid);
}

/**
 * Gets session `sessionId` ready for the app to write to. Claude Desktop's idle process for it is ended (see
 * `endIdleClaude`). Returns where it stays open (Claude Desktop answering, or a terminal), in which case the
 * app's request runs beside it; null when the app may write to it. The app's own `claude -p` runs don't count.
 */
export async function claimSession(sessionId: string, opts: ReleaseOptions = {}): Promise<ClaudeApp | null> {
  const holder = await openSession(sessionId, opts.dir);
  if (!holder || holder.entrypoint.startsWith('sdk')) return null;
  if (!holder.inDesktop) return 'terminal';
  if (!(await endIdleClaude(holder, opts))) return 'desktop';
  // Desktop may have opened it again straight away.
  return (await openElsewhere(sessionId, opts.dir))?.app ?? null;
}

/**
 * Takes session `sessionId` from Claude Code in a terminal, when you say so: its Claude ends if it's idle. False when
 * Claude is answering there (or the process can't be confirmed); true once no terminal has it (Claude Desktop's copy is
 * `claimSession`'s to handle).
 */
export async function takeFromTerminal(sessionId: string, opts: ReleaseOptions = {}): Promise<boolean> {
  const holder = await openSession(sessionId, opts.dir);
  if (!holder || holder.entrypoint.startsWith('sdk') || holder.inDesktop) return true;
  return endIdleClaude(holder, opts);
}

/** Where session `sessionId` is open outside the app now, and whether Claude is answering there; the app's own runs don't count. */
export async function openElsewhere(sessionId: string, dir = sessionsDir()): Promise<{ app: ClaudeApp; busy: boolean } | null> {
  const holder = await openSession(sessionId, dir);
  if (!holder || holder.entrypoint.startsWith('sdk')) return null;
  return { app: holder.inDesktop ? 'desktop' : 'terminal', busy: holder.status !== 'idle' };
}

/** The Agent SDK, loaded when first needed (it's large); only its readers of Claude Code's local session files are used. */
const sdk = () => import('@anthropic-ai/claude-agent-sdk');

/** When session `sessionId` last changed, or undefined when Claude Code doesn't have it (deleted, or cleaned up). */
export async function sessionChangedAt(sessionId: string, dir: string): Promise<number | undefined> {
  return (await (await sdk()).getSessionInfo(sessionId, { dir }))?.lastModified;
}

/** The session's messages, as the Agent SDK documents them (Claude Code's files themselves are internal). */
export async function sessionMessages(sessionId: string, dir: string): Promise<SessionLine[]> {
  return (await (await sdk()).getSessionMessages(sessionId, { dir })) as SessionLine[];
}
