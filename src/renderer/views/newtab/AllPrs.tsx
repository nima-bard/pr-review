import { useEffect, useMemo, useState } from 'react';
import type { RepoMapping, SearchPage } from '../../../shared/model';
import { api, errorText } from '../../api';
import { Button, cx, ErrorBox, Icon, Select, Spinner } from '../../components/ui';
import { openPr } from '../../state/tabs';
import { getQualifier, setQualifier, setState } from '../../../shared/query';
import { PrRow, useOpenKeys } from './NewTab';

interface Saved {
  name: string;
  query: string;
}

const SAVED_KEY = 'saved-searches';
const REPO_KEY = 'all-prs-repo';
const DEFAULT_QUERY = 'is:pr is:open sort:updated-desc';

/** The repo picked last time; '' means "All repositories", null means nothing remembered yet. */
function loadLastRepo(): string | null {
  try {
    return localStorage.getItem(REPO_KEY);
  } catch {
    return null;
  }
}

function saveLastRepo(repo: string): void {
  try {
    localStorage.setItem(REPO_KEY, repo);
  } catch {
    // Not remembering the repo is harmless.
  }
}

function loadSaved(): Saved[] {
  try {
    return JSON.parse(localStorage.getItem(SAVED_KEY) ?? '[]') as Saved[];
  } catch {
    return [];
  }
}

const DEFAULT_SAVED: Saved[] = [
  { name: 'Needs my review', query: 'is:pr is:open review-requested:@me' },
  { name: 'Mine', query: 'is:pr is:open author:@me' },
  { name: 'Involves me', query: 'is:pr is:open involves:@me' },
];

const FILTERS: { key: string; label: string; placeholder: string; options?: string[] }[] = [
  { key: 'author', label: 'Author', placeholder: 'login or @me' },
  { key: 'label', label: 'Label', placeholder: 'label name' },
  { key: 'review-requested', label: 'Reviewers', placeholder: 'login or @me' },
  { key: 'assignee', label: 'Assignee', placeholder: 'login or @me' },
  { key: 'review', label: 'Review', placeholder: '', options: ['none', 'required', 'approved', 'changes_requested'] },
  { key: 'sort', label: 'Sort', placeholder: '', options: ['updated-desc', 'created-desc', 'comments-desc', 'reactions-desc'] },
];

function FilterButton({ filter, query, setQuery }: { filter: (typeof FILTERS)[number]; query: string; setQuery(q: string): void }) {
  const current = getQualifier(query, filter.key);
  const [open, setOpen] = useState(false);
  const [draft, setDraft] = useState(current);
  return (
    <div className="relative">
      <button
        type="button"
        aria-expanded={open}
        onClick={() => {
          setDraft(current);
          setOpen(!open);
        }}
        className={cx(
          'flex items-center gap-1.5 h-[30px] px-2.5 rounded-[7px] border text-[12.5px] cursor-pointer',
          current ? 'bg-info-bg border-info-line text-strong' : 'bg-raised border-line-2 text-fg',
        )}
      >
        {filter.label}
        {current && <span className="font-mono text-[11.5px] text-info">{current}</span>}
        <Icon name="chevron" size={11} />
      </button>
      {open && (
        <div role="dialog" aria-label={`Filter by ${filter.label}`} className="absolute top-9 left-0 z-20 w-[260px] rounded-[10px] bg-raised border border-line-2 p-3 flex flex-col gap-2 shadow-xl">
          <div className="font-semibold text-strong">Filter by {filter.label.toLowerCase()}</div>
          {filter.options ? (
            <div className="flex flex-col">
              {['', ...filter.options].map((o) => (
                <label key={o} className="flex items-center gap-2 py-1 cursor-pointer">
                  <input type="radio" name={filter.key} checked={draft === o} onChange={() => setDraft(o)} style={{ accentColor: 'var(--c-accent)' }} />
                  <span>{o || 'Any'}</span>
                </label>
              ))}
            </div>
          ) : (
            <input
              autoFocus
              value={draft}
              onChange={(e) => setDraft(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === 'Enter') {
                  setQuery(setQualifier(query, filter.key, draft.trim()));
                  setOpen(false);
                }
              }}
              placeholder={filter.placeholder}
              aria-label={filter.label}
              className="h-[30px] px-2.5 rounded-[7px] bg-side border border-line-2 text-[12.5px] outline-none focus:border-accent"
            />
          )}
          <div className="flex justify-end gap-2">
            <Button size="sm" variant="ghost" onClick={() => setOpen(false)}>
              Cancel
            </Button>
            <Button
              size="sm"
              variant="primary"
              onClick={() => {
                setQuery(setQualifier(query, filter.key, draft.trim()));
                setOpen(false);
              }}
            >
              Apply
            </Button>
          </div>
        </div>
      )}
    </div>
  );
}

export function AllPrs({ tabId }: { tabId: string }) {
  const [repos, setRepos] = useState<RepoMapping[]>([]);
  const [lastRepo] = useState(loadLastRepo);
  const [query, setQuery] = useState(() => (lastRepo ? setQualifier(DEFAULT_QUERY, 'repo', lastRepo) : DEFAULT_QUERY));
  const [text, setText] = useState(query);
  const [page, setPage] = useState<SearchPage | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [saved, setSaved] = useState<Saved[]>(() => {
    const s = loadSaved();
    return s.length > 0 ? s : DEFAULT_SAVED;
  });
  const [naming, setNaming] = useState<string | null>(null);
  const openKeys = useOpenKeys();

  useEffect(() => {
    void api.listRepos().then((r) => {
      setRepos(r);
      if (lastRepo === null && r[0] && !/\brepo:/.test(query)) {
        const q = setQualifier(query, 'repo', r[0].slug);
        setQuery(q);
        setText(q);
      }
    });
  }, []);

  useEffect(() => {
    setText(query);
    saveLastRepo(getQualifier(query, 'repo'));
    let cancelled = false;
    setLoading(true);
    setError(null);
    api
      .search(query)
      .then((p) => !cancelled && setPage(p))
      .catch((err: unknown) => !cancelled && setError(errorText(err)))
      .finally(() => !cancelled && setLoading(false));
    return () => {
      cancelled = true;
    };
  }, [query]);

  const state = useMemo(() => (/\bis:closed\b/.test(query) ? 'closed' : 'open'), [query]);
  const repo = getQualifier(query, 'repo');

  const loadMore = async () => {
    if (!page?.endCursor) return;
    setLoading(true);
    try {
      const next = await api.search(query, page.endCursor);
      setPage({ ...next, items: [...page.items, ...next.items] });
    } catch (err) {
      setError(errorText(err));
    } finally {
      setLoading(false);
    }
  };

  const persistSaved = (list: Saved[]) => {
    setSaved(list);
    try {
      localStorage.setItem(SAVED_KEY, JSON.stringify(list));
    } catch {
      return;
    }
  };

  return (
    <section aria-label="All pull requests" className="flex flex-col gap-3.5">
      <div className="flex flex-wrap items-center gap-2">
        <label className="flex">
          <span className="sr-only">Repository</span>
          <Select surface="raised" value={repo} onChange={(e) => setQuery(setQualifier(query, 'repo', e.target.value))}>
            <option value="">All repositories</option>
            {repos.map((r) => (
              <option key={r.slug} value={r.slug}>
                {r.slug}
              </option>
            ))}
          </Select>
        </label>
        <form
          className="flex-1 min-w-[360px] relative"
          onSubmit={(e) => {
            e.preventDefault();
            setQuery(text.trim());
          }}
        >
          <label htmlFor="pr-query" className="sr-only">
            Search pull requests
          </label>
          <span className="absolute left-3 top-[11px] text-muted">
            <Icon name="search" />
          </span>
          <input
            id="pr-query"
            value={text}
            onChange={(e) => setText(e.target.value)}
            className="w-full h-9 pl-9 pr-3 rounded-lg bg-card border border-accent text-strong font-mono text-[12.5px] outline-none"
          />
        </form>
      </div>
      <div className="flex flex-wrap items-center gap-1.5">
        {FILTERS.map((f) => (
          <FilterButton key={f.key} filter={f} query={query} setQuery={setQuery} />
        ))}
        <span className="flex-1" />
        <Button size="sm" variant="ghost" onClick={() => setQuery(setQualifier(DEFAULT_QUERY, 'repo', repo))}>
          Clear filters
        </Button>
      </div>
      <div className="flex flex-wrap items-center gap-1.5">
        <span className="text-muted text-[12px] mr-1">Saved</span>
        {saved.map((s) => (
          <button
            key={s.name}
            type="button"
            onClick={() => setQuery(repo ? setQualifier(s.query, 'repo', repo) : s.query)}
            className="h-[26px] px-2.5 rounded-full bg-hover border border-line-2 text-[12px] hover:border-accent cursor-pointer"
          >
            {s.name}
          </button>
        ))}
        {naming === null ? (
          <button
            type="button"
            onClick={() => setNaming('')}
            className="h-[26px] px-2.5 rounded-full border border-dashed border-line-2 text-[12px] text-soft cursor-pointer"
          >
            + Save this search
          </button>
        ) : (
          <form
            className="flex items-center gap-1.5"
            onSubmit={(e) => {
              e.preventDefault();
              if (naming.trim()) persistSaved([...saved, { name: naming.trim(), query }]);
              setNaming(null);
            }}
          >
            <input
              autoFocus
              aria-label="Name for this search"
              value={naming}
              onChange={(e) => setNaming(e.target.value)}
              onKeyDown={(e) => e.key === 'Escape' && setNaming(null)}
              placeholder="Name"
              className="h-[26px] px-2 rounded-md bg-side border border-line-2 text-[12px] outline-none focus:border-accent"
            />
            <Button size="sm" variant="primary" type="submit">
              Save
            </Button>
          </form>
        )}
        {saved.length > 0 && (
          <button type="button" onClick={() => persistSaved([])} className="text-[11.5px] text-faint hover:text-fg cursor-pointer ml-1">
            reset
          </button>
        )}
      </div>

      {error && <ErrorBox message={error} />}

      <div className="border border-line-2 rounded-[10px] overflow-hidden">
        <div className="flex items-center gap-4 px-3.5 py-2.5 bg-card border-b border-line-2">
          <button type="button" aria-pressed={state === 'open'} onClick={() => setQuery(setState(query, 'open'))} className={cx('cursor-pointer', state === 'open' ? 'text-strong font-semibold' : 'text-muted')}>
            Open
          </button>
          <button type="button" aria-pressed={state === 'closed'} onClick={() => setQuery(setState(query, 'closed'))} className={cx('cursor-pointer', state === 'closed' ? 'text-strong font-semibold' : 'text-muted')}>
            Closed
          </button>
          <span className="flex-1" />
          {loading ? <Spinner /> : <span className="text-muted text-[12px]">{page ? `${page.total} results` : ''}</span>}
        </div>
        {page?.items.map((item) => <PrRow key={item.key} item={item} tabId={tabId} openKeys={openKeys} showRepo={!repo} onOpen={(v) => void openPr(v, tabId)} />)}
        {page && page.items.length === 0 && <div className="px-3.5 py-3 text-muted bg-panel">No pull requests match.</div>}
        {page?.hasNextPage && (
          <div className="p-2.5 bg-panel">
            <Button size="sm" onClick={() => void loadMore()} disabled={loading}>
              Load more
            </Button>
          </div>
        )}
      </div>
      <p className="text-muted text-[12px]">
        Filters edit the query and the query drives the filters, like on github.com. Nothing is checked out until you open a result.
      </p>
    </section>
  );
}
