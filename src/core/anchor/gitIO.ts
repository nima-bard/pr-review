import type { BlobReader } from '../git/blobs';
import { blobHunks, renameMap } from '../git/diff';
import type { LineHunk } from './hunks';
import type { TrackIO } from './track';

/** TrackIO backed by a local clone, with per-step caches shared by all threads of a PR. */
export function createGitTrackIO(repo: string, blobs: BlobReader): TrackIO {
  const renames = new Map<string, Promise<Map<string, string | null>>>();
  const hunks = new Map<string, Promise<LineHunk[]>>();
  return {
    blobLines: (sha, path) => blobs.readLines(sha, path),
    hunks(from, to, fromPath, toPath) {
      const key = `${from}:${fromPath}\0${to}:${toPath}`;
      let p = hunks.get(key);
      if (!p) {
        p = blobHunks(repo, from, to, fromPath, toPath);
        hunks.set(key, p);
      }
      return p;
    },
    async pathAt(from, to, path) {
      const key = `${from}..${to}`;
      let p = renames.get(key);
      if (!p) {
        p = renameMap(repo, from, to);
        renames.set(key, p);
      }
      const map = await p;
      return map.has(path) ? (map.get(path) ?? null) : path;
    },
  };
}
