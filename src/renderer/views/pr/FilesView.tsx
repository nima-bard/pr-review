import { File as PierreFile } from '@pierre/diffs/react';
import type { SelectedLineRange } from '@pierre/diffs';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Group, Panel, Separator, useDefaultLayout } from 'react-resizable-panels';
import type { PrPreview, PrSnapshot } from '../../../shared/model';
import { Button, cx, Icon, Kbd, PanelTitle, Segmented, Skeleton, Spinner } from '../../components/ui';
import { SHORTCUTS, useReviewKeys } from './useReviewKeys';
import { commentedPaths, FileSection, FullFileDiff, strayThreads, threadsForFile } from '../../diff/FileSection';
import { ThreadCard } from '../../diff/ThreadCard';
import { useFileContent } from '../../diff/useFileDiff';
import { api } from '../../api';
import { appendToSummary, closeContentTab, closeContentTabs, getPrUi, moveContentTab, prView, setPrefs, updateUi, usePrefs, usePrUi } from '../../state/ui';
import { MARKER_CLASS, useTabReorder } from '../../components/useTabReorder';
import { FileIcon } from '../../components/fileIcons';
import { fileMenuItems, runFileAction } from '../../components/fileMenu';
import { useDiffAppearance } from '../../state/settings';
import { useFocusLine } from '../../diff/useFocusLine';
import { useSearchHighlights } from '../../diff/useSearchHighlights';
import { useFindInView } from '../../diff/useFindInView';
import { FindBar } from './FindBar';
import { FileTree } from './FileTree';
import { SearchPanel } from './SearchPanel';
import { Octicon } from '../../components/octicons';
import { useTextSelectionContext } from '../../diff/useTextSelectionContext';
import { type Activity, ActivityBar, ActivityCount, ActivityLoading } from './ActivityBar';
import { CommitsView } from './CommitsView';
import { Overview } from './Overview';
import { openSettings } from '../../state/tabs';
import { useSessions } from '../../state/sessions';
import { ClaudeSpinner, DetailsPanel, SidePanel, toggleDetails, toggleSidePanel, useClaudeWorking, useSidePanelShows } from './SidePanel';
import { useClaudeSettings } from '../../state/claude';
import { treeCompare } from './treeOrder';

async function showTabMenu(snapshot: PrSnapshot, id: string): Promise<void> {
  const key = snapshot.key;
  const tabs = getPrUi(key).contentTabs;
  const index = tabs.findIndex((t) => t.id === id);
  const files = tabs.filter((t) => t.kind === 'file').map((t) => t.id);
  const others = files.filter((f) => f !== id);
  const right = tabs.slice(index + 1).filter((t) => t.kind === 'file').map((t) => t.id);
  const isFile = tabs[index]?.kind === 'file';
  const tab = tabs[index];
  // A file tab also gets the file's actions (it shows the whole file already).
  const fileItems = tab?.kind === 'file' ? ['separator' as const, ...fileMenuItems(snapshot, tab.path, { whole: false })] : [];
  const choice = await api.contextMenu([
    { id: 'close', label: 'Close', enabled: isFile },
    { id: 'others', label: 'Close Others', enabled: others.length > 0 },
    { id: 'right', label: 'Close to the Right', enabled: right.length > 0 },
    'separator',
    { id: 'all', label: 'Close All', enabled: files.length > 0 },
    ...fileItems,
  ]);
  if (tab?.kind === 'file' && (await runFileAction(snapshot, tab.path, choice))) return;
  if (choice === 'close') closeContentTab(key, id);
  if (choice === 'others') closeContentTabs(key, others, id);
  if (choice === 'right') closeContentTabs(key, right, id);
  if (choice === 'all') closeContentTabs(key, files);
}

function ContentTabs({ snapshot }: { snapshot: PrSnapshot }) {
  const ui = usePrUi(snapshot.key);
  const reorder = useTabReorder('files', ui.contentTabs.map((t) => t.id), (from, slot) => moveContentTab(snapshot.key, from, slot));
  return (
    <div className="flex items-stretch bg-side border-b border-line flex-none">
      <div role="tablist" aria-label="Open files" {...reorder.rowProps} className="flex items-stretch overflow-x-auto min-w-0 flex-1">
        {ui.contentTabs.map((t, index) => {
          const active = t.id === ui.activeContent;
          const marker = reorder.marker(index);
          const label = t.kind === 'changes' ? 'All changes' : t.path.split('/').pop();
          return (
            <div
              key={t.id}
              {...reorder.tabProps(index)}
              onMouseDown={(e) => e.button === 1 && e.preventDefault()}
              onAuxClick={(e) => {
                if (e.button === 1 && t.kind === 'file') closeContentTab(snapshot.key, t.id);
              }}
              onContextMenu={(e) => {
                e.preventDefault();
                void showTabMenu(snapshot, t.id);
              }}
              className={cx(
                'relative flex items-center border-r border-line',
                active ? 'bg-bg text-strong after:absolute after:inset-x-0 after:bottom-0 after:h-0.5 after:bg-accent' : 'text-soft',
                reorder.dragging === t.id && 'opacity-50',
                marker && MARKER_CLASS[marker],
              )}
            >
              <button
                type="button"
                role="tab"
                aria-selected={active}
                onClick={() => updateUi(snapshot.key, { activeContent: t.id })}
                onDoubleClick={() => t.kind === 'file' && updateUi(snapshot.key, (u) => ({ contentTabs: u.contentTabs.map((x) => (x.id === t.id && x.kind === 'file' ? { ...x, preview: false } : x)) }))}
                className={cx('flex items-center gap-2 h-9 pl-3.5 pr-2 whitespace-nowrap cursor-pointer', t.kind === 'file' && t.preview && 'italic')}
                title={t.kind === 'file' ? t.path : undefined}
              >
                {t.kind === 'changes' ? <Icon name="list" size={13} /> : <FileIcon path={t.path} size={14} />}
                {label}
                {t.kind === 'changes' && <span className="text-muted text-[12px]">{snapshot.files.length} files</span>}
                {t.kind === 'file' && !t.changed && <span className="not-italic text-[11px] text-muted">read-only</span>}
              </button>
              {t.kind === 'file' && (
                <button type="button" aria-label={`Close ${t.path}`} onClick={() => closeContentTab(snapshot.key, t.id)} className="grid place-items-center w-6 h-6 mr-1 rounded text-faint hover:text-fg hover:bg-raised cursor-pointer">
                  <Icon name="close" size={11} />
                </button>
              )}
            </div>
          );
        })}
      </div>
      {/* How the diffs are laid out, beside the tabs they're in (also in the View menu). */}
      <div className="flex items-center px-2 flex-none">
        <Segmented size="sm" label="Diff layout" value={ui.layout} onChange={(layout) => updateUi(snapshot.key, { layout })} options={[{ value: 'split', label: 'Split' }, { value: 'unified', label: 'Unified' }]} />
      </div>
    </div>
  );
}

/** Comments on files that left the PR and whose line couldn't be found; otherwise no file section would show them. */
function StrayComments({ snapshot }: { snapshot: PrSnapshot }) {
  const ui = usePrUi(snapshot.key);
  const hideResolved = usePrefs((p) => p.hideResolved);
  const byPath = useMemo(() => {
    const map = new Map<string, ReturnType<typeof strayThreads>>();
    for (const t of strayThreads(snapshot)) {
      if (hideResolved && t.isResolved && t.id !== ui.focusThread) continue;
      map.set(t.anchor.path, [...(map.get(t.anchor.path) ?? []), t]);
    }
    return [...map.entries()].sort(([a], [b]) => treeCompare(a, b));
  }, [snapshot, hideResolved, ui.focusThread]);
  if (byPath.length === 0) return null;
  const count = byPath.reduce((n, [, list]) => n + list.length, 0);
  return (
    <section aria-label="Comments on code no longer in this PR" className="border border-warn-line rounded-[9px] bg-panel overflow-clip">
      <div className="flex flex-wrap items-baseline gap-x-2 gap-y-0.5 px-3 py-2 bg-subtle border-b border-line-2">
        <strong className="text-strong font-semibold">Comments on code that's no longer in this PR</strong>
        <span className="text-muted text-[12px]">{count}</span>
        <span className="text-muted text-[12px] basis-full">Their file was deleted, renamed or split, and the commented line couldn't be found in the current code.</span>
      </div>
      <div className="flex flex-col gap-4 p-3">
        {byPath.map(([path, threads]) => (
          <div key={path} id={`file-${path}`} className="flex flex-col gap-2">
            <div className="flex items-center gap-1.5 font-mono text-[12px] text-muted min-w-0">
              <FileIcon path={path} size={14} />
              <span className="truncate">{path}</span>
            </div>
            {threads.map((t) => (
              <ThreadCard key={t.id} snapshot={snapshot} thread={t} focused={ui.focusThread === t.id} wide />
            ))}
          </div>
        ))}
      </div>
    </section>
  );
}

function AllChanges({ snapshot }: { snapshot: PrSnapshot }) {
  const ui = usePrUi(snapshot.key);
  const prefs = usePrefs();
  // In the file tree's order (at each level folders first, then files), so the diffs follow the tree.
  const sorted = useMemo(() => [...snapshot.files].sort((a, b) => treeCompare(a.path, b.path)), [snapshot.files]);
  const commented = useMemo(() => (prefs.onlyCommented ? commentedPaths(snapshot, prefs.hideResolved) : null), [snapshot, prefs.onlyCommented, prefs.hideResolved]);
  const afterViewed = prefs.hideViewed ? sorted.filter((f) => f.viewed !== 'VIEWED' || f.path === ui.focusPath) : sorted;
  const hiddenViewed = sorted.length - afterViewed.length;
  const files = commented ? afterViewed.filter((f) => commented.has(f.path) || f.path === ui.focusPath) : afterViewed;
  const hiddenUncommented = afterViewed.length - files.length;
  const list = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const path = ui.focusPath;
    const threadId = ui.focusThread;
    const elementId = ui.focusElement;
    if (!path) return;
    // Unfolded, also when it's folded for being viewed (no entry yet), so the thread or line is there to show.
    if (ui.collapsed[path] !== false) updateUi(snapshot.key, (u) => ({ collapsed: { ...u.collapsed, [path]: false } }));
    const content = list.current;
    const scroller = content?.closest<HTMLElement>('.overflow-y-auto') ?? null;
    // Sections load lazily as they near the viewport, and the target's own diff loads too, so heights keep changing
    // for a while after a jump. Keep the target (the thread, once it exists) in place until the user takes over.
    let pinned = true;
    const align = () => {
      if (!pinned) return;
      // A thread, or another element on a line (a draft, an ask's marker); else the file's top.
      const thread = (threadId ? document.getElementById(`thread-${threadId}`) : null) ?? (elementId ? document.getElementById(elementId) : null);
      (thread ?? document.getElementById(`file-${path}`))?.scrollIntoView({ block: thread ? 'center' : 'start' });
    };
    align();
    const resize = new ResizeObserver(align);
    if (content) resize.observe(content);
    const userEvents = ['wheel', 'touchmove', 'pointerdown', 'keydown'] as const;
    const release = () => {
      pinned = false;
      resize.disconnect();
    };
    for (const e of userEvents) scroller?.addEventListener(e, release, { passive: true });
    const timeout = setTimeout(release, 8000);
    return () => {
      release();
      clearTimeout(timeout);
      for (const e of userEvents) scroller?.removeEventListener(e, release);
    };
  }, [ui.focusPath, ui.focusThread, ui.focusElement, ui.focusSeq, snapshot.key]);
  if (sorted.length === 0) return <div className="p-6 text-muted">This pull request has no file changes.</div>;
  return (
    <div ref={list} className="flex flex-col gap-3.5 p-4 pb-10">
      {(hiddenViewed > 0 || hiddenUncommented > 0 || prefs.hideResolved) && (
        <div className="flex flex-wrap items-center gap-2 text-[12px] text-muted">
          {hiddenViewed > 0 && (
            <span>
              {hiddenViewed} viewed file{hiddenViewed === 1 ? '' : 's'} hidden ·{' '}
              <button type="button" onClick={() => setPrefs({ hideViewed: false })} className="text-accent cursor-pointer">
                show
              </button>
            </span>
          )}
          {hiddenUncommented > 0 && (
            <span>
              {hiddenUncommented} file{hiddenUncommented === 1 ? '' : 's'} without comments hidden ·{' '}
              <button type="button" onClick={() => setPrefs({ onlyCommented: false })} className="text-accent cursor-pointer">
                show
              </button>
            </span>
          )}
          {prefs.hideResolved && (
            <span>
              Resolved comments hidden ·{' '}
              <button type="button" onClick={() => setPrefs({ hideResolved: false })} className="text-accent cursor-pointer">
                show
              </button>
            </span>
          )}
        </div>
      )}
      <StrayComments snapshot={snapshot} />
      {files.length === 0 && <div className="text-muted">{hiddenUncommented > 0 ? 'No remaining files have comments.' : 'All files are viewed. 🎉'}</div>}
      {files.map((f) => (
        <FileSection key={f.path} snapshot={snapshot} file={f} threadCount={threadsForFile(snapshot, f.path).length} />
      ))}
    </div>
  );
}

function ReadOnlyFile({ snapshot, path }: { snapshot: PrSnapshot; path: string }) {
  const content = useFileContent(snapshot.key, snapshot.details.headRefOid, 'head', path);
  const [selection, setSelection] = useState<SelectedLineRange | null>(null);
  const [done, setDone] = useState<string | null>(null);
  const view = useRef<HTMLDivElement>(null);
  useFocusLine(snapshot.key, path, view, true, (line) => {
    setSelection({ start: line, end: line });
    setDone(null);
  });
  const a = selection ? Math.min(selection.start, selection.end) : 0;
  const b = selection ? Math.max(selection.start, selection.end) : 0;
  const permalink = `https://github.com/${snapshot.ref.owner}/${snapshot.ref.repo}/blob/${snapshot.details.headRefOid}/${path}#L${a}${b !== a ? `-L${b}` : ''}`;
  const quote = () => {
    const lines = (content?.contents ?? '').split('\n').slice(a - 1, b);
    const ext = path.split('.').pop() ?? '';
    appendToSummary(snapshot.key, `${path} lines ${a}–${b}:\n\n\`\`\`${ext}\n${lines.join('\n')}\n\`\`\`\n${permalink}`);
    setDone('Quoted into your review summary.');
  };
  const appearance = useDiffAppearance();
  const wordWrap = usePrefs((p) => p.wordWrap);
  const options = useMemo(
    () => ({
      ...appearance,
      disableFileHeader: true,
      enableLineSelection: true,
      overflow: wordWrap ? ('wrap' as const) : ('scroll' as const),
      onLineSelected: (r: SelectedLineRange | null) => {
        setSelection(r);
        setDone(null);
      },
    }),
    [appearance, wordWrap],
  );
  return (
    <div className="flex flex-col gap-3 p-4">
      <div className="flex flex-wrap items-center gap-x-2 gap-y-1 text-muted text-[12px]">
        <span className="font-mono text-strong">{path}</span>
        <span className="flex-1" />
        <span>
          at head <span className="font-mono text-fg">{snapshot.details.headRefOid.slice(0, 7)}</span> · not part of this PR · read-only
        </span>
      </div>
      <div className="flex items-start gap-3 px-3 py-2.5 rounded-[9px] bg-info-subtle border border-info-line">
        <Icon name="info" size={16} className="text-info mt-0.5" />
        <span className="flex-1 text-fg leading-snug">
          This file isn't in the PR, so GitHub can't take line comments here. Select lines to quote them into your review summary or copy a permalink.
        </span>
      </div>
      {selection && (
        <div className="sticky top-0 z-10 flex flex-wrap items-center gap-2 px-3 py-2 rounded-lg bg-raised-2 border border-chip-on-line">
          <span className="font-semibold">{a === b ? `Line ${a}` : `Lines ${a}–${b}`}</span>
          <span className="text-muted">not in this PR, no comments</span>
          <span className="flex-1" />
          {done && <span className="text-add text-[12px]">{done}</span>}
          <Button size="sm" variant="primary" onClick={quote}>
            Quote in review summary
          </Button>
          <Button
            size="sm"
            onClick={() => {
              void navigator.clipboard.writeText(permalink);
              setDone('Permalink copied.');
            }}
          >
            Copy permalink
          </Button>
        </div>
      )}
      <div ref={view} className="border border-line-2 rounded-[9px] bg-panel overflow-hidden">
        {!content ? (
          <div className="p-4">
            <Spinner label="Loading…" />
          </div>
        ) : content.missing ? (
          <div className="p-4 text-muted">File not found at head.</div>
        ) : content.binary ? (
          <div className="p-4 text-muted">Binary file.</div>
        ) : (
          <PierreFile file={{ name: path, contents: content.contents, cacheKey: `${snapshot.details.headRefOid}:${path}` }} options={options} selectedLines={selection} />
        )}
      </div>
    </div>
  );
}

function Content({ snapshot, active }: { snapshot: PrSnapshot; active: boolean }) {
  const ui = usePrUi(snapshot.key);
  const scroller = useRef<HTMLDivElement | null>(null);
  // The search text is marked in the code on screen, while the search sidebar has a query.
  useSearchHighlights(scroller, snapshot.key, active);
  const found = useFindInView(scroller, snapshot.key, active);
  const tab = ui.contentTabs.find((t) => t.id === ui.activeContent) ?? ui.contentTabs[0]!;
  const changed = tab.kind === 'file' ? snapshot.files.find((f) => f.path === tab.path) : undefined;
  return (
    <div className="h-full flex flex-col min-w-0">
      <ContentTabs snapshot={snapshot} />
      <div className="relative flex-1 min-h-0">
        <FindBar snapshot={snapshot} count={found.count} current={found.current} allChanges={tab.kind === 'changes'} />
        {/* Positioned, so what's absolutely placed in the diffs (a screen reader's hidden label, say) is placed and clipped
            in here, not in the frame around it, where it would make the whole column scroll. */}
        <div ref={scroller} className="relative h-full overflow-y-auto">
          {tab.kind === 'changes' && <AllChanges snapshot={snapshot} />}
          {tab.kind === 'file' && changed && (
            <div className="p-4">
              <FullFileDiff snapshot={snapshot} file={changed} />
            </div>
          )}
          {tab.kind === 'file' && !changed && <ReadOnlyFile snapshot={snapshot} path={tab.path} />}
        </div>
      </div>
    </div>
  );
}

/** The left sidebar: the file tree, or Find in files (⌘⇧F), chosen in the strip of icons beside it. Both stay mounted, so each keeps its state. */
function Sidebar({ snapshot }: { snapshot: PrSnapshot }) {
  const key = snapshot.key;
  const sidebar = usePrUi(key).sidebar;
  return (
    // data-sidebar: clicks in here keep the thread you've selected (going to another is a click here too).
    <div data-sidebar className="h-full flex flex-col bg-side">
      <PanelTitle title={sidebar === 'search' ? 'Search' : 'Files'} />
      <div className={cx('flex-1 min-h-0', sidebar !== 'files' && 'hidden')}>
        <FileTree snapshot={snapshot} />
      </div>
      <div className={cx('flex-1 min-h-0', sidebar !== 'search' && 'hidden')}>
        <SearchPanel snapshot={snapshot} visible={sidebar === 'search'} />
      </div>
    </div>
  );
}

/**
 * The splitter is its own 7px strip between the panels (drawing a 1px line), and the whole of its grab area: the
 * library's default widens a thin splitter's grab area by a few pixels on each side, over the neighbouring panels'
 * scrollbars. There the cursor promised a resize, but pressing it scrolled the panel.
 */
const SEPARATOR =
  'relative w-[7px] flex-none before:absolute before:inset-y-0 before:left-[3px] before:w-px before:bg-line before:transition-colors hover:before:bg-accent data-[separator=active]:before:bg-accent';
const GRAB_AREA = { coarse: 20, fine: 7 };

function CheatSheet({ onClose }: { onClose(): void }) {
  return (
    <div className="fixed inset-0 z-50 grid place-items-center bg-black/50" onMouseDown={(e) => e.target === e.currentTarget && onClose()}>
      <div role="dialog" aria-labelledby="keys-h" className="w-[420px] rounded-xl bg-raised border border-line-2 shadow-2xl p-4">
        <div className="flex items-center mb-3">
          <h2 id="keys-h" className="text-[15px] font-bold text-strong">
            Keyboard shortcuts
          </h2>
          <span className="flex-1" />
          <button type="button" aria-label="Close" onClick={onClose} className="text-muted hover:text-fg cursor-pointer">
            <Icon name="close" size={13} />
          </button>
        </div>
        <dl className="grid grid-cols-[110px_1fr] gap-y-1.5">
          {SHORTCUTS.map(([k, d]) => (
            <div key={k} className="contents">
              <dt>
                <Kbd>{k}</Kbd>
              </dt>
              <dd className="text-fg">{d}</dd>
            </div>
          ))}
        </dl>
      </div>
    </div>
  );
}

/** The keyboard shortcuts of the files, once the pull request has loaded (they need its files and threads). */
function ReviewKeys({ snapshot, enabled, onHelp }: { snapshot: PrSnapshot; enabled: boolean; onHelp(): void }) {
  useReviewKeys(snapshot, enabled, onHelp);
  return null;
}

/** The tree's place while the pull request is still being checked out. */
function TreeSkeleton({ title }: { title: string }) {
  const rows = ['w-2/3', 'ml-4 w-1/2', 'ml-4 w-3/5', 'w-1/2', 'ml-4 w-2/3', 'ml-8 w-2/5', 'w-3/5'];
  return (
    <div className="h-full flex flex-col bg-side">
      <PanelTitle title={title} />
      <div aria-hidden="true" className="flex flex-col gap-3 p-3">
        <Skeleton className="h-[26px]" />
        {rows.map((w, i) => (
          <Skeleton key={i} className={`h-3 ${w}`} />
        ))}
      </div>
    </div>
  );
}

/** The diffs' (or the commits') place while the pull request is still being checked out, with how far along it is. */
function ContentSkeleton({ prKey, what }: { prKey: string; what: string }) {
  const progress = useSessions((s) => s.progress[prKey]);
  return (
    <div className="h-full flex flex-col gap-4 p-4 overflow-hidden">
      <div className="flex flex-col gap-1">
        <Spinner label={progress ?? 'Loading…'} />
        <span className="pl-5.5 text-[12px] text-muted">{what} show once the pull request is checked out.</span>
      </div>
      {[0, 1].map((i) => (
        <div key={i} aria-hidden="true" className="rounded-[10px] border border-line-2 overflow-hidden">
          <div className="flex items-center gap-2 h-10 px-3 bg-subtle border-b border-line">
            <Skeleton className="w-48 h-3" />
          </div>
          <div className="flex flex-col gap-2.5 p-3">
            {['w-1/2', 'w-2/3', 'w-5/12', 'w-3/4', 'w-1/3'].map((w, j) => (
              <Skeleton key={j} className={`h-3 ${w}`} />
            ))}
          </div>
        </div>
      ))}
    </div>
  );
}

/**
 * A pull request's frame: the strip of icons on the left (Overview, Files, Search, Commits, and Settings at its foot),
 * what they show (the Overview and the commits in place of the tree and the diffs, which stay mounted behind them so
 * you come back to your place), and the right panel with its strip (Details, Comments, Claude). It shows from the
 * start: while the pull request is checked out (`snapshot` undefined), the Overview and Details are there already, and
 * what needs the checkout has a spinner on its icon and a placeholder in its place.
 */
export function FilesView({ pr, snapshot, active = true }: { pr: PrPreview; snapshot: PrSnapshot | undefined; active?: boolean }) {
  const key = pr.key;
  const ui = usePrUi(key);
  const loaded = snapshot !== undefined;
  const [help, setHelp] = useState(false);
  const toggleHelp = useCallback(() => setHelp((h) => !h), []);
  const overview = prView(ui) === 'overview';
  const commits = !overview && ui.sidebar === 'commits';
  const covered = overview || commits;
  const root = useRef<HTMLDivElement>(null);
  useTextSelectionContext(key, root, active);
  // Beside the Overview its details, beside the files the comments or Claude, beside the commits nothing. The details
  // are their own panel (narrower by default), so each keeps its own width.
  const showDetails = overview && ui.showDetails;
  const showSide = !covered && ui.showPanel;
  const panelIds = [...(ui.showTree && !covered ? ['tree'] : []), 'content', ...(showDetails ? ['details'] : []), ...(showSide ? ['side'] : [])];
  const layout = useDefaultLayout({ id: `files-${pr.role}`, panelIds });
  const claudeOn = useClaudeSettings((s) => s.enabled);
  const commentsShown = useSidePanelShows(key, 'comments');
  const claudeShown = useSidePanelShows(key, 'claude');
  const working = useClaudeWorking(key);
  const unresolved = snapshot ? snapshot.threads.filter((t) => !t.isResolved).length : 0;
  // On what needs the checkout, until it's there.
  const pending = loaded ? undefined : <ActivityLoading />;
  const sidebarShows = (id: 'files' | 'search') => !covered && ui.showTree && ui.sidebar === id;
  const showSidebar = (id: 'files' | 'search') =>
    updateUi(key, (u) => (sidebarShows(id) ? { showTree: false } : { view: 'files', showTree: true, sidebar: id, ...(id === 'search' ? { searchFocusSeq: u.searchFocusSeq + 1 } : {}) }));
  // Pressed again, the Overview and the commits go back to the files.
  const backToFiles = () => updateUi(key, (u) => ({ view: 'files', showTree: true, sidebar: u.sidebar === 'commits' ? 'files' : u.sidebar }));
  const d = pr.details;
  const left: Activity[] = [
    {
      id: 'overview',
      label: 'Overview',
      title: 'Overview: the description and the conversation, in place of the files',
      icon: <Octicon name="home" size={20} />,
      active: overview,
      onClick: () => (overview ? backToFiles() : updateUi(key, { view: 'overview' })),
    },
    { id: 'files', label: 'Files', title: 'Files (⇧⌘E)', icon: <Icon name="file" size={20} />, active: sidebarShows('files'), badge: pending, onClick: () => showSidebar('files') },
    { id: 'search', label: 'Search', title: 'Find in files (⇧⌘F)', icon: <Icon name="search" size={20} />, active: sidebarShows('search'), badge: pending, onClick: () => showSidebar('search') },
    {
      id: 'commits',
      label: 'Commits',
      title: 'Commits, in place of the files',
      icon: <Octicon name="git-commit" size={20} />,
      active: commits,
      badge: pending,
      onClick: () => (commits ? backToFiles() : updateUi(key, { view: 'files', sidebar: 'commits' })),
    },
  ];
  // At the bottom of the left strip, like VS Code's gear.
  const settings: Activity[] = [{ id: 'settings', label: 'Settings', title: 'Settings (⌘,)', icon: <Octicon name="gear" size={20} />, active: false, onClick: () => openSettings() }];
  // Details' badge: failing checks in red, or conflicts with the base branch.
  const failing = d.checks.filter((c) => c.state === 'failure').length;
  const conflicts = d.state === 'OPEN' && d.mergeable === 'CONFLICTING';
  const details: Activity = {
    id: 'details',
    label: `Details${failing > 0 ? `, ${failing} check${failing === 1 ? '' : 's'} failing` : conflicts ? ', has conflicts' : ''}`,
    title: 'Details: reviewers, checks, merge, linked issues and your checkout',
    icon: <Icon name="info" size={20} />,
    active: showDetails,
    badge: failing > 0 ? <ActivityCount n={failing} tone="bad" /> : conflicts ? <ActivityCount n="!" tone="warn" /> : undefined,
    onClick: () => toggleDetails(key),
  };
  const chat: Activity[] = [
    {
      id: 'comments',
      label: `Comments${unresolved > 0 ? `, ${unresolved} unresolved` : ''}`,
      title: 'Review comments (⇧⌘C)',
      icon: <Octicon name="comment-discussion" size={20} />,
      active: commentsShown,
      badge: pending ?? (unresolved > 0 ? <ActivityCount n={unresolved} /> : undefined),
      onClick: () => toggleSidePanel(key, 'comments'),
    },
    ...(claudeOn
      ? [
          {
            id: 'claude',
            label: 'Claude',
            title: 'The conversation with Claude about this pull request (⇧⌘A)',
            icon: <Octicon name="comment-ai" size={20} />,
            active: claudeShown,
            badge: pending ?? (working ? <ClaudeSpinner /> : undefined),
            onClick: () => toggleSidePanel(key, 'claude'),
          },
        ]
      : []),
  ];
  const right: Activity[] = overview ? [details] : commits ? [] : chat;
  return (
    <>
      {snapshot && <ReviewKeys snapshot={snapshot} enabled={active && !help && !covered} onHelp={toggleHelp} />}
      {help && <CheatSheet onClose={() => setHelp(false)} />}
      <div ref={root} className="h-full flex">
        <ActivityBar label="Overview, files and commits" edge="left" items={left} bottom={settings} />
        <div className="flex-1 min-w-0">
          <Group orientation="horizontal" className="h-full" resizeTargetMinimumSize={GRAB_AREA} defaultLayout={layout.defaultLayout} onLayoutChanged={layout.onLayoutChanged}>
            {ui.showTree && !covered && (
              <>
                <Panel id="tree" defaultSize="22" minSize={200} maxSize="45">
                  {snapshot ? <Sidebar snapshot={snapshot} /> : <TreeSkeleton title={ui.sidebar === 'search' ? 'Search' : 'Files'} />}
                </Panel>
                <Separator className={SEPARATOR} />
              </>
            )}
            {/* Everything in it scrolls by itself (the diffs, the Overview, the commits), so the panel itself never does:
                otherwise one stray pixel below makes a second scrollbar, and going to a line scrolls the whole column. */}
            <Panel id="content" minSize={420} style={{ overflow: 'clip' }}>
              {overview && <Overview pr={pr} snapshot={snapshot} />}
              {commits && (snapshot ? <CommitsView snapshot={snapshot} /> : <ContentSkeleton prKey={key} what="The commits" />)}
              {!snapshot && !covered && <ContentSkeleton prKey={key} what="The files" />}
              {snapshot && (
                <div className={cx('h-full', covered && 'hidden')}>
                  <Content snapshot={snapshot} active={active && !covered} />
                </div>
              )}
            </Panel>
            {showDetails && (
              <>
                <Separator className={SEPARATOR} />
                <Panel id="details" defaultSize="20" minSize={240} maxSize="35">
                  <DetailsPanel pr={pr} snapshot={snapshot} />
                </Panel>
              </>
            )}
            {showSide && (
              <>
                <Separator className={SEPARATOR} />
                <Panel id="side" defaultSize="26" minSize={280} maxSize="45">
                  <SidePanel pr={pr} snapshot={snapshot} />
                </Panel>
              </>
            )}
          </Group>
        </div>
        {right.length > 0 && <ActivityBar label="Side panels" edge="right" items={right} />}
      </div>
    </>
  );
}
