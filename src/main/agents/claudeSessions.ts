import { execFile } from 'node:child_process';
import { readdir, readFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join } from 'node:path';

/** A Claude Code process that has a session open, as Claude Code registers it in `~/.claude/sessions/<pid>.json`. */
export interface OpenSession {
  pid: number;
  /** Claude Desktop runs it (`claude-desktop`), or a terminal (`cli`)… */
  inDesktop: boolean;
  /** Claude Desktop's id for it ("local_…"), when Desktop runs it. */
  desktopId: string | null;
}

/** Where Claude Code registers its running sessions. */
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
 * that have ended are left behind, so only live ones count.
 */
export async function openSession(sessionId: string, dir = sessionsDir()): Promise<OpenSession | null> {
  const names = await readdir(dir).catch(() => [] as string[]);
  for (const name of names.filter((n) => /^\d+\.json$/.test(n))) {
    const entry = await readFile(join(dir, name), 'utf8')
      .then((text) => JSON.parse(text) as Record<string, unknown>)
      .catch(() => null);
    if (entry?.sessionId !== sessionId || typeof entry.pid !== 'number' || !alive(entry.pid)) continue;
    const inDesktop = entry.entrypoint === 'claude-desktop';
    const host = typeof entry.hostSessionId === 'string' && DESKTOP_ID.test(entry.hostSessionId) ? entry.hostSessionId : null;
    return { pid: entry.pid, inDesktop, desktopId: inDesktop ? (host ?? `local_${sessionId}`) : null };
  }
  return null;
}

/** The link that switches Claude Desktop to its Code session `desktopId`. */
export const desktopSessionLink = (desktopId: string): string => `claude://code/continue?session=${encodeURIComponent(desktopId)}`;

/** Shows Claude Desktop's Code session `desktopId`, bringing Desktop to the front. */
export function showInDesktop(desktopId: string): Promise<void> {
  return new Promise((resolve, reject) => execFile('open', [desktopSessionLink(desktopId)], (err) => (err ? reject(err) : resolve())));
}
