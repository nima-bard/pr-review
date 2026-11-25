import { useState } from 'react';
import type { PrSnapshot, ReviewEvent } from '../../shared/model';
import { api, errorText } from '../api';
import { Badge, Button, cx, ErrorBox, Icon } from '../components/ui';
import { discardUnsent, unsentComments } from '../diff/Composer';
import { focusFile, loadSummary, requestComposer, saveSummary, updateUi } from '../state/ui';

const VERDICTS: { id: ReviewEvent; title: string; desc: string; tone: string }[] = [
  { id: 'COMMENT', title: 'Comment', desc: 'General feedback, no explicit approval.', tone: 'text-strong' },
  { id: 'APPROVE', title: 'Approve', desc: 'Merge once checks pass.', tone: 'text-add-strong' },
  { id: 'REQUEST_CHANGES', title: 'Request changes', desc: 'Must be addressed before merging.', tone: 'text-del-strong' },
];

export function SubmitReviewDialog({ snapshot }: { snapshot: PrSnapshot }) {
  const key = snapshot.key;
  const [summary, setSummary] = useState(() => loadSummary(key));
  const [event, setEvent] = useState<ReviewEvent>('COMMENT');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const close = () => updateUi(key, { showSubmit: false });
  const own = snapshot.role === 'author';
  const verdicts = own ? VERDICTS.filter((v) => v.id === 'COMMENT') : VERDICTS;
  const pendingFromWeb = snapshot.pendingReview?.commentCount ?? 0;
  // Every draft goes out, the ones an agent wrote too (they're marked "from …").
  const drafts = snapshot.drafts;
  const empty = drafts.length === 0 && pendingFromWeb === 0 && summary.trim() === '' && event === 'COMMENT';
  const blocked = drafts.some((d) => d.unplaceable);
  // Typed but never added: not part of the review, so say so before it goes out without them.
  const [unsent, setUnsent] = useState(() => unsentComments(key, snapshot.drafts));

  const submit = async () => {
    setBusy(true);
    setError(null);
    try {
      await api.submitReview(key, { event, body: summary });
      saveSummary(key, '');
      close();
    } catch (err) {
      setError(errorText(err));
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="fixed inset-0 z-50 grid place-items-center bg-black/50" onMouseDown={(e) => e.target === e.currentTarget && close()}>
      <div role="dialog" aria-labelledby="submit-h" className="w-[640px] max-w-[calc(100vw-32px)] max-h-[calc(100vh-64px)] flex flex-col rounded-xl bg-raised border border-line-2 shadow-2xl overflow-hidden">
        <div className="flex items-center gap-2.5 px-4 py-3.5">
          <h2 id="submit-h" className="text-[15px] font-bold text-strong">
            Submit your review
          </h2>
          <span className="text-muted">
            {snapshot.ref.repo} #{snapshot.ref.number} · at {snapshot.details.headRefOid.slice(0, 7)}
          </span>
          <span className="flex-1" />
          <button type="button" aria-label="Close" onClick={close} className="grid place-items-center w-[26px] h-[26px] rounded-md text-muted hover:text-fg cursor-pointer">
            <Icon name="close" size={13} />
          </button>
        </div>
        <div className="flex-1 overflow-y-auto px-4 pb-4 flex flex-col gap-3.5">
          {pendingFromWeb > 0 && (
            <div className="flex gap-2.5 px-3 py-2.5 rounded-[9px] bg-info-subtle border border-info-line">
              <Icon name="info" size={16} className="text-info mt-0.5" />
              <span className="text-fg leading-snug">
                You have a pending review from github.com with {pendingFromWeb} comment{pendingFromWeb === 1 ? '' : 's'}. It's included: GitHub allows one pending review per person.
              </span>
            </div>
          )}
          {unsent.length > 0 && (
            <section aria-labelledby="unsent-h" className="flex flex-col gap-2 px-3 py-2.5 rounded-[9px] bg-warn-bg border border-warn-line">
              <h3 id="unsent-h" className="text-[13px] font-semibold text-warn">
                Not in this review: {unsent.length} unfinished comment{unsent.length === 1 ? '' : 's'}
              </h3>
              <span className="text-[12px] text-soft">You typed {unsent.length === 1 ? 'this' : 'these'} but didn't add {unsent.length === 1 ? 'it' : 'them'} to the review, so {unsent.length === 1 ? "it won't" : "they won't"} be sent. Open one to add it, or discard it.</span>
              {unsent.map((u) => (
                <div key={u.storageKey} className="flex gap-2.5 items-start px-3 py-2 rounded-[8px] bg-panel border border-line-2">
                  <span className="flex-1 min-w-0 flex flex-col gap-1">
                    <span className="font-mono text-[11.5px] text-soft">
                      {u.target.path} · {u.target.startLine !== u.target.endLine ? `L${u.target.startLine}–${u.target.endLine}` : `L${u.target.endLine}`}
                      {u.target.draftId ? ' · unsaved edit of a draft' : ''}
                    </span>
                    <span className="text-fg whitespace-pre-wrap line-clamp-3">{u.text}</span>
                  </span>
                  <Button
                    size="sm"
                    onClick={() => {
                      close();
                      focusFile(key, u.target.path);
                      requestComposer(key, u.target);
                    }}
                  >
                    Open
                  </Button>
                  <Button
                    size="sm"
                    variant="ghost"
                    onClick={() => {
                      discardUnsent(u.storageKey);
                      setUnsent(unsentComments(key, snapshot.drafts));
                    }}
                  >
                    Discard
                  </Button>
                </div>
              ))}
            </section>
          )}
          <section aria-labelledby="drafts-h" className="flex flex-col gap-2">
            <h3 id="drafts-h" className="text-[13px] font-semibold text-strong">
              Comments in this review <span className="text-muted font-normal">{drafts.length + pendingFromWeb}</span>
            </h3>
            {drafts.length === 0 && <div className="text-muted text-[12.5px]">No draft comments. Hover a diff line and click "+" to add one.</div>}
            {drafts.map((d) => (
              <div key={d.id} className="flex gap-2.5 items-start px-3 py-2.5 rounded-[9px] bg-panel border border-line-2">
                <span className="flex-1 min-w-0 flex flex-col gap-1">
                  <span className="flex flex-wrap items-center gap-2">
                    <span className="font-mono text-[11.5px] text-soft">
                      {d.path} · {d.startLine !== undefined ? `L${d.startLine}–${d.line}` : `L${d.line}`}
                    </span>
                    {d.postedThreadId ? <Badge tone="ok">Posted, awaiting submit</Badge> : <Badge tone="info">{d.origin ? `Local draft · from ${d.origin.agent}` : 'Local draft'}</Badge>}
                    {d.unplaceable && <Badge tone="bad">Line changed in a new push · move or delete</Badge>}
                  </span>
                  <span className="text-fg whitespace-pre-wrap line-clamp-4">{d.body}</span>
                </span>
                <Button
                  size="sm"
                  onClick={() => {
                    close();
                    focusFile(key, d.path);
                  }}
                >
                  Show
                </Button>
                <button type="button" aria-label={`Delete comment on ${d.path}`} onClick={() => void api.deleteDraft(key, d.id)} className="grid place-items-center w-[26px] h-[26px] rounded-md bg-raised-2 border border-line-2 text-fg cursor-pointer">
                  <Icon name="trash" size={12} />
                </button>
              </div>
            ))}
          </section>
          <section className="flex flex-col gap-1.5">
            <label htmlFor="summary" className="text-[13px] font-semibold text-strong">
              Summary
            </label>
            <textarea
              id="summary"
              rows={6}
              value={summary}
              onChange={(e) => {
                setSummary(e.target.value);
                saveSummary(key, e.target.value);
              }}
              className="resize-y px-3 py-2.5 rounded-[9px] bg-side border border-info-line focus:border-accent outline-none leading-relaxed"
            />
            <span className="text-[12px] text-muted">Lines quoted from files outside the diff are added here as permalinks.</span>
          </section>
          <fieldset className="flex flex-col gap-2">
            <legend className="mb-2 text-[13px] font-semibold text-strong">Verdict</legend>
            {own && <div className="text-[12px] text-muted">You can't approve or request changes on your own pull request.</div>}
            {verdicts.map((v) => (
              <label key={v.id} className={cx('flex gap-2.5 items-start px-3 py-2.5 rounded-[9px] border cursor-pointer', event === v.id ? 'bg-active border-info-line' : 'border-line-2')}>
                <input type="radio" name="verdict" checked={event === v.id} onChange={() => setEvent(v.id)} className="mt-0.5" style={{ accentColor: 'var(--c-accent)' }} />
                <span>
                  <span className={cx('font-semibold', v.tone)}>{v.title}</span>
                  <br />
                  <span className="text-[12px] text-muted">{v.desc}</span>
                </span>
              </label>
            ))}
          </fieldset>
          {error && <ErrorBox message={error} />}
        </div>
        <div className="flex items-center gap-2.5 px-4 py-3 bg-panel border-t border-line-2">
          <span className="flex-1 text-[12px] text-muted">Drafts are saved locally and only go to GitHub when you submit.</span>
          <Button onClick={close}>Keep drafting</Button>
          <Button variant="primary" disabled={busy || empty || blocked} title={blocked ? 'Move or delete drafts on changed lines first' : undefined} onClick={() => void submit()}>
            {busy ? 'Submitting…' : drafts.length > 0 ? `Submit review (${drafts.length})` : 'Submit review'}
          </Button>
        </div>
      </div>
    </div>
  );
}
