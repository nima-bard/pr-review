import { readdir, stat } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import type { RepoMapping } from '../../shared/model';
import { git } from '../git/exec';
import { expandHome } from '../paths';
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

/**
 * Maps owner/repo of each clone's remotes to the clone. A root is a folder that holds clones (its direct subfolders
 * are looked at), or a clone itself: given the clone where the folder that holds it was meant, the clone is used, and
 * its own subfolders (its worktrees, say) aren't taken for clones. "~/" means the home folder.
 */
export async function scanRoots(roots: readonly string[]): Promise<RepoMapping[]> {
  const found: RepoMapping[] = [];
  const add = async (dir: string) => {
    for (const r of (await remotesOf(dir)).sort(preferOrigin)) {
      found.push({ slug: `${r.info.owner}/${r.info.repo}`.toLowerCase(), path: dir, source: 'scan' });
    }
  };
  for (const given of roots) {
    const root = expandHome(given);
    if (await isPrimaryClone(root)) {
      await add(root);
      continue;
    }
    let entries: string[];
    try {
      entries = await readdir(root);
    } catch {
      continue;
    }
    const clones = (await Promise.all(entries.map(async (name) => ((await isPrimaryClone(join(root, name))) ? join(root, name) : null)))).filter((d): d is string => d !== null);
    for (const dir of clones.sort()) await add(dir);
  }
  return found;
}

/**
 * The repository's top folder for `dir`, which can be any folder inside it: git finds the repository from a subfolder
 * too, but then reads every path it's given (`git diff … -- <path>`, `ls-tree`, `blame`) relative to that subfolder,
 * so a clone picked one level too deep showed every file with "No textual changes". Found by going up from `dir` as
 * git says (`--show-cdup`), so it's spelled as `dir` was (no symlinks resolved) and `dir` itself when it is the top,
 * which keeps the worktree paths made from it where they were. `dir` too when git can't say (not a repository, or a
 * bare one).
 */
export async function repoTopLevel(dir: string): Promise<string> {
  try {
    const up = (await git(dir, ['rev-parse', '--show-cdup'])).trim();
    return up ? resolve(dir, up) : dir;
  } catch {
    return dir;
  }
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
