import { processFile, type FileDiffMetadata } from '@pierre/diffs';
import { useEffect, useState } from 'react';
import type { FileContent, FileDiffModel } from '../../shared/model';
import { api, errorText } from '../api';

export interface LoadedDiff {
  model: FileDiffModel;
  meta: FileDiffMetadata | undefined;
}

const diffCache = new Map<string, Promise<LoadedDiff | null>>();
const fileCache = new Map<string, Promise<FileContent>>();

export function clearDiffCache(prefix: string): void {
  for (const k of diffCache.keys()) if (k.startsWith(prefix)) diffCache.delete(k);
  for (const k of fileCache.keys()) if (k.startsWith(prefix)) fileCache.delete(k);
}

export function loadFile(key: string, version: string, rev: 'base' | 'head' | 'worktree', path: string): Promise<FileContent> {
  const k = `${key}@${version}:${rev}:${path}`;
  let p = fileCache.get(k);
  if (!p) {
    p = api.readFile(key, rev, path);
    fileCache.set(k, p);
    p.catch(() => fileCache.delete(k));
  }
  return p;
}

/** Above this, a file keeps the patch-only diff (unchanged regions load when expanded). */
const MAX_EAGER_CONTENT = 1_500_000;

/**
 * Both sides of a modified or renamed file, so Pierre gets a complete diff: it can then show short unchanged gaps
 * (see `collapsedContextThreshold`) and count the lines left at the end. Added and deleted files already carry
 * their whole content in the patch.
 */
async function eagerContents(key: string, version: string, model: FileDiffModel): Promise<{ oldFile: { name: string; contents: string }; newFile: { name: string; contents: string } } | null> {
  if (model.binary || (model.change !== 'modified' && model.change !== 'renamed')) return null;
  const [oldFile, newFile] = await Promise.all([loadFile(key, version, 'base', model.oldPath), loadFile(key, version, 'head', model.path)]);
  if (oldFile.missing || newFile.missing || oldFile.binary || newFile.binary) return null;
  if (oldFile.contents.length + newFile.contents.length > MAX_EAGER_CONTENT) return null;
  return { oldFile: { name: model.oldPath, contents: oldFile.contents }, newFile: { name: model.path, contents: newFile.contents } };
}

/** `withContents`: load both file sides up front (not in compare mode, where the old side isn't the base). */
export function useFileDiff(key: string, version: string, path: string, enabled: boolean, withContents = false): { data: LoadedDiff | null; error: string | null; loading: boolean } {
  const [state, setState] = useState<{ data: LoadedDiff | null; error: string | null; loading: boolean }>({ data: null, error: null, loading: enabled });
  useEffect(() => {
    if (!enabled) return;
    const k = `${key}@${version}:${path}${withContents ? ':full' : ''}`;
    let p = diffCache.get(k);
    if (!p) {
      p = api.getFileDiff(key, path).then(async (model) => {
        if (!model) return null;
        if (model.patch.trim() === '') return { model, meta: undefined };
        const contents = withContents ? await eagerContents(key, version, model).catch(() => null) : null;
        return { model, meta: processFile(model.patch, { isGitDiff: true, cacheKey: k, ...(contents ?? {}) }) };
      });
      diffCache.set(k, p);
      p.catch(() => diffCache.delete(k));
    }
    let alive = true;
    setState((s) => ({ ...s, loading: true }));
    p.then(
      (data) => alive && setState({ data, error: null, loading: false }),
      (err: unknown) => alive && setState({ data: null, error: errorText(err), loading: false }),
    );
    return () => {
      alive = false;
    };
  }, [key, version, path, enabled, withContents]);
  return state;
}

export function useFileContent(key: string, version: string, rev: 'base' | 'head' | 'worktree', path: string | null): FileContent | null {
  const [content, setContent] = useState<FileContent | null>(null);
  useEffect(() => {
    if (!path) return;
    let alive = true;
    setContent(null);
    void loadFile(key, version, rev, path).then((c) => alive && setContent(c));
    return () => {
      alive = false;
    };
  }, [key, version, rev, path]);
  return content;
}
