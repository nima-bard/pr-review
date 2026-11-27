import { useEffect } from 'react';
import type { PrSnapshot } from '../../../shared/model';
import { closeFind, focusFile, getPrUi, requestComposer, updateUi } from '../../state/ui';
import { treeCompare } from './treeOrder';

function typing(target: EventTarget | null): boolean {
  const el = target as HTMLElement | null;
  return !!el && (el.tagName === 'INPUT' || el.tagName === 'TEXTAREA' || el.tagName === 'SELECT' || el.isContentEditable);
}

/** j/k: next/previous file · n/p: next/previous open thread · t: filter files · ?: cheat sheet. */
export function useReviewKeys(snapshot: PrSnapshot, active: boolean, onHelp: () => void): void {
  useEffect(() => {
    if (!active) return;
    const files = [...snapshot.files].sort((a, b) => treeCompare(a.path, b.path)).map((f) => f.path);
    const order = new Map(files.map((p, i) => [p, i]));
    const threads = snapshot.threads
      .filter((t) => !t.isResolved)
      .sort((a, b) => (order.get(a.anchor.path) ?? 1e9) - (order.get(b.anchor.path) ?? 1e9) || (a.anchor.line ?? 0) - (b.anchor.line ?? 0));
    const onKey = (e: KeyboardEvent) => {
      if (e.metaKey || e.ctrlKey || e.altKey || typing(e.target)) return;
      const ui = getPrUi(snapshot.key);
      if (e.key === 'j' || e.key === 'k') {
        if (files.length === 0) return;
        const cur = ui.focusPath ? files.indexOf(ui.focusPath) : -1;
        const next = e.key === 'j' ? Math.min(files.length - 1, cur + 1) : Math.max(0, cur - 1);
        focusFile(snapshot.key, files[next]!);
      } else if (e.key === 'n' || e.key === 'p') {
        if (threads.length === 0) return;
        const cur = ui.focusThread ? threads.findIndex((t) => t.id === ui.focusThread) : -1;
        const next = e.key === 'n' ? (cur + 1) % threads.length : (cur - 1 + threads.length) % threads.length;
        const t = threads[next]!;
        focusFile(snapshot.key, t.anchor.path, t.id);
      } else if (e.key === 't') {
        e.preventDefault();
        updateUi(snapshot.key, { showTree: true, sidebar: 'files' });
        // Every open PR keeps its (hidden) view: focus this one's box, the visible one.
        setTimeout(() => [...document.querySelectorAll<HTMLInputElement>('input[placeholder="Filter files"]')].find((el) => el.offsetParent !== null)?.focus(), 0);
      } else if (e.key === '?') {
        onHelp();
      } else if (e.key === 'Escape') {
        if (getPrUi(snapshot.key).find.open) closeFind(snapshot.key);
        else requestComposer(snapshot.key, null);
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [snapshot, active, onHelp]);
}

export const SHORTCUTS: [string, string][] = [
  ['j / k', 'Next / previous file'],
  ['n / p', 'Next / previous open thread'],
  ['t', 'Filter files'],
  ['⌘F / ⌘G', 'Find in this view / next match'],
  ['⇧⌘F', 'Find in files'],
  ['⇧⌘E', 'Show the file tree'],
  ['⌘B', 'Show or hide the left panel (files, search)'],
  ['⇧⌘C', 'Show or hide the right panel (comments, Claude)'],
  ['⇧⌘A', 'Show the conversation with Claude, or hide it'],
  ['⌥Z', 'Toggle word wrap'],
  ['⌘R', 'Refresh pull request'],
  ['⌥⌘1–9', 'Run a quick action'],
  ['⌘T / ⌘W', 'New tab / close tab'],
  ['⌘1…9', 'Switch tab'],
  ['⌘,', 'Settings'],
  ['⌘⏎', 'Send comment or reply'],
  ['Esc', 'Cancel comment'],
  ['?', 'This cheat sheet'],
];
