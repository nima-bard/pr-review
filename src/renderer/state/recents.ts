import { create } from 'zustand';
import type { PrSnapshot, SearchItem } from '../../shared/model';

const STORAGE_KEY = 'recent-prs';
const MAX = 20;

/** A pull request opened in this app; `openedAt` orders the list, `item` is refreshed with each snapshot. */
export interface RecentPr {
  item: SearchItem;
  openedAt: string;
}

function load(): RecentPr[] {
  try {
    const list = JSON.parse(localStorage.getItem(STORAGE_KEY) ?? '[]') as RecentPr[];
    return Array.isArray(list) ? list.filter((r) => r?.item?.key && r.openedAt) : [];
  } catch {
    return [];
  }
}

export const useRecents = create<RecentPr[]>(() => load());

function save(list: RecentPr[]): void {
  const sorted = [...list].sort((a, b) => b.openedAt.localeCompare(a.openedAt)).slice(0, MAX);
  useRecents.setState(sorted, true);
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(sorted));
  } catch {
    // Only the list's persistence is lost; it still works for this session.
  }
}

/** The row data for the shared PR list, built from what the open PR already knows. */
function toItem(s: PrSnapshot): SearchItem {
  const d = s.details;
  const passed = d.checks.filter((c) => c.state === 'success' || c.state === 'neutral').length;
  const checks = d.checks.length === 0 ? null : d.checks.some((c) => c.state === 'failure') ? 'failure' : d.checks.some((c) => c.state === 'pending') ? 'pending' : 'success';
  return {
    key: s.key,
    ref: s.ref,
    title: d.title,
    author: d.author,
    isDraft: d.isDraft,
    state: d.state,
    createdAt: d.createdAt,
    updatedAt: d.updatedAt,
    labels: d.labels,
    reviewDecision: d.reviewDecision,
    checks,
    checkCounts: d.checks.length ? { passed, total: d.checks.length } : null,
    comments: s.threads.length + s.conversation.filter((c) => c.kind === 'comment').length,
    additions: d.additions,
    deletions: d.deletions,
  };
}

/** Called with every snapshot: adds a PR the first time, otherwise only refreshes its details (not its position). */
export function rememberSnapshot(s: PrSnapshot): void {
  const list = useRecents.getState();
  const existing = list.find((r) => r.item.key === s.key);
  save(existing ? list.map((r) => (r === existing ? { ...r, item: toItem(s) } : r)) : [...list, { item: toItem(s), openedAt: new Date().toISOString() }]);
}

/** Called when the user opens a PR (also an already open one), so it moves to the top. */
export function markOpened(key: string): void {
  const list = useRecents.getState();
  if (list.some((r) => r.item.key === key)) save(list.map((r) => (r.item.key === key ? { ...r, openedAt: new Date().toISOString() } : r)));
}

export function clearRecents(): void {
  save([]);
}
