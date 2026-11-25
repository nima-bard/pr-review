import type { CommentView, TrackedAnchor, TriageBucket } from './model';

/** Claude Code's sign-off, "🤖 Generated with [Claude Code](https://claude.com/claude-code)". */
const CLAUDE_FOOTER = /Generated with \[?Claude Code\]?/i;

export function isClaudeGenerated(body: string): boolean {
  return CLAUDE_FOOTER.test(body);
}

type TriageComment = Pick<CommentView, 'createdAt' | 'viewerDidAuthor' | 'body'>;

/**
 * Whether a comment is the viewer's own word. On the viewer's own PR, a Claude-generated comment posted from their
 * account is review feedback for them to act on, not their reply.
 */
export function isViewersWord(c: TriageComment, viewerIsAuthor: boolean): boolean {
  return c.viewerDidAuthor && !(viewerIsAuthor && isClaudeGenerated(c.body));
}

export interface TriageInput {
  isResolved: boolean;
  comments: readonly TriageComment[];
  anchor: Pick<TrackedAnchor, 'changedAt' | 'changedAtTime' | 'locallyModified'>;
  viewerIsAuthor: boolean;
}

export function triage(t: TriageInput): TriageBucket {
  if (t.isResolved) return 'resolved';
  const last = t.comments.at(-1);
  if (last && t.anchor.changedAt && t.anchor.changedAtTime && t.anchor.changedAtTime > last.createdAt) {
    return 'likely-addressed';
  }
  if (t.anchor.locallyModified) return 'likely-addressed';
  return last && !isViewersWord(last, t.viewerIsAuthor) ? 'needs-reply' : 'waiting';
}
