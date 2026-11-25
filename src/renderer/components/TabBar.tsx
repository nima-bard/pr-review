import { useWaitingCount } from '../state/inbox';
import { useSessions } from '../state/sessions';
import { activate, closeTab, moveTab, newTab, popOutKey, popOutTab, useTabs, type Tab } from '../state/tabs';
import { Avatar, cx, Icon } from './ui';
import { MARKER_CLASS, useTabReorder } from './useTabReorder';

/** "owner/repo" from a PR key like "github.com/owner/repo#12". */
const repoOfKey = (key: string) => /([^/]+\/[^/]+)#\d+$/.exec(key)?.[1] ?? key;

function TabLabel({ tab, showRepo }: { tab: Tab; showRepo: boolean }) {
  const snapshot = useSessions((s) => (tab.kind === 'pr' ? s.snapshots[tab.key] : undefined));
  const loading = useSessions((s) => (tab.kind === 'pr' ? s.progress[tab.key] !== undefined : false));
  if (tab.kind === 'settings') {
    return (
      <>
        <Icon name="sliders" size={13} />
        <span className="whitespace-nowrap">Settings</span>
      </>
    );
  }
  if (tab.kind === 'new') {
    return (
      <>
        <Icon name="search" size={13} />
        <span className="whitespace-nowrap">New tab</span>
      </>
    );
  }
  const m = /([^/]+)#(\d+)$/.exec(tab.key);
  const repo = snapshot?.ref.repo ?? m?.[1] ?? '';
  const num = snapshot?.ref.number ?? Number(m?.[2] ?? 0);
  const d = snapshot?.details ?? (tab.kind === 'pr' ? tab.summary : undefined);
  const dormant = tab.kind === 'pr' && tab.dormant === true && !snapshot;
  const by = snapshot?.role === 'author' ? 'you' : d?.author;
  const tooltip = d ? `${repoOfKey(tab.key)} #${num}: ${d.title} (by ${by})${dormant ? ' · opens when you switch to it' : ''}` : `${repoOfKey(tab.key)} #${num}`;
  return (
    <span className="flex-1 flex items-center gap-2 min-w-0" title={tooltip}>
      {/* The author's avatar (your own face on your PRs); it pulses while the PR loads or refreshes. */}
      <span className={cx('flex-none', (loading || (!snapshot && !dormant)) && 'animate-pulse')}>
        {d ? <Avatar login={d.author} url={d.authorAvatarUrl} size={16} /> : <span aria-hidden="true" className="block w-4 h-4 rounded-full bg-raised-2" />}
      </span>
      {/* The title only gets the space left over (basis 0), so a narrow tab drops it first, then truncates the repo; the number stays. */}
      {showRepo && <span className="text-faint truncate min-w-0">{repo}</span>}
      <span className="font-semibold flex-none">#{num}</span>
      <span className="truncate min-w-0 flex-[1_1_0%]">{d?.title ?? ''}</span>
    </span>
  );
}

export function TabBar() {
  const { tabs, activeId } = useTabs();
  const waiting = useWaitingCount();
  // The repo name only helps tell tabs apart when PRs from more than one repo are open.
  const showRepo = new Set(tabs.flatMap((t) => (t.kind === 'pr' ? [repoOfKey(t.key)] : []))).size > 1;
  const reorder = useTabReorder('app', tabs.map((t) => t.id), moveTab);
  return (
    <div {...reorder.rowProps} className="drag flex items-end gap-1 pl-[84px] pr-2.5 min-h-[42px] bg-titlebar border-b border-line flex-none">
      {tabs.map((tab, index) => {
        const active = tab.id === activeId;
        const marker = reorder.marker(index);
        return (
          <div
            key={tab.id}
            {...reorder.tabProps(index)}
            onMouseDown={(e) => e.button === 1 && e.preventDefault()}
            onAuxClick={(e) => e.button === 1 && closeTab(tab.id)}
            className={cx(
              'no-drag relative flex items-center gap-0.5 h-[34px] pl-3 pr-1 rounded-t-lg border border-b-0',
              // Like browser tabs: PR tabs share one width and shrink together (titles truncate, the number stays);
              // "New tab" and "Settings" keep their size.
              tab.kind === 'pr' ? 'basis-[260px] shrink min-w-[112px]' : 'flex-none',
              active ? 'bg-panel border-line text-strong after:absolute after:inset-x-0 after:bottom-0 after:h-0.5 after:bg-accent' : 'border-transparent text-soft hover:bg-hover/60',
              reorder.dragging === tab.id && 'opacity-50',
              marker && MARKER_CLASS[marker],
            )}
          >
            <button type="button" onClick={() => activate(tab.id)} className="flex-1 flex items-center gap-2 min-w-0 h-8 overflow-hidden cursor-pointer">
              <TabLabel tab={tab} showRepo={showRepo} />
            </button>
            {tab.kind === 'pr' && !popOutKey && active && (
              <button
                type="button"
                aria-label="Open this pull request in its own window"
                title="Pop out into a window"
                onClick={() => void popOutTab(tab.id)}
                className="grid place-items-center w-[22px] h-[22px] rounded-[5px] text-faint hover:bg-raised hover:text-fg cursor-pointer"
              >
                <Icon name="external" size={12} />
              </button>
            )}
            <button
              type="button"
              aria-label="Close tab"
              onClick={() => closeTab(tab.id)}
              className="grid place-items-center w-[22px] h-[22px] rounded-[5px] text-faint hover:bg-raised hover:text-fg cursor-pointer"
            >
              <Icon name="close" size={12} />
            </button>
          </div>
        );
      })}
      <button
        type="button"
        aria-label="New tab: open a pull request (⌘T)"
        title="New tab (⌘T)"
        onClick={newTab}
        className="no-drag flex items-center gap-1 h-[30px] mb-0.5 px-2 rounded-[7px] text-soft hover:bg-raised cursor-pointer"
      >
        <Icon name="plus" size={15} />
        {waiting > 0 && <span className="px-1.5 rounded-full bg-chip text-[11px] font-semibold">{waiting}</span>}
      </button>
      <div className="flex-1" />
    </div>
  );
}
