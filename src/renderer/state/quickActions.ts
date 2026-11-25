import { create } from 'zustand';
import type { PrSnapshot, QuickAction } from '../../shared/model';
import { actionsFor } from '../../shared/quickActions';
import type { ContextMenuItem } from '../../shared/ipc';
import { api, errorText } from '../api';
import { setSessionError } from './sessions';
import { openSettings } from './tabs';

/** The quick actions from Settings, kept here for the menus and shortcuts. */
export const useQuickActions = create<{ actions: QuickAction[] }>(() => ({ actions: [] }));

export async function loadQuickActions(): Promise<void> {
  const settings = await api.getSettings();
  useQuickActions.setState({ actions: settings.quickActions });
}

export function setQuickActions(actions: QuickAction[]): void {
  useQuickActions.setState({ actions });
}

const repoOf = (snapshot: PrSnapshot) => `${snapshot.ref.owner}/${snapshot.ref.repo}`;

/** The PR's actions, in their order in Settings (⌥⌘1–9 run the first nine). */
export function prActions(snapshot: PrSnapshot): QuickAction[] {
  return actionsFor(useQuickActions.getState().actions, repoOf(snapshot), 'pr');
}

export function fileActions(snapshot: PrSnapshot): QuickAction[] {
  return actionsFor(useQuickActions.getState().actions, repoOf(snapshot), 'file');
}

/** Runs an action; a failure (no terminal, a bad setting…) shows on the PR. */
export async function runQuickAction(key: string, actionId: string, file: string | null = null): Promise<void> {
  try {
    await api.runQuickAction(key, actionId, file);
  } catch (err) {
    setSessionError(key, errorText(err));
  }
}

/** The Actions menu: the PR's actions with their shortcuts, and a way to Settings. */
export async function showActionsMenu(snapshot: PrSnapshot): Promise<void> {
  const actions = prActions(snapshot);
  const items: ContextMenuItem[] = [
    ...actions.map((a, i) => ({ id: `qa:${a.id}`, label: a.mode === 'terminal' ? `${a.name} ↗` : a.name, accelerator: i < 9 ? `Alt+Cmd+${i + 1}` : undefined })),
    ...(actions.length === 0 ? [{ id: 'none', label: 'No quick actions for this repository', enabled: false }] : []),
    'separator',
    { id: 'settings', label: actions.length === 0 ? 'Set Up Quick Actions…' : 'Edit Quick Actions…' },
  ];
  const choice = await api.contextMenu(items);
  if (choice === 'settings') openSettings('quick-actions');
  else if (choice?.startsWith('qa:')) await runQuickAction(snapshot.key, choice.slice(3));
}
