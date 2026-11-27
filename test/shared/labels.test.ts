import { describe, expect, it } from 'vitest';
import { tierTone, uncertainPlacement } from '../../src/shared/labels';
import type { TrackedAnchor } from '../../src/shared/model';

const at = (tier: TrackedAnchor['tier'], score?: number): TrackedAnchor => ({ tier, path: 'src/a.ts', line: 23, ...(score !== undefined ? { score } : {}) });

describe('uncertainPlacement', () => {
  it('says how alike the code is for a re-anchored comment', () => {
    const p = uncertainPlacement(at('fuzzy', 0.85));
    expect(p?.short).toBe('≈ 85%');
    expect(p?.explanation).toContain('like the line it was written on (≈ 85% alike)');
    expect(p?.explanation).toContain('Compare then ↔ now');
  });

  it('calls a best guess one, and a match Claude made AI-matched', () => {
    expect(uncertainPlacement(at('guess', 0.67))?.short).toBe('Best guess');
    expect(uncertainPlacement(at('guess', 0.67))?.explanation).toContain('couldn’t find that line again');
    expect(uncertainPlacement(at('ai', 0.9))?.short).toBe('AI-matched');
  });

  it('is there exactly for the cards with a yellow border (a warn tier)', () => {
    for (const tier of ['exact', 'shifted', 'manual', 'fuzzy', 'guess', 'ai', 'orphan'] as const) {
      expect(uncertainPlacement(at(tier, 0.5)) !== null).toBe(tierTone(at(tier)) === 'warn');
    }
  });

  it('does without a score', () => {
    expect(uncertainPlacement(at('fuzzy'))?.short).toBe('Re-anchored');
    expect(uncertainPlacement(at('fuzzy'))?.explanation).not.toContain('%');
  });
});
