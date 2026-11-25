import { useEffect, useState } from 'react';
import type { CommitsData, PrSnapshot } from '../../shared/model';
import { api, errorText } from '../api';
import { setSessionError } from '../state/sessions';
import { Badge, Button, cx, ErrorBox, Icon, Spinner, shortSha, timeAgo } from '../components/ui';
import { updateUi } from '../state/ui';

/**
 * Switches the diff to the changes after `from` (null: all changes). It returns at once: the Changes button shows the
 * new choice with a spinner until the file list arrives, and a failure shows in the PR's error banner.
 */
export function showChanges(key: string, from: string | null, label: string): void {
  updateUi(key, { pendingCompare: label });
  void api
    .setCompare(key, from, label)
    .catch((err: unknown) => setSessionError(key, `Couldn't switch to "${label}": ${errorText(err)}`))
    .finally(() => updateUi(key, { pendingCompare: null }));
}

export function VersionsDialog({ snapshot }: { snapshot: PrSnapshot }) {
  const key = snapshot.key;
  const [data, setData] = useState<CommitsData | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [from, setFrom] = useState<string | null>(snapshot.compare?.from ?? null);
  const [showOld, setShowOld] = useState(false);
  const head = snapshot.details.headRefOid;
  const last = snapshot.lastReviewedOid;
  const close = () => updateUi(key, { showVersions: false });

  useEffect(() => {
    api.listCommits(key).then(setData, (err: unknown) => setError(errorText(err)));
  }, [key]);


  const lastVersion = last ? snapshot.versions.find((v) => v.sha === last) : undefined;
  const headVersion = snapshot.versions.find((v) => v.sha === head);
  const groups = [...(data?.groups ?? [])].reverse();
  const current = groups.filter((g) => g.inHistory);
  const replaced = groups.filter((g) => !g.inHistory);
  const selectedCount = from === null ? data?.commits.length ?? 0 : (() => {
    const idx = data?.commits.findIndex((c) => c.sha === from) ?? -1;
    return idx === -1 ? 0 : (data?.commits.length ?? 0) - idx - 1;
  })();

  return (
    <div className="fixed inset-0 z-50 grid place-items-center bg-black/50" onMouseDown={(e) => e.target === e.currentTarget && close()}>
      <div role="dialog" aria-labelledby="ver-h" className="w-[560px] max-w-[calc(100vw-32px)] max-h-[calc(100vh-64px)] flex flex-col rounded-xl bg-raised border border-line-2 shadow-2xl overflow-hidden">
        <div className="flex items-center gap-2.5 px-4 py-3.5 border-b border-line-2">
          <h2 id="ver-h" className="text-[15px] font-bold text-strong">
            Select changes to view
          </h2>
          <span className="flex-1" />
          <button type="button" aria-label="Close" onClick={close} className="grid place-items-center w-[26px] h-[26px] rounded-md text-muted hover:text-fg cursor-pointer">
            <Icon name="close" size={13} />
          </button>
        </div>
        <div role="radiogroup" aria-label="Presets" className="px-2 py-1.5 border-b border-line-2">
          {lastVersion && last !== head && (
            <button type="button" role="radio" aria-checked={from === last} onClick={() => setFrom(last)} className={cx('flex w-full gap-2.5 items-start text-left px-2 py-2 rounded-lg cursor-pointer', from === last && 'bg-active')}>
              <span className="w-4 pt-0.5 text-accent">{from === last && <Icon name="check" size={15} />}</span>
              <span className="flex flex-col gap-0.5">
                <span className="font-semibold text-strong text-[13.5px]">Changes since your last review</span>
                <span className="text-muted text-[12px]">
                  v{lastVersion.n} → v{headVersion?.n ?? '?'} · only files this PR touches, so rebase noise is hidden
                </span>
              </span>
            </button>
          )}
          <button type="button" role="radio" aria-checked={from === null} onClick={() => setFrom(null)} className={cx('flex w-full gap-2.5 items-start text-left px-2 py-2 rounded-lg cursor-pointer', from === null && 'bg-active')}>
            <span className="w-4 pt-0.5 text-accent">{from === null && <Icon name="check" size={15} />}</span>
            <span className="flex flex-col gap-0.5">
              <span className="font-semibold text-strong text-[13.5px]">All changes</span>
              <span className="text-muted text-[12px]">{data ? `${data.commits.length} commits · ` : ''}against the merge-base with {snapshot.details.baseRefName}</span>
            </span>
          </button>
        </div>
        <div className="px-4 py-2 bg-panel border-b border-line-2 text-muted text-[12px] font-semibold">Or start from a commit · grouped by push</div>
        <div className="flex-1 overflow-y-auto px-2 pt-1 pb-2">
          {error && <ErrorBox message={error} />}
          {!data && !error && (
            <div className="p-3">
              <Spinner label="Loading commits…" />
            </div>
          )}
          {current.map((g) => (
            <div key={g.version.sha}>
              <div className="flex items-center gap-2 px-2 pt-3 pb-1.5">
                <span className="font-mono text-[11.5px] font-bold text-strong">v{g.version.n}</span>
                <span className="text-muted text-[12px]">
                  {g.version.forcePush ? 'force-pushed' : 'pushed'} {timeAgo(g.version.seenAt)}
                </span>
                {g.version.sha === head && <Badge tone="info">Head</Badge>}
                {g.rangeDiff && <Badge tone="warn">Rebased</Badge>}
                {g.version.sha === last && <Badge tone="purple">You reviewed here</Badge>}
                <span className="flex-1 h-px bg-line" />
              </div>
              {g.rangeDiff && (
                <div className="mx-1 my-1 px-2.5 py-2 rounded-lg bg-warn-subtle border border-warn-line text-[12px] text-warn-soft">
                  Range-diff vs the previous version: {g.rangeDiff.identical} identical, {g.rangeDiff.changed} changed, {g.rangeDiff.added} new, {g.rangeDiff.removed} dropped.
                </div>
              )}
              {[...g.commits].reverse().map((c) => {
                const included = from !== null && data ? data.commits.findIndex((x) => x.sha === c.sha) > data.commits.findIndex((x) => x.sha === from) : from === null;
                return (
                  <label key={c.sha} className={cx('flex gap-2.5 items-start px-2 py-2 rounded-lg cursor-pointer', included && 'bg-active')}>
                    <input type="radio" name="from" checked={from === c.sha} onChange={() => setFrom(c.sha)} className="mt-1" aria-label={`Show changes after ${c.subject}`} style={{ accentColor: 'var(--c-accent)' }} />
                    <span className="flex-1 min-w-0 flex flex-col gap-0.5">
                      <span className={cx('font-semibold leading-snug', included ? 'text-strong' : 'text-fg')}>{c.subject}</span>
                      <span className="text-muted text-[12px]">
                        {c.author} committed {timeAgo(c.date)}
                      </span>
                    </span>
                    <span className="font-mono text-[11.5px] text-soft pt-0.5">{shortSha(c.sha)}</span>
                  </label>
                );
              })}
            </div>
          ))}
          {replaced.length > 0 && (
            <button type="button" onClick={() => setShowOld(!showOld)} className="flex w-full gap-2.5 items-center text-left px-2.5 py-2 mt-2 rounded-lg border border-dashed border-line-2 text-soft cursor-pointer">
              <Icon name="chevron" size={13} rotate={showOld ? 0 : -90} />
              <span className="flex-1">
                {replaced.length} version{replaced.length === 1 ? '' : 's'} replaced by force-pushes
              </span>
              <Badge>kept locally</Badge>
            </button>
          )}
          {showOld &&
            replaced.map((g) => (
              <label key={g.version.sha} className="flex gap-2.5 items-start px-2 py-2 rounded-lg cursor-pointer">
                <input type="radio" name="from" checked={from === g.version.sha} onChange={() => setFrom(g.version.sha)} className="mt-1" style={{ accentColor: 'var(--c-accent)' }} />
                <span className="flex-1 flex flex-col gap-0.5">
                  <span className="font-semibold text-fg">
                    v{g.version.n} · {shortSha(g.version.sha)}
                  </span>
                  <span className="text-muted text-[12px]">seen {timeAgo(g.version.seenAt)} · compare it with head</span>
                </span>
                {g.version.sha === last && <Badge tone="purple">You reviewed this</Badge>}
              </label>
            ))}
        </div>
        <div className="flex items-center gap-2.5 px-4 py-3 bg-panel border-t border-line-2">
          <span className="flex-1 text-[12px] text-muted">{from === null ? 'All changes in the PR' : `${selectedCount} commit${selectedCount === 1 ? '' : 's'} up to head`}</span>
          <Button onClick={close}>Cancel</Button>
          <Button
            variant="primary"
            onClick={() => {
              close();
              showChanges(key, from, from === null ? 'All changes' : from === last ? 'Since your last review' : `Since ${shortSha(from)}`);
            }}
          >
            Show changes
          </Button>
        </div>
      </div>
    </div>
  );
}
