import type { DockTab } from '../../shared/ipc';
import { api } from '../api';
import { useSessions } from './sessions';
import { popOutKey, repoOfKey, useTabs, type PrTab } from './tabs';

/** "#3017 Fix the …", with the repository first ("platform #3017 …") when it's needed to tell tabs apart. */
function tabLabel(key: string, title: string | undefined, withRepo: boolean): string {
  const m = /([^/]+)#(\d+)$/.exec(key);
  const text = `${withRepo && m ? `${m[1]} ` : ''}#${m?.[2] ?? ''}${title ? ` ${title}` : ''}`;
  return text.length > 80 ? `${text.slice(0, 79)}…` : text;
}

/**
 * Keeps the Dock menu's list of this window's PR tabs current (right-click the app's icon in the Dock). A popped-out
 * PR's window is named after its PR instead, which is how macOS lists it there and in the Window menu.
 */
export function startDockTabs(): () => void {
  let last = '';
  const update = () => {
    const { tabs, activeId } = useTabs.getState();
    const { snapshots, previews } = useSessions.getState();
    const prTabs = tabs.filter((t): t is PrTab => t.kind === 'pr');
    const withRepo = popOutKey !== null || new Set(prTabs.map((t) => repoOfKey(t.key))).size > 1;
    const list: DockTab[] = prTabs.map((t) => ({
      id: t.id,
      label: tabLabel(t.key, (snapshots[t.key]?.details ?? previews[t.key]?.details ?? t.summary)?.title, withRepo),
      active: t.id === activeId,
    }));
    const json = JSON.stringify(list);
    if (json === last) return;
    last = json;
    if (popOutKey) document.title = list[0]?.label ?? 'PR Review';
    else api.reportTabs(list);
  };
  update();
  const stopTabs = useTabs.subscribe(update);
  const stopSessions = useSessions.subscribe(update);
  return () => {
    stopTabs();
    stopSessions();
  };
}
