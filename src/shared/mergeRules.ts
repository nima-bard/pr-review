import type { MergeInfo, MergeMethod } from './model';

export const MERGE_METHODS: Record<MergeMethod, { title: string; action: string; desc: string }> = {
  MERGE: { title: 'Create a merge commit', action: 'Merge', desc: 'All commits are added to the base branch with a merge commit.' },
  SQUASH: { title: 'Squash and merge', action: 'Squash and merge', desc: 'The commits are combined into one commit on the base branch.' },
  REBASE: { title: 'Rebase and merge', action: 'Rebase and merge', desc: 'The commits are rebased onto the base branch one by one, without a merge commit.' },
};

/** One of the branch's rules for merging, and where it stands: met, waiting (checks running), a warning, or not met. */
export interface MergeRule {
  tone: 'ok' | 'pending' | 'warn' | 'bad';
  text: string;
}

const plural = (n: number, word: string) => `${n} ${word}${n === 1 ? '' : 's'}`;

/** The rules and their state, in github.com's merge box order: conflicts, an out-of-date branch, reviews, checks. */
export function mergeRules(info: MergeInfo): MergeRule[] {
  const base = info.baseRefName;
  const rules: MergeRule[] = [];
  if (info.isDraft) rules.push({ tone: 'bad', text: 'This pull request is still a draft' });
  if (info.mergeable === 'CONFLICTING') rules.push({ tone: 'bad', text: `Conflicts with ${base}: resolve them on the branch first` });
  else if (info.mergeable === 'UNKNOWN') rules.push({ tone: 'pending', text: 'GitHub is checking for conflicts…' });
  else rules.push({ tone: 'ok', text: `No conflicts with ${base}` });
  if (info.mergeStateStatus === 'BEHIND') rules.push({ tone: 'bad', text: `The branch is behind ${base}, and the rules require it to be up to date` });

  if (info.reviewDecision === 'APPROVED') rules.push({ tone: 'ok', text: 'Approved' });
  else if (info.reviewDecision === 'CHANGES_REQUESTED') rules.push({ tone: 'bad', text: 'Changes requested' });
  else if (info.reviewDecision === 'REVIEW_REQUIRED') rules.push({ tone: 'bad', text: 'A review is required' });

  const required = info.checks.filter((c) => c.required);
  const failed = required.filter((c) => c.state === 'failure').length;
  const running = required.filter((c) => c.state === 'pending').length;
  if (failed > 0) rules.push({ tone: 'bad', text: `${plural(failed, 'required check')} failed` });
  else if (running > 0) rules.push({ tone: 'pending', text: `${plural(running, 'required check')} still running` });
  else if (required.length > 0) rules.push({ tone: 'ok', text: `${required.length === 1 ? 'The required check' : `All ${required.length} required checks`} passed` });
  const others = info.checks.filter((c) => !c.required);
  const othersFailed = others.filter((c) => c.state === 'failure').length;
  const othersRunning = others.filter((c) => c.state === 'pending').length;
  if (othersFailed > 0) rules.push({ tone: 'warn', text: `${plural(othersFailed, 'check')} failed (not required)` });
  else if (othersRunning > 0) rules.push({ tone: 'pending', text: `${plural(othersRunning, 'check')} still running (not required)` });
  else if (others.length > 0 && required.length === 0) rules.push({ tone: 'ok', text: `${others.length === 1 ? 'The check' : `All ${others.length} checks`} passed` });

  // Blocked by a rule GitHub doesn't name here (signed commits, resolved conversations, deployments…).
  if (info.mergeStateStatus === 'BLOCKED' && !rules.some((r) => r.tone === 'bad' || (r.tone === 'pending' && r.text.includes('required')))) {
    rules.push({ tone: 'bad', text: `Blocked by a rule for ${base} (see the pull request on GitHub)` });
  }
  return rules;
}

/**
 * What merging can do now: merge (`ready`), wait for the rules (`blocked`: auto-merge, or bypassing them if allowed),
 * go through the merge queue, or nothing yet (with why).
 */
export type MergeVerdict = 'ready' | 'blocked' | 'queue' | 'queued' | 'conflicts' | 'draft' | 'closed' | 'no-access' | 'checking';

export function mergeVerdict(info: MergeInfo): MergeVerdict {
  if (info.state !== 'OPEN') return 'closed';
  if (info.isDraft) return 'draft';
  if (!info.canMerge) return 'no-access';
  if (info.mergeable === 'CONFLICTING' || info.mergeStateStatus === 'DIRTY') return 'conflicts';
  if (info.mergeQueue.enabled) return info.mergeQueue.queued ? 'queued' : 'queue';
  // UNSTABLE: only checks that aren't required failed. HAS_HOOKS: GitHub Enterprise pre-receive hooks; it can merge.
  if (['CLEAN', 'UNSTABLE', 'HAS_HOOKS'].includes(info.mergeStateStatus)) return 'ready';
  if (info.mergeable === 'UNKNOWN' || info.mergeStateStatus === 'UNKNOWN') return 'checking';
  return 'blocked';
}
