import { useEffect, type RefObject } from 'react';
import { matcher, matchRanges } from '../../shared/searchMatch';
import { usePrUi } from '../state/ui';

/** The highlight's name; its style is in the code views' own CSS (settings.ts), since Pierre draws code in shadow roots. */
export const SEARCH_HIGHLIGHT = 'pr-search';

/** Ranges for the matches of `re` in one code line, mapped onto its text nodes (the syntax colouring splits a line into spans). */
export function lineRanges(line: HTMLElement, re: RegExp): Range[] {
  const text = line.textContent ?? '';
  const matches = text ? matchRanges(text, re) : [];
  if (matches.length === 0) return [];
  const nodes: { node: Text; start: number }[] = [];
  const walker = document.createTreeWalker(line, NodeFilter.SHOW_TEXT);
  for (let offset = 0, n = walker.nextNode(); n; n = walker.nextNode()) {
    nodes.push({ node: n as Text, start: offset });
    offset += (n as Text).length;
  }
  const at = (pos: number, end: boolean) => {
    // The text node holding `pos`; an end at a node boundary stays in the earlier node.
    const i = nodes.findLastIndex((x) => (end ? x.start < pos : x.start <= pos));
    const hit = nodes[Math.max(0, i)]!;
    return { node: hit.node, offset: Math.min(pos - hit.start, hit.node.length) };
  };
  return matches.map(([a, b]) => {
    const range = new Range();
    const start = at(a, false);
    const end = at(b, true);
    range.setStart(start.node, start.offset);
    range.setEnd(end.node, end.offset);
    return range;
  });
}

/**
 * Marks the search text in the code under `root`, like VS Code marks search matches in open editors, while the PR's
 * search sidebar has a query and this view is on screen. It uses the CSS Custom Highlight API, so neither React's
 * nor Pierre's DOM is touched, and repaints when Pierre redraws lines (loading, highlighting, expanding).
 */
export function useSearchHighlights(root: RefObject<HTMLElement | null>, key: string, onScreen: boolean): void {
  const ui = usePrUi(key);
  const { pattern, regex, wholeWord, matchCase } = ui.search;
  const enabled = onScreen && ui.view === 'files' && ui.showTree && ui.sidebar === 'search' && pattern !== '';
  useEffect(() => {
    const registry = CSS.highlights;
    const re = enabled ? matcher({ pattern, regex, wholeWord, matchCase }) : null;
    if (!registry || !re || !root.current) return;
    const observers: MutationObserver[] = [];
    const watched = new WeakSet<Node>();
    let frame = 0;
    const schedule = () => {
      if (!frame) frame = requestAnimationFrame(paint);
    };
    const watch = (node: Node) => {
      if (watched.has(node)) return;
      watched.add(node);
      const observer = new MutationObserver(schedule);
      observer.observe(node, { childList: true, subtree: true, characterData: true });
      observers.push(observer);
    };
    function paint() {
      frame = 0;
      const ranges: Range[] = [];
      for (const host of root.current?.querySelectorAll('diffs-container') ?? []) {
        if (!host.shadowRoot) continue;
        watch(host.shadowRoot);
        for (const line of host.shadowRoot.querySelectorAll<HTMLElement>('[data-line]')) ranges.push(...lineRanges(line, re!));
      }
      registry.set(SEARCH_HIGHLIGHT, new Highlight(...ranges));
    }
    watch(root.current);
    paint();
    return () => {
      cancelAnimationFrame(frame);
      for (const o of observers) o.disconnect();
      registry.delete(SEARCH_HIGHLIGHT);
    };
  }, [enabled, pattern, regex, wholeWord, matchCase, root]);
}
