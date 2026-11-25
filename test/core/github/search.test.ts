import { describe, expect, it } from 'vitest';
import { checkCounts } from '../../../src/core/github/search';

const runs = (counts: Record<string, number>) => Object.entries(counts).map(([state, count]) => ({ state, count }));

describe('checkCounts', () => {
  it('counts neutral and skipped check runs as passing, like github.com', () => {
    expect(checkCounts({ checkRunCount: 3, checkRunCountsByState: runs({ SUCCESS: 1, NEUTRAL: 1, SKIPPED: 1 }), statusContextCount: 0, statusContextCountsByState: [] })).toEqual({ passed: 3, total: 3 });
  });

  it('adds commit statuses to check runs', () => {
    expect(
      checkCounts({ checkRunCount: 2, checkRunCountsByState: runs({ SUCCESS: 1, FAILURE: 1 }), statusContextCount: 2, statusContextCountsByState: runs({ SUCCESS: 1, PENDING: 1 }) }),
    ).toEqual({ passed: 2, total: 4 });
  });

  it('returns null when there are no checks', () => {
    expect(checkCounts({ checkRunCount: 0, checkRunCountsByState: null, statusContextCount: 0, statusContextCountsByState: null })).toBeNull();
    expect(checkCounts(undefined)).toBeNull();
  });
});
