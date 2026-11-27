import { useEffect, useState } from 'react';
import type { CommitsData, PrSnapshot } from '../../../shared/model';
import { api, errorText } from '../../api';
import { Badge, Button, ErrorBox, shortSha, Spinner, timeAgo } from '../../components/ui';
import { showChanges } from '../../dialogs/VersionsDialog';
import { updateUi } from '../../state/ui';

/**
 * The pull request's commits, grouped by push, chosen with the Commits icon on the left: they take the place of the
 * file tree and the diffs. "Changes after this" shows the diffs again, from that commit.
 */
export function CommitsView({ snapshot }: { snapshot: PrSnapshot }) {
  const [data, setData] = useState<CommitsData | null>(null);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => {
    api.listCommits(snapshot.key).then(setData, (err: unknown) => setError(errorText(err)));
  }, [snapshot.key, snapshot.details.headRefOid]);

  const showFrom = (sha: string, label: string) => {
    updateUi(snapshot.key, { sidebar: 'files', showTree: true, activeContent: 'changes' });
    showChanges(snapshot.key, sha, label);
  };

  return (
    <div className="h-full overflow-y-auto">
      <div className="max-w-[900px] mx-auto px-5 py-4 flex flex-col gap-3">
        {error && <ErrorBox message={error} />}
        {!data && !error && <Spinner label="Loading commits…" />}
        {data &&
          [...data.groups].reverse().map((g) => (
            <section key={g.version.sha} className="flex flex-col gap-1.5">
              <div className="flex items-center gap-2 pt-2">
                <span className="font-mono text-[12px] font-bold text-strong">v{g.version.n}</span>
                <span className="text-muted text-[12px]">
                  {g.version.forcePush ? 'force-pushed' : 'pushed'} {timeAgo(g.version.seenAt)}
                </span>
                {g.version.sha === snapshot.details.headRefOid && <Badge tone="info">Head</Badge>}
                {g.version.sha === snapshot.lastReviewedOid && <Badge tone="purple">You reviewed here</Badge>}
                {!g.inHistory && <Badge>Replaced by a force-push</Badge>}
                {g.rangeDiff && (
                  <Badge tone="warn">
                    Rebased: {g.rangeDiff.identical} identical, {g.rangeDiff.changed} changed
                  </Badge>
                )}
                <span className="flex-1 h-px bg-line" />
              </div>
              <div className="border border-line-2 rounded-[10px] overflow-hidden">
                {g.commits.length === 0 && <div className="px-3.5 py-2.5 bg-panel text-muted text-[12.5px]">{g.inHistory ? 'No new commits in this push.' : `Head was ${shortSha(g.version.sha)}`}</div>}
                {[...g.commits].reverse().map((c) => (
                  <div key={c.sha} className="flex items-center gap-3 px-3.5 py-2.5 bg-panel border-b border-line last:border-b-0">
                    <span className="flex-1 min-w-0 flex flex-col gap-0.5">
                      <span className="font-semibold text-strong truncate">{c.subject}</span>
                      <span className="text-muted text-[12px]">
                        {c.author} committed {timeAgo(c.date)}
                      </span>
                    </span>
                    <span className="font-mono text-[11.5px] text-soft">{shortSha(c.sha)}</span>
                    <Button size="sm" onClick={() => showFrom(c.sha, `Since ${shortSha(c.sha)}`)}>
                      Changes after this
                    </Button>
                  </div>
                ))}
              </div>
            </section>
          ))}
      </div>
    </div>
  );
}
