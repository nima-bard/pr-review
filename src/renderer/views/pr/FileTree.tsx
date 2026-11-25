import { useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import type { Draft, FileEntry, PrSnapshot, ThreadView } from '../../../shared/model';
import { api } from '../../api';
import { changeColor, changeLetter, commentedPaths, strayThreads, threadsForFile } from '../../diff/FileSection';
import { FileIcon, FolderIcon } from '../../components/fileIcons';
import { showFileMenu } from '../../components/fileMenu';
import { cx, Icon, Segmented } from '../../components/ui';
import { focusFile, openFileTab, setPrefs, updateUi, usePrefs, usePrUi } from '../../state/ui';
import { closestInTree, foldersOf } from './treeOrder';

interface Node {
  name: string;
  path: string;
  dirs: Map<string, Node>;
  files: string[];
}

/** `anc`: the paths of the folder rows above this row, one per depth (a file for comment rows). */
type Row =
  | { kind: 'dir'; path: string; label: string; depth: number; anc: string[]; open: boolean; changed: string[] }
  | { kind: 'file'; path: string; depth: number; anc: string[]; entry: FileEntry | undefined; stray: boolean; threads: ThreadView[]; drafts: Draft[] }
  | { kind: 'comment'; depth: number; anc: string[]; path: string; thread?: ThreadView; draft?: Draft };

const BASE = 8;
const INDENT = 16;

/** Vertical indent guides, one per ancestor, centred under that ancestor's arrow; shown while the tree is hovered. */
function Guides({ depth, active }: { depth: number; active: number }) {
  return Array.from({ length: depth }, (_, i) => (
    <span
      key={i}
      aria-hidden="true"
      className={cx('absolute inset-y-0 w-px opacity-0 group-hover/tree:opacity-100 transition-opacity duration-150', i === active ? 'bg-dim' : 'bg-chip')}
      style={{ left: BASE + i * INDENT + 7.5 }}
    />
  ));
}

const VIEWED_BOX = 'w-[13px] h-[13px] m-0 flex-none cursor-pointer';

function buildTree(paths: readonly string[]): Node {
  const root: Node = { name: '', path: '', dirs: new Map(), files: [] };
  for (const p of paths) {
    const parts = p.split('/');
    let node = root;
    for (const part of parts.slice(0, -1)) {
      let child = node.dirs.get(part);
      if (!child) {
        child = { name: part, path: node.path ? `${node.path}/${part}` : part, dirs: new Map(), files: [] };
        node.dirs.set(part, child);
      }
      node = child;
    }
    node.files.push(p);
  }
  return root;
}

const allFilesCache = new Map<string, Promise<string[]>>();

function useAllFiles(snapshot: PrSnapshot, enabled: boolean): string[] | null {
  const [paths, setPaths] = useState<string[] | null>(null);
  useEffect(() => {
    if (!enabled) return;
    const k = `${snapshot.key}@${snapshot.details.headRefOid}`;
    let p = allFilesCache.get(k);
    if (!p) {
      p = api.listAllFiles(snapshot.key);
      allFilesCache.set(k, p);
    }
    let alive = true;
    void p.then((list) => alive && setPaths(list));
    return () => {
      alive = false;
    };
  }, [snapshot.key, snapshot.details.headRefOid, enabled]);
  return paths;
}

function commentTone(t: ThreadView | undefined, d: Draft | undefined): string {
  if (d) return 'var(--c-accent)';
  if (!t) return 'var(--c-soft)';
  if (t.isResolved) return 'var(--c-add)';
  if (t.anchor.tier === 'orphan') return 'var(--c-dim)';
  if (t.isOutdated) return 'var(--c-warn)';
  return 'var(--c-soft)';
}

function ToggleChip({ label, on, onChange }: { label: string; on: boolean; onChange(v: boolean): void }) {
  return (
    <button
      type="button"
      aria-pressed={on}
      onClick={() => onChange(!on)}
      className={cx('h-[24px] px-2.5 rounded-full border text-[11.5px] cursor-pointer', on ? 'bg-chip-on border-chip-on-line text-fg font-semibold' : 'border-line-2 text-soft')}
    >
      {on ? '✓ ' : ''}
      {label}
    </button>
  );
}

export function FileTree({ snapshot }: { snapshot: PrSnapshot }) {
  const key = snapshot.key;
  const ui = usePrUi(key);
  const prefs = usePrefs();
  const [filter, setFilter] = useState('');
  /** Folders the user opened or closed by hand; the rest follow the default (see `open` below). */
  const [dirOverrides, setDirOverrides] = useState<Record<string, boolean>>({});
  const allPaths = useAllFiles(snapshot, ui.tree === 'all');
  const entries = useMemo(() => new Map(snapshot.files.map((f) => [f.path, f])), [snapshot.files]);
  const activeTab = ui.contentTabs.find((t) => t.id === ui.activeContent);
  const activePath = activeTab?.kind === 'file' ? activeTab.path : ui.focusPath;

  const q = filter.trim().toLowerCase();
  /** The files the tree lists (folders open or not), and the ones that left the PR but still carry comments. */
  const { paths, strayPaths } = useMemo(() => {
    // Files that left the PR but still carry comments stay in the tree, where they used to be.
    const strayPaths = new Set(strayThreads(snapshot).filter((t) => !(prefs.hideResolved && t.isResolved)).map((t) => t.anchor.path));
    const base = ui.tree === 'all' && allPaths ? allPaths : snapshot.files.map((f) => f.path);
    const source = [...base, ...[...strayPaths].filter((p) => !base.includes(p))];
    const commented = prefs.onlyCommented ? commentedPaths(snapshot, prefs.hideResolved) : null;
    const visible = source.filter((p) => !(prefs.hideViewed && entries.get(p)?.viewed === 'VIEWED') && (!commented || commented.has(p)));
    return { paths: q ? visible.filter((p) => p.toLowerCase().includes(q)) : visible, strayPaths };
  }, [ui.tree, allPaths, snapshot, q, entries, prefs.hideViewed, prefs.hideResolved, prefs.onlyCommented]);

  const rows = useMemo(() => {
    const changedPaths = new Set(snapshot.files.map((f) => f.path));
    const out: Row[] = [];
    const walk = (node: Node, anc: string[]) => {
      const depth = anc.length;
      for (const child of [...node.dirs.values()].sort((a, b) => a.name.localeCompare(b.name))) {
        let label = child.name;
        let cur = child;
        while (cur.dirs.size === 1 && cur.files.length === 0) {
          const next = [...cur.dirs.values()][0]!;
          label = `${label}/${next.name}`;
          cur = next;
        }
        const changed = [...changedPaths].filter((p) => p.startsWith(`${cur.path}/`));
        // All files: only folders with changes start open, so the PR's files stay easy to find.
        const open = q !== '' || (dirOverrides[cur.path] ?? (ui.tree === 'changed' || changed.length > 0));
        out.push({ kind: 'dir', path: cur.path, label, depth, anc, open, changed });
        if (open) walk(cur, [...anc, cur.path]);
      }
      for (const path of [...node.files].sort((a, b) => a.localeCompare(b))) {
        const threads = threadsForFile(snapshot, path).filter((t) => !(prefs.hideResolved && t.isResolved));
        const drafts = snapshot.drafts.filter((d) => d.path === path);
        out.push({ kind: 'file', path, depth, anc, entry: entries.get(path), stray: strayPaths.has(path), threads, drafts });
        const showComments = ui.openComments[path] ?? true;
        if (showComments) {
          const under = [...anc, path];
          for (const t of threads) out.push({ kind: 'comment', depth: depth + 1, anc: under, path, thread: t });
          for (const d of drafts) out.push({ kind: 'comment', depth: depth + 1, anc: under, path, draft: d });
        }
      }
    };
    walk(buildTree(paths), []);
    return out;
  }, [ui.tree, paths, strayPaths, snapshot, q, dirOverrides, entries, ui.openComments, prefs.hideResolved]);

  // Switching between Changed and All files keeps the open file in view: its folders open and it scrolls into the
  // middle. If it isn't listed (an unchanged file, going to Changed), the closest listed file is shown and flashed.
  const list = useRef<HTMLDivElement>(null);
  const shownTree = useRef(ui.tree);
  const revealPending = useRef(false);
  const [reveal, setReveal] = useState<{ path: string; near: boolean } | null>(null);
  const [flash, setFlash] = useState<string | null>(null);
  useLayoutEffect(() => {
    if (shownTree.current !== ui.tree) {
      shownTree.current = ui.tree;
      revealPending.current = true;
    }
    if (!revealPending.current || (ui.tree === 'all' && !allPaths)) return;
    revealPending.current = false;
    const target = activePath ? closestInTree(activePath, paths) : null;
    if (!target) return;
    setDirOverrides((o) => ({ ...o, ...Object.fromEntries(foldersOf(target).map((d) => [d, true])) }));
    setReveal({ path: target, near: target !== activePath });
  }, [ui.tree, allPaths, paths, activePath]);
  useLayoutEffect(() => {
    const box = list.current;
    const row = reveal && box?.querySelector<HTMLElement>(`[data-tree-file="${CSS.escape(reveal.path)}"]`);
    if (!reveal || !box || !row) return;
    setReveal(null);
    const top = row.getBoundingClientRect().top - box.getBoundingClientRect().top;
    if (top < 0 || top + row.offsetHeight > box.clientHeight) box.scrollTop += top - (box.clientHeight - row.offsetHeight) / 2;
    if (reveal.near) setFlash(reveal.path);
  }, [reveal, rows]);
  useEffect(() => {
    if (!flash) return;
    const timer = setTimeout(() => setFlash(null), 1500);
    return () => clearTimeout(timer);
  }, [flash]);

  const viewedCount = snapshot.files.filter((f) => f.viewed === 'VIEWED').length;
  const toggleDir = (path: string, open: boolean) => setDirOverrides((o) => ({ ...o, [path]: !open }));

  const activeRow = rows.find((r) => r.kind === 'file' && r.path === activePath);
  const activeDir = activeRow && activeRow.anc.length > 0 ? { depth: activeRow.anc.length - 1, path: activeRow.anc[activeRow.anc.length - 1]! } : null;
  const activeGuide = (r: Row) => (activeDir && r.anc[activeDir.depth] === activeDir.path ? activeDir.depth : -1);

  return (
    <nav aria-label="Files" className="h-full flex flex-col bg-side">
      <div className="px-2.5 pt-2.5 flex flex-col gap-2">
        <Segmented
          stretch
          label="File tree scope"
          value={ui.tree}
          onChange={(v) => updateUi(key, { tree: v })}
          options={[
            { value: 'changed', label: `Changed · ${snapshot.files.length}` },
            { value: 'all', label: 'All files' },
          ]}
        />
        <label className="relative">
          <span className="sr-only">Filter files</span>
          <span className="absolute left-2.5 top-[9px] text-faint">
            <Icon name="search" size={13} />
          </span>
          <input
            value={filter}
            onChange={(e) => setFilter(e.target.value)}
            placeholder="Filter files"
            className="w-full h-[31px] pl-8 pr-2.5 rounded-[7px] bg-raised border border-line-2 focus:border-accent outline-none text-[12.5px]"
          />
        </label>
        <div className="flex flex-wrap gap-1.5">
          <ToggleChip label="Hide viewed" on={prefs.hideViewed} onChange={(v) => setPrefs({ hideViewed: v })} />
          <ToggleChip label="Hide resolved" on={prefs.hideResolved} onChange={(v) => setPrefs({ hideResolved: v })} />
          <ToggleChip label="Hide without comments" on={prefs.onlyCommented} onChange={(v) => setPrefs({ onlyCommented: v })} />
        </div>
        <div className="flex items-center gap-2 text-muted text-[12px]">
          <span>
            {viewedCount} of {snapshot.files.length} viewed
          </span>
          <span aria-hidden="true" className="flex-1 h-1 rounded bg-line overflow-hidden">
            <span className="block h-1 bg-accent" style={{ width: `${snapshot.files.length ? (100 * viewedCount) / snapshot.files.length : 0}%` }} />
          </span>
        </div>
      </div>
      <div ref={list} className="group/tree flex-1 overflow-y-auto mt-2 pb-3">
        {ui.tree === 'all' && !allPaths && <div className="px-3 text-muted">Loading files…</div>}
        {rows.map((r) => {
          const indent = { paddingLeft: BASE + r.depth * INDENT };
          const guides = <Guides depth={r.depth} active={activeGuide(r)} />;
          if (r.kind === 'dir') {
            const viewable = r.changed.filter((p) => entries.has(p));
            const allViewed = viewable.length > 0 && viewable.every((p) => entries.get(p)?.viewed === 'VIEWED');
            return (
              <div key={`d:${r.path}`} className="relative flex items-center gap-2 h-6 pr-2.5 text-[12.5px] hover:bg-hover" style={indent}>
                {guides}
                <button type="button" aria-expanded={r.open} onClick={() => toggleDir(r.path, r.open)} className="flex items-center min-w-0 flex-1 h-full text-left cursor-pointer">
                  <span className="grid place-items-center w-4 flex-none text-muted">
                    <Icon name="chevron" size={12} rotate={r.open ? 0 : -90} />
                  </span>
                  <FolderIcon path={r.path} open={r.open} />
                  <span className="ml-1.5 truncate text-fg">{r.label}</span>
                  {ui.tree === 'all' && r.changed.length > 0 && <span aria-label="contains changes" className="ml-1.5 w-1.5 h-1.5 rounded-full bg-accent flex-none" />}
                </button>
                {viewable.length > 0 && (
                  <input
                    type="checkbox"
                    aria-label={`Mark all files in ${r.label} as viewed`}
                    checked={allViewed}
                    onChange={() => void api.setViewed(key, viewable, !allViewed)}
                    className={VIEWED_BOX}
                    style={{ accentColor: 'var(--c-accent)' }}
                  />
                )}
              </div>
            );
          }
          if (r.kind === 'file') {
            const e = r.entry;
            const count = r.threads.length + r.drafts.length;
            const open = ui.openComments[r.path] ?? true;
            const active = activePath === r.path;
            return (
              <div
                key={`f:${r.path}`}
                data-tree-file={r.path}
                onContextMenu={(e) => {
                  e.preventDefault();
                  void showFileMenu(snapshot, r.path);
                }}
                className={cx('relative flex items-center gap-2 h-6 pr-2.5 text-[12.5px] transition-colors duration-500', active || flash === r.path ? 'bg-active' : 'hover:bg-hover')}
                style={indent}
              >
                {guides}
                <span className="flex items-center min-w-0 flex-1 h-full">
                  {count > 0 ? (
                    <button
                      type="button"
                      aria-label={`${open ? 'Hide' : 'Show'} comments on ${r.path}`}
                      aria-expanded={open}
                      onClick={() => updateUi(key, (u) => ({ openComments: { ...u.openComments, [r.path]: !open } }))}
                      className="grid place-items-center w-4 h-full flex-none text-muted cursor-pointer"
                    >
                      <Icon name="chevron" size={12} rotate={open ? 0 : -90} />
                    </button>
                  ) : (
                    <span aria-hidden="true" className="w-4 flex-none" />
                  )}
                  <button
                    type="button"
                    // ⌘-click: the file in its own (kept) tab; a click shows a changed file in All changes, any other in a preview tab.
                    onClick={(ev) => (ev.metaKey ? openFileTab(key, r.path, !!e, false) : e || r.stray ? focusFile(key, r.path) : openFileTab(key, r.path, false, true))}
                    title={`${r.path} (⌘-click to open in a tab)`}
                    onDoubleClick={() => openFileTab(key, r.path, !!e, false)}
                    className="flex items-center min-w-0 flex-1 h-full text-left cursor-pointer"
                  >
                    <span className={cx('flex-none', e?.change === 'deleted' && 'opacity-50')}>
                      <FileIcon path={r.path} />
                    </span>
                    {/* Deleted files read like VS Code's: red name with a red strikethrough. */}
                    <span
                      className={cx(
                        'ml-1.5 truncate',
                        active && 'font-semibold',
                        // One colour class per state, so stylesheet order can't pick the wrong one.
                        e?.change === 'deleted' ? 'text-del line-through decoration-del decoration-[1.5px]' : r.stray ? 'text-muted italic' : active ? 'text-strong' : e ? 'text-fg' : 'text-muted',
                      )}
                    >
                      {r.path.split('/').pop()}
                    </span>
                  </button>
                </span>
                {r.stray && (
                  <span title="This file is no longer part of the PR; its comments couldn't be placed in the current code." className="px-1 rounded bg-chip text-soft text-[10.5px] font-semibold flex-none">
                    not in PR
                  </span>
                )}
                {e?.viewed === 'DISMISSED' && <span className="px-1 rounded bg-warn-bg text-warn text-[10.5px] font-semibold flex-none">new</span>}
                {count > 0 && (
                  <span className={cx('inline-flex items-center gap-0.5 text-[11.5px] flex-none', r.threads.some((t) => t.isOutdated && !t.isResolved) ? 'text-warn' : 'text-muted')}>
                    <Icon name="comment" size={12} />
                    {count}
                  </span>
                )}
                {e && (
                  <>
                    <span className="font-mono text-[11px] flex-none">
                      <span className="text-add">+{e.additions}</span> <span className="text-del">−{e.deletions}</span>
                    </span>
                    <span className="w-3 text-center font-mono text-[11px] font-semibold flex-none" style={{ color: changeColor(e.change) }} title={e.change}>
                      {changeLetter(e.change)}
                    </span>
                    <input
                      type="checkbox"
                      aria-label={`Mark ${r.path} as viewed`}
                      checked={e.viewed === 'VIEWED'}
                      onChange={() => void api.setViewed(key, [r.path], e.viewed !== 'VIEWED')}
                      className={VIEWED_BOX}
                      style={{ accentColor: 'var(--c-accent)' }}
                    />
                  </>
                )}
              </div>
            );
          }
          const t = r.thread;
          const d = r.draft;
          const first = t?.comments[0];
          const line = t ? (t.fileLevel ? 'file' : t.anchor.line !== undefined ? `L${t.anchor.line}` : '—') : `L${d!.line}`;
          const tag = d
            ? 'draft'
            : t?.isResolved
              ? 'resolved'
              : t?.anchor.tier === 'orphan' && !t.fileLevel && t.isOutdated
                ? 'lost'
                : t?.isOutdated && t.anchor.score !== undefined
                  ? `≈${Math.round(t.anchor.score * 100)}%`
                  : null;
          return (
            <button
              type="button"
              key={`c:${t?.id ?? d!.id}`}
              onClick={() => focusFile(key, r.path, t?.id ?? null)}
              aria-label={`Go to comment by ${first?.author ?? 'you'} at ${line}`}
              className="relative flex items-center gap-1.5 w-full h-[22px] pr-2.5 text-left cursor-pointer hover:bg-hover"
              style={indent}
            >
              {guides}
              <span className="grid place-items-center w-4 flex-none">
                <span aria-hidden="true" className="w-1.5 h-1.5 rounded-full" style={{ background: commentTone(t, d) }} />
              </span>
              <span className="font-mono text-[10.5px] text-muted min-w-[26px] flex-none">{line}</span>
              <span className={cx('flex-1 min-w-0 truncate text-[12px]', t?.isResolved ? 'text-muted' : 'text-fg')}>
                <span className="font-semibold text-strong">{first?.author ?? snapshot.viewer}</span> {(first?.body ?? d?.body ?? '').split('\n')[0]}
              </span>
              {tag && (
                <span className={cx('px-1 rounded text-[10px] font-semibold flex-none', tag === 'draft' ? 'bg-info-bg text-info' : tag === 'lost' || tag === 'resolved' ? 'bg-chip text-soft' : 'bg-warn-bg text-warn')}>{tag}</span>
              )}
              {t && t.comments.length > 1 && (
                <span className="inline-flex items-center gap-0.5 text-[11px] text-muted flex-none">
                  <Icon name="comment" size={11} />
                  {t.comments.length}
                </span>
              )}
            </button>
          );
        })}
      </div>
    </nav>
  );
}
