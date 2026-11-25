import type { CodeSearchQuery } from './model';

/** The query as a JavaScript regular expression, to mark every match in a line (git reports only the first). */
export function matcher(q: Pick<CodeSearchQuery, 'pattern' | 'regex' | 'wholeWord' | 'matchCase'>): RegExp | null {
  const source = q.regex ? q.pattern : q.pattern.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const wrapped = q.wholeWord ? `(?<!\\w)(?:${source})(?!\\w)` : source;
  for (const flags of ['gu', 'g']) {
    try {
      return new RegExp(wrapped, q.matchCase ? flags : `${flags}i`);
    } catch {
      // Some PCRE patterns git accepts aren't valid here (or not in unicode mode): then nothing is marked.
    }
  }
  return null;
}

/** Every match of `re` in `text`, as [start, end) (empty matches skipped). */
export function matchRanges(text: string, re: RegExp): [number, number][] {
  const ranges: [number, number][] = [];
  re.lastIndex = 0;
  for (let m = re.exec(text); m; m = re.exec(text)) {
    if (m[0].length === 0) {
      re.lastIndex++;
      continue;
    }
    ranges.push([m.index, m.index + m[0].length]);
  }
  return ranges;
}
