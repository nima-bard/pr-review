import type { RemovalBlocker, TrackedAnchor } from './model';

export function tierLabel(anchor: TrackedAnchor, originalLine: number | null): string {
  const pct = anchor.score !== undefined ? ` ≈ ${Math.round(anchor.score * 100)}%` : '';
  switch (anchor.tier) {
    case 'exact':
      return 'Re-anchored · exact';
    case 'shifted': {
      if (anchor.movedFrom) return `Re-anchored · moved from ${anchor.movedFrom.split('/').pop()}`;
      const delta = anchor.line !== undefined && originalLine !== null ? anchor.line - originalLine : 0;
      return `Re-anchored · shifted ${delta >= 0 ? '+' : ''}${delta} lines`;
    }
    case 'manual':
      return 'Placed by you';
    case 'fuzzy':
      return `Re-anchored${pct}`;
    case 'guess':
      return `Best guess${pct} · verify`;
    case 'ai':
      return `AI-matched${pct} · verify`;
    case 'orphan':
      return anchor.reason === 'file-level-comment'
        ? 'File comment'
        : anchor.reason === 'file-deleted'
          ? 'File deleted'
          : 'Location lost';
  }
}

export function tierTone(anchor: TrackedAnchor): 'ok' | 'warn' | 'muted' {
  if (anchor.tier === 'exact' || anchor.tier === 'shifted' || anchor.tier === 'manual') return 'ok';
  if (anchor.tier === 'orphan') return 'muted';
  return 'warn';
}

/** The label a blocked worktree shows. */
export const BLOCKER_LABEL: Record<RemovalBlocker, string> = {
  dirty: 'Uncommitted changes',
  unreachable: 'Commits on no branch',
  locked: 'Locked',
  unreadable: 'Git can’t read it',
};

/** Whether "Force remove" may override it (losing what it names); never for a locked worktree. */
export const canForceRemove = (b: RemovalBlocker): boolean => b === 'dirty' || b === 'unreachable';

/** What a blocked worktree's label explains on hover. */
export function blockerHint(b: RemovalBlocker, lockReason: string | null): string {
  if (b === 'locked') return `Another tool is using it${lockReason ? ` (${lockReason})` : ''}: it stays until it’s unlocked`;
  if (b === 'dirty') return 'Force remove deletes these changes';
  if (b === 'unreachable') return 'Force remove loses these commits';
  return 'Check it in a terminal';
}

/** The second click's label: what removing it costs. */
export function confirmText(b: RemovalBlocker | null): string {
  return b === 'dirty' ? 'Lose changes and remove' : b === 'unreachable' ? 'Lose commits and remove' : 'Confirm remove';
}
