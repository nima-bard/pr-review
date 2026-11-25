import { useState } from 'react';
import type { PrSnapshot } from '../../../shared/model';
import { api, errorText } from '../../api';
import { Avatar, Badge, Button, Label, Markdown, shortSha, timeAgo } from '../../components/ui';
import { updateUi } from '../../state/ui';
import { ReviewThreads, threadGroup } from './ReviewThreads';
import { Reactions } from '../../components/Reactions';
import { Octicon } from '../../components/octicons';
import { CommentEditor } from '../../diff/CommentEditor';
import { showChanges } from '../../dialogs/VersionsDialog';

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

export function Overview({ snapshot }: { snapshot: PrSnapshot }) {
  const d = snapshot.details;
  const [comment, setComment] = useState('');
  const [editingId, setEditingId] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const failing = d.checks.filter((c) => c.state === 'failure').length;
  const viewed = snapshot.files.filter((f) => f.viewed === 'VIEWED').length;

  const post = async () => {
    setBusy(true);
    setError(null);
    try {
      await api.addPrComment(snapshot.key, comment);
      setComment('');
    } catch (err) {
      setError(errorText(err));
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="h-full flex flex-wrap overflow-y-auto">
      <main className="flex-[999_1_560px] min-w-0 px-5 pt-4 pb-8">
        <div className="max-w-[1200px] mx-auto flex flex-col gap-4">
          <SinceLastReview snapshot={snapshot} />
          <ReviewThreads snapshot={snapshot} />
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
            {snapshot.conversation.length === 0 && <div className="text-muted">No PR-level comments yet.</div>}
            {snapshot.conversation.map((c) =>
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
                    {c.viewerCanUpdate && c.body !== undefined && editingId !== c.id && (
                      <button type="button" aria-label="Edit comment" title="Edit" onClick={() => setEditingId(c.id)} className="grid place-items-center w-7 h-7 rounded-md text-muted hover:text-fg hover:bg-raised-2 cursor-pointer">
                        <Octicon name="pencil" size={14} />
                      </button>
                    )}
                  </div>
                  {editingId === c.id && c.body !== undefined && (
                    <div className="px-3.5 pb-3 text-comment">
                      <CommentEditor prKey={snapshot.key} kind={c.kind === 'review' ? 'review' : 'comment'} commentId={c.id} body={c.body} onDone={() => setEditingId(null)} />
                    </div>
                  )}
                  {c.bodyHTML.trim() && editingId !== c.id && (
                    <div className="px-3.5 pt-2.5 pb-3">
                      <Markdown html={c.bodyHTML} className="text-comment text-fg" />
                      <Reactions prKey={snapshot.key} subjectId={c.id} reactions={c.reactions ?? []} />
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
              <div className="flex justify-end">
                <Button disabled={!comment.trim() || busy} onClick={() => void post()}>
                  Comment
                </Button>
              </div>
            </div>
          </section>
        </div>
      </main>
      <aside aria-label="PR details" className="flex-[1_1_300px] min-w-0 bg-side border-l border-line px-3.5 pt-3.5 pb-6 flex flex-col gap-5">
        <section>
          <h2 className="mb-2 text-[11.5px] font-bold text-muted uppercase tracking-wider">Reviewers</h2>
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
          <div className="flex flex-col gap-1 text-[12.5px] text-fg">
            <span>{d.mergeable === 'CONFLICTING' ? 'Has conflicts with ' : d.mergeable === 'MERGEABLE' ? 'No conflicts with ' : 'Checking mergeability against '}{d.baseRefName}</span>
            <span className="text-muted">State: {d.mergeStateStatus.toLowerCase().replace(/_/g, ' ')}</span>
          </div>
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
        {snapshot.role === 'reviewer' && (
        <section>
          <h2 className="mb-2 text-[11.5px] font-bold text-muted uppercase tracking-wider">Your review</h2>
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
        </section>
        )}
        <section>
          <h2 className="mb-2 text-[11.5px] font-bold text-muted uppercase tracking-wider">Local</h2>
          <div className="flex flex-col gap-1 text-[12px] text-muted">
            <span className="font-mono text-fg break-all">{snapshot.worktree.path.replace(/^\/Users\/[^/]+/, '~')}</span>
            <span>
              {snapshot.worktree.mode === 'detached' ? 'detached' : 'branch'} at <span className="font-mono text-fg">{shortSha(d.headRefOid)}</span>
            </span>
            <span>
              {d.changedFiles} files · <span className="text-add">+{d.additions}</span> <span className="text-del">−{d.deletions}</span> · {d.commitCount} commits
            </span>
          </div>
        </section>
      </aside>
    </div>
  );
}
