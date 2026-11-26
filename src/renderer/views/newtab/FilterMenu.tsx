import { useEffect, useRef, useState } from 'react';
import type { FilterSuggestion, SuggestionKind } from '../../../shared/model';
import { getQualifier, setQualifier } from '../../../shared/query';
import { api } from '../../api';
import { Avatar, Button, cx, Icon } from '../../components/ui';

export interface Filter {
  key: string;
  label: string;
  placeholder: string;
  /** Text filters: where the suggestions come from. */
  suggest?: SuggestionKind;
  /** Choice filters: the values ('' for none) and what they're called. */
  options?: { value: string; label: string }[];
}

export const FILTERS: Filter[] = [
  { key: 'author', label: 'Author', placeholder: 'Filter people', suggest: 'author' },
  { key: 'label', label: 'Label', placeholder: 'Filter labels', suggest: 'label' },
  { key: 'review-requested', label: 'Reviewers', placeholder: 'Filter people', suggest: 'reviewer' },
  { key: 'assignee', label: 'Assignee', placeholder: 'Filter people', suggest: 'assignee' },
  {
    key: 'review',
    label: 'Review',
    placeholder: '',
    options: [
      { value: '', label: 'Any' },
      { value: 'none', label: 'No reviews' },
      { value: 'required', label: 'Review required' },
      { value: 'approved', label: 'Approved' },
      { value: 'changes_requested', label: 'Changes requested' },
    ],
  },
  {
    key: 'sort',
    label: 'Sort',
    placeholder: '',
    options: [
      { value: 'updated-desc', label: 'Recently updated' },
      { value: 'created-desc', label: 'Newest' },
      { value: 'created-asc', label: 'Oldest' },
      { value: 'comments-desc', label: 'Most commented' },
      { value: 'reactions-desc', label: 'Most reactions' },
    ],
  },
];

const ME: FilterSuggestion = { value: '@me', label: '@me', detail: 'You', avatarUrl: null, color: null };

/** The menu's list for what's typed: suggestions from the repository (after a short pause), with @me for people. */
function useSuggestions(filter: Filter, repo: string, typed: string): { items: FilterSuggestion[]; loading: boolean } {
  const [items, setItems] = useState<FilterSuggestion[]>([]);
  const [loading, setLoading] = useState(false);
  useEffect(() => {
    const kind = filter.suggest;
    if (!kind || !repo) {
      setItems([]);
      return;
    }
    let current = true;
    setLoading(true);
    const timer = setTimeout(() => {
      void api
        .filterSuggestions(repo, kind, typed.replace(/^@/, ''))
        .then((list) => current && setItems(list), () => current && setItems([]))
        .finally(() => current && setLoading(false));
    }, 200);
    return () => {
      current = false;
      clearTimeout(timer);
    };
  }, [filter.suggest, repo, typed]);
  const t = typed.trim().toLowerCase();
  const me = filter.suggest !== 'label' && (t === '' || '@me'.startsWith(t) || 'me'.startsWith(t)) ? [ME] : [];
  return { items: [...me, ...items], loading };
}

/**
 * A github.com-style filter button for the search query: its menu lists suggestions (or the choices) to pick from,
 * and typing narrows them. Only one is open at a time; a click elsewhere or Escape closes it.
 */
export function FilterButton({ filter, query, repo, setQuery, open, onToggle, onClose }: {
  filter: Filter;
  query: string;
  repo: string;
  setQuery(q: string): void;
  open: boolean;
  onToggle(): void;
  onClose(): void;
}) {
  const current = getQualifier(query, filter.key);
  const [typed, setTyped] = useState('');
  const [highlight, setHighlight] = useState(-1);
  const wrapper = useRef<HTMLDivElement>(null);
  const { items, loading } = useSuggestions(filter, open ? repo : '', typed);
  const choices: FilterSuggestion[] = filter.options
    ? filter.options.map((o) => ({ value: o.value, label: o.label, detail: null, avatarUrl: null, color: null }))
    : items;

  useEffect(() => {
    if (!open) return;
    setTyped('');
    setHighlight(-1);
    const onDown = (e: MouseEvent) => {
      if (!wrapper.current?.contains(e.target as Node)) onClose();
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== 'Escape') return;
      e.stopPropagation();
      onClose();
    };
    document.addEventListener('mousedown', onDown);
    window.addEventListener('keydown', onKey, true);
    return () => {
      document.removeEventListener('mousedown', onDown);
      window.removeEventListener('keydown', onKey, true);
    };
  }, [open]);

  const apply = (value: string) => {
    setQuery(setQualifier(query, filter.key, value.trim()));
    onClose();
  };
  const shown = filter.options ? (filter.options.find((o) => o.value === current)?.label ?? current) : current;

  return (
    <div ref={wrapper} className="relative">
      <button
        type="button"
        aria-expanded={open}
        aria-haspopup="dialog"
        onClick={onToggle}
        className={cx(
          'flex items-center gap-1.5 h-[30px] px-2.5 rounded-[7px] border text-[12.5px] cursor-pointer',
          current ? 'bg-info-bg border-info-line text-strong' : 'bg-raised border-line-2 text-fg',
        )}
      >
        {filter.label}
        {current && <span className={cx('text-[11.5px] text-info', !filter.options && 'font-mono')}>{shown}</span>}
        <Icon name="chevron" size={11} />
      </button>
      {open && (
        <div role="dialog" aria-label={`Filter by ${filter.label}`} className="absolute top-9 left-0 z-30 w-[300px] rounded-[10px] bg-raised border border-line-2 shadow-xl flex flex-col overflow-hidden">
          <div className="px-3 pt-2.5 pb-2 font-semibold text-strong">{filter.key === 'sort' ? 'Sort by' : `Filter by ${filter.label.toLowerCase()}`}</div>
          {!filter.options && (
            <div className="px-3 pb-2">
              <input
                autoFocus
                value={typed}
                onChange={(e) => {
                  setTyped(e.target.value);
                  setHighlight(-1);
                }}
                onKeyDown={(e) => {
                  if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
                    e.preventDefault();
                    const n = choices.length;
                    if (n > 0) setHighlight((h) => (e.key === 'ArrowDown' ? (h + 1) % n : (h - 1 + n) % n));
                  }
                  if (e.key === 'Enter') {
                    const picked = choices[highlight];
                    if (picked) apply(picked.value);
                    else if (typed.trim()) apply(typed);
                  }
                }}
                placeholder={filter.placeholder}
                aria-label={filter.label}
                role="combobox"
                aria-expanded="true"
                aria-autocomplete="list"
                className="w-full h-[30px] px-2.5 rounded-[7px] bg-side border border-line-2 text-[12.5px] outline-none focus:border-accent"
              />
            </div>
          )}
          <ul role="listbox" aria-label={filter.label} className="max-h-[280px] overflow-y-auto border-t border-line">
            {choices.map((c, i) => (
              <li key={c.value || '(any)'} role="option" aria-selected={c.value === current}>
                <button
                  type="button"
                  onMouseEnter={() => setHighlight(i)}
                  onClick={() => apply(c.value)}
                  className={cx('w-full flex items-center gap-2 px-3 py-1.5 text-left text-[12.5px] cursor-pointer', i === highlight ? 'bg-hover' : '')}
                >
                  <span className="w-3.5 flex-none text-accent">{c.value === current && <Icon name="check" size={12} />}</span>
                  {c.avatarUrl && <Avatar login={c.value} url={c.avatarUrl} size={18} />}
                  {c.color && <span aria-hidden="true" className="w-3 h-3 rounded-full flex-none border border-black/20" style={{ background: c.color }} />}
                  <span className="font-semibold text-strong whitespace-nowrap">{c.label}</span>
                  {c.detail && <span className="text-muted truncate min-w-0">{c.detail}</span>}
                </button>
              </li>
            ))}
            {!filter.options && choices.length === 0 && (
              <li className="px-3 py-2 text-[12px] text-muted">
                {!repo ? 'Pick a repository to see suggestions. Or type a name and press Enter.' : loading ? 'Looking…' : typed.trim() ? 'No matches. Press Enter to filter by what you typed.' : 'Nothing to suggest.'}
              </li>
            )}
          </ul>
          {!filter.options && (current || typed.trim()) && (
            <div className="flex items-center justify-end gap-2 px-3 py-2 border-t border-line">
              {current && (
                <Button size="sm" variant="ghost" onClick={() => apply('')}>
                  Clear
                </Button>
              )}
              {typed.trim() && (
                <Button size="sm" variant="primary" onClick={() => apply(typed)}>
                  Filter by “{typed.trim()}”
                </Button>
              )}
            </div>
          )}
        </div>
      )}
    </div>
  );
}
