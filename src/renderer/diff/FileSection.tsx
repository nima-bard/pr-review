import { FileDiff } from '@pierre/diffs/react';
import type { DiffLineAnnotation, FileDiffMetadata, SelectedLineRange } from '@pierre/diffs';
import { memo, useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import type { AgentTurn, DiffSide, Draft, FileEntry, PrSnapshot, ThreadView } from '../../shared/model';
import { api } from '../api';
import { Badge, Button, cx, Icon, Spinner } from '../components/ui';
import { openFileTab, requestComposer, updateUi, usePrefs, usePrUi, type ComposerTarget } from '../state/ui';
import { unsentKey } from '../state/unsent';
import { FileIcon } from '../components/fileIcons';
import { showFileMenu } from '../components/fileMenu';
import { Octicon } from '../components/octicons';
import { useDiffAppearance } from '../state/settings';
import { Composer, DraftCard } from './Composer';
import { AskCard } from './AskCard';
import { useAgentSession } from '../state/sessions';
import { ThreadCard } from './ThreadCard';
import { loadFile, useFileDiff } from './useFileDiff';
import { useFocusLine } from './useFocusLine';

type Meta = { kind: 'thread'; thread: ThreadView } | { kind: 'draft'; draft: Draft } | { kind: 'composer'; target: ComposerTarget } | { kind: 'ask'; turn: AgentTurn };

const CHANGE_LETTER: Record<FileEntry['change'], string> = { added: 'A', modified: 'M', deleted: 'D', renamed: 'R', copied: 'C' };
export const changeColor = (c: FileEntry['change']) => (c === 'added' ? 'var(--c-add)' : c === 'deleted' ? 'var(--c-del)' : c === 'renamed' ? 'var(--c-info)' : 'var(--c-mod)');
export const changeLetter = (c: FileEntry['change']) => CHANGE_LETTER[c];

const toPierreSide = (s: DiffSide) => (s === 'LEFT' ? 'deletions' : 'additions');

export function threadsForFile(snapshot: PrSnapshot, path: string): ThreadView[] {
  return snapshot.threads.filter((t) => t.anchor.path === path || (t.anchor.line === undefined && t.path === path));
}

/**
 * Threads whose file is no longer part of the PR (deleted, renamed or split away) and whose line couldn't be followed
 * into the current code. No file section shows them, so All changes and the tree list them separately.
 */
export function strayThreads(snapshot: PrSnapshot): ThreadView[] {
  const files = new Set(snapshot.files.map((f) => f.path));
  return snapshot.threads.filter((t) => !files.has(t.anchor.path) && !(t.anchor.line === undefined && files.has(t.path)));
}

/** Paths that have a draft or a comment thread (unresolved only when `hideResolved`), matching `threadsForFile`. */
export function commentedPaths(snapshot: PrSnapshot, hideResolved: boolean): Set<string> {
  const out = new Set(snapshot.drafts.map((d) => d.path));
  for (const t of snapshot.threads) {
    if (hideResolved && t.isResolved) continue;
    out.add(t.anchor.path);
    if (t.anchor.line === undefined) out.add(t.path);
  }
  return out;
}

function useVisible(rootMargin = '1200px'): [React.RefObject<HTMLDivElement | null>, boolean] {
  const ref = useRef<HTMLDivElement | null>(null);
  const [visible, setVisible] = useState(false);
  useEffect(() => {
    const el = ref.current;
    if (!el || visible) return;
    const io = new IntersectionObserver((entries) => {
      if (entries.some((e) => e.isIntersecting)) {
        setVisible(true);
        io.disconnect();
      }
    }, { rootMargin });
    io.observe(el);
    return () => io.disconnect();
  }, [visible, rootMargin]);
  return [ref, visible];
}

interface DiffBodyProps {
  snapshot: PrSnapshot;
  file: FileEntry;
  fullFile: boolean;
}

const DiffBody = memo(function DiffBody({ snapshot, file, fullFile }: DiffBodyProps) {
  const key = snapshot.key;
  const ui = usePrUi(key);
  const version = `${snapshot.details.headRefOid}:${snapshot.mergeBase}`;
  const { data, error, loading } = useFileDiff(key, version, file.path, true, snapshot.compare === null);
  const hideResolved = usePrefs((p) => p.hideResolved);
  const wordWrap = usePrefs((p) => p.wordWrap);
  const threads = useMemo(
    () => threadsForFile(snapshot, file.path).filter((t) => !(hideResolved && t.isResolved && t.id !== ui.focusThread)),
    [snapshot, file.path, hideResolved, ui.focusThread],
  );
  const drafts = useMemo(() => snapshot.drafts.filter((d) => d.path === file.path), [snapshot.drafts, file.path]);
  const turns = useAgentSession(key)?.turns;
  const asks = useMemo(() => (turns ?? []).filter((t) => t.request.kind === 'lines' && t.request.target?.path === file.path && !t.markerHidden), [turns, file.path]);
  const [selection, setSelection] = useState<SelectedLineRange | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  // Pierre keeps the "+" on the selected lines, so drop the selection once the comment editor closes (saved or discarded).
  const composerOpen = ui.composer !== null;
  useEffect(() => {
    if (!composerOpen) setSelection(null);
  }, [composerOpen]);
  /** A click in the code (not the line-number gutter) clears the line selection, and with it the "+". */
  // In a file tab, a search result's line is selected and scrolled to.
  const body = useRef<HTMLDivElement>(null);
  useFocusLine(key, file.path, body, fullFile, (line) => setSelection({ start: line, end: line, side: 'additions' }));
  const clearSelectionOnCodeClick = useCallback((e: React.MouseEvent) => {
    const path = e.nativeEvent.composedPath().filter((n): n is Element => n instanceof Element);
    if (path.some((el) => el.hasAttribute('data-line')) && !path.some((el) => el.hasAttribute('data-column-number') || el.hasAttribute('data-gutter-buffer'))) setSelection(null);
  }, []);

  const commentable = data?.model.commentable;
  const placeable = useCallback(
    (side: DiffSide, line: number | undefined) => line !== undefined && !!commentable && commentable[side].includes(line),
    [commentable],
  );

  const { annotations, outside } = useMemo(() => {
    const annotations: DiffLineAnnotation<Meta>[] = [];
    const outside: ThreadView[] = [];
    for (const t of threads) {
      const line = t.anchor.endLine ?? t.anchor.line;
      if (!t.fileLevel && line !== undefined && (fullFile || placeable(t.side, line))) {
        annotations.push({ side: toPierreSide(t.side), lineNumber: line, metadata: { kind: 'thread', thread: t } });
      } else {
        outside.push(t);
      }
    }
    for (const d of drafts) {
      if (ui.composer?.draftId === d.id) continue;
      annotations.push({ side: toPierreSide(d.side), lineNumber: d.line, metadata: { kind: 'draft', draft: d } });
    }
    for (const t of asks) {
      const target = t.request.target!;
      if (fullFile || placeable(target.side, target.endLine)) annotations.push({ side: toPierreSide(target.side), lineNumber: target.endLine, metadata: { kind: 'ask', turn: t } });
    }
    if (ui.composer && ui.composer.path === file.path) {
      annotations.push({ side: toPierreSide(ui.composer.side), lineNumber: ui.composer.endLine, metadata: { kind: 'composer', target: ui.composer } });
    }
    return { annotations, outside };
  }, [threads, drafts, asks, ui.composer, file.path, placeable, fullFile]);

  const startComment = useCallback(
    (range: SelectedLineRange) => {
      const side: DiffSide = range.side === 'deletions' ? 'LEFT' : 'RIGHT';
      const a = Math.min(range.start, range.end);
      const b = Math.max(range.start, range.end);
      if (!placeable(side, a) || !placeable(side, b)) {
        setNotice('GitHub only accepts comments on lines shown in the diff (changed lines and 3 lines of context).');
        return;
      }
      setNotice(null);
      requestComposer(key, { path: file.path, side, startLine: a, endLine: b });
    },
    [key, file.path, placeable],
  );

  const loadDiffFiles = useCallback(
    async (fd: FileDiffMetadata) => {
      const [oldFile, newFile] = await Promise.all([
        loadFile(key, version, 'base', fd.prevName ?? file.oldPath ?? file.path),
        loadFile(key, version, 'head', file.path),
      ]);
      return { oldFile: { name: fd.prevName ?? fd.name, contents: oldFile.contents }, newFile: { name: fd.name, contents: newFile.contents } };
    },
    [key, version, file.path, file.oldPath],
  );

  const renderAnnotation = useCallback(
    (a: DiffLineAnnotation<Meta>): ReactNode => {
      const m = a.metadata;
      return (
        <div className="py-2.5 pr-4 pl-3 bg-inset border-y border-line">
          {m.kind === 'thread' && <ThreadCard snapshot={snapshot} thread={m.thread} focused={ui.focusThread === m.thread.id} />}
          {m.kind === 'draft' && <DraftCard snapshot={snapshot} draft={m.draft} />}
          {m.kind === 'ask' && <AskCard snapshot={snapshot} turn={m.turn} />}
          {/* Keyed per line, so opening another line gets a fresh editor instead of reusing this one's text. */}
          {m.kind === 'composer' && <Composer key={unsentKey(key, m.target)} snapshot={snapshot} target={m.target} />}
        </div>
      );
    },
    [snapshot, ui.focusThread],
  );

  const appearance = useDiffAppearance();
  const options = useMemo(
    () => ({
      diffStyle: ui.layout,
      ...appearance,
      disableFileHeader: true,
      enableGutterUtility: true,
      onGutterUtilityClick: (range: SelectedLineRange) => {
        if (selection && selection.side === range.side && range.start >= Math.min(selection.start, selection.end) && range.start <= Math.max(selection.start, selection.end)) {
          startComment(selection);
        } else {
          startComment(range);
        }
      },
      enableLineSelection: true,
      onLineSelected: (range: SelectedLineRange | null) => setSelection(range),
      loadDiffFiles,
      expandUnchanged: fullFile,
      expansionLineCount: 20,
      // Gaps of up to 3 unchanged lines are shown instead of a "3 unmodified lines" bar.
      collapsedContextThreshold: 3,
      overflow: wordWrap ? ('wrap' as const) : ('scroll' as const),
    }),
    [ui.layout, appearance, startComment, selection, loadDiffFiles, fullFile, wordWrap],
  );

  if (loading && !data) return <div className="px-4 py-3"><Spinner label="Loading diff…" /></div>;
  if (error) return <div className="px-4 py-3 text-del">{error}</div>;
  return (
    <div ref={body} onClick={clearSelectionOnCodeClick}>
      {outside.length > 0 && (
        <div className="flex flex-col gap-2 px-3 py-2.5 bg-inset border-b border-line">
          <div className="text-[11.5px] text-muted">Comments not on a line shown in this diff</div>
          {outside.map((t) => (
            <ThreadCard key={t.id} snapshot={snapshot} thread={t} focused={ui.focusThread === t.id} />
          ))}
        </div>
      )}
      {notice && <div className="px-3 py-1.5 text-[12px] text-warn bg-warn-bg">{notice}</div>}
      {data?.model.binary ? (
        <div className="px-4 py-3 text-muted">Binary file not shown.</div>
      ) : !data?.meta ? (
        <div className="px-4 py-3 text-muted">{file.change === 'renamed' ? 'File renamed without changes.' : 'No textual changes.'}</div>
      ) : (
        <FileDiff<Meta> fileDiff={data.meta} options={options} lineAnnotations={annotations} renderAnnotation={renderAnnotation} selectedLines={selection} />
      )}
    </div>
  );
});

/** Grey bars in the shape of code behind the "Load diff" prompt, like github.com. */
const SKELETON: [indent: number, ...widths: number[]][] = [
  [0, 64, 136],
  [18, 136, 168],
  [18, 98, 52, 70],
  [0, 36],
];

function DeletedPlaceholder({ deletions, onLoad }: { deletions: number; onLoad(): void }) {
  return (
    <div className="relative h-[124px] overflow-hidden rounded-b-[9px]">
      <div aria-hidden="true" className="absolute inset-0 flex flex-col gap-3 px-4 py-4">
        {SKELETON.map(([indent, ...widths], i) => (
          <div key={i} className="flex gap-2" style={{ paddingLeft: indent }}>
            {widths.map((w, j) => (
              <span key={j} className="h-[11px] rounded bg-subtle" style={{ width: w }} />
            ))}
          </div>
        ))}
      </div>
      <div className="relative h-full flex flex-col items-center justify-center gap-1">
        <button type="button" onClick={onLoad} className="text-link text-[14px] font-semibold hover:underline cursor-pointer">
          Load diff
        </button>
        <span className="text-muted text-[13px]">
          This file was deleted{deletions > 0 ? ` (${deletions} line${deletions === 1 ? '' : 's'})` : ''}.
        </span>
      </div>
    </div>
  );
}

export function FileSection({ snapshot, file, threadCount }: { snapshot: PrSnapshot; file: FileEntry; threadCount: number }) {
  const key = snapshot.key;
  const ui = usePrUi(key);
  const defaultCollapsed = file.viewed === 'VIEWED' || file.generated;
  const collapsed = ui.collapsed[file.path] ?? defaultCollapsed;
  const [ref, visible] = useVisible();
  const viewed = file.viewed === 'VIEWED';
  const toggleCollapsed = () => updateUi(key, (u) => ({ collapsed: { ...u.collapsed, [file.path]: !collapsed } }));
  const dir = file.path.includes('/') ? file.path.slice(0, file.path.lastIndexOf('/') + 1) : '';
  const name = file.path.slice(dir.length);
  // Like github.com, a deleted file's old contents load on request, unless comments or drafts sit on it.
  const [loadDeleted, setLoadDeleted] = useState(false);
  const hasComments = threadCount > 0 || snapshot.drafts.some((d) => d.path === file.path);
  const deletedPlaceholder = file.change === 'deleted' && !loadDeleted && !hasComments;

  return (
    <section ref={ref} id={`file-${file.path}`} aria-label={file.path} className="border border-line-2 rounded-[9px] bg-panel overflow-clip">
      {/* Square on purpose: the section's clip rounds it at rest; rounded corners of its own let scrolled code show through while it's pinned. */}
      <div className={cx('sticky top-0 z-10 flex flex-wrap items-center gap-x-2.5 gap-y-1 px-3 py-2 bg-subtle', !collapsed && 'border-b border-line-2')}>
        <button type="button" aria-label={collapsed ? `Expand ${file.path}` : `Collapse ${file.path}`} onClick={toggleCollapsed} className="grid place-items-center w-[22px] h-[22px] rounded text-muted hover:text-fg cursor-pointer">
          <Icon name="chevron" size={13} rotate={collapsed ? -90 : 0} />
        </button>
        <span className="font-mono text-[11px] font-semibold" style={{ color: changeColor(file.change) }}>
          {changeLetter(file.change)}
        </span>
        <FileIcon path={file.path} />
        {/* ⌘-click the name: the whole file in its own tab. */}
        <span
          className="font-mono text-[12.5px] text-muted min-w-0 truncate"
          title={`${file.path} (⌘-click to open in a tab)`}
          onClick={(e) => e.metaKey && openFileTab(key, file.path, true, false)}
        >
          {file.oldPath && file.oldPath !== file.path && <span className="text-faint">{file.oldPath} → </span>}
          {dir}
          <strong className="text-strong font-semibold">{name}</strong>
        </span>
        <span className="font-mono text-[11.5px]">
          <span className="text-add">+{file.additions}</span> <span className="text-del">−{file.deletions}</span>
        </span>
        {file.generated && <Badge>Generated</Badge>}
        {file.viewed === 'DISMISSED' && <Badge tone="warn">Changed since viewed</Badge>}
        <span className="flex-1" />
        {threadCount > 0 && <span className="text-muted text-[12px]">{threadCount} threads</span>}
        <button
          type="button"
          aria-label={`Actions for ${file.path}`}
          title="Show whole file, open in editor, view on GitHub, copy path…"
          onClick={() => void showFileMenu(snapshot, file.path)}
          className="grid place-items-center w-[26px] h-[26px] rounded-md border border-line-2 bg-raised-2 text-muted hover:text-fg cursor-pointer"
        >
          <Octicon name="kebab-horizontal" size={14} />
        </button>
        <label className={cx('flex items-center gap-1.5 h-[26px] px-2.5 rounded-md border text-[12px] cursor-pointer', viewed ? 'bg-info-bg border-info-line' : 'bg-raised-2 border-line-2')}>
          <input
            type="checkbox"
            checked={viewed}
            onChange={() => {
              void api.setViewed(key, [file.path], !viewed);
              updateUi(key, (u) => ({ collapsed: { ...u.collapsed, [file.path]: !viewed } }));
            }}
            style={{ accentColor: 'var(--c-accent)' }}
          />
          Viewed
        </label>
      </div>
      {!collapsed && visible && (deletedPlaceholder ? <DeletedPlaceholder deletions={file.deletions} onLoad={() => setLoadDeleted(true)} /> : <DiffBody snapshot={snapshot} file={file} fullFile={false} />)}
      {!collapsed && !visible && <div className="h-40" />}
    </section>
  );
}

export function FullFileDiff({ snapshot, file }: { snapshot: PrSnapshot; file: FileEntry }) {
  return (
    <div className="border border-line-2 rounded-[9px] bg-panel overflow-hidden">
      <DiffBody snapshot={snapshot} file={file} fullFile />
    </div>
  );
}
