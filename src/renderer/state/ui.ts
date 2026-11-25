import { create } from 'zustand';
import type { CodeSearchQuery } from '../../shared/model';
import { hasUnsavedText, unsentKey, type ComposerTarget } from './unsent';
import { moveToSlot } from './reorder';

export type PrViewKind = 'overview' | 'files' | 'commits';
export type ContentTab = { id: 'changes'; kind: 'changes' } | { id: string; kind: 'file'; path: string; preview: boolean; changed: boolean };

export type { ComposerTarget } from './unsent';

export interface PrUi {
  view: PrViewKind | null;
  tree: 'changed' | 'all';
  layout: 'split' | 'unified';
  showTree: boolean;
  showPanel: boolean;
  scope: 'pr' | 'file';
  filter: 'open' | 'mine' | 'reply' | 'outdated' | 'resolved' | 'all';
  contentTabs: ContentTab[];
  activeContent: string;
  composer: ComposerTarget | null;
  /** Something tried to close or replace an editor with unsaved text: it asks first, then goes on to `next`. */
  composerPrompt: { next: ComposerTarget | null } | null;
  focusPath: string | null;
  focusThread: string | null;
  /** Bumped by every jump, so selecting the same file again scrolls back to it. */
  focusSeq: number;
  collapsed: Record<string, boolean>;
  openComments: Record<string, boolean>;
  showSubmit: boolean;
  showVersions: boolean;
  /** The label of a comparison being switched to, until its file list arrives. */
  pendingCompare: string | null;
  /** The left sidebar: the file tree, or Find in files. */
  sidebar: 'files' | 'search';
  search: CodeSearchQuery;
  /** Whether the "files to include / exclude" fields show. */
  searchDetails: boolean;
  /** Bumped by ⌘⇧F, so the search box takes focus again. */
  searchFocusSeq: number;
  /** A line a file tab should show and select (a search result); `seq` repeats a jump to the same line. */
  focusLine: { path: string; line: number; seq: number } | null;
}

const DEFAULT_UI: PrUi = {
  view: null,
  tree: 'changed',
  layout: 'split',
  showTree: true,
  showPanel: true,
  scope: 'pr',
  filter: 'open',
  contentTabs: [{ id: 'changes', kind: 'changes' }],
  activeContent: 'changes',
  composer: null,
  composerPrompt: null,
  focusPath: null,
  focusThread: null,
  focusSeq: 0,
  collapsed: {},
  openComments: {},
  showSubmit: false,
  pendingCompare: null,
  sidebar: 'files',
  search: { pattern: '', matchCase: false, wholeWord: false, regex: false, include: '', exclude: '', scope: 'changed' },
  searchDetails: false,
  searchFocusSeq: 0,
  focusLine: null,
  showVersions: false,
};

interface UiState {
  byKey: Record<string, PrUi>;
}

export const useUiStore = create<UiState>(() => ({ byKey: {} }));

export function usePrUi(key: string): PrUi {
  return useUiStore((s) => s.byKey[key] ?? DEFAULT_UI);
}

export function getPrUi(key: string): PrUi {
  return useUiStore.getState().byKey[key] ?? DEFAULT_UI;
}

export function updateUi(key: string, patch: Partial<PrUi> | ((ui: PrUi) => Partial<PrUi>)): void {
  useUiStore.setState((s) => {
    const cur = s.byKey[key] ?? DEFAULT_UI;
    const next = typeof patch === 'function' ? patch(cur) : patch;
    return { byKey: { ...s.byKey, [key]: { ...cur, ...next } } };
  });
}

export function openFileTab(key: string, path: string, changed: boolean, preview: boolean): void {
  updateUi(key, (ui) => {
    const id = `file:${path}`;
    let tabs = ui.contentTabs;
    if (!tabs.some((t) => t.id === id)) {
      const withoutPreview = preview ? tabs.filter((t) => !(t.kind === 'file' && t.preview)) : tabs;
      tabs = [...withoutPreview, { id, kind: 'file', path, preview, changed }];
    } else if (!preview) {
      tabs = tabs.map((t) => (t.id === id && t.kind === 'file' ? { ...t, preview: false } : t));
    }
    return { contentTabs: tabs, activeContent: id, view: 'files' };
  });
}

/** Closes the given file tabs ("All changes" always stays); if the active tab goes, `fallback` becomes active. */
export function closeContentTabs(key: string, ids: readonly string[], fallback = 'changes'): void {
  updateUi(key, (ui) => {
    const tabs = ui.contentTabs.filter((t) => t.kind === 'changes' || !ids.includes(t.id));
    return { contentTabs: tabs, activeContent: tabs.some((t) => t.id === ui.activeContent) ? ui.activeContent : fallback };
  });
}

/** Opens a file at a line (a search result): its tab (a preview tab unless `pin`), scrolled to the line and selecting it. */
export function openAtLine(key: string, path: string, line: number, changed: boolean, pin: boolean): void {
  openFileTab(key, path, changed, !pin);
  updateUi(key, (ui) => ({ focusLine: { path, line, seq: (ui.focusLine?.seq ?? 0) + 1 } }));
}

/** ⌘⇧F: the Files view with the search sidebar, its box focused (and filled with `seed`, a selected bit of code). */
export function showSearch(key: string, seed?: string): void {
  updateUi(key, (ui) => ({
    view: 'files',
    showTree: true,
    sidebar: 'search',
    searchFocusSeq: ui.searchFocusSeq + 1,
    ...(seed ? { search: { ...ui.search, pattern: seed } } : {}),
  }));
}

/** Drag reorder of the file tabs ("All changes" included). */
export function moveContentTab(key: string, from: number, slot: number): void {
  updateUi(key, (ui) => ({ contentTabs: moveToSlot(ui.contentTabs, from, slot) }));
}

export function closeContentTab(key: string, id: string): void {
  closeContentTabs(key, [id]);
}

/**
 * Opens a comment editor at `next`, or closes it with `null`. If the open editor has text that isn't in the review,
 * nothing changes yet: the editor asks (keep editing, discard, or add it) and then continues to `next`.
 */
export function requestComposer(key: string, next: ComposerTarget | null): void {
  const current = getPrUi(key).composer;
  const same = current && next && unsentKey(key, current) === unsentKey(key, next);
  if (current && !same && hasUnsavedText(key, current)) {
    updateUi(key, { composerPrompt: { next } });
    return;
  }
  updateUi(key, { composer: next, composerPrompt: null });
}

export function focusFile(key: string, path: string, threadId: string | null = null): void {
  updateUi(key, (ui) => ({ activeContent: 'changes', focusPath: path, focusThread: threadId, focusSeq: ui.focusSeq + 1, view: 'files' }));
}

export interface ViewPrefs {
  hideViewed: boolean;
  hideResolved: boolean;
  onlyCommented: boolean;
  wordWrap: boolean;
  /** Find in files results: a flat list of files, or folders like the file tree. */
  searchView: 'list' | 'tree';
}

const DEFAULT_PREFS: ViewPrefs = { hideViewed: false, hideResolved: false, onlyCommented: false, wordWrap: false, searchView: 'list' };

const PREFS_KEY = 'view-prefs';

function loadPrefs(): ViewPrefs {
  try {
    return { ...DEFAULT_PREFS, ...(JSON.parse(localStorage.getItem(PREFS_KEY) ?? '{}') as Partial<ViewPrefs>) };
  } catch {
    return DEFAULT_PREFS;
  }
}

export const usePrefs = create<ViewPrefs>(() => loadPrefs());

export function setPrefs(patch: Partial<ViewPrefs>): void {
  usePrefs.setState(patch);
  try {
    localStorage.setItem(PREFS_KEY, JSON.stringify(usePrefs.getState()));
  } catch {
    return;
  }
}

const SUMMARY_PREFIX = 'summary:';

export function loadSummary(key: string): string {
  try {
    return localStorage.getItem(SUMMARY_PREFIX + key) ?? '';
  } catch {
    return '';
  }
}

export function saveSummary(key: string, text: string): void {
  try {
    localStorage.setItem(SUMMARY_PREFIX + key, text);
  } catch {
    return;
  }
}

export function appendToSummary(key: string, text: string): void {
  const cur = loadSummary(key);
  saveSummary(key, cur.trim() === '' ? text : `${cur.trimEnd()}\n\n${text}`);
}
