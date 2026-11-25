import type { PrRef } from './model';

const URL_RE = /^https?:\/\/([^/\s]+)\/([^/\s]+)\/([^/\s]+)\/pull\/(\d+)(?:[/?#].*)?$/i;
const SHORT_RE = /^(?:([\w.-]+)\/)?([\w.-]+)\/([\w.-]+)#(\d+)$/;

export function parsePrInput(input: string, defaultHost = 'github.com'): PrRef | null {
  const text = input.trim();
  const url = URL_RE.exec(text);
  if (url) {
    return { host: url[1]!.toLowerCase(), owner: url[2]!, repo: url[3]!, number: Number(url[4]) };
  }
  const short = SHORT_RE.exec(text);
  if (short) {
    return { host: (short[1] ?? defaultHost).toLowerCase(), owner: short[2]!, repo: short[3]!, number: Number(short[4]) };
  }
  return null;
}

export function formatPrRef(ref: PrRef): string {
  const base = `${ref.owner}/${ref.repo}#${ref.number}`;
  return ref.host === 'github.com' ? base : `${ref.host}/${base}`;
}

/**
 * The pull request a `prreview://` link points at, as input for opening it: `prreview://open?pr=<url or owner/repo#n>`,
 * or a GitHub URL with its scheme swapped, `prreview://github.com/owner/repo/pull/12/files`.
 */
export function prFromAppUrl(url: string): string | null {
  const m = /^prreview:\/\/(.+)$/i.exec(url.trim());
  if (!m) return null;
  const open = /^open\/?\?(?:.*&)?pr=([^&#]+)/.exec(m[1]!);
  let input: string;
  try {
    input = open ? decodeURIComponent(open[1]!) : `https://${m[1]!.replace(/^https?:\/\//i, '')}`;
  } catch {
    return null;
  }
  return parsePrInput(input) ? input : null;
}

/** The PR view a GitHub URL shows: its Files changed or Commits tab, else none (the PR's own default). */
export function prViewFromUrl(input: string): 'files' | 'commits' | null {
  const m = /\/pull\/\d+\/(files|changes|commits)\b/i.exec(input);
  if (!m) return null;
  return m[1]!.toLowerCase() === 'commits' ? 'commits' : 'files';
}

/**
 * Pull request links the app opens in the browser get `pr_review=stay`, so the browser extension leaves them on
 * GitHub instead of sending them straight back to the app.
 */
export function markStay(url: string): string {
  if (!parsePrInput(url)) return url;
  try {
    const u = new URL(url);
    u.searchParams.set('pr_review', 'stay');
    return u.toString();
  } catch {
    return url;
  }
}
