import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import { isSuggestion } from '../../shared/drafts';
import type { Draft, PrSnapshot } from '../../shared/model';
import type { ReviewBridge } from './reviewBridge';

/** Who is calling: the agent's name and the app's turn that started it, if any. */
export type CallerOrigin = () => { agent: string; turnId: string | null };

const text = (t: string) => ({ content: [{ type: 'text' as const, text: t }] });
const json = (value: unknown) => text(JSON.stringify(value, null, 2));
const fail = (t: string) => ({ ...text(t), isError: true });

const PR = z.string().describe('The PR Review key from list_open_prs, a PR URL, or owner/repo#123');

/** A tool's work, with a thrown error (a PR that isn't open, a draft that isn't the agent's) as the tool's error. */
async function guarded<T>(run: () => Promise<T>): Promise<T | ReturnType<typeof fail>> {
  try {
    return await run();
  } catch (err) {
    return fail(err instanceof Error ? err.message : String(err));
  }
}

const draftView = (d: Draft) => ({
  id: d.id,
  path: d.path,
  side: d.side,
  line: d.line,
  start_line: d.startLine ?? null,
  body: d.body,
  by: d.origin ? d.origin.agent : 'user',
  status: d.origin ? (d.origin.acceptedAt ? 'accepted' : 'suggested') : 'user draft',
  posted: d.postedThreadId !== undefined,
});

/** The PR as an agent needs it: details, changed files, review threads where they sit now, and the pending drafts. */
function prView(s: PrSnapshot) {
  const d = s.details;
  return {
    key: s.key,
    url: d.url,
    title: d.title,
    author: d.author,
    state: d.state,
    base: d.baseRefName,
    head: d.headRefName,
    head_sha: d.headRefOid,
    worktree: s.worktree.path,
    description: d.body,
    files: s.files.map((f) => ({ path: f.path, old_path: f.oldPath, change: f.change, additions: f.additions, deletions: f.deletions })),
    threads: s.threads.map((t) => ({
      path: t.path,
      side: t.side,
      line: t.anchor.line ?? null,
      end_line: t.anchor.endLine ?? null,
      resolved: t.isResolved,
      outdated: t.isOutdated,
      comments: t.comments.map((c) => ({ author: c.author, body: c.body })),
    })),
    drafts: s.drafts.map(draftView),
  };
}

/** [1,2,3,7,8] → "1–3, 7–8" (keeps error messages short). */
export function ranges(lines: readonly number[]): string {
  const sorted = [...new Set(lines)].sort((a, b) => a - b);
  const parts: string[] = [];
  let start: number | null = null;
  let prev = 0;
  for (const l of sorted) {
    if (start !== null && l === prev + 1) {
      prev = l;
      continue;
    }
    if (start !== null) parts.push(start === prev ? String(start) : `${start}–${prev}`);
    start = l;
    prev = l;
  }
  if (start !== null) parts.push(start === prev ? String(start) : `${start}–${prev}`);
  return parts.length > 0 ? parts.join(', ') : 'none';
}

/** The draft `id` of PR `pr`, if an agent may change it: only suggestions nobody has accepted yet. */
function agentDraft(bridge: ReviewBridge, pr: string, id: string): Draft {
  const draft = bridge.snapshot(pr).drafts.find((d) => d.id === id);
  if (!draft) throw new Error(`There is no draft ${id}. list_drafts shows the current ones.`);
  if (!isSuggestion(draft)) throw new Error("That draft is the user's; it can't be changed by an agent.");
  return draft;
}

/** The PR Review tools: read the pull requests open in the app, and manage draft comments. Nothing reaches GitHub. */
export function registerReviewTools(server: McpServer, bridge: ReviewBridge, origin: CallerOrigin): void {
  server.registerTool(
    'list_open_prs',
    {
      title: 'List the pull requests open in PR Review',
      description: 'The pull requests open in PR Review, with the key the other tools take and the worktree each is checked out in.',
      annotations: { readOnlyHint: true },
    },
    async () => json(bridge.openPrs()),
  );

  server.registerTool(
    'get_pr',
    {
      title: 'Get a pull request',
      description: 'Details, changed files, review threads (where their lines are now) and the draft comments of a pull request open in PR Review.',
      inputSchema: { pr: PR },
      annotations: { readOnlyHint: true },
    },
    async ({ pr }) => guarded(async () => json(prView(bridge.snapshot(pr)))),
  );

  server.registerTool(
    'get_file_diff',
    {
      title: 'Get the diff of a file',
      description: 'The unified diff of one changed file, and the lines a comment can go on (side RIGHT: the head; LEFT: the base).',
      inputSchema: { pr: PR, path: z.string() },
      annotations: { readOnlyHint: true },
    },
    async ({ pr, path }) =>
      guarded(async () => {
        const diff = await bridge.fileDiff(pr, path);
        if (!diff) return fail(`${path} isn't changed in this pull request (get_pr lists the files).`);
        return json({ path: diff.path, old_path: diff.oldPath, change: diff.change, binary: diff.binary, commentable: { RIGHT: ranges(diff.commentable.RIGHT), LEFT: ranges(diff.commentable.LEFT) }, patch: diff.patch });
      }),
  );

  server.registerTool(
    'list_drafts',
    {
      title: 'List draft comments',
      description: "The pending review's draft comments in PR Review: the user's own, and agent suggestions (accepted or not).",
      inputSchema: { pr: PR },
      annotations: { readOnlyHint: true },
    },
    async ({ pr }) => guarded(async () => json(bridge.snapshot(pr).drafts.map(draftView))),
  );

  server.registerTool(
    'add_draft',
    {
      title: 'Add a draft review comment',
      description:
        "Adds a comment to the user's pending review in PR Review as a suggestion. It is not posted: the user accepts, edits or dismisses it, and submits the review from the app. " +
        'Lines are numbered in the PR head (side RIGHT) or the base (side LEFT), and must be in the diff (changed lines and their context).',
      inputSchema: {
        pr: PR,
        path: z.string(),
        line: z.number().int().positive().describe('The last line of the comment'),
        start_line: z.number().int().positive().optional().describe('The first line, for a multi-line comment'),
        side: z.enum(['RIGHT', 'LEFT']).default('RIGHT'),
        body: z.string().min(1).describe('Markdown; ```suggestion blocks work'),
      },
    },
    async ({ pr, path, line, start_line, side, body }) =>
      guarded(async () => {
        const diff = await bridge.fileDiff(pr, path);
        if (!diff) return fail(`${path} isn't changed in this pull request. Comment only on files in the diff (get_pr lists them).`);
        if (start_line !== undefined && start_line > line) return fail(`start_line ${start_line} is after line ${line}.`);
        const ok = diff.commentable[side];
        const bad = [start_line ?? line, line].find((l) => !ok.includes(l));
        if (bad !== undefined) return fail(`Line ${bad} of ${path} isn't in the diff on side ${side}, so GitHub can't take a comment there. Commentable lines: ${ranges(ok)}.`);
        const draft = await bridge.addDraft(pr, { path, side, line, startLine: start_line ?? null, body }, origin());
        return text(`Added draft ${draft.id} on ${path}:${line}. The user will review it in PR Review.`);
      }),
  );

  server.registerTool(
    'update_draft',
    {
      title: 'Change a draft comment',
      description: 'Replaces the text of a suggestion an agent added that the user has not accepted yet.',
      inputSchema: { pr: PR, id: z.string(), body: z.string().min(1) },
    },
    async ({ pr, id, body }) =>
      guarded(async () => {
        agentDraft(bridge, pr, id);
        const draft = await bridge.updateDraft(pr, id, body);
        return text(`Updated draft ${draft.id}.`);
      }),
  );

  server.registerTool(
    'delete_draft',
    {
      title: 'Delete a draft comment',
      description: 'Deletes a suggestion an agent added that the user has not accepted yet.',
      inputSchema: { pr: PR, id: z.string() },
      annotations: { destructiveHint: true },
    },
    async ({ pr, id }) =>
      guarded(async () => {
        agentDraft(bridge, pr, id);
        await bridge.deleteDraft(pr, id);
        return text(`Deleted draft ${id}.`);
      }),
  );
}
