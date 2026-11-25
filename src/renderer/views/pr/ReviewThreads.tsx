import { useMemo, useState } from 'react';
import type { PrSnapshot, ThreadView } from '../../../shared/model';
import { api, errorText } from '../../api';
import { FileIcon } from '../../components/fileIcons';
import { Avatar, Badge, Button, cx, Icon } from '../../components/ui';
import { threadLocation, ThreadCard } from '../../diff/ThreadCard';
import { useFileContent } from '../../diff/useFileDiff';
import { focusFile, updateUi } from '../../state/ui';
import { isClaudeGenerated, isViewersWord } from '../../../shared/triage';

export type ThreadGroup = 'needs-reply' | 'likely-addressed' | 'waiting' | 'others' | 'resolved';

interface Group {
  id: ThreadGroup;
  title: string;
  hint: string;
  dot: string;
}

const AUTHOR_GROUPS: Group[] = [
  { id: 'needs-reply', title: 'Needs your reply', hint: "last word isn't yours (Claude's counts as theirs)", dot: 'var(--c-accent)' },
  { id: 'likely-addressed', title: 'Likely addressed', hint: 'code changed since the last comment', dot: 'var(--c-warn)' },
  { id: 'waiting', title: 'Waiting on reviewer', hint: 'you replied last', dot: 'var(--c-faint)' },
  { id: 'resolved', title: 'Resolved', hint: '', dot: 'var(--c-add)' },
];

const REVIEWER_GROUPS: Group[] = [
  { id: 'needs-reply', title: 'Replies to you', hint: 'someone answered your thread', dot: 'var(--c-accent)' },
  { id: 'likely-addressed', title: 'Likely addressed', hint: 'code changed since your thread · check and resolve', dot: 'var(--c-warn)' },
  { id: 'waiting', title: 'Waiting on author', hint: 'you commented last', dot: 'var(--c-faint)' },
  { id: 'others', title: 'Other open threads', hint: "threads you haven't joined", dot: 'var(--c-dim)' },
  { id: 'resolved', title: 'Resolved', hint: '', dot: 'var(--c-add)' },
];

/**
 * The author sees every thread from their side (the stored triage). A reviewer only "owes" something on threads they
 * took part in; everyone else's threads are listed separately so they don't read as "needs your reply".
 */
export function threadGroup(t: ThreadView, role: PrSnapshot['role']): ThreadGroup {
  if (t.isResolved) return 'resolved';
  if (role === 'reviewer' && !t.comments.some((c) => c.viewerDidAuthor)) return 'others';
  return t.triage;
}

function CodeContext({ snapshot, thread }: { snapshot: PrSnapshot; thread: ThreadView }) {
  const author = snapshot.role === 'author';
  const rev = thread.side === 'LEFT' ? 'base' : author ? 'worktree' : 'head';
  const content = useFileContent(snapshot.key, `${snapshot.details.headRefOid}:${snapshot.syncedAt}`, rev, thread.anchor.line !== undefined ? thread.anchor.path : null);
  if (!content || thread.anchor.line === undefined || content.missing) return null;
  const lines = content.contents.split('\n');
  const start = Math.max(1, thread.anchor.line - 3);
  const endLine = thread.anchor.endLine ?? thread.anchor.line;
  const end = Math.min(lines.length, endLine + 3);
  return (
    <div className="rounded-[9px] border border-line-2 bg-side overflow-hidden">
      <div className="flex items-center gap-2 px-3 py-1.5 text-[11.5px] text-muted border-b border-line">
        <FileIcon path={thread.anchor.path} size={14} />
        <span className="font-mono truncate">{thread.anchor.path}</span>
        <span className="flex-none">{rev === 'worktree' ? 'your working tree' : rev === 'head' ? 'PR head' : 'base'}</span>
        {thread.anchor.locallyModified && <Badge tone="warn">uncommitted changes</Badge>}
      </div>
      <div className="font-mono text-code leading-[1.6] overflow-x-auto py-1">
        {lines.slice(start - 1, end).map((text, i) => {
          const n = start + i;
          const hit = n >= thread.anchor.line! && n <= endLine;
          return (
            <div key={n} className={cx('grid min-w-[560px]', hit && 'bg-info-bg')} style={{ gridTemplateColumns: '4px 48px minmax(0,1fr)' }}>
              <span style={{ background: hit ? 'var(--c-accent)' : 'transparent' }} />
              <span className={cx('text-right pr-3 select-none', hit ? 'text-strong' : 'text-faint')}>{n}</span>
              <span className="whitespace-pre">{text}</span>
            </div>
          );
        })}
      </div>
    </div>
  );
}

function ReRequest({ snapshot }: { snapshot: PrSnapshot }) {
  const candidates = snapshot.details.reviewers.filter((r) => !r.login.startsWith('@') && r.state !== 'REQUESTED' && r.login !== snapshot.viewer);
  const [selected, setSelected] = useState<string[]>(() => candidates.filter((r) => r.state === 'CHANGES_REQUESTED' || r.state === 'COMMENTED').map((r) => r.login));
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState<string | null>(null);
  if (candidates.length === 0) return null;
  return (
    <div className="flex flex-wrap items-center gap-2 px-3 py-2.5 rounded-[10px] border border-line-2 bg-card">
      <span className="font-semibold text-strong">Re-request review</span>
      {candidates.map((r) => (
        <label key={r.login} className="flex items-center gap-1.5 px-2 py-0.5 rounded-full bg-raised border border-line-2 cursor-pointer">
          <input
            type="checkbox"
            checked={selected.includes(r.login)}
            onChange={() => setSelected((s) => (s.includes(r.login) ? s.filter((x) => x !== r.login) : [...s, r.login]))}
            style={{ accentColor: 'var(--c-accent)' }}
          />
          <Avatar login={r.login} url={r.avatarUrl} size={16} />
          <span className="text-[12px]">{r.login}</span>
        </label>
      ))}
      <span className="flex-1" />
      {msg && <span className="text-[12px] text-muted">{msg}</span>}
      <Button
        variant="primary"
        size="sm"
        disabled={busy || selected.length === 0}
        onClick={async () => {
          setBusy(true);
          try {
            await api.requestReviews(snapshot.key, selected);
            setMsg('Review re-requested.');
          } catch (err) {
            setMsg(errorText(err));
          } finally {
            setBusy(false);
          }
        }}
      >
        Request
      </Button>
    </div>
  );
}

function ThreadRow({ snapshot, thread, open, onToggle }: { snapshot: PrSnapshot; thread: ThreadView; open: boolean; onToggle(): void }) {
  const first = thread.comments[0];
  const last = thread.comments.at(-1);
  return (
    <div className="border-b border-line last:border-b-0">
      <button type="button" aria-expanded={open} onClick={onToggle} className={cx('flex w-full items-center gap-2.5 px-3.5 py-2 text-left cursor-pointer', open ? 'bg-active' : 'hover:bg-hover')}>
        <Icon name="chevron" size={12} rotate={open ? 0 : -90} className="text-muted flex-none" />
        <Avatar login={first?.author ?? '?'} url={first?.avatarUrl} size={20} />
        <span className="flex items-center gap-1.5 flex-none max-w-[38%] min-w-0">
          <FileIcon path={thread.anchor.path} size={14} />
          <span className="font-mono text-[11.5px] text-soft truncate">{thread.anchor.path.split('/').pop()}</span>
          <span className="font-mono text-[11.5px] text-muted flex-none">{threadLocation(thread)}</span>
        </span>
        <span className="flex-1 min-w-0 truncate text-[12.5px] text-fg">
          <span className="font-semibold text-strong">{first?.author}</span> {first?.body.split('\n')[0]}
        </span>
        {thread.anchor.locallyModified && <Badge tone="warn">Local edit</Badge>}
        {thread.isOutdated && !thread.anchor.locallyModified && <Badge tone="warn">Outdated</Badge>}
        {/```suggestion/.test(first?.body ?? '') && <Badge>Suggestion</Badge>}
        <span className="flex-none text-[11.5px] text-muted">
          {last && isClaudeGenerated(last.body) ? `Claude${last.viewerDidAuthor ? ' (as you)' : ''}` : last && isViewersWord(last, snapshot.role === 'author') ? 'you' : last?.author} · {thread.comments.length}
        </span>
      </button>
      {open && (
        <div className="flex flex-col gap-2.5 px-3.5 pt-1 pb-3.5 bg-panel">
          <CodeContext snapshot={snapshot} thread={thread} />
          <ThreadCard snapshot={snapshot} thread={thread} focused wide />
          <div>
            <Button size="sm" variant="ghost" onClick={() => focusFile(snapshot.key, thread.anchor.path, thread.id)}>
              Show in Files
            </Button>
          </div>
        </div>
      )}
    </div>
  );
}

/** The top of the Overview: what needs attention, grouped by who is expected to act. */
export function ReviewThreads({ snapshot }: { snapshot: PrSnapshot }) {
  const groups = snapshot.role === 'author' ? AUTHOR_GROUPS : REVIEWER_GROUPS;
  const grouped = useMemo(() => {
    const map = new Map<ThreadGroup, ThreadView[]>(groups.map((g) => [g.id, []]));
    for (const t of snapshot.threads) map.get(threadGroup(t, snapshot.role))?.push(t);
    return map;
  }, [snapshot.threads, snapshot.role, groups]);
  const [openIds, setOpenIds] = useState<Set<string>>(() => new Set());
  const [showResolved, setShowResolved] = useState(false);
  const openCount = snapshot.threads.filter((t) => !t.isResolved).length;
  const resolvedCount = snapshot.threads.length - openCount;
  const toggle = (id: string) =>
    setOpenIds((s) => {
      const n = new Set(s);
      if (n.has(id)) n.delete(id);
      else n.add(id);
      return n;
    });

  return (
    <section aria-labelledby="threads-h" className="flex flex-col gap-2.5">
      <div className="flex flex-wrap items-baseline gap-x-2.5 gap-y-1">
        <h2 id="threads-h" className="text-[13.5px] font-bold text-strong">
          Review threads
        </h2>
        <span className="text-muted text-[12px]">
          {openCount} open · {resolvedCount} resolved
        </span>
        <span className="flex-1" />
        <Button size="sm" variant="ghost" onClick={() => updateUi(snapshot.key, { view: 'files' })}>
          Review files →
        </Button>
      </div>
      {snapshot.role === 'author' && <ReRequest snapshot={snapshot} />}
      {snapshot.role === 'reviewer' && snapshot.drafts.length > 0 && (
        <div className="flex flex-wrap items-center gap-2 px-3 py-2.5 rounded-[10px] border border-info-line bg-info-bg text-[12.5px]">
          <span className="text-fg">
            {snapshot.drafts.length} draft comment{snapshot.drafts.length === 1 ? '' : 's'} not submitted yet
          </span>
          <span className="flex-1" />
          <Button size="sm" variant="primary" onClick={() => updateUi(snapshot.key, { showSubmit: true })}>
            Submit review
          </Button>
        </div>
      )}
      <div className="rounded-[10px] border border-line-2 bg-card overflow-hidden">
        {snapshot.threads.length === 0 && <div className="px-3.5 py-3 text-muted">No review threads yet.</div>}
        {snapshot.threads.length > 0 && openCount === 0 && <div className="px-3.5 py-3 text-muted">No open threads. 🎉</div>}
        {groups.map((g) => {
          const items = grouped.get(g.id) ?? [];
          if (items.length === 0) return null;
          const resolved = g.id === 'resolved';
          return (
            <div key={g.id} className="border-b border-line last:border-b-0">
              <div className="flex items-center gap-2 px-3.5 h-8 bg-subtle border-b border-line">
                <span aria-hidden="true" className="w-2 h-2 rounded-full flex-none" style={{ background: g.dot }} />
                <h3 className="text-[11.5px] font-bold text-strong uppercase tracking-wide">{g.title}</h3>
                <span className="text-muted text-[12px]">{items.length}</span>
                <span className="flex-1" />
                {resolved ? (
                  <button type="button" onClick={() => setShowResolved(!showResolved)} className="text-muted text-[11.5px] hover:text-fg cursor-pointer">
                    {showResolved ? 'hide' : 'show'}
                  </button>
                ) : (
                  <span className="text-muted text-[11.5px] truncate">{g.hint}</span>
                )}
              </div>
              {(!resolved || showResolved) && items.map((t) => <ThreadRow key={t.id} snapshot={snapshot} thread={t} open={openIds.has(t.id)} onToggle={() => toggle(t.id)} />)}
            </div>
          );
        })}
      </div>
    </section>
  );
}
