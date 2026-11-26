/** HTML that comments use for layout (a details block, a line break…), not text; `<foo>` placeholders stay. */
const LAYOUT_TAGS = /<\/?(?:details|summary|br|p|div|span|sub|sup|b|i|em|strong|code|kbd|img|a|hr|ul|ol|li|table|thead|tbody|tr|td|th|h[1-6])\b[^>]*>/gi;

/** One line of Markdown as plain text: links and images to their text, without emphasis, code or heading marks. */
function plainLine(line: string): string {
  return line
    .replace(/^\s{0,3}(?:#{1,6}\s+|>\s?|[-*+]\s+(?:\[[ xX]\]\s+)?|\d+[.)]\s+)/, '')
    .replace(/!?\[([^\]]*)\]\([^)]*\)/g, '$1')
    .replace(/`([^`]+)`/g, '$1')
    .replace(/(\*\*|__|~~)(.+?)\1/g, '$2')
    .replace(/(^|[^\w*])[*_]([^*_\s](?:[^*_]*[^*_\s])?)[*_](?=[^\w*]|$)/g, '$1$2')
    .replace(/\s+/g, ' ')
    .trim();
}

/**
 * The start of a comment for a one-line preview (the file tree, a folded thread): its first line of text, as GitHub
 * would show it, without the Markdown around it. Code blocks (suggestions too), HTML comments, layout tags and table
 * rules are left out.
 */
export function markdownPreview(markdown: string): string {
  const text = markdown
    .replace(/<!--[\s\S]*?-->/g, '')
    .replace(/^\s{0,3}(`{3,}|~{3,})[^\n]*\n[\s\S]*?(?:^\s{0,3}\1[^\n]*$|(?![\s\S]))/gm, '')
    .replace(LAYOUT_TAGS, ' ');
  for (const line of text.split('\n')) {
    if (/^\s*\|?\s*:?-{3,}/.test(line) || /^\s*([-*_])(\s*\1){2,}\s*$/.test(line)) continue;
    const plain = plainLine(line);
    if (plain) return plain;
  }
  return '';
}
