import { useEffect, useState } from 'react';
import type { RepoMapping, WorktreeInfo } from '../../../shared/model';
import { api, errorText } from '../../api';
import { Badge, Button, ErrorBox, Icon, shortSha, Spinner } from '../../components/ui';
import { openPr } from '../../state/tabs';

export function WorktreesView({ tabId }: { tabId: string }) {
  const [list, setList] = useState<WorktreeInfo[] | null>(null);
  const [repos, setRepos] = useState<RepoMapping[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [confirm, setConfirm] = useState<string | null>(null);

  const load = async () => {
    try {
      setList(await api.listWorktrees());
      setRepos(await api.listRepos());
    } catch (err) {
      setError(errorText(err));
    }
  };

  useEffect(() => {
    void load();
  }, []);

  const remove = async (w: WorktreeInfo) => {
    if (confirm !== w.path) {
      setConfirm(w.path);
      return;
    }
    setConfirm(null);
    try {
      await api.removeWorktree(w.repoPath, w.path);
      await load();
    } catch (err) {
      setError(errorText(err));
    }
  };

  const linked = list?.filter((w) => !w.isPrimary) ?? [];

  return (
    <div className="grid gap-6 items-start" style={{ gridTemplateColumns: 'repeat(auto-fit, minmax(440px, 1fr))' }}>
      <section aria-labelledby="wt-h" className="flex flex-col gap-2.5">
        <div className="flex items-baseline gap-2">
          <h2 id="wt-h" className="text-[14px] font-semibold text-strong">
            Worktrees on this machine
          </h2>
          <span className="text-muted">{linked.length}</span>
          <span className="flex-1" />
          <Button size="sm" variant="ghost" onClick={() => void load()}>
            <Icon name="refresh" size={12} /> Refresh
          </Button>
        </div>
        {error && <ErrorBox message={error} />}
        {!list && <Spinner label="Scanning…" />}
        <div className="border border-line-2 rounded-[10px] overflow-hidden">
          {linked.length === 0 && list && <div className="px-3.5 py-3 text-muted bg-panel">No linked worktrees in your repositories.</div>}
          {linked.map((w) => (
            <div key={w.path} className="flex gap-3 items-center px-3.5 py-2.5 bg-panel border-b border-line last:border-b-0">
              <Icon name="folder" className="text-muted" />
              <span className="flex-1 min-w-0 flex flex-col gap-0.5">
                <span className="font-mono text-[12px] text-fg truncate">{w.path}</span>
                <span className="text-[12px] text-muted">
                  {w.slug ?? 'unknown repo'} · {w.detached ? `detached at ${shortSha(w.head)}` : `branch ${w.branch}`}
                </span>
              </span>
              {w.locked !== null && (
                <Badge tone="purple">
                  <Icon name="lock" size={11} /> Locked{w.locked ? ` · ${w.locked.slice(0, 32)}` : ''}
                </Badge>
              )}
              {w.owned && <Badge tone="info">Created here</Badge>}
              {w.prNumber && w.slug && (
                <Button size="sm" onClick={() => void openPr(`${w.slug}#${w.prNumber}`, tabId)}>
                  Open PR
                </Button>
              )}
              {w.locked === null && (
                <Button size="sm" variant={confirm === w.path ? 'danger' : 'secondary'} onClick={() => void remove(w)}>
                  {confirm === w.path ? 'Confirm remove' : 'Remove'}
                </Button>
              )}
            </div>
          ))}
        </div>
        <p className="text-muted text-[12px]">Locked worktrees (e.g. Claude Code sessions) are never removed. Removing refuses worktrees with uncommitted changes.</p>
      </section>
      <section aria-labelledby="repo-h" className="flex flex-col gap-2.5">
        <div className="flex items-baseline gap-2">
          <h2 id="repo-h" className="text-[14px] font-semibold text-strong">
            Repositories
          </h2>
          <span className="text-muted">{repos.length}</span>
          <span className="flex-1" />
          <Button size="sm" variant="ghost" onClick={async () => setRepos(await api.rescanRepos())}>
            Rescan
          </Button>
        </div>
        <div className="border border-line-2 rounded-[10px] overflow-hidden">
          {repos.map((r) => (
            <div key={r.slug} className="flex gap-3 items-center px-3.5 py-2 bg-panel border-b border-line last:border-b-0">
              <span className="font-mono text-[12px] text-fg min-w-[200px]">{r.slug}</span>
              <span aria-hidden="true" className="text-faint">
                →
              </span>
              <span className="flex-1 font-mono text-[12px] text-muted truncate">{r.path}</span>
              {r.source === 'manual' && <Badge>manual</Badge>}
            </div>
          ))}
        </div>
      </section>
    </div>
  );
}
