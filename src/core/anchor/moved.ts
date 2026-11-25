import { git } from '../git/exec';
import type { TrackedAnchor } from './types';

/** For an orphaned thread: was the commented line moved verbatim (possibly to another file)? */
export async function recoverMoved(
  repo: string,
  orphan: TrackedAnchor,
  origin: { sha: string; path: string; line: number; text: string },
  head: string,
): Promise<TrackedAnchor> {
  if (orphan.tier !== 'orphan' || (orphan.reason !== 'no-confident-match' && orphan.reason !== 'file-deleted')) return orphan;
  const moved = await findMovedLine(repo, origin.sha, origin.path, origin.line, origin.text, head);
  if (!moved) return orphan;
  const result: TrackedAnchor = { tier: 'shifted', path: moved.path, line: moved.line };
  if (moved.path !== origin.path) result.movedFrom = origin.path;
  if (orphan.changedAt) result.changedAt = orphan.changedAt;
  return result;
}

export interface LineOrigin {
  commit: string;
  path: string;
  line: number;
}

/** Parses `git blame --porcelain` output into the origin of each final line. */
export function parseBlamePorcelain(out: string): Map<number, LineOrigin> {
  const result = new Map<number, LineOrigin>();
  const filenames = new Map<string, string>();
  let current: { commit: string; origLine: number; finalLine: number } | null = null;
  for (const line of out.split('\n')) {
    const header = /^([0-9a-f]{40}) (\d+) (\d+)(?: \d+)?$/.exec(line);
    if (header) {
      current = { commit: header[1]!, origLine: Number(header[2]), finalLine: Number(header[3]) };
      continue;
    }
    if (!current) continue;
    if (line.startsWith('filename ')) {
      filenames.set(current.commit, line.slice('filename '.length));
    } else if (line.startsWith('\t')) {
      const path = filenames.get(current.commit);
      if (path !== undefined) result.set(current.finalLine, { commit: current.commit, path, line: current.origLine });
      current = null;
    }
  }
  return result;
}

export async function blameOrigin(repo: string, rev: string, path: string, line: number): Promise<LineOrigin | null> {
  try {
    // -L restricts blame to one line, so lower the copy-detection threshold (default: 40 alphanumeric chars).
    // -w: code moved into another file is often re-indented (e.g. a module wrapper removed when a file is split).
    const out = await git(repo, ['blame', '--porcelain', '-w', '-C10', '-L', `${line},${line}`, rev, '--', path]);
    return parseBlamePorcelain(out).get(line) ?? null;
  } catch {
    return null;
  }
}

/**
 * Finds a line that moved to another place or file, unchanged apart from indentation: candidate files come from
 * `git grep` of the trimmed text at head, and `git blame -w -C` confirms it is the same line
 * (same introducing commit, path and line), not a coincidental duplicate.
 */
export async function findMovedLine(repo: string, originalRev: string, originalPath: string, line: number, text: string, head: string): Promise<{ path: string; line: number } | null> {
  const needle = text.trim();
  if (needle.length < 8) return null;
  const origin = await blameOrigin(repo, originalRev, originalPath, line);
  if (!origin) return null;
  let grep = '';
  try {
    grep = await git(repo, ['grep', '-F', '-n', '--no-color', '-e', needle, head]);
  } catch {
    return null;
  }
  const candidates = grep
    .split('\n')
    .filter(Boolean)
    .map((l) => {
      const rest = l.slice(head.length + 1);
      const m = /^(.*?):(\d+):/.exec(rest);
      return m ? { path: m[1]!, line: Number(m[2]) } : null;
    })
    .filter((c): c is { path: string; line: number } => c !== null)
    .slice(0, 20);
  for (const c of candidates) {
    const o = await blameOrigin(repo, head, c.path, c.line);
    if (o && o.commit === origin.commit && o.path === origin.path && o.line === origin.line) return c;
  }
  return null;
}
