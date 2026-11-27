import type { PrSnapshot } from '../../shared/model';
import type { ContextMenuItem } from '../../shared/ipc';
import { api, errorText } from '../api';
import { setSessionError } from '../state/sessions';
import { openFileTab } from '../state/ui';
import { fileActions, runQuickAction } from '../state/quickActions';

/** GitHub's anchor for a file on a pull request's "Files changed" page: "diff-" and the SHA-256 of its path. */
async function diffAnchor(path: string): Promise<string> {
  const hash = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(path));
  return `diff-${[...new Uint8Array(hash)].map((b) => b.toString(16).padStart(2, '0')).join('')}`;
}

/** The actions on a file (its ⋯ button, a right-click in the tree, the file tab's menu); `whole` adds "Show Whole File". */
export function fileMenuItems(snapshot: PrSnapshot, path: string, { whole = true } = {}): ContextMenuItem[] {
  const deleted = snapshot.files.find((f) => f.path === path)?.change === 'deleted';
  return [
    ...(whole ? [{ id: 'file:whole', label: 'Show Whole File' }, 'separator' as const] : []),
    { id: 'file:editor', label: 'Open in Editor', enabled: !deleted },
    { id: 'file:github', label: 'View on GitHub' },
    { id: 'file:finder', label: 'Reveal in Finder', enabled: !deleted },
    'separator',
    { id: 'file:copy', label: 'Copy Path' },
    { id: 'file:copy-full', label: 'Copy Full Path' },
    // Changed in the checkout and not committed: it can go back.
    ...(snapshot.worktree.uncommitted.includes(path) ? ['separator' as const, { id: 'file:discard', label: 'Discard Changes…' }] : []),
    ...actionItems(snapshot, deleted),
  ];
}

/** The file quick actions from Settings, after the built-in ones. */
function actionItems(snapshot: PrSnapshot, deleted: boolean): ContextMenuItem[] {
  const actions = fileActions(snapshot);
  if (actions.length === 0) return [];
  return ['separator', ...actions.map((a) => ({ id: `qa:${a.id}`, label: a.mode === 'terminal' ? `${a.name} ↗` : a.name, enabled: !deleted }))];
}

/** Runs a file action chosen from `fileMenuItems`; returns false for any other menu choice. */
export async function runFileAction(snapshot: PrSnapshot, path: string, choice: string | null): Promise<boolean> {
  if (choice?.startsWith('qa:')) {
    await runQuickAction(snapshot.key, choice.slice(3), path);
    return true;
  }
  if (!choice?.startsWith('file:')) return false;
  const changed = snapshot.files.some((f) => f.path === path);
  const { host, owner, repo, number } = snapshot.ref;
  try {
    if (choice === 'file:whole') openFileTab(snapshot.key, path, changed, false);
    if (choice === 'file:editor') await api.openInEditor(snapshot.key, path, 1);
    if (choice === 'file:finder') await api.showInFinder(snapshot.key, path);
    if (choice === 'file:copy') await navigator.clipboard.writeText(path);
    if (choice === 'file:copy-full') await navigator.clipboard.writeText(`${snapshot.worktree.path}/${path}`);
    if (choice === 'file:discard') await api.discardLocal(snapshot.key, [path]);
    if (choice === 'file:github') {
      // A changed file: its place in the pull request's "Files changed"; any other file: as it is at the PR's head.
      await api.openExternal(
        changed ? `https://${host}/${owner}/${repo}/pull/${number}/files#${await diffAnchor(path)}` : `https://${host}/${owner}/${repo}/blob/${snapshot.details.headRefOid}/${path}`,
      );
    }
  } catch (err) {
    setSessionError(snapshot.key, errorText(err));
  }
  return true;
}

/** Shows the file actions as a native menu and runs the chosen one. */
export async function showFileMenu(snapshot: PrSnapshot, path: string): Promise<void> {
  await runFileAction(snapshot, path, await api.contextMenu(fileMenuItems(snapshot, path)));
}
