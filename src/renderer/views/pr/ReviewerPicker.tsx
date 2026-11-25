import { useEffect, useLayoutEffect, useRef, useState, type RefObject } from 'react';
import { createPortal } from 'react-dom';
import type { ReviewerCandidate, ReviewerOptions } from '../../../shared/model';
import { api, errorText } from '../../api';
import { Avatar, Button, cx, Spinner } from '../../components/ui';

const matches = (c: ReviewerCandidate, q: string) => !q || c.id.toLowerCase().includes(q) || (c.name ?? '').toLowerCase().includes(q);

/**
 * Requesting reviews, like github.com's reviewer picker: GitHub's suggestions, everyone else with access (searched on
 * GitHub as you type) and the organization's teams, with the current requests ticked. The changes go to GitHub when
 * it closes (Done, Esc or a click outside); unticking someone withdraws their request.
 */
export function ReviewerPicker({ prKey, anchor, onClose }: { prKey: string; anchor: RefObject<HTMLElement | null>; onClose(): void }) {
  const [query, setQuery] = useState('');
  const [options, setOptions] = useState<ReviewerOptions | null>(null);
  const [loading, setLoading] = useState(true);
  const [initial, setInitial] = useState<Set<string> | null>(null);
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [pos, setPos] = useState<{ top: number; left: number } | null>(null);
  const box = useRef<HTMLDivElement>(null);
  const input = useRef<HTMLInputElement>(null);

  // Everyone matching the query, asked of GitHub a moment after typing stops.
  useEffect(() => {
    let stale = false;
    setLoading(true);
    const timer = setTimeout(
      () => {
        api.reviewerOptions(prKey, query).then(
          (o) => {
            if (stale) return;
            setOptions(o);
            setLoading(false);
            setInitial((cur) => {
              if (cur) return cur;
              setSelected(new Set(o.requested));
              return new Set(o.requested);
            });
          },
          (err: unknown) => {
            if (stale) return;
            setError(errorText(err));
            setLoading(false);
          },
        );
      },
      query ? 250 : 0,
    );
    return () => {
      stale = true;
      clearTimeout(timer);
    };
  }, [prKey, query]);

  useLayoutEffect(() => {
    const a = anchor.current?.getBoundingClientRect();
    if (!a) return;
    const width = 340;
    setPos({ top: Math.min(a.bottom + 6, window.innerHeight - 200), left: Math.max(8, Math.min(a.right - width, window.innerWidth - width - 8)) });
    input.current?.focus();
  }, [anchor]);

  const apply = async () => {
    if (saving) return;
    const before = initial ?? new Set<string>();
    const add = [...selected].filter((id) => !before.has(id));
    const remove = [...before].filter((id) => !selected.has(id));
    if (add.length === 0 && remove.length === 0) {
      onClose();
      return;
    }
    setSaving(true);
    setError(null);
    try {
      await api.changeReviewRequests(prKey, add, remove);
      onClose();
    } catch (err) {
      setError(errorText(err));
      setSaving(false);
    }
  };

  // Esc and clicks outside close it, applying the changes like Done.
  const applyRef = useRef(apply);
  applyRef.current = apply;
  useEffect(() => {
    const outside = (e: MouseEvent) => {
      const t = e.target as Node;
      if (!box.current?.contains(t) && !anchor.current?.contains(t)) void applyRef.current();
    };
    const key = (e: KeyboardEvent) => {
      if (e.key !== 'Escape') return;
      e.stopPropagation();
      void applyRef.current();
    };
    document.addEventListener('mousedown', outside);
    window.addEventListener('keydown', key, true);
    return () => {
      document.removeEventListener('mousedown', outside);
      window.removeEventListener('keydown', key, true);
    };
  }, [anchor]);

  const toggle = (id: string) =>
    setSelected((s) => {
      const next = new Set(s);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });

  const q = query.trim().toLowerCase();
  const groups: [string, ReviewerCandidate[]][] = options
    ? [
        ['Suggestions', options.suggestions.filter((c) => matches(c, q))],
        ['Everyone else', options.users.filter((c) => matches(c, q))],
        ['Teams', options.teams.filter((c) => matches(c, q))],
      ]
    : [];
  const shown = groups.filter(([, list]) => list.length > 0);
  const before = initial ?? new Set<string>();
  const changes = [...selected].filter((id) => !before.has(id)).length + [...before].filter((id) => !selected.has(id)).length;

  if (!pos) return null;
  return createPortal(
    <div
      ref={box}
      role="dialog"
      aria-label="Request reviews"
      className="fixed z-50 w-[340px] max-h-[min(480px,calc(100vh-80px))] flex flex-col rounded-xl bg-raised border border-line-2 shadow-2xl shadow-black/40 overflow-hidden"
      style={{ top: pos.top, left: pos.left }}
    >
      <div className="flex flex-col gap-2 p-3 border-b border-line">
        <h3 className="text-[13px] font-semibold text-strong">Request reviews</h3>
        <input
          ref={input}
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          placeholder="Type or choose a user or team"
          aria-label="Find a reviewer"
          spellCheck={false}
          className="h-8 px-2.5 rounded-[7px] bg-card border border-line-2 focus:border-accent outline-none"
        />
      </div>
      <div className="flex-1 min-h-0 overflow-y-auto" aria-busy={loading}>
        {!options && loading && (
          <div className="p-3">
            <Spinner label="Loading…" />
          </div>
        )}
        {options && shown.length === 0 && !loading && <div className="p-3 text-muted text-[12.5px]">{q ? `No one matching “${query.trim()}” has access.` : 'No one else has access to this repository.'}</div>}
        {shown.map(([title, list]) => (
          <section key={title} aria-label={title}>
            <h4 className="sticky top-0 px-3 py-1.5 bg-panel border-y border-line text-[11.5px] font-semibold text-muted">{title}</h4>
            {list.map((c) => (
              <label key={c.id} className={cx('flex items-start gap-2.5 px-3 py-2 cursor-pointer hover:bg-hover', selected.has(c.id) && 'bg-active')}>
                <input type="checkbox" checked={selected.has(c.id)} onChange={() => toggle(c.id)} className="mt-1" style={{ accentColor: 'var(--c-accent)' }} />
                <Avatar login={c.id} url={c.avatarUrl} size={20} />
                <span className="flex-1 min-w-0 flex flex-col">
                  <span className="truncate">
                    <span className="font-semibold text-strong">{c.kind === 'team' ? `@${c.id}` : c.id}</span>
                    {c.name && c.name !== c.id && <span className="ml-1.5 text-muted">{c.name}</span>}
                  </span>
                  {c.reason && <span className="text-[11.5px] text-muted">{c.reason}</span>}
                </span>
              </label>
            ))}
          </section>
        ))}
      </div>
      <div className="flex items-center gap-2 px-3 py-2 bg-panel border-t border-line">
        <span className={cx('flex-1 text-[11.5px]', error ? 'text-del' : 'text-muted')}>{error ?? (saving ? 'Saving…' : changes > 0 ? `${changes} change${changes === 1 ? '' : 's'}, sent when you close this` : 'Untick someone to withdraw their request')}</span>
        <Button size="sm" variant="primary" disabled={saving} onClick={() => void apply()}>
          Done
        </Button>
      </div>
    </div>,
    document.body,
  );
}
