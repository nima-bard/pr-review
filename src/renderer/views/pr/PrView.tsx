import { useEffect, useState } from 'react';
import type { PrPreview, PrSnapshot } from '../../../shared/model';
import { api, errorText } from '../../api';
import { retryPr } from '../../state/tabs';
import { Octicon, PrStatePill } from '../../components/octicons';
import { Badge, Button, cx, ErrorBox, Icon, Segmented, shortSha, Skeleton, Spinner, timeAgo } from '../../components/ui';
import { MergeDialog } from '../../dialogs/MergeDialog';
import { SubmitReviewDialog } from '../../dialogs/SubmitReviewDialog';
import { showChanges, VersionsDialog } from '../../dialogs/VersionsDialog';
import { setSessionError, useSessions } from '../../state/sessions';
import { updateUi, usePrUi, type PrViewKind } from '../../state/ui';
import { CommitsView } from './CommitsView';
import { RunsDialog, RunsIndicator } from './ActionRuns';
import { showActionsMenu } from '../../state/quickActions';
import { FilesView } from './FilesView';
import { Overview } from './Overview';
import { useClaudeSettings } from '../../state/claude';
import { loadClaudeView } from '../../state/sessions';

/** GitHub's state pill, plus the review decision when it says more than "review required". */
function StateBadge({ pr }: { pr: PrPreview }) {
  const d = pr.details;
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

/** In place of a view's count while the PR first loads. */
function Pending() {
  return <span role="img" aria-label="loading" title="Loading: the pull request is being checked out" className="w-3 h-3 rounded-full border-2 border-line-2 border-t-accent animate-spin" />;
}

/** Merge… (the merge dialog), or for a draft: Ready for review. */
function MergeButton({ snapshot }: { snapshot: PrSnapshot }) {
  const [busy, setBusy] = useState(false);
  const key = snapshot.key;
  if (!snapshot.details.isDraft) {
    return (
      <Button onClick={() => updateUi(key, { showMerge: true })} title="Merge this pull request: the branch's rules, the merge method and the commit message">
        <Octicon name="git-merge" size={14} className="text-done" />
        Merge…
      </Button>
    );
  }
  return (
    <Button
      disabled={busy}
      title="Mark the draft as ready for review: reviewers are notified, and it can be merged"
      onClick={() => {
        setBusy(true);
        api
          .setPrDraft(key, false)
          .catch((err: unknown) => setSessionError(key, errorText(err)))
          .finally(() => setBusy(false));
      }}
    >
      {busy ? 'Marking ready…' : 'Ready for review'}
    </Button>
  );
}

/** `snapshot` is undefined while the PR first loads: then only `pr` (a preview) is known. */
function Header({ pr, snapshot, view }: { pr: PrPreview; snapshot: PrSnapshot | undefined; view: PrViewKind }) {
  const key = pr.key;
  const ui = usePrUi(key);
  const d = pr.details;
  const since = snapshot ? sinceLastReview(snapshot) : null;
  const drafts = snapshot?.drafts.length ?? 0;
  const count = (n: number | undefined) => (n === undefined ? <Pending /> : <span className="px-1.5 rounded-full bg-chip text-[11px]">{n}</span>);
  const views: { value: PrViewKind; label: React.ReactNode }[] = [
    { value: 'overview', label: 'Overview' },
    { value: 'files', label: <>Files {count(snapshot?.files.length)}</> },
    { value: 'commits', label: <>Commits {count(snapshot && d.commitCount)}</> },
  ];
  return (
    <div className="grid grid-cols-[minmax(0,1fr)_auto_minmax(0,1fr)] items-center gap-x-3.5 px-4 py-2.5 bg-panel border-b border-line flex-none">
      {/* The view switch sits in the middle, so it stays put while the buttons beside it change with the view. */}
      <div className="min-w-0">
        <div className="flex items-center gap-2 min-w-0">
          <StateBadge pr={pr} />
          <h1 className="text-[15px] font-semibold text-strong truncate min-w-0" title={d.title}>
            {d.title}
          </h1>
          <span className="text-faint text-[14px] flex-none">#{d.number}</span>
        </div>
        <div className="mt-1 text-muted text-[12px] truncate">
          <strong className="text-fg font-semibold">{pr.role === 'author' ? 'You' : d.author}</strong> {pr.role === 'author' ? 'want' : 'wants'} to merge{' '}
          <code className="font-mono text-[11.5px] px-1.5 rounded bg-branch-bg text-branch">{d.headRefName}</code> into{' '}
          <code className="font-mono text-[11.5px] px-1.5 rounded bg-branch-bg text-branch">{d.baseRefName}</code> · <span className="text-add">+{d.additions}</span> <span className="text-del">−{d.deletions}</span>
        </div>
      </div>
      <Segmented label="PR views" value={view} onChange={(v) => updateUi(key, { view: v })} options={views} />
      <div className="flex flex-wrap items-center justify-end gap-x-2 gap-y-2 min-w-0">
        {view === 'files' && snapshot && (
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
          </>
        )}
        {/* The pull request's own actions are on the Overview; ⌥⌘1–9 run quick actions from anywhere. */}
        {snapshot && view === 'overview' && (
          <Button onClick={() => void showActionsMenu(snapshot)} title="Quick actions: your own commands for this pull request (⌥⌘1–9). Set them up in Settings.">
            <Octicon name="zap" size={14} className="text-warn" />
            Actions
          </Button>
        )}
        {snapshot && view === 'overview' && d.state === 'OPEN' && (d.isDraft ? d.viewerCan.update : d.viewerCan.merge) && <MergeButton snapshot={snapshot} />}
        <Button variant="primary" disabled={!snapshot} title={snapshot ? undefined : 'Available once the pull request has loaded'} onClick={() => updateUi(key, { showSubmit: true })}>
          Submit review
          {drafts > 0 && <span className="px-1.5 rounded-full bg-black/20 text-[11.5px]">{drafts} draft{drafts === 1 ? '' : 's'}</span>}
        </Button>
      </div>
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

function SpinnerLabel({ prKey }: { prKey: string }) {
  const progress = useSessions((s) => s.progress[prKey]);
  return <Spinner label={progress ?? 'Loading…'} />;
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
      <RunsIndicator prKey={snapshot.key} />
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

/** Files or Commits before the PR's first snapshot: their shape, and what the app is doing (fetching, checking out…). */
function NotYet({ prKey, view }: { prKey: string; view: 'files' | 'commits' }) {
  const progress = useSessions((s) => s.progress[prKey]);
  const status = (
    <div className="flex flex-col gap-1">
      <Spinner label={progress ?? 'Loading…'} />
      <span className="pl-5.5 text-[12px] text-muted">{view === 'files' ? 'The files' : 'The commits'} show once the pull request is checked out.</span>
    </div>
  );
  if (view === 'commits') {
    return (
      <div className="h-full overflow-hidden px-5 py-4">
        <div className="max-w-[1000px] mx-auto flex flex-col gap-3">
          {status}
          {[0, 1, 2, 3].map((i) => (
            <Skeleton key={i} className="h-[52px] rounded-[10px]" />
          ))}
        </div>
      </div>
    );
  }
  const rows = ['w-2/3', 'ml-4 w-1/2', 'ml-4 w-3/5', 'w-1/2', 'ml-4 w-2/3', 'ml-8 w-2/5', 'w-3/5'];
  return (
    <div className="h-full flex overflow-hidden">
      <div className="w-[300px] flex-none flex flex-col gap-3 p-3 bg-side border-r border-line">
        <Skeleton className="h-[26px]" />
        <Skeleton className="h-[26px]" />
        {rows.map((w, i) => (
          <Skeleton key={i} className={`h-3 ${w}`} />
        ))}
      </div>
      <div className="flex-1 min-w-0 flex flex-col gap-4 p-4">
        {status}
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
    </div>
  );
}

export function PrView({ prKey, active }: { prKey: string; active: boolean }) {
  const snapshot = useSessions((s) => s.snapshots[prKey]);
  const preview = useSessions((s) => s.previews[prKey]);
  const progress = useSessions((s) => s.progress[prKey]);
  const error = useSessions((s) => s.errors[prKey]);
  const ui = usePrUi(prKey);
  const loaded = snapshot !== undefined;
  // The PR's Claude session, for the markers on asked lines and the Claude icon, before its panel is opened.
  const claudeOn = useClaudeSettings((s) => s.enabled);
  useEffect(() => {
    if (loaded && claudeOn) void loadClaudeView(prKey).catch(() => undefined);
  }, [prKey, loaded, claudeOn]);

  const pr = snapshot ?? preview;
  if (!pr) {
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
      <Header pr={pr} snapshot={snapshot} view={view} />
      {error && (
        <div className="px-4 py-2 bg-del-subtle border-b border-del-line">
          <ErrorBox message={error} onRetry={() => void (snapshot ? api.refreshPr(prKey) : retryPr(prKey))} />
        </div>
      )}
      <div className="flex-1 min-h-0">
        {view === 'files' && (snapshot ? <FilesView snapshot={snapshot} active={active && !ui.showSubmit && !ui.showVersions} /> : <NotYet prKey={prKey} view="files" />)}
        {view === 'overview' && <Overview pr={pr} snapshot={snapshot} />}
        {view === 'commits' && (snapshot ? <CommitsView snapshot={snapshot} /> : <NotYet prKey={prKey} view="commits" />)}
      </div>
      {snapshot ? (
        <StatusBar snapshot={snapshot} />
      ) : (
        <footer className="flex items-center gap-4 px-3 py-1 bg-titlebar border-t border-line text-muted text-[11.5px] flex-none">
          <span className="flex-1" />
          {!error && <SpinnerLabel prKey={prKey} />}
        </footer>
      )}
      {snapshot && ui.showSubmit && <SubmitReviewDialog snapshot={snapshot} />}
      {snapshot && ui.showVersions && <VersionsDialog snapshot={snapshot} />}
      {snapshot && ui.showMerge && <MergeDialog snapshot={snapshot} />}
      {ui.showRuns && <RunsDialog prKey={prKey} />}
    </div>
  );
}
