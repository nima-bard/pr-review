import { useEffect, useState, type ReactNode } from 'react';
import { LOCAL_CHANGES, type CheckoutMode, type PrSnapshot } from '../../../shared/model';
import { api, errorText } from '../../api';
import { Button, cx, ErrorBox, Icon } from '../../components/ui';
import { Octicon } from '../../components/octicons';
import { showChanges } from '../../dialogs/VersionsDialog';
import { useClaudeSettings } from '../../state/claude';
import { setSessionError } from '../../state/sessions';
import { leaveCommits, updateUi } from '../../state/ui';

const plural = (n: number, one: string, many = `${one}s`) => `${n} ${n === 1 ? one : many}`;
const tilde = (path: string) => path.replace(/^\/Users\/[^/]+/, '~');

/** A checkout step with its button busy meanwhile; a failure shows in the pull request's error banner. */
function useStep(key: string) {
  const [busy, setBusy] = useState<string | null>(null);
  const run = (name: string, step: () => Promise<unknown>) => {
    setBusy(name);
    step()
      .catch((err: unknown) => setSessionError(key, errorText(err)))
      .finally(() => setBusy(null));
  };
  return { busy, run };
}

/**
 * Switches between Review and Contribute; first, unless you said not to, a dialog explains what changes (`SwitchDialog`).
 */
export async function askSwitch(key: string, mode: CheckoutMode): Promise<void> {
  if ((await api.getSettings()).explainCheckout) updateUi(key, { confirmCheckout: mode });
  else await api.setCheckout(key, mode);
}

/** The diffs show what changed in the checkout since the latest push (Local changes), in the Files view. */
export function showLocalChanges(key: string): void {
  updateUi(key, (u) => ({ view: 'files', ...leaveCommits(u) }));
  showChanges(key, LOCAL_CHANGES, 'Local changes');
}

/** Throws away every change not committed in the checkout, once you've said so (the app asks). */
const discardAll = (snapshot: PrSnapshot) => api.discardLocal(snapshot.key, snapshot.worktree.uncommitted);

/** What the two checkout modes are called: the app has no editor, so you contribute in your own (or Claude does). */
const MODES: { mode: CheckoutMode; label: string; icon: 'eye' | 'git-branch' }[] = [
  { mode: 'reading', label: 'Review', icon: 'eye' },
  { mode: 'editing', label: 'Contribute', icon: 'git-branch' },
];

/**
 * Reading the pull request (PR Review's own checkout, which follows each push) or editing it on its branch. In the
 * header, so it shows in every view; editing is in the accent colour, with the strip under the header.
 */
export function CheckoutSwitch({ snapshot }: { snapshot: PrSnapshot }) {
  const key = snapshot.key;
  const { busy, run } = useStep(key);
  const current = snapshot.worktree.checkout;
  const titles: Record<CheckoutMode, string> = {
    reading: 'Review: PR Review’s own worktree, detached at the latest push and updated with every push. Claude can read the code but not edit it.',
    editing: `Contribute: check out ${snapshot.details.headRefName} to commit and push changes, made in your editor or by Claude.`,
  };
  return (
    <div role="radiogroup" aria-label="Checkout" className="inline-flex flex-none p-0.5 rounded-[7px] bg-raised border border-line-2">
      {MODES.map(({ mode, label, icon }) => {
        const on = current === mode;
        return (
          <button
            key={mode}
            type="button"
            role="radio"
            aria-checked={on}
            disabled={busy !== null}
            title={titles[mode]}
            onClick={() => !on && run(mode, () => askSwitch(key, mode))}
            className={cx(
              // As tall as the header's buttons (32px with the frame), and their text; contributing in the accent colour.
              'inline-flex items-center gap-1.5 h-[26px] px-3 rounded-[5px] text-[13px] font-medium cursor-pointer disabled:cursor-default',
              on ? (mode === 'editing' ? 'bg-accent text-ink' : 'bg-sel text-strong') : 'text-soft hover:text-fg',
            )}
          >
            {busy === mode ? (
              <span aria-hidden="true" className="w-3.5 h-3.5 rounded-full border-2 border-line-2 border-t-accent animate-spin" />
            ) : (
              <Octicon name={icon} size={14} />
            )}
            {label}
          </button>
        );
      })}
    </div>
  );
}

/**
 * Under the header while contributing: the branch and where it's checked out, what changed, and the steps that take
 * the changes on (Local changes, Commit, Pull, Push). Reviewing, it shows only when files were changed there anyway (in
 * your editor, say), since the checkout then stops following new pushes.
 */
export function CheckoutBar({ snapshot }: { snapshot: PrSnapshot }) {
  const key = snapshot.key;
  const w = snapshot.worktree;
  const { busy, run } = useStep(key);
  const changed = w.uncommitted.length;
  const showing = snapshot.compare?.from === LOCAL_CHANGES;
  const localButton = (
    <Button size="sm" aria-pressed={showing} onClick={() => showLocalChanges(key)} className={cx(showing && 'border-accent!')}>
      Local changes
    </Button>
  );

  if (w.checkout === 'reading') {
    if (changed === 0) return null;
    return (
      <div role="status" className="flex flex-wrap items-center gap-x-3 gap-y-1.5 px-4 py-1.5 bg-warn-bg border-b border-warn-line text-[12px] text-fg flex-none">
        <Octicon name="eye" size={13} className="text-warn" />
        <span className="min-w-0">
          {plural(changed, 'file has', 'files have')} uncommitted changes in PR Review’s worktree. It won’t follow new pushes until you discard them or switch to Contribute.
        </span>
        <span className="flex-1" />
        {localButton}
        <Button size="sm" disabled={busy !== null} onClick={() => run('discard', () => discardAll(snapshot))}>
          Discard
        </Button>
        <Button size="sm" disabled={busy !== null} onClick={() => run('edit', () => askSwitch(key, 'editing'))}>
          Contribute
        </Button>
      </div>
    );
  }

  const sync = w.sync;
  const facts = [
    changed > 0 ? plural(changed, 'uncommitted file') : 'no uncommitted changes',
    sync && sync.ahead > 0 ? plural(sync.ahead, 'unpushed commit') : null,
    sync && sync.behind > 0 ? `${plural(sync.behind, 'new commit')} on GitHub` : null,
  ].filter((f): f is string => f !== null);
  return (
    // One row: a long path gives way first, from its left, then the facts; the buttons stay.
    <div role="status" aria-label="Contributing" className="flex items-center gap-x-3 px-4 py-1.5 bg-info-bg border-b border-info-line text-[12px] text-fg whitespace-nowrap flex-none">
      {/* Short of room, only the path gives way (from its left): a fraction of a pixel taken from the branch or the facts
          would already cut them. A very long branch name is cut at about half the room. */}
      <span className="flex items-center gap-1.5 min-w-0 flex-1 overflow-hidden">
        <Octicon name="git-branch" size={13} className="text-accent flex-none" />
        {w.branch ? (
          <>
            <span className="flex-none">Contributing on</span>{' '}
            <code className="font-mono text-[11.5px] px-1.5 rounded bg-branch-bg text-branch shrink-0 max-w-[45%] truncate">{w.branch}</code>{' '}
            {!w.owned && (
              <span className="flex min-w-0 overflow-hidden text-muted" title={`Your own worktree, which already had this branch checked out: ${w.path}`}>
                <span className="flex-none">in your worktree&nbsp;</span>
                <span dir="rtl" className="min-w-0 truncate font-mono">
                  <bdi dir="ltr">{tilde(w.path)}</bdi>
                </span>
              </span>
            )}
            {' '}
            <span className="shrink-0 text-muted ml-1.5">{facts.join(' · ')}</span>
          </>
        ) : (
          <span className="text-warn min-w-0 truncate">Couldn’t check out the branch. Switch to Review and back to try again.</span>
        )}
      </span>
      {localButton}
      {changed > 0 && (
        <Button size="sm" disabled={busy !== null} onClick={() => run('discard', () => discardAll(snapshot))}>
          Discard
        </Button>
      )}
      <Button size="sm" disabled={busy !== null || changed === 0 || !w.branch} title={changed === 0 ? 'No changes to commit' : undefined} onClick={() => updateUi(key, { showCommit: true })}>
        <Octicon name="git-commit" size={13} />
        Commit…
      </Button>
      {sync && sync.behind > 0 && (
        <Button size="sm" disabled={busy !== null || changed > 0} title={changed > 0 ? 'Commit or discard your changes first' : `Rebase your commits onto ${plural(sync.behind, 'new commit')} from GitHub`} onClick={() => run('pull', () => api.pullLocal(key))}>
          {busy === 'pull' ? 'Pulling…' : `Pull ${sync.behind}`}
        </Button>
      )}
      {sync && sync.ahead > 0 && (
        <Button
          size="sm"
          variant="primary"
          disabled={busy !== null || !w.canPush}
          title={w.canPush ? `Push ${plural(sync.ahead, 'commit')} to ${snapshot.details.headRefName}` : 'You can’t push to this pull request’s branch'}
          onClick={() => run('push', () => api.pushLocal(key))}
        >
          {busy === 'push' ? 'Pushing…' : `Push ${sync.ahead}`}
        </Button>
      )}
    </div>
  );
}

/** Commits every change in the checkout with a message, and pushes it too if you like (⌘↩ commits). */
export function CommitDialog({ snapshot }: { snapshot: PrSnapshot }) {
  const key = snapshot.key;
  const w = snapshot.worktree;
  const [message, setMessage] = useState('');
  const [busy, setBusy] = useState<'commit' | 'push' | null>(null);
  const [error, setError] = useState<string | null>(null);
  const close = () => updateUi(key, { showCommit: false });
  const commit = (push: boolean) => {
    if (!message.trim() || busy) return;
    setBusy(push ? 'push' : 'commit');
    setError(null);
    api
      .commitLocal(key, message)
      .then(
        () =>
          push
            ? api.pushLocal(key).catch((err: unknown) => {
                throw new Error(`Committed, but pushing failed: ${errorText(err)}`);
              })
            : undefined,
      )
      .then(close, (err: unknown) => {
        setError(errorText(err));
        setBusy(null);
      });
  };
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => e.key === 'Escape' && close();
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  });
  const shown = w.uncommitted.slice(0, 12);
  return (
    <div className="fixed inset-0 z-50 grid place-items-center bg-black/50" onMouseDown={(e) => e.target === e.currentTarget && close()}>
      <div role="dialog" aria-labelledby="commit-h" className="w-[520px] max-w-[calc(100vw-32px)] flex flex-col rounded-xl bg-raised border border-line-2 shadow-2xl overflow-hidden">
        <div className="flex items-center gap-2.5 px-4 py-3.5 border-b border-line-2">
          <h2 id="commit-h" className="text-[15px] font-bold text-strong">
            Commit changes
          </h2>
          <span className="text-muted text-[12px]">
            on <span className="font-mono">{w.branch}</span>
          </span>
          <span className="flex-1" />
          <button type="button" aria-label="Close" onClick={close} className="grid place-items-center w-[26px] h-[26px] rounded-md text-muted hover:text-fg cursor-pointer">
            <Icon name="close" size={13} />
          </button>
        </div>
        <div className="flex flex-col gap-3 px-4 py-3">
          <ul aria-label="Files to commit" className="flex flex-col gap-0.5 text-[12px] font-mono text-muted max-h-40 overflow-y-auto">
            {shown.map((p) => (
              <li key={p} className="truncate" title={p}>
                {p}
              </li>
            ))}
            {w.uncommitted.length > shown.length && <li className="font-sans">and {plural(w.uncommitted.length - shown.length, 'more file')}</li>}
          </ul>
          <label className="flex flex-col gap-1.5 text-[12px] text-muted">
            Message
            <textarea
              autoFocus
              rows={3}
              value={message}
              onChange={(e) => setMessage(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === 'Enter' && e.metaKey) commit(false);
              }}
              placeholder="What this changes"
              className="px-2.5 py-2 rounded-md bg-inset border border-line-2 text-fg text-[13px] font-sans resize-y focus:outline-none focus:border-accent"
            />
          </label>
          {error && <ErrorBox message={error} />}
        </div>
        <div className="flex items-center justify-end gap-2 px-4 py-3 border-t border-line-2">
          <Button onClick={close}>Cancel</Button>
          <Button disabled={!message.trim() || busy !== null} onClick={() => commit(false)}>
            {busy === 'commit' ? 'Committing…' : 'Commit'}
          </Button>
          {w.canPush && (
            <Button variant="primary" disabled={!message.trim() || busy !== null} onClick={() => commit(true)}>
              {busy === 'push' ? 'Pushing…' : 'Commit and push'}
            </Button>
          )}
        </div>
      </div>
    </div>
  );
}

/**
 * Before a switch between Review and Contribute: where the pull request will be checked out, and what changes in how
 * you work (and what Claude may do). Going back to reviewing waits for changes not committed to be committed or
 * discarded. "Don't explain this again" turns it off; Settings › General turns it back on.
 */
export function SwitchDialog({ snapshot, to }: { snapshot: PrSnapshot; to: CheckoutMode }) {
  const key = snapshot.key;
  const w = snapshot.worktree;
  const branch = snapshot.details.headRefName;
  const claude = useClaudeSettings((c) => c.enabled);
  const [where, setWhere] = useState<{ path: string; yours: boolean } | null>(null);
  const [quiet, setQuiet] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const close = () => updateUi(key, { confirmCheckout: null });
  useEffect(() => {
    api.checkoutPlan(key, to).then(setWhere, () => setWhere(null));
  }, [key, to]);
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => e.key === 'Escape' && close();
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  });
  const code = (text: string) => <code className="font-mono text-[12px] px-1 rounded bg-branch-bg text-branch">{text}</code>;
  const blocked = to === 'reading' && w.uncommitted.length > 0;
  const ahead = w.sync?.ahead ?? 0;
  const points: ReactNode[] =
    to === 'editing'
      ? [
          where?.yours ? (
            <>
              {code(branch)} is already checked out in your worktree <span className="font-mono text-[12px]">{tilde(where.path)}</span>, so PR Review uses that one. It won’t pull,
              reset or delete anything there on its own.
            </>
          ) : (
            <>
              Checks out {code(branch)} in PR Review’s worktree{where ? <> <span className="font-mono text-[12px]">{tilde(where.path)}</span></> : null}. Open it in your editor to
              work on it.
            </>
          ),
          `Edit files in your editor${claude ? ' or ask Claude' : ''}. Uncommitted changes and unpushed commits show under Local changes.`,
          w.canPush
            ? `Commit and push them manually${claude ? ', or ask Claude to' : ''}.`
            : 'You can commit, but you can’t push to this branch (no write access), so your commits stay local.',
          'New commits on GitHub aren’t pulled in automatically anymore. The bar shows when there are some, and Pull rebases your commits onto them.',
        ]
      : [
          'PR Review switches back to its own worktree, detached at the latest push, and updates it with every new push again.',
          ...(ahead > 0 ? [<>Your {plural(ahead, 'unpushed commit')} stay on the local branch {code(branch)}.</>] : []),
          ...(claude ? ['Claude can read the code but can’t edit files anymore.'] : []),
        ];
  const go = () => {
    setBusy(true);
    setError(null);
    const remember = quiet ? api.getSettings().then((s) => api.saveSettings({ ...s, explainCheckout: false })) : Promise.resolve();
    remember
      .then(() => api.setCheckout(key, to))
      .then(close, (err: unknown) => {
        setError(errorText(err));
        setBusy(false);
      });
  };
  return (
    <div className="fixed inset-0 z-50 grid place-items-center bg-black/50" onMouseDown={(e) => e.target === e.currentTarget && close()}>
      <div role="dialog" aria-labelledby="switch-h" className="w-[520px] max-w-[calc(100vw-32px)] flex flex-col rounded-xl bg-raised border border-line-2 shadow-2xl overflow-hidden">
        <div className="flex items-center gap-2.5 px-4 py-3.5 border-b border-line-2">
          <Octicon name={to === 'editing' ? 'git-branch' : 'eye'} size={15} className={to === 'editing' ? 'text-accent' : 'text-muted'} />
          <h2 id="switch-h" className="text-[15px] font-bold text-strong">
            {to === 'editing' ? 'Contribute to this pull request?' : 'Back to reviewing?'}
          </h2>
        </div>
        <div className="flex flex-col gap-3 px-4 py-3.5 text-[13px] text-fg">
          <ul className="flex flex-col gap-2 pl-4 list-disc marker:text-muted">
            {points.map((p, i) => (
              <li key={i}>{p}</li>
            ))}
          </ul>
          {blocked && (
            <div role="alert" className="flex flex-wrap items-center gap-2 px-3 py-2 rounded-lg bg-warn-bg border border-warn-line text-[12.5px]">
              <span className="flex-1 min-w-0">
                {plural(w.uncommitted.length, 'file has', 'files have')} uncommitted changes. Commit or discard them first.
              </span>
              <Button
                size="sm"
                onClick={() => {
                  close();
                  showLocalChanges(key);
                }}
              >
                Local changes
              </Button>
            </div>
          )}
          {error && <ErrorBox message={error} />}
        </div>
        <div className="flex items-center gap-2 px-4 py-3 border-t border-line-2">
          <label className="flex items-center gap-2 text-[12px] text-muted cursor-pointer flex-1 min-w-0">
            <input type="checkbox" checked={quiet} onChange={(e) => setQuiet(e.target.checked)} style={{ accentColor: 'var(--c-accent)' }} />
            Don’t explain this again
          </label>
          <Button onClick={close}>Cancel</Button>
          <Button variant="primary" disabled={busy || blocked} onClick={go}>
            {busy ? 'Switching…' : to === 'editing' ? 'Contribute' : 'Back to reviewing'}
          </Button>
        </div>
      </div>
    </div>
  );
}
