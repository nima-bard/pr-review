/** A comment's Markdown in pieces: plain Markdown, and ```suggestion blocks (the replacement lines they propose). */
export type CommentPart = { kind: 'text'; text: string } | { kind: 'suggestion'; lines: string[] };

const SUGGESTION = /^```suggestion[^\n]*\n([\s\S]*?)^```[ \t]*$/gm;

/**
 * Splits a comment around its ```suggestion blocks, which GitHub shows as a change to the commented lines rather
 * than as code. An empty block suggests deleting the lines.
 */
export function splitSuggestions(body: string): CommentPart[] {
  const parts: CommentPart[] = [];
  let last = 0;
  for (const m of body.matchAll(SUGGESTION)) {
    const before = body.slice(last, m.index);
    if (before.trim()) parts.push({ kind: 'text', text: before });
    const content = (m[1] ?? '').replace(/\n$/, '');
    parts.push({ kind: 'suggestion', lines: content === '' ? [] : content.split('\n') });
    last = m.index + m[0].length;
  }
  const rest = body.slice(last);
  if (rest.trim()) parts.push({ kind: 'text', text: rest });
  return parts;
}
