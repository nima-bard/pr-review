import { useEffect, type RefObject } from 'react';
import type { DiffSide, LineTarget, TextSelection } from '../../shared/model';
import { clearSelectedThread, clearTextSelection, setViewContext } from '../state/viewContext';

type SelectableRoot = ShadowRoot & { getSelection?(): Selection | null };

/** Which version a line of Pierre's view belongs to: its column in split view, its kind in unified view. */
function sideOf(line: HTMLElement): DiffSide {
  if (line.closest('[data-deletions]')) return 'LEFT';
  if (line.closest('[data-additions]')) return 'RIGHT';
  return (line.dataset.lineType ?? '').includes('deletion') ? 'LEFT' : 'RIGHT';
}

/**
 * The lines a selection in one diff covers, on one side: the new version when it takes in both (a unified diff's
 * removed and added lines). A selection ending at the very start of a line (a whole line picked) leaves that line out.
 */
export function selectedLines(range: Range, shadow: ParentNode, path: string): LineTarget | null {
  const lines = [...shadow.querySelectorAll<HTMLElement>('[data-line]')].filter((l) => range.intersectsNode(l));
  const last = lines.at(-1);
  if (lines.length > 1 && last && range.endOffset === 0 && last.contains(range.endContainer)) lines.pop();
  const right = lines.filter((l) => sideOf(l) === 'RIGHT');
  const side: DiffSide = right.length > 0 ? 'RIGHT' : 'LEFT';
  const numbers = (right.length > 0 ? right : lines).map((l) => Number(l.dataset.line)).filter((n) => Number.isInteger(n) && n > 0);
  if (numbers.length === 0) return null;
  return { path, side, startLine: Math.min(...numbers), endLine: Math.max(...numbers) };
}

/**
 * What a selection within one line says and the columns it spans (from 1), leaving out whitespace at its ends; null when
 * it spans lines, says nothing, or is most of a line anyway (longer than MAX_SELECTION).
 */
export function selectionOnLine(range: Range): TextSelection | null {
  const line = (range.startContainer instanceof Element ? range.startContainer : range.startContainer.parentElement)?.closest('[data-line]');
  if (!line || !line.contains(range.endContainer)) return null;
  const raw = range.toString();
  const text = raw.trim();
  if (!text || text.length > MAX_SELECTION) return null;
  const before = document.createRange();
  before.setStart(line, 0);
  before.setEnd(range.startContainer, range.startOffset);
  const from = before.toString().length + (raw.length - raw.trimStart().length) + 1;
  return { text, from, to: from + text.length - 1 };
}

/** The element `node` is in, seen from the page: a node in one of Pierre's shadow roots counts as being in its host. */
function lightElement(node: EventTarget | null): Element | null {
  let el: Element | null = node instanceof Element ? node : node instanceof Node ? node.parentElement : null;
  while (el) {
    const owner = el.getRootNode();
    if (!(owner instanceof ShadowRoot)) return el;
    el = owner.host;
  }
  return null;
}

type Selected = { range: Range; shadow: ShadowRoot; path: string };

/** Longer than this, a selection on one line is most of it: the line is what's asked about. */
const MAX_SELECTION = 200;

/** The text selected in one of the diffs under `root`, if any. */
function selectionIn(root: HTMLElement): Selected | null {
  for (const body of root.querySelectorAll<HTMLElement>('[data-diff-path]')) {
    const shadow = body.querySelector('diffs-container')?.shadowRoot as SelectableRoot | null | undefined;
    const selection = shadow?.getSelection?.();
    if (shadow && selection && !selection.isCollapsed && selection.rangeCount > 0) return { range: selection.getRangeAt(0), shadow, path: body.dataset.diffPath ?? '' };
  }
  return null;
}

const sameRange = (a: Range | null | undefined, b: Range | null | undefined) =>
  !!a && !!b && a.startContainer === b.startContainer && a.startOffset === b.startOffset && a.endContainer === b.endContainer && a.endOffset === b.endOffset;

/**
 * Code you select in the diffs under `root` with the mouse (an ordinary text selection, not the line numbers) is what
 * the Claude box asks about next: the lines it covers, live as you drag. A press in the Files view (outside the side
 * panel, wherever it lands: code, a blank margin) takes the last one away at once, and a selection that press makes
 * brings a new one; a click off any thread also deselects the thread you'd selected. Only what follows your mouse
 * counts: Pierre redrawing lines under a selection, or typing in the Claude box, also fire "selectionchange", and must
 * neither bring back a context you removed nor drop one you're about to ask about. Pierre draws in shadow roots, where
 * the document's selection only names the host, so each diff's root is asked for its own (Chromium's
 * `ShadowRoot.getSelection`).
 */
export function useTextSelectionContext(key: string, root: RefObject<HTMLElement | null>, active: boolean): void {
  useEffect(() => {
    if (!active) return;
    let frame = 0;
    // From a press in the Files view until the selection it makes has been read.
    let armed = false;
    let pressing = false;
    // The selection there was when the press began: still the same afterwards means the press didn't select anything.
    let before: Range | null = null;
    const read = () => {
      frame = 0;
      const el = root.current;
      if (!el || !armed) return;
      if (!pressing) armed = false;
      const now = selectionIn(el);
      if (!now || sameRange(now.range, before)) return;
      const target = selectedLines(now.range, now.shadow, now.path);
      if (!target) return;
      // Within one line, what you picked on it (a word, a name) and where; across lines, the lines say it all.
      const selection = target.startLine === target.endLine ? selectionOnLine(now.range) : null;
      setViewContext(key, { kind: 'lines', target, from: 'text', ...(selection ? { selection } : {}) });
    };
    const schedule = () => {
      if (!frame) frame = requestAnimationFrame(read);
    };
    const onDown = (e: PointerEvent) => {
      const el = root.current;
      const at = lightElement(e.composedPath()[0] ?? null);
      if (!el || !at || e.button !== 0 || !el.contains(at) || at.closest('[data-side-panel]')) return;
      armed = true;
      pressing = true;
      before = selectionIn(el)?.range.cloneRange() ?? null;
      clearTextSelection(key);
      // A click in the code off any thread deselects the thread you'd selected (the file tree selects them, so not there).
      if (!at.closest('[data-thread-card], [data-sidebar]')) clearSelectedThread(key);
    };
    const onUp = () => {
      if (!pressing) return;
      pressing = false;
      // A press that changes nothing fires no "selectionchange": look once more anyway.
      schedule();
    };
    document.addEventListener('pointerdown', onDown, true);
    document.addEventListener('pointerup', onUp, true);
    document.addEventListener('selectionchange', schedule);
    return () => {
      cancelAnimationFrame(frame);
      document.removeEventListener('pointerdown', onDown, true);
      document.removeEventListener('pointerup', onUp, true);
      document.removeEventListener('selectionchange', schedule);
    };
  }, [key, root, active]);
}
