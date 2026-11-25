/** The file tree's order: at each level folders come before files, then by name. */
export function treeCompare(a: string, b: string): number {
  const pa = a.split('/');
  const pb = b.split('/');
  for (let i = 0; i < Math.min(pa.length, pb.length); i++) {
    if (pa[i] === pb[i]) continue;
    const aDir = i < pa.length - 1;
    const bDir = i < pb.length - 1;
    if (aDir !== bDir) return aDir ? -1 : 1;
    return pa[i]!.localeCompare(pb[i]!);
  }
  return pa.length - pb.length;
}

/** How many leading folders two file paths share. */
function sharedFolders(a: string, b: string): number {
  const pa = a.split('/').slice(0, -1);
  const pb = b.split('/').slice(0, -1);
  let n = 0;
  while (n < pa.length && n < pb.length && pa[n] === pb[n]) n++;
  return n;
}

/**
 * The candidate nearest to `path` in the tree: `path` itself if present, else the neighbour above or below where it
 * would be listed, preferring the one in the deeper shared folder (the one above on a tie). A folder's files are
 * listed together, so one of the two neighbours always shares the deepest folder any candidate shares.
 */
export function closestInTree(path: string, candidates: readonly string[]): string | null {
  let above: string | null = null;
  let below: string | null = null;
  for (const c of candidates) {
    const cmp = treeCompare(c, path);
    if (cmp === 0) return c;
    if (cmp < 0 && (above === null || treeCompare(c, above) > 0)) above = c;
    if (cmp > 0 && (below === null || treeCompare(c, below) < 0)) below = c;
  }
  if (above === null || below === null) return above ?? below;
  return sharedFolders(below, path) > sharedFolders(above, path) ? below : above;
}

/** The folders containing `path`, outermost first ("a/b/c.ts" → "a", "a/b"). */
export function foldersOf(path: string): string[] {
  const parts = path.split('/').slice(0, -1);
  return parts.map((_, i) => parts.slice(0, i + 1).join('/'));
}
