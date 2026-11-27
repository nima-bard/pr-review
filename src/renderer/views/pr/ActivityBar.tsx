import type { ReactNode } from 'react';
import { cx } from '../../components/ui';

export interface Activity {
  id: string;
  /** What it shows, for screen readers (with its count, if any). */
  label: string;
  /** The tooltip, with its shortcut. */
  title: string;
  icon: ReactNode;
  /** Its view is the one showing in the panel. */
  active: boolean;
  /** A count or a spinner in its corner. */
  badge?: ReactNode;
  onClick(): void;
}

/**
 * A strip of icons along one edge of the Files view, like VS Code's activity bar: each shows its view in the panel on
 * that side, and the one that's showing hides the panel again. `edge` is the window edge it sits on, which gets the mark
 * beside the icon that's showing.
 */
export function ActivityBar({ label, edge, items, bottom = [] }: { label: string; edge: 'left' | 'right'; items: Activity[]; bottom?: Activity[] }) {
  const button = (a: Activity) => (
    <button
      key={a.id}
      type="button"
      aria-label={a.label}
      aria-pressed={a.active}
      title={a.title}
      onClick={a.onClick}
      className={cx('relative grid place-items-center w-11 h-11 cursor-pointer', a.active ? 'text-strong' : 'text-muted hover:text-fg')}
    >
      {a.active && <span aria-hidden="true" className={cx('absolute top-2 bottom-2 w-0.5 rounded-full bg-accent', edge === 'left' ? 'left-0' : 'right-0')} />}
      {a.icon}
      {a.badge && <span className="absolute bottom-1.5 right-1.5">{a.badge}</span>}
    </button>
  );
  return (
    <nav aria-label={label} className={cx('w-11 flex-none flex flex-col items-center py-1 bg-side border-line', edge === 'left' ? 'border-r' : 'border-l')}>
      {items.map(button)}
      {/* Pinned to the bottom, like VS Code's gear. */}
      {bottom.length > 0 && <span className="flex-1" />}
      {bottom.map(button)}
    </nav>
  );
}

/** A count (or a mark) in an activity icon's corner, like VS Code's: `bad` and `warn` for something wrong. */
export function ActivityCount({ n, tone = 'accent' }: { n: number | string; tone?: 'accent' | 'bad' | 'warn' }) {
  const colours = { accent: 'bg-accent text-ink', bad: 'bg-del text-ink', warn: 'bg-warn text-ink' }[tone];
  return <span className={cx('grid place-items-center min-w-4 h-4 px-1 rounded-full text-[10px] font-semibold leading-none', colours)}>{typeof n === 'number' && n > 99 ? '99+' : n}</span>;
}

/** A spinner in an activity icon's corner: what it shows is still loading (the pull request is being checked out). */
export function ActivityLoading() {
  return <span role="img" aria-label="Loading" className="block w-2.5 h-2.5 rounded-full border-2 border-line-2 border-t-accent animate-spin" />;
}
