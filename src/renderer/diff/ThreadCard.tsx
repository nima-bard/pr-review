import { useEffect, useRef, useState } from 'react';
import type { CommentView, PrSnapshot, ThreadView } from '../../shared/model';
import type { ContextMenuItem } from '../../shared/ipc';
import { tierLabel, tierTone } from '../../shared/labels';
import { isClaudeGenerated } from '../../shared/triage';
import { parseHunkSide } from '../../core/anchor/fuzzy';
import { api, errorText } from '../api';
import { Octicon } from '../components/octicons';
import { Reactions } from '../components/Reactions';
import { Avatar, Badge, Button, cx, Icon, Markdown, timeAgo } from '../components/ui';
import { focusFile } from '../state/ui';
import { CommentEditor } from './CommentEditor';
import { loadFile } from './useFileDiff';

export function threadLocation(t: ThreadView): string {
  if (t.fileLevel) return 'File comment';
  const a = t.anchor;
  if (a.line === undefined) return t.originalLine ? `was line ${t.originalLine}` : 'File';
  return a.endLine !== undefined && a.endLine !== a.line ? `Lines ${a.line}–${a.endLine}` : `Line ${a.line}`;
}

const TRIAGE_LABEL: Record<ThreadView['triage'], { text: string; tone: 'info' | 'warn' | 'muted' | 'ok' }> = {
  'needs-reply': { text: 'Needs your reply', tone: 'info' },
  'likely-addressed': { text: 'Likely addressed', tone: 'warn' },
  waiting: { text: 'Waiting on them', tone: 'muted' },
  resolved: { text: 'Resolved', tone: 'ok' },
};

interface SnippetLine {
  num: number;
  text: string;
  kind: 'add' | 'del' | 'ctx';
}

/** The commented line(s) as they were in the diff when the comment was written (GitHub's hunk ends at that line). */
function snippetLines(t: ThreadView): SnippetLine[] {
  if (t.fileLevel || t.originalLine === null) return [];
  const raw = t.diffHunk.split('\n');
  const header = /^@@ -(\d+)(?:,\d+)? \+(\d+)(?:,\d+)? @@/.exec(raw[0] ?? '');
  if (!header) return [];
  let left = Number(header[1]);
  let right = Number(header[2]);
  const onSide: SnippetLine[] = [];
  for (const line of raw.slice(1)) {
    const mark = line[0];
    const text = line.slice(1);
    if (mark === '+') {
      if (t.side === 'RIGHT') onSide.push({ num: right, text, kind: 'add' });
      right++;
    } else if (mark === '-') {
      if (t.side === 'LEFT') onSide.push({ num: left, text, kind: 'del' });
      left++;
    } else if (mark === ' ' || line === '') {
      onSide.push({ num: t.side === 'LEFT' ? left : right, text, kind: 'ctx' });
      left++;
      right++;
    }
  }
  const start = t.originalStartLine ?? t.originalLine;
  return onSide.filter((l) => l.num >= start && l.num <= t.originalLine!).slice(-4);
}

function Snippet({ thread }: { thread: ThreadView }) {
  const lines = snippetLines(thread);
  if (lines.length === 0) return null;
  return (
    <div className="font-mono text-code leading-[1.55] border-b border-line">
      {lines.map((l) => (
        <div key={l.num} className={cx('grid', l.kind === 'add' ? 'bg-add-soft' : l.kind === 'del' ? 'bg-del-soft' : '')} style={{ gridTemplateColumns: '44px 18px minmax(0, 1fr)' }}>
          <span className={cx('text-right pr-2 select-none', l.kind === 'add' ? 'text-add' : l.kind === 'del' ? 'text-del' : 'text-faint')}>{l.num}</span>
          <span className={cx('select-none', l.kind === 'add' ? 'text-add' : l.kind === 'del' ? 'text-del' : 'text-faint')}>{l.kind === 'add' ? '+' : l.kind === 'del' ? '−' : ''}</span>
          <span className="whitespace-pre-wrap break-words pr-3 text-fg">{l.text}</span>
        </div>
      ))}
    </div>
  );
}

function ThenNow({ snapshot, thread }: { snapshot: PrSnapshot; thread: ThreadView }) {
  const [now, setNow] = useState<string[] | null>(null);
  const side = parseHunkSide(thread.diffHunk, thread.side);
  const then = side.at(-1);
  useEffect(() => {
    if (thread.anchor.line === undefined) return;
    let alive = true;
    const rev = thread.side === 'LEFT' ? 'base' : snapshot.role === 'author' && thread.anchor.locallyModified ? 'worktree' : 'head';
    void loadFile(snapshot.key, snapshot.details.headRefOid, rev, thread.anchor.path).then((f) => {
      if (!alive) return;
      const lines = f.contents.split('\n');
      const start = thread.anchor.line! - 1;
      const end = (thread.anchor.endLine ?? thread.anchor.line!) - 1;
      setNow(lines.slice(start, end + 1));
    });
    return () => {
      alive = false;
    };
  }, [snapshot.key, snapshot.details.headRefOid, snapshot.role, thread]);
  return (
    <div className="grid border-b border-line" style={{ gridTemplateColumns: 'repeat(auto-fit, minmax(240px, 1fr))' }}>
      <div className="px-3 py-2 border-r border-line min-w-0">
        <div className="text-[11.5px] text-muted mb-1">
          When commented{thread.originalCommit ? ` · ${thread.originalCommit.slice(0, 7)}` : ''} · line {thread.originalLine}
        </div>
        <pre className="font-mono text-code leading-[1.6] px-2 rounded-md bg-del-soft overflow-x-auto whitespace-pre">{then ? then.text : '(not available)'}</pre>
      </div>
      <div className="px-3 py-2 min-w-0">
        <div className="text-[11.5px] text-muted mb-1">Now · {thread.anchor.line !== undefined ? `line ${thread.anchor.line}` : 'not found'}</div>
        <pre className="font-mono text-code leading-[1.6] px-2 rounded-md bg-add-soft overflow-x-auto whitespace-pre">{now ? now.join('\n') : thread.anchor.line === undefined ? '(code no longer found)' : '…'}</pre>
      </div>
    </div>
  );
}

/** A square icon button: `sm` (24px) in the thread and comment headers, `md` (28px) in the Conversations panel. */
function IconButton({ label, onClick, children, size = 'md', className }: { label: string; onClick(e: React.MouseEvent): void; children: React.ReactNode; size?: 'sm' | 'md'; className?: string }) {
  return (
    <button type="button" aria-label={label} title={label} onClick={onClick} className={cx('grid place-items-center rounded-md text-muted hover:text-fg hover:bg-raised-2 cursor-pointer flex-none', size === 'sm' ? 'w-6 h-6' : 'w-7 h-7', className)}>
      {children}
    </button>
  );
}

const quote = (body: string) =>
  body
    .split('\n')
    .map((l) => `> ${l}`)
    .join('\n') + '\n\n';

/** One comment in GitHub's layout: replies are indented under a thread line and sit on a darker background. */
function CommentItem({ snapshot, comment, reply, clamp, onQuote }: { snapshot: PrSnapshot; comment: CommentView; reply: boolean; clamp: boolean; onQuote(text: string): void }) {
  const [expanded, setExpanded] = useState(false);
  const [editing, setEditing] = useState(false);
  const [overflowing, setOverflowing] = useState(false);
  const body = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (clamp && body.current) setOverflowing(body.current.scrollHeight > body.current.clientHeight + 4);
  }, [clamp, comment.bodyHTML]);
  const menu = async () => {
    const items: ContextMenuItem[] = [
      ...(comment.viewerCanUpdate ? [{ id: 'edit', label: 'Edit' }, 'separator' as const] : []),
      { id: 'quote', label: 'Quote reply' },
      { id: 'copy', label: 'Copy link' },
      'separator',
      { id: 'github', label: 'View on GitHub' },
    ];
    const choice = await api.contextMenu(items);
    if (choice === 'edit') setEditing(true);
    if (choice === 'quote') onQuote(quote(comment.body));
    if (choice === 'copy') void navigator.clipboard.writeText(comment.url);
    if (choice === 'github') void api.openExternal(comment.url);
  };
  const clamped = clamp && !expanded;
  return (
    <div className={cx('px-3 pt-2.5 pb-3', reply ? 'bg-inset' : '')}>
      <div className="flex items-center gap-2 min-w-0">
        <Avatar login={comment.author} url={comment.avatarUrl} size={22} />
        <strong className="font-semibold text-strong truncate">{comment.author}</strong>
        <span className="text-muted text-[12px] whitespace-nowrap">
          {timeAgo(comment.createdAt)}
          {comment.edited ? ' · edited' : ''}
        </span>
        {comment.pending && <Badge tone="info">Pending</Badge>}
        {isClaudeGenerated(comment.body) && (
          <span title="Signed “Generated with Claude Code”">
            <Badge tone="purple">Claude</Badge>
          </span>
        )}
        <span className="flex-1" />
        {comment.author === snapshot.details.author && <span className="px-2 h-5 leading-[18px] rounded-full border border-line-2 text-[11px] text-soft flex-none">Author</span>}
        <IconButton label="Comment actions" onClick={() => void menu()} size="sm">
          <Octicon name="kebab-horizontal" size={14} />
        </IconButton>
      </div>
      <div className={cx(reply && 'relative pl-[30px]')}>
        {reply && <span aria-hidden="true" className="absolute left-[10.5px] top-1 bottom-0 w-px bg-line-2" />}
        {editing ? (
          <CommentEditor prKey={snapshot.key} kind="thread" commentId={comment.id} body={comment.body} onDone={() => setEditing(false)} />
        ) : (
          <>
            <div ref={body} className={cx('relative', clamped && 'max-h-[9.5em] overflow-hidden')}>
              <Markdown html={comment.bodyHTML} className="mt-1.5 text-fg" />
              {clamped && overflowing && <span aria-hidden="true" className={cx('absolute inset-x-0 bottom-0 h-10 bg-linear-to-t', reply ? 'from-inset' : 'from-raised')} />}
            </div>
            {clamp && (overflowing || expanded) && (
              <button type="button" onClick={() => setExpanded(!expanded)} className="mt-1 text-accent text-[12px] cursor-pointer">
                {expanded ? 'Show less' : 'Show more'}
              </button>
            )}
            {/* Pending comments aren't published yet, so GitHub doesn't accept reactions on them. */}
            {!comment.pending && <Reactions prKey={snapshot.key} subjectId={comment.id} reactions={comment.reactions} />}
          </>
        )}
      </div>
    </div>
  );
}

/**
 * A review thread, styled after github.com.
 * - `inline` (default): next to the code in a diff, or on the Overview (`wide` fills the column there).
 * - `panel`: in the Conversations panel, with the file path, a jump-to-file button and the commented line.
 */
export function ThreadCard({
  snapshot,
  thread,
  focused = false,
  wide = false,
  variant = 'inline',
}: {
  snapshot: PrSnapshot;
  thread: ThreadView;
  focused?: boolean;
  wide?: boolean;
  variant?: 'inline' | 'panel';
}) {
  const [expanded, setExpanded] = useState(!thread.isResolved || focused);
  const [compare, setCompare] = useState(false);
  const [moving, setMoving] = useState(false);
  const [moveTo, setMoveTo] = useState(String(thread.anchor.line ?? ''));
  const [reply, setReply] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const replyBox = useRef<HTMLTextAreaElement>(null);
  const key = snapshot.key;
  const panel = variant === 'panel';
  const first = thread.comments[0];
  const tone = tierTone(thread.anchor);
  const showTier = thread.isOutdated && !thread.fileLevel;
  const hasSuggestion = thread.comments.some((c) => /```suggestion/.test(c.body));
  const author = snapshot.role === 'author';

  useEffect(() => {
    if (focused) setExpanded(true);
  }, [focused]);

  // Resolving a conversation (here, elsewhere in the app or on github.com) folds it away; unresolving opens it again.
  const wasResolved = useRef(thread.isResolved);
  useEffect(() => {
    if (thread.isResolved === wasResolved.current) return;
    wasResolved.current = thread.isResolved;
    setExpanded(!thread.isResolved);
  }, [thread.isResolved]);

  const run = async (fn: () => Promise<void>) => {
    setBusy(true);
    setError(null);
    try {
      await fn();
    } catch (err) {
      setError(errorText(err));
    } finally {
      setBusy(false);
    }
  };
  const send = (resolve: boolean) =>
    void run(async () => {
      await api.reply(key, thread.id, reply);
      if (resolve) await api.setResolved(key, thread.id, true);
      setReply('');
    });
  const setResolved = (resolved: boolean) => void run(() => api.setResolved(key, thread.id, resolved));
  const quoteInto = (text: string) => {
    setReply((r) => (r ? `${r}\n${text}` : text));
    setExpanded(true);
    setTimeout(() => replyBox.current?.focus(), 0);
  };

  const threadMenu = async () => {
    const items: ContextMenuItem[] = [];
    if (showTier) items.push({ id: 'move', label: 'Move to another line…' });
    if (author && thread.anchor.line !== undefined) items.push({ id: 'editor', label: 'Open in editor' });
    items.push({ id: 'files', label: 'Show in Files' });
    if (first) items.push('separator', { id: 'github', label: 'View on GitHub' });
    const choice = await api.contextMenu(items);
    if (choice === 'move') setMoving(true);
    if (choice === 'editor') void run(() => api.openInEditor(key, thread.anchor.path, thread.anchor.line ?? 1));
    if (choice === 'files') focusFile(key, thread.anchor.path, thread.id);
    if (choice === 'github' && first) void api.openExternal(first.url);
  };

  const chevron = (
    <IconButton label={expanded ? 'Collapse thread' : 'Expand thread'} onClick={() => setExpanded(!expanded)} size="sm" className="-ml-1">
      <Icon name="chevron" size={12} rotate={expanded ? 0 : -90} />
    </IconButton>
  );
  const dir = thread.anchor.path.includes('/') ? thread.anchor.path.slice(0, thread.anchor.path.lastIndexOf('/') + 1) : '';

  return (
    <div
      id={panel ? undefined : `thread-${thread.id}`}
      className={cx(
        'rounded-[9px] bg-raised border overflow-hidden font-sans text-comment',
        !wide && !panel && 'max-w-[680px]',
        focused ? 'border-accent' : tone === 'warn' && showTier && !thread.isResolved ? 'border-warn-line' : 'border-line-2',
      )}
    >
      {panel ? (
        <div className={cx('flex items-center gap-1.5 pl-2.5 pr-1.5 h-9 bg-subtle', expanded && 'border-b border-line')}>
          {chevron}
          <button type="button" onClick={() => focusFile(key, thread.anchor.path, thread.id)} title={thread.anchor.path} className="flex items-baseline gap-1.5 min-w-0 flex-1 text-left cursor-pointer hover:underline" aria-label={`Show ${thread.anchor.path} in Files`}>
            {/* Like github.com, the folders give way first (cut from the left) so the file name stays readable. */}
            <span className="flex min-w-0 font-mono text-[12px]">
              {dir && (
                <span className="truncate text-soft" style={{ direction: 'rtl', flexShrink: 1000 }}>
                  <bdi>{dir}</bdi>
                </span>
              )}
              <span className="truncate text-strong shrink-0 max-w-full">{thread.anchor.path.slice(dir.length)}</span>
            </span>
            <span className="text-muted text-[12px] whitespace-nowrap flex-none">{threadLocation(thread)}</span>
          </button>
          {thread.isResolved ? (
            <span title="Resolved" className="grid place-items-center w-7 h-7 text-add flex-none">
              <Octicon name="check-circle" size={15} label="Resolved" />
            </span>
          ) : (
            thread.viewerCanResolve && (
              <IconButton label="Resolve conversation" onClick={() => setResolved(true)}>
                <Octicon name="check-circle" size={15} />
              </IconButton>
            )
          )}
        </div>
      ) : (
        <div className={cx('flex items-start gap-2 pl-2.5 pr-1.5 py-1.5', expanded && 'border-b border-line-2')}>
          {chevron}
          <div className="flex flex-wrap items-center gap-x-2 gap-y-1 min-w-0 flex-1 min-h-6">
            {/* Compact: the card already sits next to the code, so just the line (and "old" for the left side). */}
            <span className="text-[12.5px] text-muted whitespace-nowrap">
              {threadLocation(thread)}
              {thread.side === 'LEFT' && !thread.fileLevel ? ' · old' : ''}
            </span>
            {showTier && <Badge tone={tone === 'ok' ? 'ok' : tone === 'warn' ? 'warn' : 'muted'}>Outdated · {tierLabel(thread.anchor, thread.originalLine)}</Badge>}
            {thread.anchor.locallyModified && <Badge tone="warn">Changed locally</Badge>}
            {author && !thread.isResolved && <Badge tone={TRIAGE_LABEL[thread.triage].tone}>{TRIAGE_LABEL[thread.triage].text}</Badge>}
            {thread.comments.some((c) => c.pending) && <Badge tone="info">Pending</Badge>}
            {!expanded && first && (
              <span className="min-w-0 flex-1 truncate text-[12.5px] text-muted">
                <span className="text-fg font-semibold">{first.author}</span> {first.body.split('\n')[0]}
              </span>
            )}
          </div>
          {/* As tall as the arrow, so a taller button here can't push the row's controls out of line. */}
          <div className="flex items-center gap-1.5 flex-none h-6">
            {expanded && showTier && (
              <Button size="sm" variant="ghost" onClick={() => setCompare(!compare)} aria-pressed={compare}>
                Compare then ↔ now
              </Button>
            )}
            {expanded && author && hasSuggestion && !thread.isResolved && (
              <Button size="sm" disabled={busy} onClick={() => void run(() => api.applySuggestion(key, thread.id))}>
                Apply suggestion
              </Button>
            )}
            {thread.isResolved && <span className="px-2 h-5 leading-[18px] rounded-full border border-line-2 text-[11px] text-soft flex-none">Resolved</span>}
            <IconButton label="Thread actions" onClick={() => void threadMenu()} size="sm">
              <Octicon name="kebab-horizontal" size={14} />
            </IconButton>
          </div>
        </div>
      )}
      {expanded && (
        <>
          {panel && <Snippet thread={thread} />}
          {compare && <ThenNow snapshot={snapshot} thread={thread} />}
          {moving && (
            <form
              className="flex flex-wrap items-center gap-2 px-3 py-2 border-b border-line bg-hover"
              onSubmit={(e) => {
                e.preventDefault();
                const n = Number(moveTo);
                if (Number.isInteger(n) && n > 0) void run(() => api.setThreadPlacement(key, thread.id, n)).then(() => setMoving(false));
              }}
            >
              <label className="text-[12px] text-muted" htmlFor={`move-${thread.id}`}>
                Place this comment at line
              </label>
              <input
                id={`move-${thread.id}`}
                value={moveTo}
                onChange={(e) => setMoveTo(e.target.value.replace(/\D/g, ''))}
                inputMode="numeric"
                className="w-20 h-[26px] px-2 rounded-md bg-side border border-line-2 focus:border-accent outline-none font-mono text-[12px]"
              />
              <span className="text-[12px] text-muted">of {thread.anchor.path.split('/').pop()} (kept on this machine and followed through later pushes)</span>
              <span className="flex-1" />
              <Button size="sm" variant="ghost" onClick={() => setMoving(false)}>
                Cancel
              </Button>
              {thread.anchor.tier === 'manual' && (
                <Button size="sm" variant="ghost" onClick={() => void run(() => api.setThreadPlacement(key, thread.id, null)).then(() => setMoving(false))}>
                  Reset to automatic
                </Button>
              )}
              <Button size="sm" variant="primary" type="submit" disabled={busy || !moveTo}>
                Place
              </Button>
            </form>
          )}
          {thread.comments.map((c, i) => (
            <CommentItem key={c.id} snapshot={snapshot} comment={c} reply={i > 0} clamp={panel} onQuote={quoteInto} />
          ))}
          {thread.viewerCanReply && (
            <div className={cx('flex flex-col gap-2 px-3 pt-2.5 pb-3', thread.comments.length > 1 && 'bg-inset')}>
              <div className="flex items-start gap-2">
                <label className="sr-only" htmlFor={`reply-${variant}-${thread.id}`}>
                  Reply
                </label>
                <textarea
                  ref={replyBox}
                  id={`reply-${variant}-${thread.id}`}
                  rows={reply.includes('\n') ? 4 : 1}
                  value={reply}
                  onChange={(e) => setReply(e.target.value)}
                  onKeyDown={(e) => {
                    if (e.key === 'Enter' && (e.metaKey || e.ctrlKey) && reply.trim()) send(false);
                    if (e.key === 'Escape') setReply('');
                  }}
                  placeholder="Write a reply"
                  className="flex-1 resize-y min-h-[32px] px-2.5 py-[5px] rounded-[7px] bg-side border border-line-2 focus:border-accent outline-none"
                />
                {!thread.isResolved && thread.viewerCanResolve && !reply.trim() && (
                  <Button disabled={busy} onClick={() => setResolved(true)}>
                    Resolve
                  </Button>
                )}
              </div>
              {reply.trim() && (
                <div className="flex flex-wrap items-center gap-2">
                  <span className="text-[11.5px] text-muted">{snapshot.pendingReview ? 'Added to your pending review from github.com until you submit it.' : 'Posts immediately · ⌘⏎'}</span>
                  <span className="flex-1" />
                  <Button size="sm" variant="ghost" onClick={() => setReply('')}>
                    Cancel
                  </Button>
                  {!thread.isResolved && thread.viewerCanResolve && (
                    <Button size="sm" disabled={busy} onClick={() => send(true)}>
                      Reply &amp; resolve
                    </Button>
                  )}
                  <Button size="sm" variant="primary" disabled={busy} onClick={() => send(false)}>
                    {snapshot.pendingReview ? 'Reply (to pending review)' : 'Reply'}
                  </Button>
                </div>
              )}
            </div>
          )}
          {thread.isResolved && (
            <div className="flex flex-wrap items-center gap-x-3 gap-y-1.5 px-3 py-2.5 border-t border-line bg-subtle">
              {thread.viewerCanUnresolve && (
                <Button size="sm" disabled={busy} onClick={() => setResolved(false)}>
                  Unresolve conversation
                </Button>
              )}
              <span className="text-[12px] text-muted">
                {thread.resolvedBy ? (
                  <>
                    <strong className="text-soft">{thread.resolvedBy === snapshot.viewer ? 'You' : thread.resolvedBy}</strong> marked this conversation as resolved
                  </>
                ) : (
                  'This conversation was marked as resolved'
                )}
              </span>
            </div>
          )}
          {error && <div className="px-3 py-2 text-del text-[12px]">{error}</div>}
        </>
      )}
    </div>
  );
}
