import { useEffect, type RefObject } from 'react';
import { matcher } from '../../shared/searchMatch';
import { getPrUi, usePrUi } from '../state/ui';
import { lineRanges } from './useSearchHighlights';

/** Line `line` of the new code in Pierre's view under `root`: its line-number cell (not the removed side's). */
function lineElement(root: HTMLElement | null, line: number): HTMLElement | null {
  const shadow = root?.querySelector('diffs-container')?.shadowRoot;
  if (!shadow) return null;
  for (const el of shadow.querySelectorAll<HTMLElement>(`[data-column-number="${line}"]`)) {
    if (!el.closest('[data-deletions]') && el.getAttribute('data-line-type') !== 'change-deletion') return el;
  }
  return null;
}

/** On a long line, scrolls sideways to the line's first search match (like VS Code), if the search has one there. */
function revealMatch(gutterCell: HTMLElement, key: string): void {
  const re = getPrUi(key).search.pattern ? matcher(getPrUi(key).search) : null;
  const index = gutterCell.getAttribute('data-line-index');
  const shadow = gutterCell.getRootNode();
  if (!re || index === null || !(shadow instanceof ShadowRoot)) return;
  const code = [...shadow.querySelectorAll<HTMLElement>(`[data-line][data-line-index="${index}"]`)].find((el) => !el.closest('[data-deletions]'));
  const first = code ? lineRanges(code, re)[0] : undefined;
  // The match's own box: a syntax token can be a whole long string, so scrolling to its element isn't enough.
  const column = code?.closest<HTMLElement>('[data-code]');
  if (!column) return;
  // No match on the line (or none the search can mark): show the line's start, not wherever the last jump left it.
  if (!first) {
    column.scrollLeft = 0;
    return;
  }
  const match = first.getBoundingClientRect();
  const box = column.getBoundingClientRect();
  if (match.left >= box.left && match.right <= box.right) return;
  column.scrollLeft += match.left - box.left - box.width / 2 + match.width / 2;
}

/**
 * Shows the line a search result asked for in this file's view: selects it (`select`) and scrolls it to the middle,
 * and sideways to the match. Pierre draws the file asynchronously and draws it again (syntax colours from the
 * worker, the new selection, word-wrapped heights), which moves the line and resets the sideways scroll, so the line
 * is kept in place through those redraws: for two seconds, or until the user scrolls, clicks or types.
 */
export function useFocusLine(key: string, path: string, root: RefObject<HTMLElement | null>, enabled: boolean, select: (line: number) => void): void {
  const focus = usePrUi(key).focusLine;
  const target = enabled && focus?.path === path ? focus : null;
  useEffect(() => {
    if (!target) return;
    select(target.line);
    const giveUp = performance.now() + 5000;
    let holdUntil = 0;
    let frame = 0;
    let stopped = false;
    const observers: { disconnect(): void }[] = [];
    const reveal = () => {
      frame = 0;
      if (stopped) return;
      const el = lineElement(root.current, target.line);
      if (!el) {
        // Not drawn yet: look again next frame.
        if (performance.now() < giveUp) frame = requestAnimationFrame(reveal);
        return;
      }
      el.scrollIntoView({ block: 'center' });
      revealMatch(el, key);
      if (holdUntil === 0) hold(el);
    };
    const schedule = () => {
      if (!stopped && frame === 0 && performance.now() < holdUntil) frame = requestAnimationFrame(reveal);
    };
    /** Reveal again whenever Pierre redraws or resizes the view, for a while. */
    const hold = (el: HTMLElement) => {
      holdUntil = performance.now() + 2000;
      const shadow = el.getRootNode();
      if (!(shadow instanceof ShadowRoot)) return;
      const redraws = new MutationObserver(schedule);
      redraws.observe(shadow, { childList: true, subtree: true });
      const resizes = new ResizeObserver(schedule);
      resizes.observe(shadow.host);
      observers.push(redraws, resizes);
    };
    const stop = () => {
      stopped = true;
      cancelAnimationFrame(frame);
      for (const o of observers) o.disconnect();
      for (const type of USER_INPUT) removeEventListener(type, stop, true);
    };
    for (const type of USER_INPUT) addEventListener(type, stop, { capture: true, passive: true });
    // Two frames: after React has drawn the new selection.
    frame = requestAnimationFrame(() => (frame = requestAnimationFrame(reveal)));
    return stop;
    // A new jump (seq) or another file; `select` and `root` are stable for the view.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [target?.seq, path]);
}

/** The user taking over: scrolling, clicking or typing ends holding the line in place. */
const USER_INPUT = ['wheel', 'pointerdown', 'keydown', 'touchmove'] as const;
