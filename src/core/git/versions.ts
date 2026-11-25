import type { Version } from '../../shared/model';
import { git, gitOk } from './exec';

export async function pinVersion(repo: string, prNumber: number, v: Version): Promise<void> {
  await git(repo, ['update-ref', `refs/review/pr-${prNumber}/v${v.n}`, v.sha]);
}

/** Appends `sha` as the next version unless it is already the latest. */
export function appendVersion(versions: readonly Version[], sha: string, source: Version['source'], forcePush: boolean, seenAt = new Date().toISOString()): Version[] {
  if (versions.some((v) => v.sha === sha)) return [...versions];
  return [...versions, { n: versions.length + 1, sha, seenAt, source, forcePush }];
}

/** Merges timeline-derived head SHAs (oldest first) with app-recorded versions, renumbering by time. */
export function mergeVersions(recorded: readonly Version[], timeline: readonly { sha: string; at: string; forcePush: boolean }[]): Version[] {
  const bySha = new Map<string, Version>();
  for (const v of recorded) bySha.set(v.sha, v);
  for (const t of timeline) {
    if (!bySha.has(t.sha)) bySha.set(t.sha, { n: 0, sha: t.sha, seenAt: t.at, source: 'timeline', forcePush: t.forcePush });
  }
  return [...bySha.values()]
    .sort((a, b) => a.seenAt.localeCompare(b.seenAt))
    .map((v, i) => ({ ...v, n: i + 1 }));
}

const MAX_STEPS = 60;

export function sampleSteps(revs: readonly string[], max = MAX_STEPS): string[] {
  if (revs.length <= max) return [...revs];
  const step = revs.length / max;
  const picked: string[] = [];
  for (let i = 0; i < max - 1; i++) picked.push(revs[Math.floor(i * step)]!);
  picked.push(revs[revs.length - 1]!);
  return [...new Set(picked)];
}

/** Commits to walk from a thread's originalCommit to head (both included). */
export async function buildChain(repo: string, original: string, head: string, versions: readonly Version[]): Promise<string[]> {
  if (original === head) return [head];
  if (await gitOk(repo, ['merge-base', '--is-ancestor', original, head])) {
    const out = await git(repo, ['rev-list', '--reverse', '--first-parent', `${original}..${head}`]);
    const revs = out.split('\n').filter(Boolean);
    return [original, ...sampleSteps(revs)];
  }
  const idx = versions.findIndex((v) => v.sha === original);
  const tail = idx === -1 ? [] : versions.slice(idx + 1).map((v) => v.sha);
  return [original, ...tail.filter((s) => s !== head && s !== original), head];
}

export async function commitsBetween(repo: string, from: string | null, to: string): Promise<{ sha: string; subject: string; author: string; date: string }[]> {
  const range = from ? `${from}..${to}` : to;
  const out = await git(repo, ['log', '--reverse', '--format=%H%x00%s%x00%an%x00%cI%x1e', range]);
  return out
    .split('\x1e')
    .map((r) => r.trim())
    .filter(Boolean)
    .map((r) => {
      const [sha = '', subject = '', author = '', date = ''] = r.split('\0');
      return { sha, subject, author, date };
    });
}

export interface RangeDiffSummary {
  identical: number;
  changed: number;
  added: number;
  removed: number;
}

/** Compares the PR commits of two versions, each from its own merge-base with the base branch (hides the rebase itself). */
export async function rangeDiffSummary(repo: string, oldHead: string, newHead: string, baseOid: string): Promise<RangeDiffSummary | null> {
  try {
    const oldBase = (await git(repo, ['merge-base', oldHead, baseOid])).trim();
    const newBase = (await git(repo, ['merge-base', newHead, baseOid])).trim();
    const out = await git(repo, ['range-diff', '--no-color', '-s', `${oldBase}..${oldHead}`, `${newBase}..${newHead}`]);
    const summary: RangeDiffSummary = { identical: 0, changed: 0, added: 0, removed: 0 };
    for (const line of out.split('\n')) {
      const m = /^\s*(\d+|-):\s+\S+\s+([=!<>])\s+(\d+|-):/.exec(line);
      if (!m) continue;
      if (m[2] === '=') summary.identical++;
      else if (m[2] === '!') summary.changed++;
      else if (m[2] === '>') summary.added++;
      else summary.removed++;
    }
    return summary;
  } catch {
    return null;
  }
}
