import { spawn } from 'node:child_process';
import type { CodeSearchMatch, CodeSearchQuery, CodeSearchResult } from '../../shared/model';
import { matcher, matchRanges } from '../../shared/searchMatch';
import { ENV, FIXED_CONFIG } from '../git/exec';

export { matcher };

export const RESULT_LIMIT = 2000;
const SHOWN_CHARS = 240;
/** Characters kept before a match that's further into its line. */
const LEAD_IN = 24;

/** VS Code-style globs from a comma-separated list: "*.ts" and "src" match at any depth, "./a/b" from the root. */
export function splitGlobs(list: string): string[] {
  // Commas separate globs, except inside braces ("*.{ts,tsx}").
  const parts: string[] = [];
  let depth = 0;
  let cur = '';
  for (const c of list) {
    if (c === ',' && depth === 0) {
      parts.push(cur);
      cur = '';
      continue;
    }
    if (c === '{') depth++;
    if (c === '}') depth = Math.max(0, depth - 1);
    cur += c;
  }
  parts.push(cur);
  return parts
    .map((g) => g.trim().replace(/^\.\//, ''))
    .filter(Boolean)
    .map((g) => (g.endsWith('/') ? `${g}**` : g))
    .map((g) => (g.includes('/') ? g : `**/${g}`));
}

/** A glob as a regular expression over a path; it also matches everything inside a folder it matches. */
export function globToRegExp(glob: string): RegExp {
  let re = '';
  for (let i = 0; i < glob.length; i++) {
    const c = glob[i]!;
    if (c === '*' && glob[i + 1] === '*') {
      const slash = glob[i + 2] === '/';
      re += slash ? '(?:.*/)?' : '.*';
      i += slash ? 2 : 1;
    } else if (c === '*') re += '[^/]*';
    else if (c === '?') re += '[^/]';
    else if (c === '{') re += '(?:';
    else if (c === '}') re += ')';
    else if (c === ',') re += '|';
    else re += c.replace(/[.+^$()|[\]\\]/g, '\\$&');
  }
  return new RegExp(`^${re}(?:/.*)?$`, 'i');
}

/** The paths that pass the include and exclude globs. */
export function filterPaths(paths: readonly string[], include: string, exclude: string): string[] {
  const inc = splitGlobs(include).map(globToRegExp);
  const exc = splitGlobs(exclude).map(globToRegExp);
  return paths.filter((p) => (inc.length === 0 || inc.some((r) => r.test(p))) && !exc.some((r) => r.test(p)));
}

/** "a.{ts,tsx}" → "a.ts", "a.tsx" (git's glob pathspecs have no braces). */
export function expandBraces(glob: string): string[] {
  const open = glob.indexOf('{');
  if (open === -1) return [glob];
  let depth = 0;
  let close = -1;
  const options: string[] = [];
  let cur = '';
  for (let i = open + 1; i < glob.length; i++) {
    const c = glob[i]!;
    if (c === '{') depth++;
    if (c === '}' && depth-- === 0) {
      close = i;
      break;
    }
    if (c === ',' && depth === 0) {
      options.push(cur);
      cur = '';
    } else cur += c;
  }
  if (close === -1) return [glob];
  options.push(cur);
  return options.flatMap((o) => expandBraces(glob.slice(0, open) + o + glob.slice(close + 1)));
}

/** The same globs as git pathspecs, for searching the whole worktree. A glob pathspec only matches whole paths,
 * so each also gets a "/**" twin for the contents of a folder it names. */
export function globPathspecs(include: string, exclude: string): string[] {
  const both = (glob: string) => expandBraces(glob).flatMap((g) => (g.endsWith('/**') ? [g] : [g, `${g}/**`]));
  return [...splitGlobs(include).flatMap(both).map((g) => `:(glob,icase)${g}`), ...splitGlobs(exclude).flatMap(both).map((g) => `:(exclude,glob,icase)${g}`)];
}

/** The line as shown: indentation dropped, cut around the first match when long, with the matches' ranges. */
export function shownLine(raw: string, re: RegExp | null): Pick<CodeSearchMatch, 'text' | 'ranges'> {
  const indent = raw.length - raw.trimStart().length;
  let text = raw.slice(indent).replace(/\s+$/, '');
  let ranges = re ? matchRanges(text, re) : [];
  // Like VS Code: a match further into the line is shown with a little of what precedes it ("…_role-admin-DarkMode"),
  // so the narrow results list doesn't cut off the match itself.
  const first = ranges[0]?.[0] ?? 0;
  const start = first > LEAD_IN + 8 ? first - LEAD_IN : 0;
  if (start > 0 || text.length > SHOWN_CHARS) {
    const cut = text.slice(start, start + SHOWN_CHARS);
    const lead = start > 0 ? '…' : '';
    const shift = lead.length - start;
    ranges = ranges.map(([a, b]): [number, number] => [a + shift, b + shift]).filter(([a]) => a >= lead.length && a < lead.length + cut.length).map(([a, b]) => [a, Math.min(b, lead.length + cut.length)]);
    text = `${lead}${cut}${start + SHOWN_CHARS < text.length ? '…' : ''}`;
  }
  return { text, ranges };
}

/**
 * Runs `git grep` in `cwd` (a worktree: the files on disk, tracked and untracked but not ignored) and streams its
 * output until `RESULT_LIMIT` matches. `paths` limits it to those files (literal paths); null searches everything
 * the globs allow.
 */
export function searchWorktree(cwd: string, q: CodeSearchQuery, paths: readonly string[] | null, signal?: AbortSignal): Promise<CodeSearchResult> {
  const empty: CodeSearchResult = { files: [], total: 0, truncated: false, error: null };
  if (q.pattern === '' || (paths && paths.length === 0)) return Promise.resolve(empty);
  const pathspecs = paths ? paths.map((p) => `:(literal)${p}`) : globPathspecs(q.include, q.exclude);
  const args = [
    ...FIXED_CONFIG,
    'grep',
    '-n',
    '--column',
    '-I',
    '--null',
    '--untracked',
    ...(q.matchCase ? [] : ['-i']),
    ...(q.wholeWord ? ['-w'] : []),
    q.regex ? '-P' : '-F',
    '-e',
    q.pattern,
    '--',
    ...pathspecs,
  ];
  const re = matcher(q);
  return new Promise((resolve) => {
    const child = spawn('git', args, { cwd, env: { ...process.env, ...ENV }, signal });
    const files: CodeSearchResult['files'] = [];
    let total = 0;
    let truncated = false;
    let rest = '';
    let stderr = '';
    const take = (record: string) => {
      const [path, line, , text] = record.split('\0');
      if (path === undefined || line === undefined || text === undefined) return;
      let file = files.at(-1);
      if (file?.path !== path) {
        file = { path, matches: [] };
        files.push(file);
      }
      file.matches.push({ line: Number(line), ...shownLine(text, re) });
      total++;
    };
    child.stdout.setEncoding('utf8');
    child.stdout.on('data', (chunk: string) => {
      if (truncated) return;
      const lines = (rest + chunk).split('\n');
      rest = lines.pop() ?? '';
      for (const record of lines) {
        take(record);
        if (total >= RESULT_LIMIT) {
          truncated = true;
          child.kill();
          break;
        }
      }
    });
    child.stderr.setEncoding('utf8');
    child.stderr.on('data', (chunk: string) => (stderr += chunk));
    child.on('error', (err) => resolve({ ...empty, error: err.name === 'AbortError' ? null : err.message }));
    child.on('close', (code) => {
      if (!truncated && rest) take(rest);
      // 1 means no match; 128 is git's error, e.g. an invalid regular expression.
      const error = !truncated && code !== null && code > 1 ? (stderr.split('\n').find((l) => l.trim()) ?? 'git grep failed').replace(/^fatal: /, '') : null;
      resolve({ files, total, truncated, error });
    });
  });
}
