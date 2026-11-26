import { describe, expect, it } from 'vitest';
import type { GitHubClient } from '../../../src/core/github/client';
import { closedFromBranch, closedPrsFor, type PrNode } from '../../../src/core/github/closedPrs';

const node = (number: number, state: string, extra: Partial<PrNode> = {}): PrNode => ({
  number,
  state,
  title: `PR ${number}`,
  closedAt: state === 'OPEN' ? null : '2026-11-20T10:00:00Z',
  isCrossRepository: false,
  ...extra,
});

describe('closedFromBranch', () => {
  it('is the latest pull request from the branch, once it is merged or closed', () => {
    expect(closedFromBranch([node(12, 'MERGED'), node(7, 'CLOSED')], 'me/fix', 'main')).toMatchObject({ number: 12, state: 'MERGED' });
  });

  it('is nothing while a pull request from the branch is still open', () => {
    expect(closedFromBranch([node(12, 'MERGED'), node(15, 'OPEN')], 'me/fix', 'main')).toBeNull();
  });

  it('ignores pull requests from forks with a branch of the same name', () => {
    expect(closedFromBranch([node(20, 'OPEN', { isCrossRepository: true }), node(12, 'MERGED')], 'fix', 'main')).toMatchObject({ number: 12 });
    expect(closedFromBranch([node(20, 'MERGED', { isCrossRepository: true })], 'fix', 'main')).toBeNull();
  });

  it('never matches the default branch', () => {
    expect(closedFromBranch([node(3, 'MERGED')], 'main', 'main')).toBeNull();
  });
});

describe('closedPrsFor', () => {
  it('asks for numbers and branches in one query, with the values as variables', async () => {
    const calls: { query: string; vars: Record<string, unknown> }[] = [];
    const client = {
      async graphql<T>(query: string, vars: Record<string, unknown> = {}): Promise<T> {
        calls.push({ query, vars });
        return {
          repository: {
            defaultBranchRef: { name: 'main' },
            q0: node(5, 'MERGED'),
            q1: {},
            q2: { nodes: [node(9, 'CLOSED')] },
            q3: { nodes: [node(11, 'OPEN')] },
            q4: node(6, 'OPEN'),
          },
        } as T;
      },
    } as unknown as GitHubClient;
    const branch = 'me/"quoted" { branch }';
    const result = await closedPrsFor(client, 'acme', 'demo', [{ number: 5 }, { number: 404 }, { branch }, { branch: 'other' }, { number: 6 }]);
    expect(result.map((r) => r?.number ?? null)).toEqual([5, null, 9, null, null]);
    expect(calls).toHaveLength(1);
    expect(calls[0]!.vars).toMatchObject({ owner: 'acme', repo: 'demo', v0: 5, v1: 404, v2: branch, v3: 'other', v4: 6 });
    expect(calls[0]!.query).not.toContain('quoted');
  });

  it('makes no request for nothing', async () => {
    const client = {
      graphql: () => {
        throw new Error('no request expected');
      },
    } as unknown as GitHubClient;
    expect(await closedPrsFor(client, 'acme', 'demo', [])).toEqual([]);
  });
});
