import { anchorFromLines, findAnchor, type AnchorText } from './fuzzy';
import { shiftLine, type LineHunk } from './hunks';
import type { AnchorConfig, AnchorTier, TrackedAnchor } from './types';

export interface TrackIO {
  blobLines(sha: string, path: string): Promise<string[] | undefined>;
  hunks(from: string, to: string, fromPath: string, toPath: string): Promise<LineHunk[]>;
  pathAt(from: string, to: string, path: string): Promise<string | null>;
}

const ORDER: AnchorTier[] = ['exact', 'shifted', 'manual', 'fuzzy', 'guess', 'ai', 'orphan'];
const worse = (a: AnchorTier, b: AnchorTier): AnchorTier => (ORDER.indexOf(a) >= ORDER.indexOf(b) ? a : b);

/** Tracks one line from chain[0] (originalCommit) to the last element (head), step by step. */
export async function trackLine(
  io: TrackIO,
  chain: readonly string[],
  start: { path: string; line: number; anchor: AnchorText },
  cfg: AnchorConfig,
): Promise<TrackedAnchor> {
  let { path, line } = start;
  let anchor = start.anchor;
  let tier: AnchorTier = 'exact';
  let score: number | undefined;
  let changedAt: string | undefined;
  let ambiguous = false;

  for (let i = 0; i + 1 < chain.length; i++) {
    const from = chain[i]!;
    const to = chain[i + 1]!;
    const nextPath = await io.pathAt(from, to, path);
    if (nextPath === null) return { tier: 'orphan', reason: 'file-deleted', path, changedAt: to };
    const shift = shiftLine(await io.hunks(from, to, path, nextPath), line);
    path = nextPath;
    if (shift.kind === 'mapped') {
      line = shift.line;
      continue;
    }
    const lines = await io.blobLines(to, path);
    if (!lines) return { tier: 'orphan', reason: 'anchor-text-unavailable', path, changedAt: changedAt ?? to };
    const hit = findAnchor(lines, anchor, shift.predictedLine, cfg);
    if (!hit || hit.score < cfg.guessThreshold) return { tier: 'orphan', reason: 'no-confident-match', path, changedAt: changedAt ?? to };
    // The diff split the line into a hunk (e.g. a neighbouring block moved), but the text itself survived.
    const unchanged = (lines[hit.line - 1] ?? '').trim() === anchor.target.trim();
    if (!unchanged) changedAt ??= to;
    ambiguous ||= hit.ambiguous;
    tier = worse(tier, hit.ambiguous || hit.score < cfg.placeThreshold ? 'guess' : unchanged ? 'shifted' : 'fuzzy');
    score = Math.min(score ?? 1, hit.score);
    line = hit.line;
    anchor = anchorFromLines(lines, line, cfg.contextLines);
  }

  if (tier === 'exact' && line !== start.line) tier = 'shifted';
  const result: TrackedAnchor = { tier, path, line };
  if (score !== undefined) result.score = score;
  if (changedAt !== undefined) result.changedAt = changedAt;
  if (ambiguous) result.ambiguous = true;
  return result;
}

/** Multi-line threads: track both endpoints; degrade to the end line if the start dies or the range inverts. */
export async function trackRange(
  io: TrackIO,
  chain: readonly string[],
  start: { path: string; startLine: number | null; line: number; startAnchor?: AnchorText; anchor: AnchorText },
  cfg: AnchorConfig,
): Promise<TrackedAnchor> {
  const end = await trackLine(io, chain, { path: start.path, line: start.line, anchor: start.anchor }, cfg);
  if (start.startLine === null || start.startLine >= start.line || !start.startAnchor || end.line === undefined) return end;
  const first = await trackLine(io, chain, { path: start.path, line: start.startLine, anchor: start.startAnchor }, cfg);
  if (first.line === undefined || first.path !== end.path || first.line > end.line) return end;
  return { ...end, line: first.line, endLine: end.line, tier: worse(first.tier, end.tier) };
}
