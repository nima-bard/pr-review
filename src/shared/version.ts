/** The repository whose GitHub releases are this app's updates. */
export const RELEASES_REPO = 'stefan-schweiger/pr-review';

/** Whether version `a` is newer than `b` ("1.10.0" > "1.9.2"; a pre-release like "1.2.0-beta.1" comes before "1.2.0"). */
export function isNewer(a: string, b: string): boolean {
  const parse = (v: string) => {
    const [core = '', pre = ''] = v.trim().replace(/^v/, '').split('-', 2);
    return { parts: core.split('.').map((n) => Number.parseInt(n, 10) || 0), pre };
  };
  const x = parse(a);
  const y = parse(b);
  for (let i = 0; i < Math.max(x.parts.length, y.parts.length); i++) {
    const d = (x.parts[i] ?? 0) - (y.parts[i] ?? 0);
    if (d !== 0) return d > 0;
  }
  if (x.pre === y.pre) return false;
  if (!x.pre) return true;
  if (!y.pre) return false;
  return x.pre.localeCompare(y.pre, undefined, { numeric: true }) > 0;
}
