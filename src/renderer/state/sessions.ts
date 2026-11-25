import { create } from 'zustand';
import type { PrSnapshot } from '../../shared/model';
import { api } from '../api';
import { rememberSnapshot } from './recents';

interface SessionsState {
  snapshots: Record<string, PrSnapshot>;
  progress: Record<string, string | undefined>;
  errors: Record<string, string | undefined>;
  /** When the PR was last checked for changes on GitHub (a sync counts too). */
  checkedAt: Record<string, string | undefined>;
}

export const useSessions = create<SessionsState>(() => ({ snapshots: {}, progress: {}, errors: {}, checkedAt: {} }));

export function startSessionEvents(): () => void {
  return api.onPrEvent((event) => {
    if (event.type === 'snapshot') rememberSnapshot(event.snapshot);
    useSessions.setState((s) => {
      if (event.type === 'snapshot') {
        return {
          snapshots: { ...s.snapshots, [event.key]: event.snapshot },
          progress: { ...s.progress, [event.key]: undefined },
          errors: { ...s.errors, [event.key]: undefined },
          checkedAt: { ...s.checkedAt, [event.key]: event.snapshot.syncedAt },
        };
      }
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

export function setSessionError(key: string, message: string | undefined): void {
  useSessions.setState((s) => ({ errors: { ...s.errors, [key]: message } }));
}

export function useSnapshot(key: string | undefined): PrSnapshot | undefined {
  return useSessions((s) => (key ? s.snapshots[key] : undefined));
}

export function forgetSession(key: string): void {
  useSessions.setState((s) => {
    const { [key]: _snap, ...snapshots } = s.snapshots;
    const { [key]: _p, ...progress } = s.progress;
    const { [key]: _e, ...errors } = s.errors;
    return { snapshots, progress, errors };
  });
}
