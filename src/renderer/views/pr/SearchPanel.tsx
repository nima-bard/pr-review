import { useEffect, useMemo, useRef, useState, type KeyboardEvent, type ReactNode } from 'react';
import type { CodeSearchQuery, CodeSearchResult, PrSnapshot } from '../../../shared/model';

type ResultFile = CodeSearchResult['files'][number];
import { api, errorText } from '../../api';
import { FileIcon, FolderIcon } from '../../components/fileIcons';
import { Octicon } from '../../components/octicons';
import { cx, Icon, Segmented, Spinner } from '../../components/ui';
import { openAtLine, openFileTab, setPrefs, updateUi, usePrefs, usePrUi } from '../../state/ui';

/** A toggle inside the search box, like VS Code's Aa / ab / .* buttons. */
export function Toggle({ on, label, title, onChange, children }: { on: boolean; label: string; title: string; onChange(v: boolean): void; children: ReactNode }) {
  return (
    <button
      type="button"
      aria-label={label}
      aria-pressed={on}
      title={title}
      onClick={() => onChange(!on)}
      className={cx('grid place-items-center w-[22px] h-[20px] rounded-[4px] font-mono text-[11.5px] cursor-pointer', on ? 'bg-chip-on text-strong ring-1 ring-chip-on-line' : 'text-muted hover:text-fg hover:bg-raised-2')}
    >
      {children}
    </button>
  );
}

/** The line's text with each match marked. */
function Marked({ text, ranges }: { text: string; ranges: [number, number][] }) {
  const parts: ReactNode[] = [];
  let at = 0;
  ranges.forEach(([a, b], i) => {
    if (a > at) parts.push(text.slice(at, a));
    parts.push(
      <mark key={i} className="bg-warn-bg text-warn-strong rounded-[2px] outline outline-1 outline-warn-line">
        {text.slice(a, b)}
      </mark>,
    );
    at = b;
  });
  if (at < text.length) parts.push(text.slice(at));
  return <>{parts}</>;
}

interface Folder {
  name: string;
  path: string;
  folders: Map<string, Folder>;
  files: ResultFile[];
  count: number;
}

/** The result files as folders (with their match counts), like the file tree. */
function buildFolders(files: readonly ResultFile[]): Folder {
  const root: Folder = { name: '', path: '', folders: new Map(), files: [], count: 0 };
  for (const f of files) {
    let node = root;
    root.count += f.matches.length;
    for (const part of f.path.split('/').slice(0, -1)) {
      let child = node.folders.get(part);
      if (!child) {
        child = { name: part, path: node.path ? `${node.path}/${part}` : part, folders: new Map(), files: [], count: 0 };
        node.folders.set(part, child);
      }
      child.count += f.matches.length;
      node = child;
    }
    node.files.push(f);
  }
  return root;
}

/** A folder with just one subfolder and no files shows as one row ("src / Service.Api"), like VS Code. */
function compact(folder: Folder): { last: Folder; label: string[] } {
  const label = [folder.name];
  let last = folder;
  while (last.folders.size === 1 && last.files.length === 0) {
    last = [...last.folders.values()][0]!;
    label.push(last.name);
  }
  return { last, label };
}

/** The ids of every collapsible folder row, for Collapse all. */
function folderIds(folder: Folder): string[] {
  return [...folder.folders.values()].flatMap((child) => {
    const { last } = compact(child);
    return [`d:${last.path}`, ...folderIds(last)];
  });
}

const INDENT = 12;

interface RowProps {
  snapshot: PrSnapshot;
  depth: number;
  changed: Set<string>;
  collapsed: Record<string, boolean>;
  toggle(id: string, open: boolean): void;
}

function FolderRows({ folder, ...rest }: RowProps & { folder: Folder }) {
  const { depth, collapsed, toggle } = rest;
  const folders = [...folder.folders.values()].sort((a, b) => a.name.localeCompare(b.name));
  return (
    <>
      {folders.map((child) => {
        const { last, label } = compact(child);
        const id = `d:${last.path}`;
        const open = !collapsed[id];
        return (
          <div key={id}>
            <button
              type="button"
              aria-expanded={open}
              onClick={() => toggle(id, open)}
              title={last.path}
              className="flex w-full items-center gap-1.5 h-6 pr-2.5 text-left text-[12.5px] hover:bg-hover cursor-pointer"
              style={{ paddingLeft: 8 + depth * INDENT }}
            >
              <span className="grid place-items-center w-4 flex-none text-muted">
                <Icon name="chevron" size={12} rotate={open ? 0 : -90} />
              </span>
              <FolderIcon path={last.path} open={open} />
              <span className="truncate min-w-0 text-fg">
                {label.map((part, i) => (
                  <span key={i}>
                    {i > 0 && <span className="text-faint"> / </span>}
                    {part}
                  </span>
                ))}
              </span>
              <span className="flex-1" />
              <span className="px-1.5 rounded-full bg-chip text-[10.5px] text-soft flex-none">{last.count}</span>
            </button>
            {open && <FolderRows {...rest} folder={last} depth={depth + 1} />}
          </div>
        );
      })}
      {folder.files.map((f) => (
        <FileResult key={f.path} {...rest} file={f} showDir={false} />
      ))}
    </>
  );
}

/** A file's row (name, folder in the list view, count) and its matches; a match opens the file at that line. */
function FileResult({ snapshot, file: f, depth, showDir, changed, collapsed, toggle }: RowProps & { file: ResultFile; showDir: boolean }) {
  const key = snapshot.key;
  const focus = usePrUi(key).focusLine;
  const open = !collapsed[f.path];
  const slash = f.path.lastIndexOf('/');
  const inPr = changed.has(f.path);
  return (
    <div>
      <button
        type="button"
        aria-expanded={open}
        onClick={(e) => (e.metaKey ? openFileTab(key, f.path, inPr, false) : toggle(f.path, open))}
        title={f.path}
        className="flex w-full items-center gap-1.5 h-6 pr-2.5 text-left text-[12.5px] hover:bg-hover cursor-pointer"
        style={{ paddingLeft: 8 + depth * INDENT }}
      >
        <span className="grid place-items-center w-4 flex-none text-muted">
          <Icon name="chevron" size={12} rotate={open ? 0 : -90} />
        </span>
        <FileIcon path={f.path} />
        <span className="text-fg flex-none">{f.path.slice(slash + 1)}</span>
        {showDir && <span className="text-faint truncate min-w-0 text-[11.5px]">{slash > 0 ? f.path.slice(0, slash) : ''}</span>}
        <span className="flex-1" />
        {inPr && <span title="Changed in this PR" className="w-1.5 h-1.5 rounded-full bg-accent flex-none" />}
        <span className="px-1.5 rounded-full bg-chip text-[10.5px] text-soft flex-none">{f.matches.length}</span>
      </button>
      {open &&
        f.matches.map((m) => {
          const current = focus?.path === f.path && focus.line === m.line;
          return (
            <button
              key={m.line}
              type="button"
              onClick={(e) => openAtLine(key, f.path, m.line, inPr, e.metaKey)}
              onDoubleClick={() => openAtLine(key, f.path, m.line, inPr, true)}
              title={`${f.path}:${m.line}`}
              className={cx('flex w-full items-baseline gap-2 pr-2.5 py-[3px] text-left cursor-pointer', current ? 'bg-active' : 'hover:bg-hover')}
              style={{ paddingLeft: 38 + depth * INDENT }}
            >
              <span className="font-mono text-[10.5px] text-faint min-w-[26px] text-right flex-none">{m.line}</span>
              <span className="font-mono text-[12px] text-soft truncate min-w-0 whitespace-pre">
                <Marked text={m.text} ranges={m.ranges} />
              </span>
            </button>
          );
        })}
    </div>
  );
}

const FIELD = 'w-full h-[28px] px-2 rounded-[6px] bg-raised border border-line-2 focus:border-accent outline-none text-[12.5px]';

/**
 * Find in files (⌘⇧F), like VS Code's search view: the files on disk in the PR's worktree, either the ones in the
 * current comparison or all of them. Results group by file; a match opens its file at that line.
 */
export function SearchPanel({ snapshot, visible }: { snapshot: PrSnapshot; visible: boolean }) {
  const key = snapshot.key;
  const ui = usePrUi(key);
  const q = ui.search;
  const set = (patch: Partial<CodeSearchQuery>) => updateUi(key, (u) => ({ search: { ...u.search, ...patch } }));
  const [result, setResult] = useState<CodeSearchResult | null>(null);
  const [busy, setBusy] = useState(false);
  const [collapsed, setCollapsed] = useState<Record<string, boolean>>({});
  const [now, setNow] = useState(0);
  const input = useRef<HTMLInputElement>(null);
  const changed = useMemo(() => new Set(snapshot.files.map((f) => f.path)), [snapshot.files]);

  // ⌘⇧F: focus the box and select its text, ready to type over.
  useEffect(() => {
    if (!visible) return;
    input.current?.focus();
    input.current?.select();
  }, [ui.searchFocusSeq, visible]);

  // Search as you type (shortly after the last key); a newer search replaces an older one's results.
  const seq = useRef(0);
  useEffect(() => {
    const mine = ++seq.current;
    if (q.pattern === '') {
      setResult(null);
      setBusy(false);
      return;
    }
    setBusy(true);
    const timer = setTimeout(
      () => {
        api.searchCode(key, q).then(
          (r) => mine === seq.current && (setResult(r), setBusy(false)),
          (err: unknown) => mine === seq.current && (setResult({ files: [], total: 0, truncated: false, error: errorText(err) }), setBusy(false)),
        );
      },
      now ? 0 : 250,
    );
    return () => clearTimeout(timer);
    // The comparison and the head change which files a "changed" search covers.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [key, q.pattern, q.matchCase, q.wholeWord, q.regex, q.include, q.exclude, q.scope, snapshot.compare?.from, snapshot.details.headRefOid, now]);

  const onKey = (e: KeyboardEvent<HTMLInputElement>) => {
    if (e.key === 'Enter') setNow((n) => n + 1);
    // VS Code's ⌥C / ⌥W / ⌥R for the toggles (e.code: ⌥ changes the typed character on a Mac).
    if (e.altKey && !e.metaKey && !e.ctrlKey) {
      const toggle = { KeyC: 'matchCase', KeyW: 'wholeWord', KeyR: 'regex' } as const;
      const flag = toggle[e.code as keyof typeof toggle];
      if (flag) {
        e.preventDefault();
        set({ [flag]: !q[flag] });
      }
    }
  };

  const view = usePrefs((p) => p.searchView);
  const tree = useMemo(() => (result ? buildFolders(result.files) : null), [result]);
  const toggle = (id: string, open: boolean) => setCollapsed((c) => ({ ...c, [id]: open }));
  /** Every row that can collapse: files, and in the tree its folders (merged chains count once, by their last folder). */
  const collapsible = useMemo(() => (result ? [...result.files.map((f) => f.path), ...(view === 'tree' && tree ? folderIds(tree) : [])] : []), [result, view, tree]);
  const allCollapsed = collapsible.length > 0 && collapsible.every((id) => collapsed[id]);

  return (
    <div role="search" aria-label="Find in files" aria-busy={busy} className="h-full flex flex-col bg-side">
      <div className="px-2.5 pt-2.5 flex flex-col gap-2">
        {/* Like the Files panel: the scope first, full width. */}
        <Segmented<CodeSearchQuery['scope']>
          stretch
          label="Search scope"
          value={q.scope}
          onChange={(v) => set({ scope: v })}
          options={[
            { value: 'changed', label: `Changed · ${snapshot.files.length}` },
            { value: 'all', label: 'All files' },
          ]}
        />
        <div className="flex items-center gap-1.5">
          <div className="relative flex-1 min-w-0">
            <input
              ref={input}
              value={q.pattern}
              onChange={(e) => set({ pattern: e.target.value })}
              onKeyDown={onKey}
              placeholder="Search"
              aria-label="Search"
              spellCheck={false}
              className={cx(FIELD, 'h-[31px] pr-[82px] font-mono')}
            />
            <span className="absolute right-1.5 top-1/2 -translate-y-1/2 flex gap-0.5">
              <Toggle on={q.matchCase} label="Match case" title="Match case (⌥C)" onChange={(v) => set({ matchCase: v })}>
                Aa
              </Toggle>
              <Toggle on={q.wholeWord} label="Match whole word" title="Match whole word (⌥W)" onChange={(v) => set({ wholeWord: v })}>
                <span className="underline underline-offset-2">ab</span>
              </Toggle>
              <Toggle on={q.regex} label="Use regular expression" title="Use regular expression (⌥R)" onChange={(v) => set({ regex: v })}>
                .*
              </Toggle>
            </span>
          </div>
          <button
            type="button"
            aria-label="Files to include and exclude"
            aria-expanded={ui.searchDetails}
            title="Files to include and exclude"
            onClick={() => updateUi(key, { searchDetails: !ui.searchDetails })}
            className={cx(
              'grid place-items-center w-[31px] h-[31px] rounded-[6px] border cursor-pointer flex-none',
              ui.searchDetails || q.include || q.exclude ? 'bg-chip-on border-chip-on-line text-strong' : 'bg-raised border-line-2 text-muted hover:text-fg',
            )}
          >
            <Octicon name="filter" size={14} />
          </button>
        </div>
        {ui.searchDetails && (
          <div className="flex flex-col gap-1.5">
            <label className="flex flex-col gap-1">
              <span className="text-[11.5px] text-muted">files to include</span>
              <input value={q.include} onChange={(e) => set({ include: e.target.value })} onKeyDown={onKey} placeholder="e.g. *.ts, src/components" spellCheck={false} className={cx(FIELD, 'font-mono')} />
            </label>
            <label className="flex flex-col gap-1">
              <span className="text-[11.5px] text-muted">files to exclude</span>
              <input value={q.exclude} onChange={(e) => set({ exclude: e.target.value })} onKeyDown={onKey} placeholder="e.g. *.test.ts, migrations" spellCheck={false} className={cx(FIELD, 'font-mono')} />
            </label>
          </div>
        )}
        <div className="flex items-center gap-2 min-h-[20px] text-[12px] text-muted">
          {q.pattern === '' ? (
            <span>
              Searches the code as it is now in this PR&rsquo;s worktree{q.scope === 'changed' && snapshot.compare ? `, in the files changed ${snapshot.compare.label.toLowerCase()}` : ''}.
            </span>
          ) : busy && !result ? (
            <Spinner label="Searching…" />
          ) : result?.error ? (
            <span className="text-del">{result.error}</span>
          ) : result ? (
            <>
              <span className={cx(busy && 'opacity-60')}>
                {result.total === 0
                  ? 'No results'
                  : `${result.total}${result.truncated ? '+' : ''} result${result.total === 1 ? '' : 's'} in ${result.files.length} file${result.files.length === 1 ? '' : 's'}`}
                {q.scope === 'changed' && snapshot.compare ? ` · changed ${snapshot.compare.label.toLowerCase()}` : ''}
              </span>
              <span className="flex-1" />
              {result.files.length > 0 && (
                <>
                  <button
                    type="button"
                    aria-label={view === 'tree' ? 'View as list' : 'View as tree'}
                    title={view === 'tree' ? 'View as list' : 'View as tree'}
                    onClick={() => setPrefs({ searchView: view === 'tree' ? 'list' : 'tree' })}
                    className="grid place-items-center w-6 h-6 rounded-md text-muted hover:text-fg hover:bg-raised cursor-pointer"
                  >
                    <Octicon name={view === 'tree' ? 'list-unordered' : 'quote'} size={14} />
                  </button>
                  <button type="button" onClick={() => setCollapsed(allCollapsed ? {} : Object.fromEntries(collapsible.map((id) => [id, true])))} className="text-muted hover:text-fg cursor-pointer">
                    {allCollapsed ? 'Expand all' : 'Collapse all'}
                  </button>
                </>
              )}
            </>
          ) : null}
        </div>
        {snapshot.worktree.behind && (
          <div className="text-[12px] text-warn">This checkout isn&rsquo;t at the PR&rsquo;s latest commit, and the search reads the files on disk, so results can differ from the diff.</div>
        )}
        {result?.truncated && <div className="text-[12px] text-warn">Showing the first {result.total} results. Narrow the search to see the rest.</div>}
        {result && result.total === 0 && !result.error && q.scope === 'changed' && (
          <button type="button" onClick={() => set({ scope: 'all' })} className="text-left text-[12px] text-link hover:underline cursor-pointer">
            Search all files instead
          </button>
        )}
      </div>
      <div className="flex-1 overflow-y-auto mt-1.5 pb-3">
        {result && view === 'list' && result.files.map((f) => <FileResult key={f.path} snapshot={snapshot} file={f} depth={0} showDir changed={changed} collapsed={collapsed} toggle={toggle} />)}
        {result && view === 'tree' && <FolderRows snapshot={snapshot} folder={tree!} depth={0} changed={changed} collapsed={collapsed} toggle={toggle} />}
      </div>
    </div>
  );
}
