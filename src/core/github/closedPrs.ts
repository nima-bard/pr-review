import type { GitHubClient } from './client';

/** The merged or closed pull request a worktree was for. */
export interface ClosedPr {
  number: number;
  state: 'MERGED' | 'CLOSED';
  title: string;
  closedAt: string | null;
}

/** How a worktree is matched to its pull request: by the number in its folder's name, or by its branch. */
export type PrLookup = { number: number } | { branch: string };

export interface PrNode {
  number: number;
  state: string;
  title: string;
  closedAt: string | null;
  isCrossRepository: boolean;
}

const closed = (n: PrNode | null | undefined): ClosedPr | null =>
  n && (n.state === 'MERGED' || n.state === 'CLOSED') ? { number: n.number, state: n.state, title: n.title, closedAt: n.closedAt } : null;

/**
 * The pull request a branch was for, if it's done: the latest one from this repository's `branch` (`nodes` newest
 * first), unless one from it is still open. Never the default branch, which pull requests can come from too.
 */
export function closedFromBranch(nodes: readonly PrNode[], branch: string, defaultBranch: string | null): ClosedPr | null {
  if (branch === defaultBranch) return null;
  const own = nodes.filter((n) => !n.isCrossRepository);
  if (own.some((n) => n.state === 'OPEN')) return null;
  return closed(own[0]);
}

/** For each lookup, its merged or closed pull request, or null (still open, or none). One query for the repository. */
export async function closedPrsFor(client: GitHubClient, owner: string, repo: string, lookups: readonly PrLookup[]): Promise<(ClosedPr | null)[]> {
  if (lookups.length === 0) return [];
  const fields = 'number state title closedAt isCrossRepository';
  const vars: Record<string, unknown> = { owner, repo };
  const parts = lookups.map((l, i) => {
    if ('number' in l) {
      vars[`v${i}`] = l.number;
      // issueOrPullRequest: a number that's an issue, or nothing, just comes back empty.
      return `q${i}: issueOrPullRequest(number: $v${i}) { ... on PullRequest { ${fields} } }`;
    }
    vars[`v${i}`] = l.branch;
    return `q${i}: pullRequests(headRefName: $v${i}, first: 5, orderBy: { field: UPDATED_AT, direction: DESC }) { nodes { ${fields} } }`;
  });
  const params = lookups.map((l, i) => `$v${i}: ${'number' in l ? 'Int!' : 'String!'}`).join(', ');
  const query = `query($owner: String!, $repo: String!, ${params}) { repository(owner: $owner, name: $repo) { defaultBranchRef { name } ${parts.join('\n')} } }`;
  // The aliases q0, q1… are a PR (or an empty object) for a number, a connection for a branch.
  const data = await client.graphql<{ repository: Record<string, unknown> | null }>(query, vars);
  const r = data.repository;
  if (!r) return lookups.map(() => null);
  const defaultBranch = (r.defaultBranchRef as { name: string } | null)?.name ?? null;
  return lookups.map((l, i) => {
    const found = r[`q${i}`] as Partial<PrNode> | { nodes: PrNode[] } | null | undefined;
    if ('number' in l) return found && !('nodes' in found) && found.number !== undefined ? closed(found as PrNode) : null;
    return closedFromBranch(found && 'nodes' in found ? found.nodes : [], l.branch, defaultBranch);
  });
}
