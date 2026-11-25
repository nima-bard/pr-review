import type { PrSnapshot, QuickAction } from './model';

/**
 * The environment variables a quick action gets, with what they hold. They're passed as variables, not pasted into
 * the command: titles and branch names come from whoever opened the pull request, and as "$PR_TITLE" the shell
 * treats them as text, never as commands.
 */
export const ACTION_VARIABLES: { name: string; desc: string; file?: true }[] = [
  { name: 'PR_NUMBER', desc: 'The pull request number' },
  { name: 'PR_URL', desc: 'Its address on GitHub' },
  { name: 'PR_REPO', desc: 'owner/repo' },
  { name: 'PR_OWNER', desc: 'The repository owner' },
  { name: 'PR_REPO_NAME', desc: 'The repository name' },
  { name: 'PR_TITLE', desc: 'The title' },
  { name: 'PR_AUTHOR', desc: 'The author’s login' },
  { name: 'PR_ROLE', desc: '"author" on your own pull requests, else "reviewer"' },
  { name: 'PR_HEAD_BRANCH', desc: 'The branch with the changes' },
  { name: 'PR_BASE_BRANCH', desc: 'The branch it merges into' },
  { name: 'PR_HEAD_SHA', desc: 'The head commit' },
  { name: 'PR_BASE_SHA', desc: 'The base branch’s commit' },
  { name: 'PR_MERGE_BASE', desc: 'Where the branch left the base branch' },
  { name: 'PR_COMPARE_FROM', desc: 'The commit the diff shows changes since, when that’s not the whole PR (else empty)' },
  { name: 'PR_WORKTREE', desc: 'The worktree (also the working directory)' },
  { name: 'PR_CLONE', desc: 'The clone the worktree belongs to' },
  { name: 'PR_FILE', desc: 'The file, relative to the worktree', file: true },
  { name: 'PR_FILE_PATH', desc: 'The file’s full path', file: true },
];

/** The variables for `snapshot`, and `file` for a file action. */
export function actionEnv(snapshot: PrSnapshot, file: string | null = null): Record<string, string> {
  const { ref, details: d } = snapshot;
  return {
    PR_NUMBER: String(ref.number),
    PR_URL: d.url,
    PR_REPO: `${ref.owner}/${ref.repo}`,
    PR_OWNER: ref.owner,
    PR_REPO_NAME: ref.repo,
    PR_TITLE: d.title,
    PR_AUTHOR: d.author,
    PR_ROLE: snapshot.role,
    PR_HEAD_BRANCH: d.headRefName,
    PR_BASE_BRANCH: d.baseRefName,
    PR_HEAD_SHA: d.headRefOid,
    PR_BASE_SHA: d.baseRefOid,
    PR_MERGE_BASE: snapshot.mergeBase,
    PR_COMPARE_FROM: snapshot.compare?.from ?? '',
    PR_WORKTREE: snapshot.worktree.path,
    PR_CLONE: snapshot.clonePath,
    ...(file ? { PR_FILE: file, PR_FILE_PATH: `${snapshot.worktree.path}/${file}` } : {}),
  };
}

/** Whether `action` is offered for repository `repo` ("owner/repo"): its patterns, "owner/repo" or "owner/*"; none for all. */
export function actionApplies(action: QuickAction, repo: string): boolean {
  const patterns = action.repos.split(/[\s,]+/).filter(Boolean);
  if (patterns.length === 0) return true;
  const name = repo.toLowerCase();
  return patterns.some((p) => {
    const pattern = p.toLowerCase();
    if (pattern === '*') return true;
    if (pattern.endsWith('/*')) return name.startsWith(pattern.slice(0, -1));
    return name === pattern;
  });
}

/** The actions for a pull request (`scope` 'pr') or its files, in `repo`, in their order in Settings. */
export function actionsFor(actions: readonly QuickAction[], repo: string, scope: QuickAction['scope']): QuickAction[] {
  return actions.filter((a) => a.scope === scope && actionApplies(a, repo));
}

/** "it's" → 'it'\''s': a single-quoted shell word, whatever it holds. */
export function shellQuote(value: string): string {
  return `'${value.replace(/'/g, `'\\''`)}'`;
}

/** Starting points in Settings. */
export const ACTION_PRESETS: Omit<QuickAction, 'id'>[] = [
  { name: 'Claude review', command: 'claude --model opus "/code-review $PR_NUMBER"', mode: 'terminal', scope: 'pr', repos: '', confirm: false },
  { name: 'Open a terminal here', command: '', mode: 'terminal', scope: 'pr', repos: '', confirm: false },
  { name: 'Run the tests', command: 'npm test', mode: 'background', scope: 'pr', repos: '', confirm: false },
  { name: 'File history', command: 'git log --follow -p -- "$PR_FILE"', mode: 'terminal', scope: 'file', repos: '', confirm: false },
];

/** Terminal apps quick actions can open in, in the order "Automatic" picks the first one installed. */
export const TERMINALS: { id: string; name: string; app: string }[] = [
  { id: 'iterm', name: 'iTerm2', app: 'iTerm' },
  { id: 'ghostty', name: 'Ghostty', app: 'Ghostty' },
  { id: 'wezterm', name: 'WezTerm', app: 'WezTerm' },
  { id: 'kitty', name: 'kitty', app: 'kitty' },
  { id: 'alacritty', name: 'Alacritty', app: 'Alacritty' },
  { id: 'terminal', name: 'Terminal', app: 'Terminal' },
];
