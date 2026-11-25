import { useEffect, useState } from 'react';
import type { PrSnapshot } from '../../../shared/model';
import { api } from '../../api';
import { retryPr } from '../../state/tabs';
import { PrStatePill } from '../../components/octicons';
import { Badge, Button, ErrorBox, Icon, Segmented, shortSha, Spinner, timeAgo } from '../../components/ui';
import { SubmitReviewDialog } from '../../dialogs/SubmitReviewDialog';
import { showChanges, VersionsDialog } from '../../dialogs/VersionsDialog';
import { useSessions } from '../../state/sessions';
import { updateUi, usePrUi, type PrViewKind } from '../../state/ui';
import { CommitsView } from './CommitsView';
import { FilesView } from './FilesView';
import { Overview } from './Overview';

/** GitHub's state pill, plus the review decision when it says more than "review required". */
function StateBadge({ snapshot }: { snapshot: PrSnapshot }) {
  const d = snapshot.details;
  const open = d.state === 'OPEN' && !d.isDraft;
  return (
    <>
      <PrStatePill state={d.state} isDraft={d.isDraft} />
      {open && d.reviewDecision === 'CHANGES_REQUESTED' && <Badge tone="bad">Changes requested</Badge>}
      {open && d.reviewDecision === 'APPROVED' && <Badge tone="ok">Approved</Badge>}
    </>
  );
}

/**
 * New code since your last review, unless the diff already shows just that: a short text and a tooltip.
 * Versions count the pushes the app has seen (v1 is the first), so v3 → v5 is two pushes.
 */
function sinceLastReview(snapshot: PrSnapshot): { text: string; action: string; tooltip: string } | null {
  const last = snapshot.lastReviewedOid;
  if (!last || last === snapshot.details.headRefOid || snapshot.compare?.from === last) return null;
  const from = snapshot.versions.find((v) => v.sha === last);
  const to = snapshot.versions.find((v) => v.sha === snapshot.details.headRefOid);
  const pushes = from && to ? to.n - from.n : 0;
  return {
    text: pushes > 0 ? `${pushes} new push${pushes === 1 ? '' : 'es'} since your review` : 'New commits since your review',
    action: pushes > 0 ? `Review ${pushes} new push${pushes === 1 ? '' : 'es'}` : 'Review new commits',
    tooltip: `You last reviewed at ${shortSha(last)}${from ? ` (v${from.n})` : ''}; the PR is now at ${shortSha(snapshot.details.headRefOid)}${to ? ` (v${to.n})` : ''}. Show only what changed since then.`,
  };
}

function Header({ snapshot, view }: { snapshot: PrSnapshot; view: PrViewKind }) {
  const key = snapshot.key;
  const ui = usePrUi(key);
  const d = snapshot.details;
  const since = sinceLastReview(snapshot);
  const views: { value: PrViewKind; label: React.ReactNode }[] = [
    { value: 'overview', label: 'Overview' },
    {
      value: 'files',
      label: (
        <>
          Files <span className="px-1.5 rounded-full bg-chip text-[11px]">{snapshot.files.length}</span>
        </>
      ),
    },
    {
      value: 'commits',
      label: (
        <>
          Commits <span className="px-1.5 rounded-full bg-chip text-[11px]">{d.commitCount}</span>
        </>
      ),
    },
  ];
  return (
    <div className="flex flex-wrap items-center gap-x-3.5 gap-y-2.5 px-4 py-2.5 bg-panel border-b border-line flex-none">
      <div className="flex-[1_1_220px] min-w-0">
        <div className="flex items-center gap-2 min-w-0">
          <StateBadge snapshot={snapshot} />
          <h1 className="text-[15px] font-semibold text-strong truncate min-w-0" title={d.title}>
            {d.title}
          </h1>
          <span className="text-faint text-[14px] flex-none">#{d.number}</span>
        </div>
        <div className="mt-1 text-muted text-[12px] truncate">
          <strong className="text-fg font-semibold">{snapshot.role === 'author' ? 'You' : d.author}</strong> {snapshot.role === 'author' ? 'want' : 'wants'} to merge{' '}
          <code className="font-mono text-[11.5px] px-1.5 rounded bg-branch-bg text-branch">{d.headRefName}</code> into{' '}
          <code className="font-mono text-[11.5px] px-1.5 rounded bg-branch-bg text-branch">{d.baseRefName}</code> · <span className="text-add">+{d.additions}</span> <span className="text-del">−{d.deletions}</span>
        </div>
      </div>
      <Segmented label="PR views" value={view} onChange={(v) => updateUi(key, { view: v })} options={views} />
      {view === 'files' && (
        <>
          <Button onClick={() => updateUi(key, { showVersions: true })}>
            <span className="text-muted">Changes</span>
            <span className="font-semibold">{ui.pendingCompare ?? snapshot.compare?.label ?? 'All changes'}</span>
            {ui.pendingCompare ? <Spinner /> : <Icon name="chevron" size={12} />}
          </Button>
          {since && !ui.pendingCompare && (
            <Button title={since.tooltip} onClick={() => showChanges(key, snapshot.lastReviewedOid, 'Since your last review')} className="bg-warn-bg! border-warn-line! text-warn! hover:brightness-110">
              {since.action}
            </Button>
          )}
          <Segmented
            label="Diff layout"
            value={ui.layout}
            onChange={(v) => updateUi(key, { layout: v })}
            options={[
              { value: 'split', label: 'Split' },
              { value: 'unified', label: 'Unified' },
            ]}
          />
          <Button aria-pressed={ui.showPanel} onClick={() => updateUi(key, { showPanel: !ui.showPanel })} className={ui.showPanel ? 'bg-chip-on' : ''}>
            <Icon name="comment" />
            Conversations
            <span className="px-1.5 rounded-full bg-chip text-[11px] font-semibold">{snapshot.threads.filter((t) => !t.isResolved).length}</span>
          </Button>
        </>
      )}
      <Button variant="primary" onClick={() => updateUi(key, { showSubmit: true })}>
        Submit review
        {snapshot.drafts.length > 0 && <span className="px-1.5 rounded-full bg-black/20 text-[11.5px]">{snapshot.drafts.length} draft{snapshot.drafts.length === 1 ? '' : 's'}</span>}
      </Button>
    </div>
  );
}

/** When the PR was last synced, and checked for changes since (kept current while shown). */
function SyncStatus({ snapshot }: { snapshot: PrSnapshot }) {
  const checkedAt = useSessions((s) => s.checkedAt[snapshot.key]);
  const [, tick] = useState(0);
  useEffect(() => {
    const timer = setInterval(() => tick((n) => n + 1), 15_000);
    return () => clearInterval(timer);
  }, []);
  // "Synced 5 min ago · checked just now"; not when both would read the same.
  const checkedLater = checkedAt && new Date(checkedAt) > new Date(snapshot.syncedAt) && timeAgo(checkedAt) !== timeAgo(snapshot.syncedAt);
  return (
    <span title="PR Review checks GitHub for new pushes, comments and reviews every 45 seconds, and when you come back to the app, and syncs when something changed.">
      Synced {timeAgo(snapshot.syncedAt)}
      {checkedLater ? ` · checked ${timeAgo(checkedAt)}` : ''}
    </span>
  );
}

function StatusBar({ snapshot }: { snapshot: PrSnapshot }) {
  const progress = useSessions((s) => s.progress[snapshot.key]);
  const since = sinceLastReview(snapshot);
  return (
    <footer className="flex flex-wrap items-center gap-x-4 gap-y-1 px-3 py-1 bg-titlebar border-t border-line text-muted text-[11.5px] flex-none">
      <span className="inline-flex items-center gap-1.5">
        <Icon name="folder" size={12} />
        {snapshot.worktree.owned ? 'Worktree' : snapshot.role === 'author' ? 'Your checkout' : 'Reused worktree'}{' '}
        <span className="font-mono text-fg">{snapshot.worktree.path.replace(/^\/Users\/[^/]+/, '~')}</span>
      </span>
      <span>
        {snapshot.worktree.mode === 'detached' ? 'detached at' : 'head'} <span className="font-mono text-fg">{shortSha(snapshot.details.headRefOid)}</span>
      </span>
      {snapshot.worktree.behind && <span className="text-warn">checkout differs from PR head (diffs use the PR head)</span>}
      <span>
        merge-base <span className="font-mono text-fg">{shortSha(snapshot.mergeBase)}</span> on {snapshot.details.baseRefName}
      </span>
      <span className="flex-1" />
      {since && (
        <span className="text-warn" title={since.tooltip}>
          {since.text}
        </span>
      )}
      {progress ? <Spinner label={progress} /> : <SyncStatus snapshot={snapshot} />}
      <button type="button" aria-label="Refresh" onClick={() => void api.refreshPr(snapshot.key)} className="text-muted hover:text-fg cursor-pointer">
        <Icon name="refresh" size={12} />
      </button>
    </footer>
  );
}

export function PrView({ prKey, active }: { prKey: string; active: boolean }) {
  const snapshot = useSessions((s) => s.snapshots[prKey]);
  const progress = useSessions((s) => s.progress[prKey]);
  const error = useSessions((s) => s.errors[prKey]);
  const ui = usePrUi(prKey);

  if (!snapshot) {
    return (
      <div className="h-full grid place-items-center p-6">
        <div className="flex flex-col gap-3 items-center max-w-[560px]">
          {error ? <ErrorBox message={error} onRetry={() => void retryPr(prKey)} /> : <Spinner label={progress ?? 'Opening pull request…'} />}
        </div>
      </div>
    );
  }

  const view = ui.view ?? 'overview';
  return (
    <div className="h-full flex flex-col">
      <Header snapshot={snapshot} view={view} />
      {error && (
        <div className="px-4 py-2 bg-del-subtle border-b border-del-line">
          <ErrorBox message={error} onRetry={() => void api.refreshPr(prKey)} />
        </div>
      )}
      <div className="flex-1 min-h-0">
        {view === 'files' && <FilesView snapshot={snapshot} active={active && !ui.showSubmit && !ui.showVersions} />}
        {view === 'overview' && <Overview snapshot={snapshot} />}
        {view === 'commits' && <CommitsView snapshot={snapshot} />}
      </div>
      <StatusBar snapshot={snapshot} />
      {ui.showSubmit && <SubmitReviewDialog snapshot={snapshot} />}
      {ui.showVersions && <VersionsDialog snapshot={snapshot} />}
    </div>
  );
}
