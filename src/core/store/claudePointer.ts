import { join } from 'node:path';
import { gitDir } from '../git/worktrees';
import { safeName } from './appState';
import { readJson, writeJson } from './jsonStore';

/**
 * All the app keeps about a pull request's Claude session: which one it is, the line questions whose marker you
 * removed from the diff, and the offered choices you declined. The conversation itself is only in the session.
 */
export interface ClaudePointer {
  sessionId: string | null;
  hiddenMarkers: string[];
  /** Exchanges whose offered choices you declined. */
  dismissedOffers: string[];
}

const EMPTY: ClaudePointer = { sessionId: null, hiddenMarkers: [], dismissedOffers: [] };
const strings = (v: unknown): string[] => (Array.isArray(v) ? v.filter((m): m is string => typeof m === 'string') : []);

/**
 * Where a pull request's pointer lives: in its worktree's own git folder, so it's never committed or pushed and goes
 * away with the worktree (one file per pull request, for a checkout that serves several).
 */
export async function claudePointerFile(worktree: string, prKey: string): Promise<string> {
  return join(await gitDir(worktree), 'pr-review', `${safeName(prKey)}.json`);
}

export async function readClaudePointer(file: string): Promise<ClaudePointer> {
  const stored = await readJson<Partial<ClaudePointer>>(file, {});
  return {
    sessionId: typeof stored.sessionId === 'string' ? stored.sessionId : EMPTY.sessionId,
    hiddenMarkers: strings(stored.hiddenMarkers),
    dismissedOffers: strings(stored.dismissedOffers),
  };
}

export function writeClaudePointer(file: string, pointer: ClaudePointer): Promise<void> {
  return writeJson(file, pointer);
}
