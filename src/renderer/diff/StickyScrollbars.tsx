import { useEffect, useRef, useState, type RefObject } from 'react';

interface Bar {
  /** Where the column starts, from the left edge of the diff body. */
  left: number;
  width: number;
  scrollWidth: number;
}

const sameBars = (a: Bar[], b: Bar[]) => a.length === b.length && a.every((x, i) => x.left === b[i]?.left && x.width === b[i]?.width && x.scrollWidth === b[i]?.scrollWidth);

/**
 * Pierre scrolls each side of a diff sideways on its own, with the scrollbar at the very bottom of the file, out of reach
 * in the middle of a long one. These stand in for those scrollbars: pinned to the bottom of the view while the file is on
 * screen (and at the end of the file once you get there), and kept in step with the code both ways. The code's own
 * scrollbars are hidden in `diffAppearanceCSS`.
 */
export function StickyScrollbars({ body }: { body: RefObject<HTMLElement | null> }) {
  const [bars, setBars] = useState<Bar[]>([]);
  const columns = useRef<HTMLElement[]>([]);
  const proxies = useRef<(HTMLDivElement | null)[]>([]);
  // Where we last moved a column or bar to ourselves. Its scroll event arrives a frame later, and by then a flick or a
  // drag has moved the other side on: copying that stale position back would undo every other frame of the movement.
  const echoes = useRef(new WeakMap<Element, number>());

  useEffect(() => {
    const root = body.current;
    if (!root) return;
    let frame = 0;
    const schedule = () => {
      if (!frame) frame = requestAnimationFrame(measure);
    };
    const resize = new ResizeObserver(schedule);
    const mutations: MutationObserver[] = [];
    const watched = new WeakSet<Node>();
    const watch = (node: Node) => {
      if (watched.has(node)) return;
      watched.add(node);
      const o = new MutationObserver(schedule);
      o.observe(node, { childList: true, subtree: true });
      mutations.push(o);
    };
    const follow = (e: Event) => {
      const column = e.currentTarget as HTMLElement;
      if (isEcho(column)) return;
      copyScroll(column, proxies.current[columns.current.indexOf(column)]);
    };
    function measure() {
      frame = 0;
      const shadow = root!.querySelector('diffs-container')?.shadowRoot;
      if (shadow) watch(shadow);
      const found = shadow ? [...shadow.querySelectorAll<HTMLElement>('[data-code]')] : [];
      if (found.length !== columns.current.length || found.some((c, i) => c !== columns.current[i])) {
        for (const c of columns.current) {
          c.removeEventListener('scroll', follow);
          resize.unobserve(c);
        }
        for (const c of found) {
          c.addEventListener('scroll', follow, { passive: true });
          resize.observe(c);
        }
        columns.current = found;
      }
      const base = root!.getBoundingClientRect().left;
      const next = found.map((c) => ({ left: Math.round(c.getBoundingClientRect().left - base), width: c.clientWidth, scrollWidth: c.scrollWidth }));
      setBars((prev) => (sameBars(prev, next) ? prev : next));
    }
    resize.observe(root);
    // Pierre draws into its shadow root after mounting, and again when the layout, wrapping or expanded lines change.
    watch(root);
    measure();
    return () => {
      cancelAnimationFrame(frame);
      resize.disconnect();
      for (const o of mutations) o.disconnect();
      for (const c of columns.current) c.removeEventListener('scroll', follow);
      columns.current = [];
    };
  }, [body]);

  /** True when this scroll event only reports a position we set ourselves. */
  const isEcho = (el: Element) => {
    const echo = echoes.current.get(el);
    echoes.current.delete(el);
    return echo === el.scrollLeft;
  };
  const copyScroll = (from: Element, to: Element | null | undefined) => {
    if (!to || to.scrollLeft === from.scrollLeft) return;
    to.scrollLeft = from.scrollLeft;
    echoes.current.set(to, to.scrollLeft);
  };

  // A bar that's just appeared starts where its code is already scrolled to.
  useEffect(() => {
    bars.forEach((_, i) => {
      const column = columns.current[i];
      if (column) copyScroll(column, proxies.current[i]);
    });
  }, [bars]);

  if (!bars.some((b) => b.scrollWidth > b.width + 1)) return null;
  return (
    <div className="sticky bottom-0 z-[5] h-2.5">
      {bars.map(
        (b, i) =>
          b.scrollWidth > b.width + 1 && (
            <div
              key={i}
              ref={(el) => {
                proxies.current[i] = el;
              }}
              // A second handle on the code's own scrolling, so it stays out of the tab order and the accessibility tree.
              aria-hidden="true"
              tabIndex={-1}
              onScroll={(e) => {
                if (!isEcho(e.currentTarget)) copyScroll(e.currentTarget, columns.current[i]);
              }}
              className="absolute top-0 h-2.5 overflow-x-auto overflow-y-hidden"
              style={{ left: b.left, width: b.width }}
            >
              <div className="h-px" style={{ width: b.scrollWidth }} />
            </div>
          ),
      )}
    </div>
  );
}
