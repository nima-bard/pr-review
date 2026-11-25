import { useEffect, useRef, type KeyboardEvent } from 'react';
import type { PrSnapshot } from '../../../shared/model';
import { cx, Icon, Segmented } from '../../components/ui';
import { closeFind, showSearch, stepFind, updateUi, usePrUi, type FindSide } from '../../state/ui';
import { Toggle } from './SearchPanel';

/**
 * ⌘F's find bar over the code, like VS Code's: the query with match case / whole word / regex, which version of the
 * diff to search, "3 of 12", previous and next (⇧⏎ / ⏎, ⇧⌘G / ⌘G), Esc to close. In All changes it only sees the files on the page, so it offers the
 * same search over all changed files (⇧⌘F).
 */
export function FindBar({ snapshot, count, current, allChanges }: { snapshot: PrSnapshot; count: number; current: number; allChanges: boolean }) {
  const key = snapshot.key;
  const ui = usePrUi(key);
  const f = ui.find;
  const input = useRef<HTMLInputElement>(null);
  const set = (patch: Partial<typeof f>) => updateUi(key, (u) => ({ find: { ...u.find, ...patch } }));

  useEffect(() => {
    if (!f.open) return;
    input.current?.focus();
    input.current?.select();
  }, [ui.findFocusSeq, f.open]);

  if (!f.open) return null;

  const onKey = (e: KeyboardEvent<HTMLInputElement>) => {
    if (e.key === 'Enter') {
      e.preventDefault();
      stepFind(key, e.shiftKey ? -1 : 1);
    } else if (e.key === 'Escape') {
      e.stopPropagation();
      closeFind(key);
    } else if (e.altKey && !e.metaKey && !e.ctrlKey) {
      const toggle = { KeyC: 'matchCase', KeyW: 'wholeWord', KeyR: 'regex' } as const;
      const flag = toggle[e.code as keyof typeof toggle];
      if (flag) {
        e.preventDefault();
        set({ [flag]: !f[flag] });
      }
    }
  };
  const button = 'grid place-items-center w-6 h-6 rounded text-muted hover:text-fg hover:bg-raised-2 cursor-pointer disabled:opacity-40 disabled:cursor-default';

  return (
    <div role="search" aria-label="Find in this view" className="absolute top-2 right-5 z-30 flex flex-col gap-1 p-1.5 rounded-lg bg-raised border border-line-2 shadow-xl shadow-black/30">
      <div className="flex items-center gap-1">
        <span className="relative">
          <input
            ref={input}
            value={f.pattern}
            onChange={(e) => set({ pattern: e.target.value })}
            onKeyDown={onKey}
            placeholder="Find"
            aria-label="Find"
            spellCheck={false}
            className="w-[240px] h-[26px] pl-2 pr-[78px] rounded-[5px] bg-card border border-line-2 focus:border-accent outline-none font-mono text-[12.5px]"
          />
          <span className="absolute right-1 top-1/2 -translate-y-1/2 flex gap-0.5">
            <Toggle on={f.matchCase} label="Match case" title="Match case (⌥C)" onChange={(v) => set({ matchCase: v })}>
              Aa
            </Toggle>
            <Toggle on={f.wholeWord} label="Match whole word" title="Match whole word (⌥W)" onChange={(v) => set({ wholeWord: v })}>
              <span className="underline underline-offset-2">ab</span>
            </Toggle>
            <Toggle on={f.regex} label="Use regular expression" title="Use regular expression (⌥R)" onChange={(v) => set({ regex: v })}>
              .*
            </Toggle>
          </span>
        </span>
        <Segmented<FindSide>
          label="Search the version"
          size="sm"
          value={f.side}
          onChange={(side) => set({ side })}
          options={[
            { value: 'both', label: <span title="Both versions: an unchanged line counts once">Both</span> },
            { value: 'old', label: <span title="The old version: deleted and unchanged lines (the left side of a split diff)">Old</span> },
            { value: 'new', label: <span title="The new version: added and unchanged lines (the right side of a split diff)">New</span> },
          ]}
        />
        <span aria-live="polite" className={cx('min-w-[72px] px-1 text-[12px] whitespace-nowrap', f.pattern && count === 0 ? 'text-del' : 'text-muted')}>
          {count === 0 ? 'No results' : `${current + 1} of ${count}`}
        </span>
        <button type="button" aria-label="Previous match" title="Previous match (⇧⏎, ⇧⌘G)" disabled={count === 0} onClick={() => stepFind(key, -1)} className={button}>
          <Icon name="chevron" size={12} rotate={180} />
        </button>
        <button type="button" aria-label="Next match" title="Next match (⏎, ⌘G)" disabled={count === 0} onClick={() => stepFind(key, 1)} className={button}>
          <Icon name="chevron" size={12} />
        </button>
        <button type="button" aria-label="Close find" title="Close (Esc)" onClick={() => closeFind(key)} className={button}>
          <Icon name="close" size={11} />
        </button>
      </div>
      {allChanges && f.pattern && (
        <button
          type="button"
          onClick={() => {
            updateUi(key, (u) => ({ search: { ...u.search, pattern: f.pattern, matchCase: f.matchCase, wholeWord: f.wholeWord, regex: f.regex, scope: 'changed' } }));
            showSearch(key);
          }}
          className="self-start px-1 text-[11.5px] text-link hover:underline cursor-pointer"
        >
          Only files loaded on this page · search all changed files (⇧⌘F)
        </button>
      )}
    </div>
  );
}
