import { useEffect, useRef, useState } from 'react';
import type { PrPreview, PrSnapshot, WorktreeRemoval } from '../../../shared/model';
import { BLOCKER_LABEL, blockerHint, canForceRemove, confirmText } from '../../../shared/labels';
import { api, errorText } from '../../api';
import { Avatar, Badge, Button, Icon, Label, Markdown, shortSha, Skeleton, Spinner, timeAgo } from '../../components/ui';
import { updateUi } from '../../state/ui';
import { ReviewerPicker } from './ReviewerPicker';
import { ReviewThreads, threadGroup } from './ReviewThreads';
import { Reactions } from '../../components/Reactions';
import { Octicon } from '../../components/octicons';
import { CommentEditor } from '../../diff/CommentEditor';
import { showChanges } from '../../dialogs/VersionsDialog';

/** GitHub's merge state, in words. */
const MERGE_STATE: Record<string, string> = {
  CLEAN: 'Ready to merge',
  HAS_HOOKS: 'Ready to merge',
  UNSTABLE: 'Ready to merge; some checks that aren’t required failed',
  BLOCKED: 'Blocked until the branch’s rules are met',
  BEHIND: 'The branch is behind its base branch',
  DIRTY: 'Has conflicts',
  DRAFT: 'Draft',
  UNKNOWN: 'GitHub is checking…',
};

const REVIEW_STATE: Record<string, { text: string; className: string }> = {
  APPROVED: { text: 'Approved', className: 'text-add-strong' },
  CHANGES_REQUESTED: { text: 'Changes requested', className: 'text-del-strong' },
  COMMENTED: { text: 'Commented', className: 'text-soft' },
  DISMISSED: { text: 'Dismissed', className: 'text-muted' },
  REQUESTED: { text: 'Requested', className: 'text-info' },
  PENDING: { text: 'Pending', className: 'text-info' },
};

function SinceLastReview({ snapshot }: { snapshot: PrSnapshot }) {
  const last = snapshot.lastReviewedOid;
  const head = snapshot.details.headRefOid;
  if (!last || last === head) return null;
  const from = snapshot.versions.find((v) => v.sha === last);
  const to = snapshot.versions.find((v) => v.sha === head);
  const outdated = snapshot.threads.filter((t) => t.isOutdated && !t.isResolved && t.comments.some((c) => c.viewerDidAuthor)).length;
  const forcePushes = snapshot.versions.filter((v) => from && to && v.n > from.n && v.n <= to.n && v.forcePush).length;
  return (
    <section aria-labelledby="since-h" className="flex flex-wrap items-center gap-x-3 gap-y-2 px-3.5 py-3 rounded-[10px] border border-warn-line bg-warn-subtle">
      <h2 id="since-h" className="text-[13.5px] font-bold text-warn-strong">
        Since your last review
      </h2>
      {from && to && to.n > from.n && (
        <span title={`v${from.n} → v${to.n}: the versions are the pushes the app has seen`} className="text-[11.5px] font-semibold px-1.5 rounded bg-warn-bg text-warn">
          {to.n - from.n} new push{to.n - from.n === 1 ? '' : 'es'}
        </span>
      )}
      <span className="text-warn-soft text-[12.5px]">
        {forcePushes > 0 ? `${forcePushes} force-push${forcePushes === 1 ? '' : 'es'} · ` : ''}
        {outdated} of your threads went outdated
      </span>
      <span className="flex-1" />
      <Button
        variant="primary"
        onClick={() => {
          showChanges(snapshot.key, last, 'Since your last review');
          updateUi(snapshot.key, { view: 'files' });
        }}
      >
        Review these changes
      </Button>
    </section>
  );
}

/** A comment card's shape while the conversation loads. */
function CommentSkeleton() {
  return (
    <div aria-hidden="true" className="rounded-[10px] border border-line-2 bg-card overflow-hidden">
      <div className="flex items-center gap-2 px-3.5 py-2 border-b border-line">
        <Skeleton className="w-[22px] h-[22px] rounded-full!" />
        <Skeleton className="w-28 h-3" />
      </div>
      <div className="px-3.5 py-3 flex flex-col gap-2">
        <Skeleton className="w-11/12 h-3" />
        <Skeleton className="w-2/3 h-3" />
      </div>
    </div>
  );
}

/**
 * The PR's description, conversation and details. It shows while the PR first loads (`snapshot` undefined, `pr` a
 * preview): what needs the checkout (review threads, files viewed, the worktree) then shows as loading, and comments
 * can be read but not yet changed.
 */
/**
 * The banner on a merged or closed pull request: offers to remove its worktree (and close its tabs), unless it's the
 * clone itself, or says why it stays when removing it would lose something. Checked again with every sync.
 */
function WorktreeBanner({ snapshot }: { snapshot: PrSnapshot }) {
  const [info, setInfo] = useState<WorktreeRemoval | null>(null);
  const [confirm, setConfirm] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => {
    let current = true;
    void api.worktreeRemoval(snapshot.key).then(
      (r) => current && setInfo(r),
      () => current && setInfo(null),
    );
    return () => {
      current = false;
    };
  }, [snapshot.key, snapshot.syncedAt]);
  if (!info) return null;
  const state = snapshot.details.state === 'MERGED' ? 'merged' : 'closed';
  const blocker = info.blocker;
  if (blocker && !canForceRemove(blocker)) {
    return (
      <div className="flex flex-wrap items-center gap-2.5 px-3.5 py-2.5 rounded-[10px] bg-info-subtle border border-info-line text-[12.5px]">
        <Icon name="folder" className="text-info" />
        <span className="text-fg">This pull request is {state}. Its worktree can’t be removed:</span>
        <span title={blockerHint(blocker, null)}>
          <Badge tone="warn">{BLOCKER_LABEL[blocker]}</Badge>
        </span>
        <span className="font-mono text-[11.5px] text-faint truncate min-w-0" title={info.path}>
          {info.path}
        </span>
      </div>
    );
  }
  const remove = async () => {
    if (!confirm) {
      setConfirm(true);
      return;
    }
    setBusy(true);
    setError(null);
    try {
      // On success the session ends and this tab closes.
      await api.removePrWorktree(info.repoPath, info.path, snapshot.key, blocker !== null);
    } catch (err) {
      setError(errorText(err));
      setConfirm(false);
      setBusy(false);
    }
  };
  return (
    <section aria-label="Worktree" className="flex flex-wrap items-center gap-x-3 gap-y-2 px-3.5 py-3 rounded-[10px] bg-info-subtle border border-info-line">
      <Icon name="folder" className="text-info" />
      <div className="flex-1 min-w-[260px] flex flex-col gap-0.5">
        <span className="flex flex-wrap items-center gap-2 font-semibold text-strong">
          {blocker ? `This pull request is ${state}; its worktree has` : `This pull request is ${state}: its worktree can be removed`}
          {blocker && (
            <span title={blockerHint(blocker, null)}>
              <Badge tone="warn">{BLOCKER_LABEL[blocker]}</Badge>
            </span>
          )}
        </span>
        <span className="font-mono text-[11.5px] text-muted truncate" title={info.path}>
          {info.path}
        </span>
        {!info.owned && (
          <span className="text-[12px] text-muted">You made this worktree. {info.branch ? `The branch ${info.branch} stays, but` : 'Its'} files git ignores in it go too.</span>
        )}
        {error && <span className="text-[12px] text-del">{error}</span>}
      </div>
      <Button size="sm" variant={confirm ? 'danger' : blocker ? 'secondary' : 'primary'} disabled={busy} onClick={() => void remove()}>
        <Icon name="trash" size={13} />
        {busy ? 'Removing…' : confirm ? (blocker ? confirmText(blocker) : 'Remove and close this tab') : blocker ? 'Force remove' : 'Remove worktree'}
      </Button>
    </section>
  );
}

export function Overview({ pr, snapshot }: { pr: PrPreview; snapshot: PrSnapshot | undefined }) {
  const d = pr.details;
  const loaded = snapshot !== undefined;
  const notYet = loaded ? undefined : 'Available once the pull request has loaded';
  const [comment, setComment] = useState('');
  const [editingId, setEditingId] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [picking, setPicking] = useState(false);
  const gear = useRef<HTMLButtonElement>(null);
  const failing = d.checks.filter((c) => c.state === 'failure').length;
  const viewed = snapshot?.files.filter((f) => f.viewed === 'VIEWED').length ?? 0;

  const post = async () => {
    setBusy(true);
    setError(null);
    try {
      await api.addPrComment(pr.key, comment);
      setComment('');
    } catch (err) {
      setError(errorText(err));
    } finally {
      setBusy(false);
    }
  };

  /** A change to the PR on GitHub (closing, draft…), with the comment box's busy state and error. */
  const change = async (run: () => Promise<void>) => {
    setBusy(true);
    setError(null);
    try {
      await run();
    } catch (err) {
      setError(errorText(err));
    } finally {
      setBusy(false);
    }
  };
  const open = d.state === 'OPEN';

  return (
    <div className="h-full flex flex-wrap overflow-y-auto">
      <main className="flex-[999_1_560px] min-w-0 px-5 pt-4 pb-8">
        <div className="max-w-[1200px] mx-auto flex flex-col gap-4">
          {snapshot ? (
            <>
              {d.state !== 'OPEN' && <WorktreeBanner snapshot={snapshot} />}
              <SinceLastReview snapshot={snapshot} />
              <ReviewThreads snapshot={snapshot} />
            </>
          ) : (
            <Spinner label="Loading review threads…" />
          )}
          <article aria-labelledby="desc-h" className="rounded-[10px] border border-line-2 bg-card overflow-hidden">
            <div className="flex items-center gap-2.5 px-3.5 py-2.5 border-b border-line bg-subtle">
              <Avatar login={d.author} url={d.authorAvatarUrl} size={24} />
              <h2 id="desc-h" className="text-[13px] text-muted">
                <strong className="text-strong font-semibold">{d.author}</strong> opened this {timeAgo(d.createdAt)}
              </h2>
              <span className="flex-1" />
              <Button size="sm" onClick={() => void api.openExternal(d.url)}>
                View on GitHub
              </Button>
            </div>
            <div className="px-5 py-4 text-comment text-fg">{d.bodyHTML.trim() ? <Markdown html={d.bodyHTML} /> : <span className="text-muted">No description provided.</span>}</div>
          </article>
          <section aria-labelledby="tl-h" className="flex flex-col gap-2.5">
            <div className="flex items-baseline gap-2">
              <h2 id="tl-h" className="text-[13.5px] font-bold text-strong">
                Conversation
              </h2>
              <span className="text-muted text-[12px]">PR comments and review summaries</span>
            </div>
            {pr.conversation === null && (
              <>
                <CommentSkeleton />
                <CommentSkeleton />
              </>
            )}
            {pr.conversation?.length === 0 && <div className="text-muted">No PR-level comments yet.</div>}
            {pr.conversation?.map((c) =>
              c.kind === 'event' ? (
                <div key={c.id} className="flex items-center gap-2.5 px-3.5 text-muted text-[12.5px]">
                  <span aria-hidden="true" className="w-2 h-2 rounded-full bg-warn" />
                  <span>
                    <strong className="text-fg">{c.author}</strong> {c.text}
                  </span>
                  <span className="flex-1" />
                  <span>{timeAgo(c.createdAt)}</span>
                </div>
              ) : (
                <div key={c.id} className="rounded-[10px] border border-line-2 bg-card overflow-hidden">
                  <div className="flex flex-wrap items-center gap-2 px-3.5 py-2 border-b border-line">
                    <Avatar login={c.author} url={c.avatarUrl} size={22} />
                    <strong className="text-strong font-semibold">{c.author}</strong>
                    {c.reviewState && c.reviewState !== 'COMMENTED' && (
                      <Badge tone={c.reviewState === 'APPROVED' ? 'ok' : c.reviewState === 'CHANGES_REQUESTED' ? 'bad' : 'muted'}>{REVIEW_STATE[c.reviewState]?.text ?? c.reviewState}</Badge>
                    )}
                    <span className="text-muted text-[12px]">{timeAgo(c.createdAt)}</span>
                    <span className="flex-1" />
                    {loaded && c.viewerCanUpdate && c.body !== undefined && editingId !== c.id && (
                      <button type="button" aria-label="Edit comment" title="Edit" onClick={() => setEditingId(c.id)} className="grid place-items-center w-7 h-7 rounded-md text-muted hover:text-fg hover:bg-raised-2 cursor-pointer">
                        <Octicon name="pencil" size={14} />
                      </button>
                    )}
                  </div>
                  {editingId === c.id && c.body !== undefined && (
                    <div className="px-3.5 pb-3 text-comment">
                      <CommentEditor prKey={pr.key} kind={c.kind === 'review' ? 'review' : 'comment'} commentId={c.id} body={c.body} onDone={() => setEditingId(null)} />
                    </div>
                  )}
                  {c.bodyHTML.trim() && editingId !== c.id && (
                    <div className="px-3.5 pt-2.5 pb-3">
                      <Markdown html={c.bodyHTML} className="text-comment text-fg" />
                      <Reactions prKey={pr.key} subjectId={c.id} reactions={c.reactions ?? []} disabled={!loaded} />
                    </div>
                  )}
                </div>
              ),
            )}
            <div className="flex flex-col gap-2">
              <label htmlFor="pr-comment" className="sr-only">
                Comment on the pull request
              </label>
              <textarea
                id="pr-comment"
                rows={comment.includes('\n') ? 4 : 2}
                value={comment}
                onChange={(e) => setComment(e.target.value)}
                placeholder="Comment on the PR…"
                className="resize-y px-3 py-2 rounded-lg bg-side border border-line-2 focus:border-accent outline-none"
              />
              {error && <div className="text-del text-[12px]">{error}</div>}
              <div className="flex justify-end gap-2">
                {open && d.viewerCan.close && (
                  <Button
                    disabled={busy || !loaded}
                    title={notYet}
                    onClick={() =>
                      void change(async () => {
                        await api.setPrOpen(pr.key, false, comment);
                        setComment('');
                      })
                    }
                  >
                    <Octicon name="git-pull-request-closed" size={14} className="text-del" />
                    {comment.trim() ? 'Close with comment' : 'Close pull request'}
                  </Button>
                )}
                {d.state === 'CLOSED' && d.viewerCan.reopen && (
                  <Button
                    disabled={busy || !loaded}
                    title={notYet}
                    onClick={() =>
                      void change(async () => {
                        await api.setPrOpen(pr.key, true, comment);
                        setComment('');
                      })
                    }
                  >
                    <Octicon name="git-pull-request" size={14} className="text-add" />
                    {comment.trim() ? 'Reopen with comment' : 'Reopen pull request'}
                  </Button>
                )}
                <Button disabled={!comment.trim() || busy || !loaded} title={notYet} onClick={() => void post()}>
                  Comment
                </Button>
              </div>
            </div>
          </section>
        </div>
      </main>
      <aside aria-label="PR details" className="flex-[1_1_300px] min-w-0 bg-side border-l border-line px-3.5 pt-3.5 pb-6 flex flex-col gap-5">
        <section>
          <div className="flex items-center mb-2">
            <h2 className="flex-1 text-[11.5px] font-bold text-muted uppercase tracking-wider">Reviewers</h2>
            {open && d.viewerCan.update && (
              <button
                ref={gear}
                type="button"
                aria-label="Request reviews"
                title={notYet ?? 'Request reviews'}
                aria-expanded={picking}
                disabled={!loaded}
                onClick={() => setPicking((p) => !p)}
                className="grid place-items-center w-6 h-6 rounded-md text-muted hover:text-fg hover:bg-raised-2 cursor-pointer disabled:opacity-40 disabled:cursor-default"
              >
                <Octicon name="gear" size={14} />
              </button>
            )}
          </div>
          {picking && <ReviewerPicker prKey={pr.key} anchor={gear} onClose={() => setPicking(false)} />}
          {d.reviewers.length === 0 && <div className="text-muted text-[12.5px]">None yet</div>}
          {d.reviewers.map((r) => (
            <div key={r.login} className="flex items-center gap-2 h-[30px]">
              <Avatar login={r.login} url={r.avatarUrl} size={22} />
              <span className="flex-1 text-fg">{r.login}</span>
              <span className={`text-[12px] font-semibold ${REVIEW_STATE[r.state]?.className ?? ''}`}>{REVIEW_STATE[r.state]?.text ?? r.state}</span>
            </div>
          ))}
        </section>
        <section>
          <div className="flex items-baseline gap-2 mb-2">
            <h2 className="text-[11.5px] font-bold text-muted uppercase tracking-wider">Checks</h2>
            {failing > 0 && <span className="text-[12px] text-del-strong">{failing} failing</span>}
          </div>
          {d.checks.length === 0 && <div className="text-muted text-[12.5px]">No checks</div>}
          {d.checks.map((c) => (
            <button key={c.name} type="button" onClick={() => c.url && void api.openExternal(c.url)} className="flex w-full items-center gap-2 h-7 text-left cursor-pointer">
              <span
                aria-label={c.state}
                className="grid place-items-center w-4 h-4 rounded-full text-ink text-[10px] font-extrabold"
                style={{ background: c.state === 'success' ? 'var(--c-add)' : c.state === 'failure' ? 'var(--c-del)' : c.state === 'pending' ? 'var(--c-warn)' : 'var(--c-dim)' }}
              >
                {c.state === 'success' ? '✓' : c.state === 'failure' ? '✕' : '•'}
              </span>
              <span className="flex-1 truncate">{c.name}</span>
            </button>
          ))}
        </section>
        <section>
          <h2 className="mb-2 text-[11.5px] font-bold text-muted uppercase tracking-wider">Merge</h2>
          {d.state === 'MERGED' ? (
            <div className="flex items-center gap-2 text-[12.5px] text-fg">
              <Octicon name="git-merge" size={14} className="text-done" />
              <span>
                Merged{d.mergedBy ? ` by ${d.mergedBy}` : ''}
                {d.mergedAt ? ` ${timeAgo(d.mergedAt)}` : ''}
              </span>
            </div>
          ) : d.state === 'CLOSED' ? (
            <div className="text-[12.5px] text-muted">Closed without merging</div>
          ) : null}
          {d.state === 'OPEN' && (
            <div className="flex flex-col gap-1 text-[12.5px] text-fg">
              <span>{d.mergeable === 'CONFLICTING' ? 'Has conflicts with ' : d.mergeable === 'MERGEABLE' ? 'No conflicts with ' : 'Checking for conflicts with '}{d.baseRefName}</span>
              <span className="text-muted">{MERGE_STATE[d.mergeStateStatus] ?? d.mergeStateStatus.toLowerCase().replace(/_/g, ' ')}</span>
              <div className="flex flex-wrap items-center gap-2 mt-1.5">
                {d.isDraft && d.viewerCan.update && (
                  <Button size="sm" variant="primary" disabled={busy || !loaded} title={notYet} onClick={() => void change(() => api.setPrDraft(pr.key, false))}>
                    Ready for review
                  </Button>
                )}
                {!d.isDraft && d.viewerCan.merge && (
                  <Button size="sm" variant="success" disabled={!loaded} title={notYet} onClick={() => updateUi(pr.key, { showMerge: true })}>
                    <Octicon name="git-merge" size={13} />
                    Merge…
                  </Button>
                )}
                {!d.isDraft && d.viewerCan.update && (
                  <button
                    type="button"
                    disabled={busy || !loaded}
                    title={notYet ?? 'Still in progress? Mark it as a draft: it can’t be merged until it’s ready for review again'}
                    onClick={() => void change(() => api.setPrDraft(pr.key, true))}
                    className="text-[12px] text-link hover:underline cursor-pointer disabled:opacity-50 disabled:no-underline disabled:cursor-default"
                  >
                    Convert to draft
                  </button>
                )}
              </div>
            </div>
          )}
        </section>
        {(d.workItems.length > 0 || d.linkedIssues.length > 0 || d.labels.length > 0) && (
          <section>
            <h2 className="mb-2 text-[11.5px] font-bold text-muted uppercase tracking-wider">Linked</h2>
            <div className="flex flex-col gap-1">
              {d.workItems.map((w) => (
                <span key={w} className="font-mono text-[12px] text-info">
                  {w}
                </span>
              ))}
              {d.linkedIssues.map((i) => (
                <button key={i.number} type="button" onClick={() => void api.openExternal(i.url)} className="text-left text-[12.5px] cursor-pointer">
                  <span className="font-mono text-info">#{i.number}</span> {i.title}
                </button>
              ))}
            </div>
            <div className="flex flex-wrap gap-1.5 mt-2.5">
              {d.labels.map((l) => (
                <Label key={l.name} name={l.name} color={l.color} />
              ))}
            </div>
          </section>
        )}
        {pr.role === 'reviewer' && (
        <section>
          <h2 className="mb-2 text-[11.5px] font-bold text-muted uppercase tracking-wider">Your review</h2>
          {!snapshot ? (
            <div className="flex flex-col gap-2">
              <Skeleton className="w-32 h-3" />
              <Skeleton className="h-1" />
              <Skeleton className="w-44 h-3" />
            </div>
          ) : (
          <div className="flex flex-col gap-1.5 text-[12.5px] text-fg">
            <span>
              {viewed} of {snapshot.files.length} files viewed
            </span>
            <span aria-hidden="true" className="h-1 rounded bg-line overflow-hidden">
              <span className="block h-1 bg-accent" style={{ width: `${snapshot.files.length ? (100 * viewed) / snapshot.files.length : 0}%` }} />
            </span>
            <span>
              {snapshot.drafts.length} draft comment{snapshot.drafts.length === 1 ? '' : 's'} · {snapshot.threads.filter((t) => threadGroup(t, snapshot.role) === 'needs-reply').length} replies to you
            </span>
          </div>
          )}
        </section>
        )}
        <section>
          <h2 className="mb-2 text-[11.5px] font-bold text-muted uppercase tracking-wider">Local</h2>
          <div className="flex flex-col gap-1 text-[12px] text-muted">
            {snapshot ? (
              <>
                <span className="font-mono text-fg break-all">{snapshot.worktree.path.replace(/^\/Users\/[^/]+/, '~')}</span>
                <span>
                  {snapshot.worktree.mode === 'detached' ? 'detached' : 'branch'} at <span className="font-mono text-fg">{shortSha(d.headRefOid)}</span>
                </span>
              </>
            ) : (
              <Spinner label="Preparing the checkout…" />
            )}
            <span>
              {d.changedFiles} files · <span className="text-add">+{d.additions}</span> <span className="text-del">−{d.deletions}</span> · {d.commitCount} commits
            </span>
          </div>
        </section>
      </aside>
    </div>
  );
}
