import { join } from 'node:path';
import type { ClaudeEffort, ClaudeModelChoice } from '../../shared/model';
import { gitDir } from '../git/worktrees';
import { safeName } from './appState';
import { readJson, writeJson } from './jsonStore';

/**
 * All the app keeps about a pull request's Claude session: which one it is, the line questions whose marker you
 * removed from the diff, the offered choices you declined, and the model chosen in the conversation. The conversation
 * itself is only in the session.
 */
export interface ClaudePointer {
  sessionId: string | null;
  hiddenMarkers: string[];
  /** Exchanges whose offered choices you declined. */
  dismissedOffers: string[];
  /** The model and effort chosen in this conversation; null uses Settings › Claude's. */
  modelChoice: ClaudeModelChoice | null;
}

const EMPTY: ClaudePointer = { sessionId: null, hiddenMarkers: [], dismissedOffers: [], modelChoice: null };
const EFFORTS: readonly string[] = ['low', 'medium', 'high', 'xhigh', 'max'];

/** A saved model choice, when it's well formed. */
function modelChoice(v: unknown): ClaudeModelChoice | null {
  const c = v as Partial<ClaudeModelChoice> | null;
  if (typeof c?.model !== 'string' || typeof c.effort !== 'string' || (c.effort !== '' && !EFFORTS.includes(c.effort))) return null;
  return { model: c.model, effort: c.effort as ClaudeEffort | '' };
}
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
    modelChoice: modelChoice(stored.modelChoice),
  };
}

export function writeClaudePointer(file: string, pointer: ClaudePointer): Promise<void> {
  return writeJson(file, pointer);
}
