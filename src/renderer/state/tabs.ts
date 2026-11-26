import { create } from 'zustand';
import { prKey, type OpenPrResult, type PrSummary } from '../../shared/model';
import { parsePrInput } from '../../shared/prInput';
import { api, errorText } from '../api';
import { markOpened } from './recents';
import { moveToSlot } from './reorder';
import { tabsToRestore } from './restore';
import { checkSoon, forgetSession, loadSnapshot, setSessionError } from './sessions';
import { showSettingsSection, type SettingsSection } from './settingsPage';

/**
 * A PR tab restored at startup is `dormant`: it only has a `summary` (title and author, for the tab bar) until it
 * first becomes active, which opens its session (checkout, diffs, threads, polling).
 */
export type PrTab = { id: string; kind: 'pr'; key: string; input: string; dormant?: boolean; summary?: PrSummary };
/** `link`: a PR link this New tab opens as if pasted into it (so problems, like a repo with no clone, show there). */
export type Tab = { id: string; kind: 'new'; link?: string } | { id: string; kind: 'settings' } | PrTab;

interface TabsState {
  tabs: Tab[];
  activeId: string;
}

/** "owner/repo" from a PR key like "github.com/owner/repo#12". */
export const repoOfKey = (key: string) => /([^/]+\/[^/]+)#\d+$/.exec(key)?.[1] ?? key;

let seq = 0;
const newId = () => `t${Date.now().toString(36)}${(seq++).toString(36)}`;

const popOutMatch = /(?:^|[#&])pr=([^&]+)/.exec(window.location.hash);
export const popOutKey = popOutMatch ? decodeURIComponent(popOutMatch[1]!) : null;

const firstTab: Tab = popOutKey ? { id: newId(), kind: 'pr', key: popOutKey, input: popOutKey } : { id: newId(), kind: 'new' };
export const useTabs = create<TabsState>(() => ({ tabs: [firstTab], activeId: firstTab.id }));

function persist(): void {
  if (popOutKey) return;
  const inputs = useTabs
    .getState()
    .tabs.flatMap((t) => (t.kind === 'pr' ? [t.input] : []));
  void api.saveOpenTabs(inputs);
}

export function newTab(): void {
  const tab: Tab = { id: newId(), kind: 'new' };
  useTabs.setState((s) => ({ tabs: [...s.tabs, tab], activeId: tab.id }));
}

/** Opens a PR link (from the browser extension, a prreview:// link or a comment) in a new tab, or switches to its tab. */
export function openPrLink(input: string): void {
  const tab: Tab = { id: newId(), kind: 'new', link: input };
  useTabs.setState((s) => ({ tabs: [...s.tabs, tab], activeId: tab.id }));
}

/** Switches to the Settings tab, opening one if none is open. */
/** Opens Settings (or switches to it), at `section` if given. */
export function openSettings(section?: SettingsSection): void {
  if (section) showSettingsSection(section);
  const existing = useTabs.getState().tabs.find((t) => t.kind === 'settings');
  if (existing) return activate(existing.id);
  const tab: Tab = { id: newId(), kind: 'settings' };
  useTabs.setState((s) => ({ tabs: [...s.tabs, tab], activeId: tab.id }));
}

export function activate(id: string): void {
  useTabs.setState({ activeId: id });
}

export function activateIndex(index: number): void {
  const tab = useTabs.getState().tabs[index];
  if (tab) activate(tab.id);
}

export function closeTab(id: string): void {
  const { tabs, activeId } = useTabs.getState();
  const idx = tabs.findIndex((t) => t.id === id);
  const tab = tabs[idx];
  if (!tab) return;
  if (tab.kind === 'pr' && !tabs.some((t) => t.id !== id && t.kind === 'pr' && t.key === tab.key)) {
    void api.closePr(tab.key);
    forgetSession(tab.key);
  }
  let rest = tabs.filter((t) => t.id !== id);
  if (rest.length === 0) rest = [{ id: newId(), kind: 'new' }];
  const nextActive = activeId === id ? (rest[Math.min(idx, rest.length - 1)]?.id ?? rest[0]!.id) : activeId;
  useTabs.setState({ tabs: rest, activeId: nextActive });
  persist();
}

/** Closes every tab showing `key`, whose session has ended (its worktree was removed); a pop-out window closes. */
export function closePrTabs(key: string): void {
  if (popOutKey === key) {
    window.close();
    return;
  }
  for (const t of useTabs.getState().tabs) if (t.kind === 'pr' && t.key === key) closeTab(t.id);
}

/** Drag reorder: moves the tab at `from` before the one at `slot` (or to the end). Restores in the new order. */
export function moveTab(from: number, slot: number): void {
  useTabs.setState((s) => ({ tabs: moveToSlot(s.tabs, from, slot) }));
  persist();
}

/** Moves a PR tab into its own window; the main-process session stays alive for it. */
export async function popOutTab(id: string): Promise<void> {
  const tab = useTabs.getState().tabs.find((t) => t.id === id);
  if (tab?.kind !== 'pr') return;
  await api.popOut(tab.key);
  const { tabs, activeId } = useTabs.getState();
  const idx = tabs.findIndex((t) => t.id === id);
  let rest = tabs.filter((t) => t.id !== id);
  if (rest.length === 0) rest = [{ id: newId(), kind: 'new' }];
  useTabs.setState({ tabs: rest, activeId: activeId === id ? rest[Math.min(idx, rest.length - 1)]!.id : activeId });
  persist();
}

/** Opens a PR in tab `fromId` (a New tab) or switches to the tab that already shows it. */
export async function openPr(input: string, fromId?: string): Promise<OpenPrResult> {
  const result = await api.openPr(input);
  if (!result.ok) return result;
  void loadSnapshot(result.key);
  markOpened(result.key);
  const { tabs } = useTabs.getState();
  const existing = tabs.find((t) => t.kind === 'pr' && t.key === result.key);
  if (existing) {
    const source = tabs.find((t) => t.id === fromId);
    useTabs.setState({
      tabs: source?.kind === 'new' && tabs.length > 1 ? tabs.filter((t) => t.id !== fromId) : tabs,
      activeId: existing.id,
    });
    return result;
  }
  const tab: Tab = { id: fromId ?? newId(), kind: 'pr', key: result.key, input: input.trim() };
  useTabs.setState((s) => {
    const replaced = fromId && s.tabs.some((t) => t.id === fromId);
    return { tabs: replaced ? s.tabs.map((t) => (t.id === fromId ? tab : t)) : [...s.tabs, tab], activeId: tab.id };
  });
  persist();
  return result;
}

const ACTIVE_KEY = 'active-pr-tab';

function loadActiveInput(): string | null {
  try {
    return localStorage.getItem(ACTIVE_KEY);
  } catch {
    return null;
  }
}

async function openSession(key: string, input: string): Promise<void> {
  setSessionError(key, undefined);
  const result = await api.openPr(input).catch((err: unknown): OpenPrResult => ({ ok: false, reason: 'error', message: errorText(err) }));
  if (!result.ok) setSessionError(key, result.message);
  else void loadSnapshot(key);
}

/** The PR view's Retry when no snapshot arrived: open the session if needed, then refresh it. */
export async function retryPr(key: string): Promise<void> {
  const tab = useTabs.getState().tabs.find((t): t is PrTab => t.kind === 'pr' && t.key === key);
  if (tab) await openSession(key, tab.input);
  await api.refreshPr(key).catch(() => undefined);
}

// A dormant tab opens its session the first time it becomes active, however it got there (click, ⌘1-9, closing a
// neighbour, restore). The active PR is also remembered, so a restart reopens that one first.
useTabs.subscribe((state, prev) => {
  if (state.activeId === prev.activeId && state.tabs === prev.tabs) return;
  const active = state.tabs.find((t) => t.id === state.activeId);
  if (active?.kind === 'pr' && active.dormant) {
    useTabs.setState((s) => ({ tabs: s.tabs.map((t) => (t.id === active.id ? { ...active, dormant: false } : t)) }));
    void openSession(active.key, active.input);
  } else if (active?.kind === 'pr' && state.activeId !== prev.activeId) {
    // Switching to a PR tab: check it for changes now (if it wasn't checked in the last 20s).
    checkSoon(active.key);
  }
  if (!popOutKey && state.activeId !== prev.activeId && active?.kind === 'pr') {
    try {
      localStorage.setItem(ACTIVE_KEY, active.input);
    } catch {
      // Only the restart order is lost.
    }
  }
});

/** Restores the last session's PR tabs: the active one opens fully, the others only fetch their titles. */
export async function restoreTabs(): Promise<void> {
  if (popOutKey) return;
  const inputs = await api.getOpenTabs();
  const open = new Set(useTabs.getState().tabs.flatMap((t) => (t.kind === 'pr' ? [t.key] : [])));
  const restored: PrTab[] = tabsToRestore(inputs, open).map((t) => ({ id: newId(), kind: 'pr', ...t, dormant: true }));
  if (restored.length === 0) return;
  const savedActive = loadActiveInput();
  const active = restored.find((t) => t.input === savedActive) ?? restored.at(-1)!;
  useTabs.setState((s) => ({
    // Drop the startup blank tab; keep anything opened in the meantime.
    tabs: [...restored, ...s.tabs.filter((t) => !(t.kind === 'new' && s.tabs.length === 1))],
    activeId: active.id,
  }));
  for (const tab of restored) {
    if (tab === active) continue;
    void api.prSummary(tab.input).then((summary) => {
      if (!summary) return;
      useTabs.setState((s) => ({ tabs: s.tabs.map((t) => (t.id === tab.id && t.kind === 'pr' ? { ...t, summary } : t)) }));
    });
  }
}
