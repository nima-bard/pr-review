import { create } from 'zustand';
import type { LineTarget } from '../../shared/model';

/**
 * What you're looking at in a pull request's Files view, for the Claude box to ask about unless you remove it: the lines
 * you selected, or the review thread you clicked into or went to. The newest one counts. Kept apart from the PR's UI
 * state, so a drag over lines (which changes it on every line) only re-renders the Claude box.
 */
export type ViewContext =
  /** `from: 'text'`: an ordinary text selection in the code, rather than lines picked by their numbers. */
  | { kind: 'lines'; target: LineTarget; from?: 'text' }
  | { kind: 'thread'; threadId: string };

const useStore = create<{ byKey: Record<string, ViewContext | undefined> }>(() => ({ byKey: {} }));

const same = (a: ViewContext | undefined, b: ViewContext | undefined) => JSON.stringify(a) === JSON.stringify(b);

export function useViewContext(key: string): ViewContext | undefined {
  return useStore((s) => s.byKey[key]);
}

export function setViewContext(key: string, context: ViewContext | null): void {
  const next = context ?? undefined;
  if (same(useStore.getState().byKey[key], next)) return;
  useStore.setState((s) => ({ byKey: { ...s.byKey, [key]: next } }));
}

/** Whether `threadId` is the thread you've selected (clicked into, or gone to): it's drawn highlighted. */
export function useSelectedThread(key: string, threadId: string): boolean {
  return useStore((s) => {
    const c = s.byKey[key];
    return c?.kind === 'thread' && c.threadId === threadId;
  });
}

/** You clicked elsewhere in the code: the thread you'd selected isn't any more. */
export function clearSelectedThread(key: string): void {
  if (useStore.getState().byKey[key]?.kind === 'thread') setViewContext(key, null);
}

/** A text selection in the code went (you clicked elsewhere in it): forget it, unless something newer counts. */
export function clearTextSelection(key: string): void {
  const current = useStore.getState().byKey[key];
  if (current?.kind === 'lines' && current.from === 'text') setViewContext(key, null);
}

/** The selection in `path` went (cleared, or the comment editor closed): forget it, unless something newer counts. */
export function clearSelectedLines(key: string, path: string): void {
  const current = useStore.getState().byKey[key];
  if (current?.kind === 'lines' && current.target.path === path) setViewContext(key, null);
}
