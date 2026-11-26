import { execFile } from 'node:child_process';
import { open, readdir, readFile, stat } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join } from 'node:path';
import type { OutsideClaude } from '../../shared/model';

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

/** Claude Code's own folder: its running sessions and transcripts. */
const claudeDir = (): string => process.env.CLAUDE_CONFIG_DIR || join(homedir(), '.claude');

/** Where Claude Code registers its running sessions. */
export const sessionsDir = (): string => join(claudeDir(), 'sessions');

/** Where Claude Code keeps transcripts, one folder per project. */
export const projectsDir = (): string => join(claudeDir(), 'projects');

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
 * that have ended are left behind, so only live ones count.
 */
export async function openSession(sessionId: string, dir = sessionsDir()): Promise<OpenSession | null> {
  const names = await readdir(dir).catch(() => [] as string[]);
  for (const name of names.filter((n) => /^\d+\.json$/.test(n))) {
    const entry = await readFile(join(dir, name), 'utf8')
      .then((text) => JSON.parse(text) as Record<string, unknown>)
      .catch(() => null);
    if (entry?.sessionId !== sessionId || typeof entry.pid !== 'number' || !alive(entry.pid)) continue;
    const entrypoint = typeof entry.entrypoint === 'string' ? entry.entrypoint : '';
    const inDesktop = entrypoint === 'claude-desktop';
    const host = typeof entry.hostSessionId === 'string' && DESKTOP_ID.test(entry.hostSessionId) ? entry.hostSessionId : null;
    return {
      pid: entry.pid,
      entrypoint,
      inDesktop,
      desktopId: inDesktop ? (host ?? `local_${sessionId}`) : null,
      status: typeof entry.status === 'string' ? entry.status : '',
      startedAt: typeof entry.startedAt === 'number' ? entry.startedAt : null,
      procStart: typeof entry.procStart === 'string' ? entry.procStart : null,
    };
  }
  return null;
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
 * Ends Claude Desktop's process for a session while it's idle, so the session can be written to from the app, and
 * Desktop loads it afresh (with what the app added) when it's next opened or typed in. Claude Code saves as it goes,
 * and between turns there's nothing in flight; Desktop starts a new process when the session is used again. A busy
 * session, a terminal's, or a process that can't be confirmed to be the registered one is left alone (false).
 */
export async function endIdleDesktopProcess(holder: OpenSession, { check = sameProcess, waitMs = 5000 }: ReleaseOptions = {}): Promise<boolean> {
  if (!holder.inDesktop || holder.status !== 'idle' || !holder.procStart || !(await check(holder.pid, holder.procStart))) return false;
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
 * `endIdleDesktopProcess`). Returns where it stays open (Claude Desktop answering, or a terminal), in which case the
 * app's request runs beside it; null when the app may write to it. The app's own `claude -p` runs don't count.
 */
export async function claimSession(sessionId: string, opts: ReleaseOptions = {}): Promise<OutsideClaude | null> {
  const holder = await openSession(sessionId, opts.dir);
  if (!holder || holder.entrypoint.startsWith('sdk')) return null;
  if (!holder.inDesktop) return 'terminal';
  if (!(await endIdleDesktopProcess(holder, opts))) return 'desktop';
  // Desktop may have opened it again straight away.
  const again = await openSession(sessionId, opts.dir);
  return again && !again.entrypoint.startsWith('sdk') ? (again.inDesktop ? 'desktop' : 'terminal') : null;
}

/**
 * The transcript of session `sessionId`: `<projects>/<project>/<id>.jsonl`. The project folder is named after the
 * folder Claude Code ran in, which for a worktree may be its repository's, so every project is looked in.
 */
export async function findTranscript(sessionId: string, dir = projectsDir()): Promise<string | null> {
  const projects = await readdir(dir).catch(() => [] as string[]);
  for (const project of projects) {
    const path = join(dir, project, `${sessionId}.jsonl`);
    if (await stat(path).then((s) => s.isFile(), () => false)) return path;
  }
  return null;
}

/**
 * The whole lines transcript `path` gained since byte `offset`, and the offset after them. A line Claude Code is still
 * writing waits for the next read. A file that got shorter (rewritten) is read again from the start (`restarted`).
 * Null when there's no new whole line or the file is gone.
 */
export async function readTranscript(path: string, offset: number): Promise<{ text: string; end: number; restarted: boolean } | null> {
  const file = await open(path, 'r').catch(() => null);
  if (!file) return null;
  try {
    const { size } = await file.stat();
    const restarted = size < offset;
    const from = restarted ? 0 : offset;
    if (size === from) return null;
    const buffer = Buffer.alloc(size - from);
    await file.read(buffer, 0, buffer.length, from);
    const whole = buffer.lastIndexOf(0x0a) + 1;
    if (whole === 0) return restarted ? { text: '', end: 0, restarted } : null;
    return { text: buffer.subarray(0, whole).toString('utf8'), end: from + whole, restarted };
  } finally {
    await file.close();
  }
}

/** The link that switches Claude Desktop to its Code session `desktopId`. */
export const desktopSessionLink = (desktopId: string): string => `claude://code/continue?session=${encodeURIComponent(desktopId)}`;

/** Shows Claude Desktop's Code session `desktopId`, bringing Desktop to the front. */
export function showInDesktop(desktopId: string): Promise<void> {
  return new Promise((resolve, reject) => execFile('open', [desktopSessionLink(desktopId)], (err) => (err ? reject(err) : resolve())));
}
