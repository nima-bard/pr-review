import { useMemo } from 'react';
import type { PrSnapshot, ThreadView } from '../../../shared/model';
import { api } from '../../api';
import { Octicon } from '../../components/octicons';
import { Segmented } from '../../components/ui';
import { ThreadCard } from '../../diff/ThreadCard';
import { updateUi, usePrUi, type PrUi } from '../../state/ui';
import { threadGroup } from './ReviewThreads';
import { treeCompare } from './treeOrder';

type Filter = PrUi['filter'];

/** The three github.com filters as a switch; the rest live behind the filter button. */
const PRIMARY: Filter[] = ['all', 'open', 'mine'];

const FILTERS: Record<Filter, { label: string; match(t: ThreadView, s: PrSnapshot): boolean }> = {
  all: { label: 'All', match: () => true },
  open: { label: 'Unresolved', match: (t) => !t.isResolved },
  mine: { label: 'Mine', match: (t) => t.comments.some((c) => c.viewerDidAuthor) },
  reply: { label: 'Needs my reply', match: (t, s) => threadGroup(t, s.role) === 'needs-reply' },
  outdated: { label: 'Outdated', match: (t) => t.isOutdated && !t.isResolved },
  resolved: { label: 'Resolved', match: (t) => t.isResolved },
};

/** The side panel's comments: the review threads of the whole pull request or the file in view, filtered. */
export function ConversationsPanel({ snapshot }: { snapshot: PrSnapshot }) {
  const key = snapshot.key;
  const ui = usePrUi(key);
  const activeTab = ui.contentTabs.find((t) => t.id === ui.activeContent);
  const currentPath = activeTab?.kind === 'file' ? activeTab.path : ui.focusPath;
  const filter = FILTERS[ui.filter] ?? FILTERS.open;
  const inScope = useMemo(() => snapshot.threads.filter((t) => ui.scope === 'pr' || t.anchor.path === currentPath), [snapshot.threads, ui.scope, currentPath]);
  /** Counts follow the Whole PR / This file scope, so they match the list. */
  const count = (f: Filter) => inScope.filter((t) => FILTERS[f].match(t, snapshot)).length;
  const threads = useMemo(
    () =>
      inScope
        .filter((t) => filter.match(t, snapshot))
        .sort((a, b) => {
          if (a.anchor.path !== b.anchor.path) return a.anchor.path === currentPath ? -1 : b.anchor.path === currentPath ? 1 : treeCompare(a.anchor.path, b.anchor.path);
          return (a.anchor.line ?? 0) - (b.anchor.line ?? 0);
        }),
    [inScope, filter, snapshot, currentPath],
  );
  const prComments = snapshot.conversation.filter((c) => c.kind === 'comment').length;

  const moreFilters = async () => {
    const choice = await api.contextMenu(
      (['reply', 'outdated', 'resolved'] as const).map((f) => ({ id: f, label: `${FILTERS[f].label} (${count(f)})`, enabled: ui.filter !== f })),
    );
    if (choice === 'reply' || choice === 'outdated' || choice === 'resolved') updateUi(key, { filter: choice });
  };

  return (
    <>
      {/* Scope, filter and more filters on one row; it wraps only when the panel is too narrow for them. */}
      <div className="flex flex-wrap items-center gap-2 px-3 pt-2.5">
        <Segmented
          size="sm"
          label="Conversation scope"
          value={ui.scope}
          onChange={(v) => updateUi(key, { scope: v })}
          options={[
            { value: 'pr', label: 'Whole PR' },
            { value: 'file', label: 'This file' },
          ]}
        />
        <Segmented<Filter>
          size="sm"
          label="Conversation filter"
          value={ui.filter}
          onChange={(v) => updateUi(key, { filter: v })}
          options={PRIMARY.map((f) => ({
            value: f,
            label: (
              <>
                {FILTERS[f].label}
                {f !== 'mine' && <span className="px-1.5 rounded-full bg-chip text-[10.5px]">{count(f)}</span>}
              </>
            ),
          }))}
        />
        <span className="flex-1" />
        <button
          type="button"
          aria-label="More filters"
          title="More filters"
          onClick={() => void moreFilters()}
          className="grid place-items-center w-7 h-7 rounded-md border border-line-2 bg-raised text-muted hover:text-fg cursor-pointer"
        >
          <Octicon name="filter" size={14} />
        </button>
      </div>
      {!PRIMARY.includes(ui.filter) && (
        <div className="px-3 pt-2">
          <button type="button" onClick={() => updateUi(key, { filter: 'open' })} className="inline-flex items-center gap-1.5 h-6 pl-2.5 pr-1.5 rounded-full bg-chip-on border border-chip-on-line text-[11.5px] text-fg cursor-pointer">
            {filter.label}
            <Octicon name="x" size={12} />
          </button>
        </div>
      )}
      <div className="flex-1 overflow-y-auto px-3 pt-3 pb-4 space-y-3">
        {threads.map((t) => (
          <ThreadCard key={t.id} snapshot={snapshot} thread={t} variant="panel" focused={ui.focusThread === t.id} />
        ))}
        {threads.length === 0 && (
          <div className="text-muted text-[12.5px] text-center mt-2">{ui.scope === 'file' && !currentPath ? 'Open a file to see its conversations.' : 'No conversations match.'}</div>
        )}
        {ui.scope === 'pr' && prComments > 0 && (
          <button type="button" onClick={() => updateUi(key, { view: 'overview' })} className="mt-1 text-[12px] text-muted hover:text-fg cursor-pointer">
            {prComments} PR-level comment{prComments === 1 ? '' : 's'} on the Overview →
          </button>
        )}
      </div>
    </>
  );
}
