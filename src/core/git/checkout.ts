import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { isBinary } from './blobs';
import { parseNameStatus, parseNumstat, type ChangedFile } from './diff';
import { GitError, git } from './exec';

/**
 * A pull request's checkout while you edit it on its branch: what changed since its latest push (`head`), and the
 * steps that move those changes on (commit, pull, push, discard) or switch the checkout between following the pull
 * request and editing it. Plain git in the worktree, so it works the same whether you or Claude changed the files.
 */

const DIFF_FLAGS = ['--no-ext-diff', '--no-color', '--histogram'];

/** Files git doesn't track yet and doesn't ignore: new files. */
async function untrackedFiles(worktree: string): Promise<string[]> {
  return (await git(worktree, ['ls-files', '--others', '--exclude-standard', '-z'])).split('\0').filter(Boolean);
}

/**
 * Files changed in a worktree since `head`: in its commits not pushed yet, in edits not committed, and new files.
 * A new file's lines count as added (a binary one has none).
 */
export async function localChanges(worktree: string, head: string): Promise<ChangedFile[]> {
  const [nameStatus, numstat, untracked] = await Promise.all([
    git(worktree, ['diff', '-M', '--name-status', '-z', ...DIFF_FLAGS, head]),
    git(worktree, ['diff', '-M', '--numstat', '-z', ...DIFF_FLAGS, head]),
    untrackedFiles(worktree),
  ]);
  const stats = parseNumstat(numstat);
  const tracked: ChangedFile[] = parseNameStatus(nameStatus).map((f) => ({ path: f.path, oldPath: f.oldPath, change: f.status, ...(stats.get(f.path) ?? { additions: 0, deletions: 0, binary: false }) }));
  const added = await Promise.all(
    untracked.map(async (path): Promise<ChangedFile> => {
      const buf = await readFile(join(worktree, path)).catch(() => Buffer.alloc(0));
      const binary = isBinary(buf);
      return { path, oldPath: null, change: 'added', additions: binary ? 0 : lines(buf.toString('utf8')).length, deletions: 0, binary };
    }),
  );
  return [...tracked, ...added].sort((a, b) => a.path.localeCompare(b.path));
}

/** A text's lines, without the empty one after a final newline. */
function lines(text: string): string[] {
  const all = text.split('\n');
  if (all.at(-1) === '') all.pop();
  return all;
}

/** A whole file as an added one, in git's patch format, for a file git doesn't track yet. */
export function newFilePatch(path: string, text: string): string {
  const body = lines(text);
  if (body.length === 0) return `diff --git a/${path} b/${path}\nnew file mode 100644\n`;
  const noEol = !text.endsWith('\n') ? ['\\ No newline at end of file'] : [];
  return [`diff --git a/${path} b/${path}`, 'new file mode 100644', '--- /dev/null', `+++ b/${path}`, `@@ -0,0 +1,${body.length} @@`, ...body.map((l) => `+${l}`), ...noEol, ''].join('\n');
}

/** One file's changes since `head` as a patch: against the working copy, or all of it as new when git doesn't track it. */
export async function localPatch(worktree: string, head: string, path: string, oldPath: string | null): Promise<string> {
  const tracked = (await git(worktree, ['ls-files', '-z', '--', path])) !== '' || (await git(worktree, ['cat-file', '-e', `${head}:${path}`]).then(() => true, () => false));
  if (!tracked) {
    const buf = await readFile(join(worktree, path)).catch(() => Buffer.alloc(0));
    return isBinary(buf) ? '' : newFilePatch(path, buf.toString('utf8'));
  }
  const paths = oldPath && oldPath !== path ? [oldPath, path] : [path];
  return git(worktree, ['diff', '-M', '-U3', ...DIFF_FLAGS, head, '--', ...paths]);
}

/** The worktree's commits not pushed yet (ahead), and pushed commits it doesn't have yet (behind), against `head`. */
export async function aheadBehind(worktree: string, head: string): Promise<{ ahead: number; behind: number }> {
  const [ahead = 0, behind = 0] = (await git(worktree, ['rev-list', '--left-right', '--count', `HEAD...${head}`])).trim().split(/\s+/).map(Number);
  return { ahead, behind };
}

/** Files with changes not committed, new files included: what Commit takes, and what blocks leaving the branch. */
export async function uncommitted(worktree: string): Promise<string[]> {
  const parts = (await git(worktree, ['status', '--porcelain', '-z', '--untracked-files=all'])).split('\0');
  const paths: string[] = [];
  for (let i = 0; i < parts.length; i++) {
    const entry = parts[i]!;
    if (entry.length < 4) continue;
    paths.push(entry.slice(3));
    // A rename or copy names the old path next; it isn't a change of its own.
    if (entry[0] === 'R' || entry[0] === 'C') i++;
  }
  return paths;
}

/** The branch a worktree is on, or null when it's detached. */
export async function currentBranch(worktree: string): Promise<string | null> {
  const out = await git(worktree, ['symbolic-ref', '--quiet', '--short', 'HEAD']).catch(() => '');
  return out.trim() || null;
}

/**
 * Puts a worktree on the pull request's `branch` from `remote`, for editing: the local branch of that name when there
 * is one, as it is (its commits stay; Pull brings in what's new), else a new one tracking `remote`'s. Edits not
 * committed come along. For a branch in the same repository; a fork's is set up with `gh pr checkout`.
 */
export async function attachBranch(worktree: string, remote: string, branch: string): Promise<void> {
  await git(worktree, ['fetch', '--quiet', '--no-tags', remote, `+refs/heads/${branch}:refs/remotes/${remote}/${branch}`]);
  const exists = await git(worktree, ['rev-parse', '--verify', '--quiet', `refs/heads/${branch}`]).then(
    () => true,
    () => false,
  );
  if (exists) await git(worktree, ['checkout', '--quiet', branch]);
  else await git(worktree, ['checkout', '--quiet', '-b', branch, '--track', `${remote}/${branch}`]);
}

const plural = (n: number, one: string, many: string) => `${n} ${n === 1 ? one : many}`;

/**
 * Takes a worktree off its branch, back to following the pull request at `head`. Refused while files have changes not
 * committed; commits not pushed stay on the branch.
 */
export async function detachAt(worktree: string, head: string): Promise<void> {
  const dirty = await uncommitted(worktree);
  if (dirty.length > 0) throw new Error(`${plural(dirty.length, 'file has', 'files have')} uncommitted changes. Commit or discard them first.`);
  await git(worktree, ['checkout', '--quiet', '--detach', head]);
}

/** Commits every change in the worktree, new files too, with `message`; the new commit. */
export async function commitAll(worktree: string, message: string): Promise<string> {
  if (!message.trim()) throw new Error('The commit needs a message.');
  if ((await uncommitted(worktree)).length === 0) throw new Error('There’s nothing to commit.');
  await git(worktree, ['add', '--all']);
  await git(worktree, ['commit', '--quiet', '-m', message.trim()]);
  return (await git(worktree, ['rev-parse', 'HEAD'])).trim();
}

/**
 * Brings in what was pushed since: the worktree's own commits go on top of `head`. It needs a clean worktree, and on a
 * conflict it changes nothing and says so.
 */
export async function pullOnto(worktree: string, head: string): Promise<void> {
  const dirty = await uncommitted(worktree);
  if (dirty.length > 0) throw new Error(`${plural(dirty.length, 'file has', 'files have')} uncommitted changes. Commit or discard them, then pull.`);
  try {
    await git(worktree, ['rebase', '--quiet', head]);
  } catch {
    await git(worktree, ['rebase', '--abort']).catch(() => undefined);
    throw new Error('Your commits conflict with the new ones on GitHub. Nothing was changed: pull in a terminal to sort it out.');
  }
}

/**
 * Pushes the worktree's branch to the pull request's: to the remote and branch git has set up for it (as `gh pr
 * checkout` does for a fork), else to `fallback`. Never forced: when the branch moved on GitHub it's refused.
 */
export async function pushBranch(worktree: string, fallback: { remote: string; branch: string }): Promise<void> {
  const local = await currentBranch(worktree);
  if (!local) throw new Error('The checkout isn’t on a branch: switch to Contribute first.');
  const config = async (key: string) => (await git(worktree, ['config', '--get', key]).catch(() => '')).trim();
  const remote = (await config(`branch.${local}.pushRemote`)) || (await config(`branch.${local}.remote`)) || fallback.remote;
  const merge = (await config(`branch.${local}.merge`)) || `refs/heads/${fallback.branch}`;
  try {
    await git(worktree, ['push', '--quiet', remote, `HEAD:${merge}`]);
  } catch (err) {
    if (err instanceof GitError && /\[rejected\]|non-fast-forward|fetch first/.test(err.stderr)) throw new Error('The branch has new commits on GitHub. Pull first, then push.');
    throw err;
  }
}

/** Throws away changes to `paths` since the last commit: edited files go back to it, new files are deleted. */
export async function discard(worktree: string, paths: readonly string[]): Promise<void> {
  if (paths.length === 0) return;
  const tracked = new Set((await git(worktree, ['ls-files', '-z', '--', ...paths])).split('\0').filter(Boolean));
  const known = paths.filter((p) => tracked.has(p));
  const added = paths.filter((p) => !tracked.has(p));
  if (known.length > 0) await git(worktree, ['restore', '--source=HEAD', '--staged', '--worktree', '--', ...known]);
  if (added.length > 0) await git(worktree, ['clean', '--quiet', '-f', '--', ...added]);
}
