import { create } from 'zustand';
import type { UpdateInfo } from '../../shared/model';
import { api } from '../api';

interface UpdatesState {
  info: UpdateInfo | null;
  checking: boolean;
  /** The version whose notice was dismissed: it stays hidden until a newer one is out. */
  dismissed: string | null;
}

const DISMISSED_KEY = 'update-dismissed';

function loadDismissed(): string | null {
  try {
    return localStorage.getItem(DISMISSED_KEY);
  } catch {
    return null;
  }
}

export const useUpdates = create<UpdatesState>(() => ({ info: null, checking: false, dismissed: loadDismissed() }));

/** Compares this version with the latest GitHub release. */
export async function checkForUpdate(): Promise<UpdateInfo> {
  useUpdates.setState({ checking: true });
  try {
    const info = await api.checkForUpdate();
    useUpdates.setState({ info });
    return info;
  } finally {
    useUpdates.setState({ checking: false });
  }
}

export function dismissUpdate(version: string): void {
  useUpdates.setState({ dismissed: version });
  try {
    localStorage.setItem(DISMISSED_KEY, version);
  } catch {
    // Only shown again on the next start.
  }
}

/** Checks 15s after launch and then every 6 hours; returns the cleanup. */
export function startUpdateChecks(): () => void {
  const first = setTimeout(() => void checkForUpdate().catch(() => undefined), 15_000);
  const every = setInterval(() => void checkForUpdate().catch(() => undefined), 6 * 3600_000);
  return () => {
    clearTimeout(first);
    clearInterval(every);
  };
}
