import { readdir, stat } from 'node:fs/promises';
import { join } from 'node:path';
import type { RepoMapping } from '../../shared/model';
import { git } from '../git/exec';
import { parseRemoteConfig, type RemoteInfo } from './remote';

async function isPrimaryClone(dir: string): Promise<boolean> {
  try {
    return (await stat(join(dir, '.git'))).isDirectory();
  } catch {
    return false;
  }
}

export async function remotesOf(dir: string): Promise<{ name: string; info: RemoteInfo }[]> {
  try {
    return parseRemoteConfig(await git(dir, ['config', '--get-regexp', '^remote\\..*\\.url$']));
  } catch {
    return [];
  }
}

const preferOrigin = (a: { name: string }, b: { name: string }) =>
  (a.name === 'origin' ? 0 : a.name === 'upstream' ? 1 : 2) - (b.name === 'origin' ? 0 : b.name === 'upstream' ? 1 : 2);

/** Scans each root (depth 1) for primary clones and maps owner/repo of their remotes to the clone path. */
export async function scanRoots(roots: readonly string[]): Promise<RepoMapping[]> {
  const found: RepoMapping[] = [];
  for (const root of roots) {
    let entries: string[];
    try {
      entries = await readdir(root);
    } catch {
      continue;
    }
    await Promise.all(
      entries.map(async (name) => {
        const dir = join(root, name);
        if (!(await isPrimaryClone(dir))) return;
        const remotes = (await remotesOf(dir)).sort(preferOrigin);
        for (const r of remotes) {
          found.push({ slug: `${r.info.owner}/${r.info.repo}`.toLowerCase(), path: dir, source: 'scan' });
        }
      }),
    );
  }
  return found;
}

/** First mapping per slug wins: manual mappings before scanned ones, origin before other remotes. */
export function mergeMappings(manual: readonly RepoMapping[], scanned: readonly RepoMapping[]): RepoMapping[] {
  const bySlug = new Map<string, RepoMapping>();
  for (const m of [...manual, ...scanned]) if (!bySlug.has(m.slug)) bySlug.set(m.slug, m);
  return [...bySlug.values()].sort((a, b) => a.slug.localeCompare(b.slug));
}

export async function remoteNameFor(clonePath: string, owner: string, repo: string): Promise<string | null> {
  const slug = `${owner}/${repo}`.toLowerCase();
  const match = (await remotesOf(clonePath))
    .sort(preferOrigin)
    .find((r) => `${r.info.owner}/${r.info.repo}`.toLowerCase() === slug);
  return match?.name ?? null;
}
