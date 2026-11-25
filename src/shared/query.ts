/** Reads a qualifier value (e.g. `label:`) from a GitHub search query. */
export function getQualifier(query: string, key: string): string {
  const m = new RegExp(`(?:^|\\s)${key}:("[^"]*"|\\S+)`).exec(query);
  return m ? m[1]!.replace(/^"|"$/g, '') : '';
}

/** Replaces (or removes, for an empty value) a qualifier, like github.com's filter menus do. */
export function setQualifier(query: string, key: string, value: string): string {
  const stripped = query.replace(new RegExp(`(?:^|\\s)${key}:("[^"]*"|\\S+)`, 'g'), '').replace(/\s+/g, ' ').trim();
  if (!value) return stripped;
  const v = /\s/.test(value) ? `"${value}"` : value;
  return `${stripped} ${key}:${v}`.trim();
}

/** Switches between is:open and is:closed while keeping is:pr. */
export function setState(query: string, state: 'open' | 'closed'): string {
  const stripped = query.replace(/(?:^|\s)is:(open|closed|merged)\b/g, '').replace(/\s+/g, ' ').trim();
  return `${stripped} is:${state}`.trim();
}
