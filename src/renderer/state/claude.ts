import { create } from 'zustand';
import type { AgentRequest, ClaudeSettings } from '../../shared/model';
import { api, errorText } from '../api';
import { setSessionError } from './sessions';
import { showSidePanel } from './ui';

/** Settings › Claude, kept here for the comment editor, the Claude button and the side panel. */
export const useClaudeSettings = create<ClaudeSettings>(() => ({ enabled: false, model: '', effort: '' }));

export async function loadClaudeSettings(): Promise<void> {
  useClaudeSettings.setState((await api.getSettings()).claude);
}

export function setClaudeSettings(settings: ClaudeSettings): void {
  useClaudeSettings.setState(settings);
}

/**
 * Asks Claude in the PR's session and, unless `reveal` is false (a line's marker shows how it goes), shows the
 * conversation; a failure shows on the PR.
 */
export async function askClaude(key: string, request: AgentRequest, reveal = true): Promise<void> {
  try {
    await api.askClaude(key, request);
    if (reveal) showSidePanel(key, 'claude');
  } catch (err) {
    setSessionError(key, errorText(err));
  }
}
