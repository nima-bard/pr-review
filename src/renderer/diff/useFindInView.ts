import { useEffect, useRef, useState, type RefObject } from 'react';
import { matcher } from '../../shared/searchMatch';
import { usePrUi } from '../state/ui';
import { lineRanges, lineRole } from './useSearchHighlights';

/** The highlight names; their styles are in the code views' own CSS (settings.ts). */
const ALL = 'pr-find';
const CURRENT = 'pr-find-current';

/** Brings a match into view: to the middle of `scroller` if it's out of view, and sideways within its code column. */
function reveal(range: Range, scroller: HTMLElement): void {
  const box = scroller.getBoundingClientRect();
  const r = range.getBoundingClientRect();
  if (r.top < box.top + 40 || r.bottom > box.bottom - 40) scroller.scrollTop += r.top - box.top - box.height / 2;
  const column = range.startContainer.parentElement?.closest<HTMLElement>('[data-code]');
  if (!column) return;
  const c = column.getBoundingClientRect();
  const m = range.getBoundingClientRect();
  if (m.left < c.left || m.right > c.right) column.scrollLeft += m.left - c.left - c.width / 2 + m.width / 2;
}

/** `twins`: matches in the left copy of a split diff's unchanged lines, marked but not counted (see `lineRole`). */
function paint(ranges: Range[], twins: Range[], current: number): void {
  CSS.highlights.set(ALL, new Highlight(...ranges.filter((_, i) => i !== current), ...twins));
  CSS.highlights.set(CURRENT, new Highlight(...(ranges[current] ? [ranges[current]] : [])));
}

/**
 * ⌘F: the matches of the find bar's query in the code lines on screen under `root` (Pierre draws code in shadow roots),
 * in the version of the diff the bar picks, in reading order (so a split diff's two columns don't interleave), marked with the CSS Custom Highlight API. Steps
 * move the current match and bring it into view. Collapsed files and ones not loaded yet don't count. Keeps up as
 * Pierre redraws.
 */
export function useFindInView(root: RefObject<HTMLElement | null>, key: string, onScreen: boolean): { count: number; current: number } {
  const ui = usePrUi(key);
  const { open, pattern, regex, wholeWord, matchCase, side } = ui.find;
  const enabled = onScreen && open && pattern !== '' && ui.view === 'files';
  const [state, setState] = useState({ count: 0, current: -1 });
  const ranges = useRef<Range[]>([]);
  const twins = useRef<Range[]>([]);
  const current = useRef(-1);

  useEffect(() => {
    const re = enabled ? matcher({ pattern, regex, wholeWord, matchCase }) : null;
    const scroller = root.current;
    if (!re || !scroller || !CSS.highlights) {
      ranges.current = [];
      twins.current = [];
      current.current = -1;
      setState({ count: 0, current: -1 });
      return;
    }
    const observers: MutationObserver[] = [];
    const watched = new WeakSet<Node>();
    let frame = 0;
    const watch = (node: Node) => {
      if (watched.has(node)) return;
      watched.add(node);
      const o = new MutationObserver(() => {
        if (!frame) frame = requestAnimationFrame(() => collect(false));
      });
      o.observe(node, { childList: true, subtree: true, characterData: true });
      observers.push(o);
    };
    /** Finds the matches; on a new query, starts from the first one at or below the top of the view and shows it. */
    function collect(fresh: boolean) {
      frame = 0;
      const found: { range: Range; top: number; left: number }[] = [];
      const shown = (range: Range) => {
        const r = range.getBoundingClientRect();
        // Nothing drawn: a collapsed file, or one not loaded yet.
        return r.width > 0 || r.height > 0 ? r : null;
      };
      twins.current = [];
      for (const host of scroller!.querySelectorAll('diffs-container')) {
        if (!host.shadowRoot) continue;
        watch(host.shadowRoot);
        for (const line of host.shadowRoot.querySelectorAll<HTMLElement>('[data-line]')) {
          const role = lineRole(line, side);
          if (role === 'skip') continue;
          for (const range of lineRanges(line, re!)) {
            const r = shown(range);
            if (!r) continue;
            if (role === 'twin') twins.current.push(range);
            else found.push({ range, top: Math.round(r.top), left: r.left });
          }
        }
      }
      found.sort((a, b) => a.top - b.top || a.left - b.left);
      ranges.current = found.map((f) => f.range);
      if (fresh || current.current >= ranges.current.length) {
        const top = scroller!.getBoundingClientRect().top;
        const first = found.findIndex((f) => f.top >= top);
        current.current = found.length === 0 ? -1 : first === -1 ? 0 : first;
        if (fresh && ranges.current[current.current]) reveal(ranges.current[current.current]!, scroller!);
      }
      paint(ranges.current, twins.current, current.current);
      setState({ count: ranges.current.length, current: current.current });
    }
    watch(scroller);
    collect(true);
    return () => {
      cancelAnimationFrame(frame);
      for (const o of observers) o.disconnect();
      CSS.highlights.delete(ALL);
      CSS.highlights.delete(CURRENT);
    };
  }, [enabled, pattern, regex, wholeWord, matchCase, side, root]);

  // A step: the next or previous match, round the end.
  useEffect(() => {
    const n = ranges.current.length;
    if (!enabled || n === 0 || ui.findStep.seq === 0 || !root.current) return;
    current.current = (current.current + ui.findStep.dir + n) % n;
    paint(ranges.current, twins.current, current.current);
    reveal(ranges.current[current.current]!, root.current);
    setState({ count: n, current: current.current });
    // Only a new step moves; the rest is read from refs.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [ui.findStep.seq]);

  return state;
}
