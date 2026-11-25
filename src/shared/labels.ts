import type { TrackedAnchor } from './model';

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
