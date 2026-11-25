import { parseHunkSide } from './fuzzy';
import type { DiffSide } from './types';

const norm = (s: string | undefined) => (s ?? '').replace(/\r$/, '').trimEnd();

/** True when every side-line of the frozen hunk appears verbatim at its stated line number. */
export function validateAgainstHunk(lines: readonly string[], diffHunk: string, side: DiffSide): boolean {
  const sideLines = parseHunkSide(diffHunk, side);
  return sideLines.length > 0 && sideLines.every((l) => norm(lines[l.num - 1]) === norm(l.text));
}

/** The first candidate revision whose blob matches the hunk wins. */
export async function pickOriginalBlob(
  candidates: readonly string[],
  load: (sha: string) => Promise<string[] | undefined>,
  diffHunk: string,
  side: DiffSide,
): Promise<{ sha: string; lines: string[] } | undefined> {
  for (const sha of candidates) {
    const lines = await load(sha);
    if (lines && validateAgainstHunk(lines, diffHunk, side)) return { sha, lines };
  }
  return undefined;
}
