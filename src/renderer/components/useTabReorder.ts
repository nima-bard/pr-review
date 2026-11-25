import { useState, type DragEvent } from 'react';

/**
 * Drag-to-reorder for a row of tabs (native drag and drop). `kind` names the row, so one row never takes another's
 * tabs. While dragging, the slot under the pointer is marked by a line on the left edge of the tab after it (or the
 * right edge of the last tab); dropping anywhere on the row moves the tab there.
 */
export function useTabReorder(kind: string, ids: readonly string[], onMove: (from: number, slot: number) => void) {
  const type = `application/x-pr-review-tab-${kind}`;
  const [drag, setDrag] = useState<{ from: number; slot: number } | null>(null);
  const ours = (e: DragEvent) => e.dataTransfer.types.includes(type);
  const drop = (e: DragEvent) => {
    if (!drag || !ours(e)) return;
    e.preventDefault();
    if (drag.slot !== drag.from && drag.slot !== drag.from + 1) onMove(drag.from, drag.slot);
    setDrag(null);
  };
  /** Shown only where the drop would change the order. */
  const marker = (index: number): 'left' | 'right' | null => {
    if (!drag || drag.slot === drag.from || drag.slot === drag.from + 1) return null;
    if (drag.slot === index) return 'left';
    if (index === ids.length - 1 && drag.slot === ids.length) return 'right';
    return null;
  };
  return {
    dragging: drag ? ids[drag.from] : undefined,
    marker,
    /** For each tab. */
    tabProps: (index: number) => ({
      draggable: true,
      onDragStart: (e: DragEvent<HTMLElement>) => {
        e.dataTransfer.setData(type, ids[index] ?? '');
        e.dataTransfer.effectAllowed = 'move';
        setDrag({ from: index, slot: index });
      },
      onDragOver: (e: DragEvent<HTMLElement>) => {
        if (!ours(e)) return;
        e.preventDefault();
        e.dataTransfer.dropEffect = 'move';
        const r = e.currentTarget.getBoundingClientRect();
        const slot = e.clientX < r.left + r.width / 2 ? index : index + 1;
        setDrag((d) => (d && d.slot !== slot ? { ...d, slot } : d));
      },
      onDragEnd: () => setDrag(null),
    }),
    /** For the row: it takes every drop (a drop on a tab bubbles up to it), also between or after the tabs. */
    rowProps: {
      onDragOver: (e: DragEvent<HTMLElement>) => {
        if (!ours(e)) return;
        e.preventDefault();
        e.dataTransfer.dropEffect = 'move';
      },
      onDrop: drop,
    },
  };
}

/** The marker line as an inset shadow, so it takes no space and leaves the tab's ::after underline alone. */
export const MARKER_CLASS = { left: 'shadow-[inset_2px_0_0_var(--c-accent)]', right: 'shadow-[inset_-2px_0_0_var(--c-accent)]' } as const;
