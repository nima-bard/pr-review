import { useCallback, useEffect, useState } from 'react';
import { MERGE_METHODS, mergeRules, mergeVerdict, type MergeRule } from '../../shared/mergeRules';
import type { CommitMessage, MergeInfo, MergeInput, MergeMethod, PrSnapshot } from '../../shared/model';
import { api, errorText } from '../api';
import { Button, cx, ErrorBox, Icon, Spinner } from '../components/ui';
import { updateUi } from '../state/ui';

const DELETE_BRANCH_KEY = 'merge-delete-branch';

function loadDeleteBranch(): boolean {
  try {
    return localStorage.getItem(DELETE_BRANCH_KEY) === '1';
  } catch {
    return false;
  }
}

function saveDeleteBranch(on: boolean): void {
  try {
    localStorage.setItem(DELETE_BRANCH_KEY, on ? '1' : '0');
  } catch {
    // Only a convenience.
  }
}

const TONE: Record<MergeRule['tone'], { mark: string; className: string }> = {
  ok: { mark: '✓', className: 'bg-add text-ink' },
  pending: { mark: '•', className: 'bg-warn text-ink' },
  warn: { mark: '!', className: 'bg-warn text-ink' },
  bad: { mark: '✕', className: 'bg-del text-ink' },
};

/** Why the merge button does nothing now, for the dialog's footer. */
const WAITING: Partial<Record<ReturnType<typeof mergeVerdict>, string>> = {
  closed: 'The pull request is closed.',
  draft: 'Drafts can’t be merged. Mark it ready for review first.',
  'no-access': 'You don’t have write access to this repository.',
  conflicts: 'Resolve the conflicts on the branch, then merge.',
  checking: 'GitHub is still checking whether the branch merges cleanly.',
  queued: 'The pull request is in the merge queue: GitHub merges it once the checks pass.',
  blocked: 'Merging is blocked until the rules are met.',
};

/**
 * Merging the pull request, like github.com's merge box: the branch's rules and where they stand, the methods the
 * repository allows, and the commit message GitHub proposes for each (editable). It merges at the head shown in the
 * app, so new commits pushed since stop it. When the rules aren't met yet it offers auto-merge, or bypassing them to
 * those allowed to.
 */
export function MergeDialog({ snapshot }: { snapshot: PrSnapshot }) {
  const key = snapshot.key;
  const [info, setInfo] = useState<MergeInfo | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [method, setMethod] = useState<MergeMethod | null>(null);
  const [messages, setMessages] = useState<Record<'MERGE' | 'SQUASH', CommitMessage> | null>(null);
  const [deleteBranch, setDeleteBranch] = useState(loadDeleteBranch);
  const [bypass, setBypass] = useState(false);
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const close = useCallback(() => updateUi(key, { showMerge: false }), [key]);

  const load = useCallback(async () => {
    setLoadError(null);
    try {
      const next = await api.mergeInfo(key);
      setInfo(next);
      setMethod((m) => (m && next.methods.includes(m) ? m : next.defaultMethod));
      // GitHub's proposed messages, unless they've been edited here already.
      setMessages((m) => m ?? next.messages);
    } catch (err) {
      setLoadError(errorText(err));
    }
  }, [key]);

  useEffect(() => {
    void load();
  }, [load]);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape' && !busy) {
        e.stopPropagation();
        close();
      }
    };
    window.addEventListener('keydown', onKey, true);
    return () => window.removeEventListener('keydown', onKey, true);
  }, [busy, close]);

  /** Runs a change on GitHub; `done` closes the dialog after it, otherwise the merge state is read again. */
  const run = async (label: string, change: () => Promise<void>, done: boolean) => {
    setBusy(label);
    setError(null);
    try {
      await change();
      if (done) close();
      else await load();
    } catch (err) {
      setError(errorText(err));
    } finally {
      setBusy(null);
    }
  };

  const verdict = info ? mergeVerdict(info) : null;
  // The rules were met, or someone allowed to is bypassing them: merge now.
  const mergeNow = verdict === 'ready' || (verdict === 'blocked' && bypass);
  const autoMerge = verdict === 'blocked' && !bypass && info?.autoMerge.available === true && !info.autoMerge.enabled;
  const action: MergeInput['action'] | null = verdict === 'queue' ? 'queue' : mergeNow ? 'merge' : autoMerge ? 'auto-merge' : null;
  const stale = info !== null && info.headRefOid !== snapshot.details.headRefOid;
  const message = method && method !== 'REBASE' && messages ? messages[method] : null;
  const showMethods = info !== null && action !== null && action !== 'queue';

  const submit = () => {
    if (!info || !method || !action) return;
    const input: MergeInput = { action, method, message, deleteBranch: action === 'merge' && info.deleteBranch === 'optional' && deleteBranch };
    void run(action === 'merge' ? 'Merging…' : action === 'queue' ? 'Adding to the merge queue…' : 'Turning on auto-merge…', () => api.mergePr(key, input), true);
  };

  const label = !method
    ? 'Merge'
    : action === 'queue'
      ? 'Merge when ready'
      : action === 'auto-merge'
        ? `Enable auto-merge (${MERGE_METHODS[method].action.toLowerCase()})`
        : bypass && verdict === 'blocked'
          ? `Bypass rules and ${MERGE_METHODS[method].action.toLowerCase()}`
          : `Confirm ${MERGE_METHODS[method].action.toLowerCase()}`;

  return (
    <div className="fixed inset-0 z-50 grid place-items-center bg-black/50" onMouseDown={(e) => e.target === e.currentTarget && !busy && close()}>
      <div role="dialog" aria-labelledby="merge-h" className="w-[640px] max-w-[calc(100vw-32px)] max-h-[calc(100vh-64px)] flex flex-col rounded-xl bg-raised border border-line-2 shadow-2xl overflow-hidden">
        <div className="flex items-center gap-2.5 px-4 py-3.5">
          <h2 id="merge-h" className="text-[15px] font-bold text-strong">
            Merge pull request
          </h2>
          <span className="text-muted truncate">
            <code className="font-mono text-[11.5px] px-1.5 rounded bg-branch-bg text-branch">{snapshot.details.headRefName}</code> into{' '}
            <code className="font-mono text-[11.5px] px-1.5 rounded bg-branch-bg text-branch">{snapshot.details.baseRefName}</code>
          </span>
          <span className="flex-1" />
          <button type="button" aria-label="Close" onClick={close} className="grid place-items-center w-[26px] h-[26px] rounded-md text-muted hover:text-fg cursor-pointer">
            <Icon name="close" size={13} />
          </button>
        </div>
        <div className="flex-1 overflow-y-auto px-4 pb-4 flex flex-col gap-3.5">
          {!info && !loadError && <Spinner label="Asking GitHub what merging takes…" />}
          {loadError && <ErrorBox message={loadError} onRetry={() => void load()} />}
          {info && (
            <>
              {stale && (
                <div className="flex items-center gap-2.5 px-3 py-2.5 rounded-[9px] bg-warn-bg border border-warn-line">
                  <span className="flex-1 text-fg leading-snug">
                    The branch has commits you haven’t seen here yet. Sync to review them: merging uses the head shown in the app ({snapshot.details.headRefOid.slice(0, 7)}), so GitHub would refuse.
                  </span>
                  <Button size="sm" disabled={busy !== null} onClick={() => void run('Syncing…', () => api.refreshPr(key), false)}>
                    Sync
                  </Button>
                </div>
              )}
              <section aria-label="Rules for merging" className="flex flex-col gap-1.5 px-3 py-2.5 rounded-[9px] bg-panel border border-line-2">
                {mergeRules(info).map((r) => (
                  <div key={r.text} className="flex items-center gap-2.5 min-h-6">
                    <span aria-label={r.tone} className={cx('grid place-items-center w-4 h-4 rounded-full text-[10px] font-extrabold flex-none', TONE[r.tone].className)}>
                      {TONE[r.tone].mark}
                    </span>
                    <span className="flex-1 text-fg">{r.text}</span>
                    {info.mergeStateStatus === 'BEHIND' && r.text.startsWith('The branch is behind') && info.canUpdateBranch && (
                      <>
                        <Button size="sm" disabled={busy !== null} onClick={() => void run('Updating the branch…', () => api.updateBranch(key, 'MERGE'), false)}>
                          Update with merge commit
                        </Button>
                        <Button size="sm" disabled={busy !== null} onClick={() => void run('Updating the branch…', () => api.updateBranch(key, 'REBASE'), false)}>
                          Rebase
                        </Button>
                      </>
                    )}
                  </div>
                ))}
              </section>
              {info.autoMerge.enabled && (
                <div className="flex items-center gap-2.5 px-3 py-2.5 rounded-[9px] bg-info-subtle border border-info-line">
                  <span className="flex-1 text-fg leading-snug">
                    Auto-merge is on: GitHub will {MERGE_METHODS[info.autoMerge.enabled.method].action.toLowerCase()} once the rules are met
                    {info.autoMerge.enabled.by ? ` (turned on by ${info.autoMerge.enabled.by})` : ''}.
                  </span>
                  {info.autoMerge.canDisable && (
                    <Button size="sm" disabled={busy !== null} onClick={() => void run('Turning off auto-merge…', () => api.disableAutoMerge(key), false)}>
                      Turn off
                    </Button>
                  )}
                </div>
              )}
              {showMethods && method && (
                <fieldset className="flex flex-col gap-2">
                  <legend className="mb-2 text-[13px] font-semibold text-strong">Merge method</legend>
                  {info.methods.map((m) => (
                    <label key={m} className={cx('flex gap-2.5 items-start px-3 py-2.5 rounded-[9px] border cursor-pointer', method === m ? 'bg-active border-info-line' : 'border-line-2')}>
                      <input type="radio" name="merge-method" checked={method === m} onChange={() => setMethod(m)} className="mt-0.5" style={{ accentColor: 'var(--c-accent)' }} />
                      <span>
                        <span className="font-semibold text-strong">{MERGE_METHODS[m].title}</span>
                        <br />
                        <span className="text-[12px] text-muted">{MERGE_METHODS[m].desc}</span>
                      </span>
                    </label>
                  ))}
                </fieldset>
              )}
              {showMethods && message && method && method !== 'REBASE' && (
                <section className="flex flex-col gap-1.5">
                  <label htmlFor="merge-headline" className="text-[13px] font-semibold text-strong">
                    Commit message
                  </label>
                  <input
                    id="merge-headline"
                    value={message.headline}
                    onChange={(e) => setMessages((all) => all && { ...all, [method]: { ...all[method], headline: e.target.value } })}
                    className="h-9 px-3 rounded-[9px] bg-side border border-line-2 focus:border-accent outline-none text-fg"
                  />
                  <label htmlFor="merge-body" className="mt-1.5 text-[13px] font-semibold text-strong">
                    Extended description
                  </label>
                  <textarea
                    id="merge-body"
                    rows={8}
                    value={message.body}
                    onChange={(e) => setMessages((all) => all && { ...all, [method]: { ...all[method], body: e.target.value } })}
                    className="resize-y px-3 py-2.5 rounded-[9px] bg-side border border-line-2 focus:border-accent outline-none leading-relaxed font-mono text-[12.5px]"
                  />
                  <span className="flex items-center gap-2 text-[12px] text-muted">
                    GitHub’s proposed message for this method.
                    <button type="button" onClick={() => setMessages((all) => all && { ...all, [method]: info.messages[method] })} className="text-link hover:underline cursor-pointer">
                      Reset
                    </button>
                    {info.authorEmail && <span className="ml-auto">Authored by {info.authorEmail}</span>}
                  </span>
                </section>
              )}
              {showMethods && method === 'REBASE' && <div className="text-[12.5px] text-muted">Each commit keeps its own message.</div>}
              {action === 'merge' && info.deleteBranch === 'optional' && (
                <label className="flex items-center gap-2 cursor-pointer">
                  <input
                    type="checkbox"
                    checked={deleteBranch}
                    onChange={(e) => {
                      setDeleteBranch(e.target.checked);
                      saveDeleteBranch(e.target.checked);
                    }}
                    style={{ accentColor: 'var(--c-accent)' }}
                  />
                  Delete <code className="font-mono text-[11.5px] px-1.5 rounded bg-branch-bg text-branch">{info.headRefName}</code> on GitHub after merging
                </label>
              )}
              {action !== null && action !== 'queue' && info.deleteBranch === 'automatic' && (
                <div className="text-[12.5px] text-muted">GitHub deletes {info.headRefName} after the merge (a repository setting).</div>
              )}
              {verdict === 'blocked' && info.canBypass && (
                <label className="flex items-start gap-2 px-3 py-2.5 rounded-[9px] border border-del-line bg-del-subtle cursor-pointer">
                  <input type="checkbox" checked={bypass} onChange={(e) => setBypass(e.target.checked)} className="mt-0.5" style={{ accentColor: 'var(--c-del)' }} />
                  <span>
                    <span className="font-semibold text-fg">Merge without waiting for the requirements to be met</span>
                    <br />
                    <span className="text-[12px] text-muted">You can bypass the rules for {info.baseRefName}. The merge goes through now, whatever the checks and reviews say.</span>
                  </span>
                </label>
              )}
              {error && <ErrorBox message={error} />}
            </>
          )}
        </div>
        <div className="flex items-center gap-2.5 px-4 py-3 bg-panel border-t border-line-2">
          <span className="flex-1 text-[12px] text-muted">{busy ?? (verdict && !action ? WAITING[verdict] : '')}</span>
          <Button onClick={close} disabled={busy !== null}>
            Cancel
          </Button>
          {verdict === 'draft' && snapshot.details.viewerCan.update ? (
            <Button variant="primary" disabled={busy !== null} onClick={() => void run('Marking it ready for review…', () => api.setPrDraft(key, false), false)}>
              Ready for review
            </Button>
          ) : verdict === 'checking' ? (
            <Button disabled={busy !== null} onClick={() => void run('Checking…', load, false)}>
              Check again
            </Button>
          ) : (
            <Button
              variant={bypass && verdict === 'blocked' ? 'danger' : action === 'auto-merge' ? 'primary' : 'success'}
              disabled={busy !== null || action === null || stale || !method}
              onClick={submit}
            >
              {label}
            </Button>
          )}
        </div>
      </div>
    </div>
  );
}
