import { create } from 'zustand';
import type { ActionRun, ClaudeView, PrPreview, PrSnapshot } from '../../shared/model';
import { api } from '../api';
import { rememberSnapshot } from './recents';

interface SessionsState {
  snapshots: Record<string, PrSnapshot>;
  /** What's known of a PR whose first snapshot isn't ready yet (see `PrPreview`). */
  previews: Record<string, PrPreview>;
  progress: Record<string, string | undefined>;
  errors: Record<string, string | undefined>;
  /** Background quick action runs per PR, newest first. */
  runs: Record<string, ActionRun[]>;
  /** When the PR was last checked for changes on GitHub (a sync counts too). */
  checkedAt: Record<string, string | undefined>;
  /** Each PR's Claude session as its conversation shows it (see `ClaudeView`), once loaded. */
  claude: Record<string, ClaudeView>;
}

export const useSessions = create<SessionsState>(() => ({ snapshots: {}, previews: {}, runs: {}, progress: {}, errors: {}, checkedAt: {}, claude: {} }));

export function startSessionEvents(): () => void {
  return api.onPrEvent((event) => {
    // Not state: `startRevealEvents` acts on it.
    if (event.type === 'reveal') return;
    if (event.type === 'snapshot') rememberSnapshot(event.snapshot);
    useSessions.setState((s) => {
      if (event.type === 'snapshot') {
        const { [event.key]: _done, ...previews } = s.previews;
        return {
          snapshots: { ...s.snapshots, [event.key]: event.snapshot },
          previews,
          progress: { ...s.progress, [event.key]: undefined },
          errors: { ...s.errors, [event.key]: undefined },
          checkedAt: { ...s.checkedAt, [event.key]: event.snapshot.syncedAt },
        };
      }
      if (event.type === 'action') {
        const list = s.runs[event.key] ?? [];
        const known = list.some((r) => r.id === event.run.id);
        return { runs: { ...s.runs, [event.key]: known ? list.map((r) => (r.id === event.run.id ? event.run : r)) : [event.run, ...list] } };
      }
      if (event.type === 'claude') return { claude: { ...s.claude, [event.key]: event.view } };
      if (event.type === 'preview') return { previews: { ...s.previews, [event.key]: event.preview } };
      if (event.type === 'checked') return { checkedAt: { ...s.checkedAt, [event.key]: event.at } };
      if (event.type === 'progress') return { progress: { ...s.progress, [event.key]: event.message } };
      return { errors: { ...s.errors, [event.key]: event.message }, progress: { ...s.progress, [event.key]: undefined } };
    });
  });
}

/**
 * Checks the PR for changes on GitHub now, unless that happened in the last 20s. For coming back to the app or to a
 * tab: the regular check runs every 45s.
 */
export function checkSoon(key: string): void {
  const last = useSessions.getState().checkedAt[key];
  if (last && Date.now() - new Date(last).getTime() < 20_000) return;
  void api.checkPr(key).catch(() => undefined);
}

/** The PR's background runs as the main process has them (for a window opened while they run). */
export async function loadRuns(key: string): Promise<void> {
  const runs = await api.quickActionRuns(key);
  useSessions.setState((s) => ({ runs: { ...s.runs, [key]: runs } }));
}

/** The PR's Claude session as the main process reads it (null while Claude is off in Settings). */
export async function loadClaudeView(key: string): Promise<void> {
  const view = await api.claudeView(key);
  if (view) useSessions.setState((s) => ({ claude: { ...s.claude, [key]: view } }));
}

export function useClaudeView(key: string): ClaudeView | undefined {
  return useSessions((s) => s.claude[key]);
}

/** Forgets a finished run, here and in the main process. */
export function dismissRun(key: string, id: string): void {
  void api.dismissQuickActionRun(id);
  useSessions.setState((s) => ({ runs: { ...s.runs, [key]: (s.runs[key] ?? []).filter((r) => r.id !== id) } }));
}

export function setSessionError(key: string, message: string | undefined): void {
  useSessions.setState((s) => ({ errors: { ...s.errors, [key]: message } }));
}

export function useSnapshot(key: string | undefined): PrSnapshot | undefined {
  return useSessions((s) => (key ? s.snapshots[key] : undefined));
}

export function forgetSession(key: string): void {
  useSessions.setState((s) => {
    const { [key]: _snap, ...snapshots } = s.snapshots;
    const { [key]: _pre, ...previews } = s.previews;
    const { [key]: _p, ...progress } = s.progress;
    const { [key]: _e, ...errors } = s.errors;
    return { snapshots, previews, progress, errors };
  });
}
