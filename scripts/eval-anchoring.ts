import { mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { anchorFromLines } from '../src/core/anchor/fuzzy';
import { createGitTrackIO } from '../src/core/anchor/gitIO';
import { trackRange } from '../src/core/anchor/track';
import { recoverMoved } from '../src/core/anchor/moved';
import { DEFAULT_ANCHOR_CONFIG, type AnchorConfig, type TrackedAnchor } from '../src/core/anchor/types';
import { BlobReader } from '../src/core/git/blobs';
import { hasCommit } from '../src/core/git/diff';
import { git } from '../src/core/git/exec';
import { buildChain } from '../src/core/git/versions';
import { fetchPullHead } from '../src/core/git/worktrees';
import { GhTokenProvider } from '../src/core/github/auth';
import { endpointsFor, GitHubClient } from '../src/core/github/client';
import { fetchThreads } from '../src/core/github/pr';
import type { ReviewThreadNode } from '../src/core/github/queries';

// Usage: npm run eval -- owner/repo /path/to/clone [--prs 50] [--place 0.7] [--guess 0.5] [--margin 0.05]
// Ground truth: non-outdated threads, whose current `line` GitHub tracked itself. We start from
// (originalCommit, originalLine), track to the comment's current commit, and compare.

interface Row {
  pr: number;
  thread: string;
  path: string;
  outdated: boolean;
  expected: number | null;
  got: number | null;
  tier: string;
  score: number | null;
  correct: boolean | null;
  steps: number;
  originalText: string;
  placedText: string;
  placedPath: string;
  movedFrom: string | null;
}

function arg(name: string, fallback: string): string {
  const i = process.argv.indexOf(`--${name}`);
  return i !== -1 && process.argv[i + 1] ? process.argv[i + 1]! : fallback;
}

const LIST_PRS = /* GraphQL */ `
  query ($owner: String!, $repo: String!, $n: Int!) {
    repository(owner: $owner, name: $repo) {
      pullRequests(last: $n, states: [MERGED, OPEN]) {
        nodes {
          number
          headRefOid
        }
      }
    }
  }
`;

async function ensure(repo: string, sha: string): Promise<boolean> {
  if (await hasCommit(repo, sha)) return true;
  try {
    await git(repo, ['fetch', '--no-tags', '-q', 'origin', sha]);
    return await hasCommit(repo, sha);
  } catch {
    return false;
  }
}

async function main(): Promise<void> {
  const [slug, clone] = process.argv.slice(2).filter((a, i, all) => !a.startsWith('--') && !all[i - 1]?.startsWith('--'));
  if (!slug || !clone) {
    console.error('Usage: npm run eval -- owner/repo /path/to/clone [--prs 50]');
    process.exit(1);
  }
  const [owner, repo] = slug.split('/') as [string, string];
  const cfg: AnchorConfig = {
    ...DEFAULT_ANCHOR_CONFIG,
    placeThreshold: Number(arg('place', String(DEFAULT_ANCHOR_CONFIG.placeThreshold))),
    guessThreshold: Number(arg('guess', String(DEFAULT_ANCHOR_CONFIG.guessThreshold))),
    ambiguityMargin: Number(arg('margin', String(DEFAULT_ANCHOR_CONFIG.ambiguityMargin))),
  };
  const client = new GitHubClient(new GhTokenProvider('github.com'), endpointsFor('github.com'));
  const prs = (await client.graphql<{ repository: { pullRequests: { nodes: { number: number; headRefOid: string }[] } } }>(LIST_PRS, { owner, repo, n: Number(arg('prs', '50')) })).repository.pullRequests.nodes;

  const blobs = new BlobReader(clone);
  const io = createGitTrackIO(clone, blobs);
  const rows: Row[] = [];

  for (const { number: pr, headRefOid } of prs) {
    const threads: ReviewThreadNode[] = await fetchThreads(client, { host: 'github.com', owner, repo, number: pr });
    if (threads.length === 0) continue;
    await fetchPullHead(clone, 'origin', pr).catch(() => undefined);
    for (const t of threads) {
      const first = t.comments.nodes[0];
      const original = first?.originalCommit?.oid;
      // Outdated comments: `commit` is where GitHub last placed them, so track to the PR head instead.
      const target = t.isOutdated ? headRefOid : first?.commit?.oid;
      if (!first || !original || !target || t.subjectType === 'FILE' || t.originalLine === null || t.diffSide !== 'RIGHT') continue;
      if (!(await ensure(clone, original)) || !(await ensure(clone, target))) continue;
      const lines = await blobs.readLines(original, t.path);
      if (!lines) continue;
      const chain = await buildChain(clone, original, target, []);
      let result: TrackedAnchor;
      try {
        result = await trackRange(
          io,
          chain,
          {
            path: t.path,
            line: t.originalLine,
            startLine: t.originalStartLine,
            anchor: anchorFromLines(lines, t.originalLine, cfg.contextLines),
            ...(t.originalStartLine !== null ? { startAnchor: anchorFromLines(lines, t.originalStartLine, cfg.contextLines) } : {}),
          },
          cfg,
        );
      } catch {
        result = { tier: 'orphan', path: t.path, reason: 'no-confident-match' };
      }
      result = await recoverMoved(clone, result, { sha: original, path: t.path, line: t.originalLine, text: lines[t.originalLine - 1] ?? '' }, target);
      const got = result.endLine ?? result.line ?? null;
      const placed = got !== null ? ((await blobs.readLines(target, result.path))?.[got - 1] ?? '') : '';
      rows.push({
        pr,
        thread: first.url,
        path: t.path,
        outdated: t.isOutdated,
        expected: t.isOutdated ? null : t.line,
        got,
        tier: result.tier,
        score: result.score ?? null,
        correct: t.isOutdated || t.line === null ? null : got === t.line,
        steps: chain.length - 1,
        originalText: lines[t.originalLine - 1] ?? '',
        placedText: placed,
        placedPath: result.path,
        movedFrom: result.movedFrom ?? null,
      });
    }
    process.stderr.write(`PR #${pr}: ${threads.length} threads\n`);
  }
  blobs.dispose();

  const truth = rows.filter((r) => r.correct !== null);
  const byTier = new Map<string, { n: number; correct: number }>();
  for (const r of truth) {
    const s = byTier.get(r.tier) ?? { n: 0, correct: 0 };
    s.n++;
    if (r.correct) s.correct++;
    byTier.set(r.tier, s);
  }
  const outdated = rows.filter((r) => r.outdated);
  const outdatedTiers = new Map<string, number>();
  for (const r of outdated) outdatedTiers.set(r.tier, (outdatedTiers.get(r.tier) ?? 0) + 1);

  const lines: string[] = [];
  lines.push(`# Re-anchoring evaluation: ${slug} (${new Date().toISOString().slice(0, 10)})`, '');
  lines.push(`Config: place ${cfg.placeThreshold}, guess ${cfg.guessThreshold}, ambiguity margin ${cfg.ambiguityMargin}`, '');
  lines.push(`## Ground truth (non-outdated RIGHT-side threads, n=${truth.length})`, '', '| Tier | Correct / n | Precision |', '|---|---|---|');
  for (const [tier, s] of byTier) lines.push(`| ${tier} | ${s.correct}/${s.n} | ${((100 * s.correct) / s.n).toFixed(1)}% |`);
  const totalCorrect = truth.filter((r) => r.correct).length;
  lines.push(`| **all** | ${totalCorrect}/${truth.length} | ${truth.length ? ((100 * totalCorrect) / truth.length).toFixed(1) : '0'}% |`, '');
  lines.push(`## Outdated RIGHT-side threads (n=${outdated.length}): tier distribution`, '', '| Tier | Count |', '|---|---|');
  for (const [tier, c] of outdatedTiers) lines.push(`| ${tier} | ${c} |`);
  lines.push('', '## Outdated placements to hand-label', '', '| PR | Tier | Score | Original line | Placed line | Thread |', '|---|---|---|---|---|---|');
  for (const r of outdated) {
    const esc = (s: string) => s.trim().replace(/\|/g, '\\|').slice(0, 80);
    lines.push(`| #${r.pr} | ${r.tier} | ${r.score?.toFixed(2) ?? ''} | \`${esc(r.originalText)}\` | \`${esc(r.placedText)}\` | ${r.thread} |`);
  }
  const wrong = truth.filter((r) => !r.correct);
  if (wrong.length > 0) {
    lines.push('', '## Ground-truth misses', '', '| PR | Tier | Expected | Got | Steps | Thread |', '|---|---|---|---|---|---|');
    for (const r of wrong) lines.push(`| #${r.pr} | ${r.tier} | ${r.expected} | ${r.got ?? '—'} | ${r.steps} | ${r.thread} |`);
  }

  const outDir = join(process.cwd(), 'eval');
  await mkdir(outDir, { recursive: true });
  const stamp = `${owner}-${repo}-${new Date().toISOString().slice(0, 10)}`;
  await writeFile(join(outDir, `${stamp}.json`), JSON.stringify(rows, null, 2));
  await writeFile(join(outDir, `${stamp}.md`), lines.join('\n'));
  console.log(lines.slice(0, 8 + byTier.size + 6 + outdatedTiers.size).join('\n'));
  console.log(`\nFull report: eval/${stamp}.md`);
}

void main().catch((err: unknown) => {
  console.error(err);
  process.exit(1);
});
