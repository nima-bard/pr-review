import { useEffect, useRef, useState } from 'react';
import type { SearchItem, StaleWorktree } from '../../../shared/model';
import { BLOCKER_LABEL, blockerHint, canForceRemove, confirmText } from '../../../shared/labels';
import { formatPrRef, prViewFromUrl } from '../../../shared/prInput';
import { api, errorText } from '../../api';
import { Avatar, Badge, Button, cx, ErrorBox, Icon, Kbd, Label, Segmented, Spinner, timeAgo } from '../../components/ui';
import { Octicon, PrStateIcon } from '../../components/octicons';
import { loadMore, refreshInbox, useInbox } from '../../state/inbox';
import { clearRecents, useRecents } from '../../state/recents';
import { openPr, useTabs } from '../../state/tabs';
import { updateUi } from '../../state/ui';
import { AllPrs } from './AllPrs';
import { WorktreesView } from './Worktrees';

type View = 'for-you' | 'all' | 'worktrees';

export function NewTab({ tabId }: { tabId: string }) {
  const [view, setView] = useState<View>('for-you');
  return (
    <div className="h-full overflow-y-auto">
      <div className="max-w-[1180px] mx-auto px-6 pt-6 pb-12 flex flex-col gap-6">
        <Segmented<View>
          label="New tab views"
          value={view}
          onChange={setView}
          options={[
            { value: 'for-you', label: 'For you' },
            { value: 'all', label: 'All pull requests' },
            { value: 'worktrees', label: 'Worktrees' },
          ]}
        />
        {view === 'for-you' && <ForYou tabId={tabId} />}
        {view === 'all' && <AllPrs tabId={tabId} />}
        {view === 'worktrees' && <WorktreesView tabId={tabId} />}
      </div>
    </div>
  );
}

/**
 * Worktrees left behind by pull requests that are merged or closed, each with its own Remove and all with Clean up
 * (both after a confirming second click); removing one closes its PR's tabs. The ones that would lose something are
 * listed too, with why, and Force remove where that only loses changes or stray commits. Rechecked whenever this New tab comes to the front or a PR tab closes.
 */
function StaleWorktrees({ tabId }: { tabId: string }) {
  const [items, setItems] = useState<StaleWorktree[] | null>(null);
  const [showList, setShowList] = useState(false);
  const [confirm, setConfirm] = useState<'all' | string | null>(null);
  const [busy, setBusy] = useState(false);
  const [outcome, setOutcome] = useState<{ removed: number; failed: string[] } | null>(null);
  const active = useTabs((s) => s.activeId === tabId);
  const openKeys = useOpenKeys();
  const openSig = [...openKeys].sort().join(' ');
  const seq = useRef(0);
  const load = async () => {
    const n = ++seq.current;
    const list = await api.staleWorktrees().catch(() => []);
    if (n === seq.current) setItems(list);
  };
  useEffect(() => {
    if (active) void load();
  }, [active, openSig]);
  if (!items) return null;
  const removable = items.filter((i) => !i.keep);
  const kept = items.filter((i) => i.keep);
  if (items.length === 0 && !outcome) return null;

  const remove = async (list: StaleWorktree[], force = false) => {
    setConfirm(null);
    setBusy(true);
    const failed: string[] = [];
    for (const i of list) {
      try {
        await api.removePrWorktree(i.worktree.repoPath, i.worktree.path, i.key, force);
      } catch (err) {
        failed.push(errorText(err));
      }
    }
    setBusy(false);
    setOutcome({ removed: list.length - failed.length, failed });
    await load();
  };
  const cleanUp = () => {
    if (confirm !== 'all') {
      setConfirm('all');
      setShowList(true);
      return;
    }
    void remove(removable);
  };
  const removeOne = (i: StaleWorktree) => {
    if (confirm !== i.worktree.path) {
      setConfirm(i.worktree.path);
      return;
    }
    void remove([i], i.keep !== null);
  };
  const n = removable.length;
  const plural = (k: number) => (k === 1 ? '' : 's');
  const anyOpen = removable.some((i) => i.open || openKeys.has(i.key));
  const title =
    n > 0
      ? `${n} worktree${plural(n)} of merged or closed pull requests can be removed`
      : kept.length > 0
        ? `${kept.length} worktree${plural(kept.length)} of merged or closed pull requests ${kept.length === 1 ? 'was' : 'were'} kept`
        : 'Worktrees cleaned up';

  return (
    <section aria-labelledby="stale-h" className="flex flex-col gap-2 px-3.5 py-3 rounded-[10px] border border-info-line bg-info-subtle">
      <div className="flex flex-wrap items-center gap-x-3 gap-y-2">
        <Icon name="folder" className="text-info" />
        <h2 id="stale-h" className="font-semibold text-strong">
          {title}
        </h2>
        {n > 0 && kept.length > 0 && <Badge tone="warn">{kept.length} kept</Badge>}
        {items.length > 0 && (
          <button type="button" aria-expanded={showList} onClick={() => setShowList(!showList)} className="text-[12.5px] text-link hover:underline cursor-pointer">
            {showList ? 'Hide' : 'Show'}
          </button>
        )}
        <span className="flex-1" />
        {outcome && outcome.removed > 0 && (
          <span className="text-[12.5px] text-add">
            Removed {outcome.removed} worktree{plural(outcome.removed)}.
          </span>
        )}
        {n > 0 && (
          <Button size="sm" variant={confirm === 'all' ? 'danger' : 'primary'} disabled={busy} onClick={cleanUp}>
            {busy ? 'Removing…' : confirm === 'all' ? `Remove ${n === 1 ? 'it' : `all ${n}`}` : 'Clean up'}
          </Button>
        )}
      </div>
      {showList && items.length > 0 && (
        <ul className="flex flex-col gap-1.5 pl-7">
          {[...removable, ...kept].map((i) => (
            <li key={i.worktree.path} className="flex items-center gap-2 text-[12.5px] min-w-0">
              <Badge tone={i.state === 'MERGED' ? 'purple' : 'bad'}>{i.state === 'MERGED' ? 'Merged' : 'Closed'}</Badge>
              <span className={cx('truncate min-w-0', i.keep ? 'text-muted' : 'text-fg')} title={i.title}>
                {i.worktree.slug}#{i.number} {i.title}
              </span>
              <span className="text-muted whitespace-nowrap">{timeAgo(i.closedAt)}</span>
              {(i.open || openKeys.has(i.key)) && (
                <Badge tone="info" className="flex-none">
                  Open in a tab
                </Badge>
              )}
              {!i.worktree.owned && (
                <span title={`Made outside PR Review${i.worktree.branch ? `; the branch ${i.worktree.branch} stays` : ''}`} className="flex-none">
                  <Badge tone="muted">Yours</Badge>
                </span>
              )}
              <span className="font-mono text-[11.5px] text-faint truncate min-w-0 flex-1" title={i.worktree.path}>
                {i.worktree.path}
              </span>
              {i.keep && (
                <span title={blockerHint(i.keep, i.worktree.locked)} className="flex-none">
                  <Badge tone="warn">{BLOCKER_LABEL[i.keep]}</Badge>
                </span>
              )}
              {(!i.keep || canForceRemove(i.keep)) && (
                <Button size="sm" variant={confirm === i.worktree.path ? 'danger' : 'secondary'} disabled={busy} onClick={() => removeOne(i)} className="flex-none">
                  {confirm === i.worktree.path ? confirmText(i.keep) : i.keep ? 'Force remove' : 'Remove'}
                </Button>
              )}
            </li>
          ))}
        </ul>
      )}
      {showList && n > 0 && (
        <p className="text-[12px] text-muted pl-7">
          {anyOpen ? 'Removing a worktree closes its pull request’s tabs. ' : ''}
          Branches stay, but files git ignores in a worktree (like .env files or build output) go with it.
        </p>
      )}
      {outcome?.failed.map((f) => (
        <span key={f} className="text-[12px] text-del pl-7">
          {f}
        </span>
      ))}
    </section>
  );
}

export function useOpenKeys(): Set<string> {
  const tabs = useTabs((s) => s.tabs);
  return new Set(tabs.flatMap((t) => (t.kind === 'pr' ? [t.key] : [])));
}

const REVIEW_TEXT: Record<string, string> = { APPROVED: 'Approved', CHANGES_REQUESTED: 'Changes requested', REVIEW_REQUIRED: 'Review required' };

/** One pull request, laid out like the github.com list: state icon, title and labels, then "#n · author opened … · review · checks". */
export function PrRow({ item, tabId, openKeys, onOpen, showRepo = true }: { item: SearchItem; tabId: string; openKeys: Set<string>; onOpen?: (input: string) => void; showRepo?: boolean }) {
  const input = formatPrRef(item.ref);
  const review = item.isDraft || item.state !== 'OPEN' ? null : item.reviewDecision ? REVIEW_TEXT[item.reviewDecision] : null;
  const checkIcon = item.checks === 'success' ? 'check' : item.checks === 'failure' ? 'x' : 'dot-fill';
  const checkColor = item.checks === 'success' ? 'var(--c-success)' : item.checks === 'failure' ? 'var(--c-danger)' : 'var(--c-attention)';
  return (
    <button
      type="button"
      onClick={() => (onOpen ? onOpen(input) : void openPr(input, tabId))}
      className="flex w-full gap-2.5 items-start text-left px-4 py-2.5 bg-panel border-b border-line last:border-b-0 hover:bg-hover cursor-pointer"
    >
      <span className="pt-[3px]">
        <PrStateIcon state={item.state} isDraft={item.isDraft} />
      </span>
      <span className="flex-1 min-w-0 flex flex-col gap-1">
        <span className="flex flex-wrap gap-x-2 gap-y-1 items-center">
          {showRepo && (
            <span className="text-muted text-[14px] font-semibold">
              {item.ref.owner}/{item.ref.repo}
            </span>
          )}
          <span className="font-semibold text-strong text-[14.5px] leading-snug">{item.title}</span>
          {item.labels.map((l) => (
            <Label key={l.name} name={l.name} color={l.color} className="font-semibold" />
          ))}
        </span>
        <span className="flex flex-wrap items-center gap-x-1.5 text-[12px] text-muted">
          <span>#{item.ref.number}</span>
          <span aria-hidden="true">·</span>
          <span className="inline-flex items-center gap-1.5">
            <Avatar login={item.author} url={item.authorAvatarUrl} size={16} />
            <span>
              <span className="text-soft">{item.author}</span> opened {timeAgo(item.createdAt)}
            </span>
          </span>
          {review && (
            <>
              <span aria-hidden="true">·</span>
              <span>{review}</span>
            </>
          )}
          {item.checks && (
            <>
              <span aria-hidden="true">·</span>
              <span className="inline-flex items-center gap-1" title={`Checks: ${item.checks}`}>
                <span style={{ color: checkColor }} className="inline-flex">
                  <Octicon name={checkIcon} size={14} label={`checks ${item.checks}`} />
                </span>
                {item.checkCounts && (
                  <span>
                    {item.checkCounts.passed}/{item.checkCounts.total}
                  </span>
                )}
              </span>
            </>
          )}
          <span aria-hidden="true">·</span>
          <span className="font-mono text-[11.5px]">
            <span className="text-add">+{item.additions}</span> <span className="text-del">−{item.deletions}</span>
          </span>
        </span>
      </span>
      <span className="flex items-center gap-3 flex-none self-center">
        {openKeys.has(item.key) && <Badge tone="info">Open in a tab</Badge>}
        {item.comments > 0 && (
          <span className="inline-flex items-center gap-1 text-[12.5px] text-muted" title={`${item.comments} comments`}>
            <Octicon name="comment" size={16} />
            {item.comments}
          </span>
        )}
      </span>
    </button>
  );
}

function ForYou({ tabId }: { tabId: string }) {
  const { sections, loading, error, loadingMore } = useInbox();
  const recents = useRecents((list) => list).slice(0, 8);
  const openKeys = useOpenKeys();
  const link = useTabs((s) => {
    const tab = s.tabs.find((t) => t.id === tabId);
    return tab?.kind === 'new' ? tab.link : undefined;
  });
  const [input, setInput] = useState(link ?? '');
  const [busy, setBusy] = useState(false);
  const [problem, setProblem] = useState<{ message: string; slug?: string } | null>(null);

  useEffect(() => {
    void refreshInbox();
  }, []);

  const open = async (value: string) => {
    setBusy(true);
    setProblem(null);
    try {
      const res = await openPr(value, tabId);
      if (!res.ok) setProblem({ message: res.message, ...(res.reason === 'no-clone' && res.ref ? { slug: `${res.ref.owner}/${res.ref.repo}` } : {}) });
      // A link to the PR's Files changed or Commits tab opens the files, with the commits shown for the latter.
      const view = res.ok ? prViewFromUrl(value) : null;
      if (res.ok && view) updateUi(res.key, view === 'commits' ? { view: 'files', sidebar: 'commits' } : { view });
    } catch (err) {
      setProblem({ message: errorText(err) });
    } finally {
      setBusy(false);
    }
  };

  const linkOpened = useRef(false);
  useEffect(() => {
    if (!link || linkOpened.current) return;
    linkOpened.current = true;
    void open(link);
    // Only on mount: the link is opened once, like pasting it.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const pickClone = async (slug: string) => {
    try {
      const mapping = await api.mapRepo(slug);
      if (mapping && input.trim()) await open(input);
    } catch (err) {
      setProblem({ message: errorText(err), slug });
    }
  };

  return (
    <>
      <section aria-labelledby="open-h" className="flex flex-col gap-3">
        <div className="flex flex-wrap items-baseline gap-x-4 gap-y-1">
          <h1 id="open-h" className="text-[22px] font-bold text-strong tracking-tight">
            Open a pull request
          </h1>
          <span className="text-muted text-[12.5px]">
            Opens in this tab. A PR that's already open switches to its tab. <Kbd>⌘T</Kbd> new tab
          </span>
        </div>
        <form
          onSubmit={(e) => {
            e.preventDefault();
            if (input.trim()) void open(input);
          }}
          className="flex flex-wrap gap-2.5 items-end"
        >
          <label className="flex-1 min-w-[320px] flex flex-col gap-1.5">
            <span className="text-[12px] text-muted">PR link or owner/repo#number</span>
            <input
              autoFocus
              value={input}
              onChange={(e) => setInput(e.target.value)}
              placeholder="https://github.com/owner/repo/pull/123"
              className="h-[42px] px-3.5 rounded-[9px] bg-card border border-line-2 focus:border-accent outline-none text-strong text-[14px] font-mono"
            />
          </label>
          <Button variant="primary" type="submit" disabled={busy} className="h-[42px] px-5">
            {busy ? 'Opening…' : 'Open ⏎'}
          </Button>
        </form>
        {problem && (
          <div className="flex flex-col gap-2">
            <ErrorBox message={problem.message} />
            {problem.slug && (
              <div className="flex gap-2">
                <Button size="sm" onClick={() => void pickClone(problem.slug!)}>
                  Pick local clone of {problem.slug}…
                </Button>
                <Button
                  size="sm"
                  variant="ghost"
                  onClick={async () => {
                    await api.rescanRepos();
                    if (input.trim()) void open(input);
                  }}
                >
                  Rescan folders
                </Button>
              </div>
            )}
          </div>
        )}
      </section>
      <StaleWorktrees tabId={tabId} />

      {error && <ErrorBox message={error} onRetry={() => void refreshInbox(true)} />}
      {loading && sections.length === 0 && <Spinner label="Loading your pull requests…" />}

      <div className="grid gap-6 items-start" style={{ gridTemplateColumns: 'repeat(auto-fit, minmax(440px, 1fr))' }}>
        {recents.length > 0 && (
          <section aria-label="Recent" className="flex flex-col gap-2.5">
            <div className="flex items-baseline gap-2">
              <h2 className="text-[14px] font-semibold text-strong">Recent</h2>
              <span className="text-muted">{recents.length}</span>
              <span className="flex-1" />
              <button type="button" onClick={clearRecents} className="text-muted text-[12px] hover:text-fg cursor-pointer">
                Clear
              </button>
            </div>
            <div className="border border-line-2 rounded-[10px] overflow-hidden">
              {recents.map((r) => (
                <PrRow key={r.item.key} item={r.item} tabId={tabId} openKeys={openKeys} onOpen={(v) => void open(v)} />
              ))}
            </div>
          </section>
        )}
        {sections.map((section) => (
          // "Your pull requests" spans the full width at the bottom; it can be long and pages with "Load more".
          <section key={section.id} aria-label={section.title} className="flex flex-col gap-2.5" style={section.id === 'mine' ? { gridColumn: '1 / -1' } : undefined}>
            <div className="flex items-baseline gap-2">
              <h2 className="text-[14px] font-semibold text-strong">{section.title}</h2>
              <span className="text-muted">{section.total}</span>
              <span className="flex-1" />
              {section.id === 'mine' && (
                <button type="button" onClick={() => void refreshInbox(true)} className={cx('text-muted hover:text-fg cursor-pointer', loading && 'animate-spin')} aria-label="Refresh">
                  <Icon name="refresh" size={13} />
                </button>
              )}
            </div>
            <div className="border border-line-2 rounded-[10px] overflow-hidden">
              {section.items.length === 0 ? (
                <div className="px-3.5 py-3 text-muted bg-panel">Nothing here.</div>
              ) : (
                section.items.map((item) => <PrRow key={item.key} item={item} tabId={tabId} openKeys={openKeys} onOpen={(v) => void open(v)} />)
              )}
              {section.hasNextPage && (
                <button
                  type="button"
                  disabled={loadingMore !== null}
                  onClick={() => void loadMore(section.id)}
                  className="flex w-full items-center justify-center gap-2 h-10 bg-subtle border-t border-line text-link text-[13px] font-semibold hover:underline cursor-pointer disabled:cursor-default disabled:no-underline"
                >
                  {loadingMore === section.id ? <Spinner label="Loading…" /> : `Load more (${section.total - section.items.length} more)`}
                </button>
              )}
            </div>
          </section>
        ))}
      </div>
    </>
  );
}
