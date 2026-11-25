import { net } from 'electron';
import { version as appVersion } from '../../package.json';
import type { UpdateInfo } from '../shared/model';
import { isNewer, RELEASES_REPO } from '../shared/version';

/** This build's version; PR_REVIEW_VERSION pretends to be another one (to try the update notice). */
export const currentVersion = () => process.env.PR_REVIEW_VERSION || appVersion;

/** Compares this version with the latest GitHub release (an anonymous API call; GitHub allows 60 an hour per address). */
export async function checkForUpdate(): Promise<UpdateInfo> {
  const current = currentVersion();
  try {
    const res = await net.fetch(`https://api.github.com/repos/${RELEASES_REPO}/releases/latest`, { headers: { accept: 'application/vnd.github+json' } });
    // 404: no release published yet.
    if (res.status === 404) return { current, latest: null, available: false, url: null, error: null };
    if (!res.ok) return { current, latest: null, available: false, url: null, error: `GitHub answered ${res.status}.` };
    const data = (await res.json()) as { tag_name: string; html_url: string };
    const latest = data.tag_name.replace(/^v/, '');
    return { current, latest, available: isNewer(latest, current), url: data.html_url, error: null };
  } catch (err) {
    return { current, latest: null, available: false, url: null, error: err instanceof Error ? err.message : String(err) };
  }
}
