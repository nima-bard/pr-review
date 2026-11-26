import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import { isAgentDraft } from '../../shared/drafts';
import type { Draft, PrSnapshot } from '../../shared/model';
import type { ReviewBridge } from './reviewBridge';

/** Who is calling, for the drafts it adds: "Claude" (the app's own), "Claude Code", or another MCP client. */
export type CallerOrigin = () => { agent: string };

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
  // An agent's draft the user edited counts as the user's.
  by: d.origin ? d.origin.agent : 'user',
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
    files: s.files.map((f) => ({ path: f.path, old_path: f.oldPath, change: f.change, additions: f.additions, deletions: f.deletions, viewed: f.viewed === 'VIEWED' })),
    threads: s.threads.map((t) => ({
      id: t.id,
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

/** The draft `id` of PR `pr`, if an agent may change it: one an agent wrote and the user hasn't edited. */
function agentDraft(bridge: ReviewBridge, pr: string, id: string): Draft {
  const draft = bridge.snapshot(pr).drafts.find((d) => d.id === id);
  if (!draft) throw new Error(`There is no draft ${id}. list_drafts shows the current ones.`);
  if (!isAgentDraft(draft)) throw new Error("That draft is the user's (they wrote or edited it); an agent can't change it.");
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
      description: "The pending review's draft comments in PR Review: the user's own, and the ones agents added (`by`).",
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
        "Adds a comment to the user's pending review in PR Review. It is not posted: the user reads it (and may edit or delete it) and submits the review from the app. " +
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
      description: 'Replaces the text of a draft an agent added that the user has not edited.',
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
      description: 'Deletes a draft an agent added that the user has not edited.',
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

  registerActionTools(server, bridge);

  server.registerTool(
    'offer_choices',
    {
      title: 'Offer follow-up choices',
      description:
        'Shows choices as buttons under your answer in PR Review, for one follow-up you could do there (add a review comment, mark files as viewed, show something…). ' +
        'Call it as the last thing in your answer, at most once, instead of asking in words. It does not wait: end your answer, and the choice the user clicks arrives as their next message.',
      inputSchema: {
        question: z.string().min(1).max(200).describe('One short line, e.g. "Leave a comment about the missing processors?"'),
        choices: z
          .array(
            z.object({
              label: z.string().min(1).max(40).describe('The button, e.g. "Yes, leave a comment"'),
              prompt: z.string().min(1).max(2000).nullable().describe('What PR Review sends you when it is clicked, as the user would say it, e.g. "Yes, add that comment." Null for a choice that does nothing, like "No".'),
            }),
          )
          .min(1)
          .max(4),
      },
      annotations: { readOnlyHint: true },
    },
    async () => text('PR Review shows these as buttons under your answer. End your answer now: the choice the user clicks arrives as their next message.'),
  );
}

/** "a, b, c and 4 more", to keep confirmations short. */
const some = (items: readonly string[], max = 5) => (items.length > max ? `${items.slice(0, max).join(', ')} and ${items.length - max} more` : items.join(', '));

/** The tools that act in the app for the user: Viewed checkboxes, searching the code, and showing things in the PR's tab. */
function registerActionTools(server: McpServer, bridge: ReviewBridge): void {
  server.registerTool(
    'set_viewed',
    {
      title: 'Mark files as viewed',
      description:
        "Ticks (or unticks) the Viewed checkbox of changed files in PR Review, as the user would: viewed files fold away in the diff. Use it when the user asks to mark files as viewed; get_pr lists the files and which are viewed.",
      inputSchema: { pr: PR, paths: z.array(z.string()).min(1).describe('Changed files, as get_pr lists them'), viewed: z.boolean().default(true) },
    },
    async ({ pr, paths, viewed }) =>
      guarded(async () => {
        const changed = new Set(bridge.snapshot(pr).files.map((f) => f.path));
        const unknown = paths.filter((p) => !changed.has(p));
        if (unknown.length > 0) return fail(`Not changed in this pull request: ${some(unknown)}. Only changed files have a Viewed checkbox (get_pr lists them).`);
        const unique = [...new Set(paths)];
        const failed = await bridge.setViewed(pr, unique, viewed);
        const state = viewed ? 'viewed' : 'not viewed';
        const done = unique.filter((p) => !failed.some((f) => f.path === p));
        if (failed.length === 0) return text(`Marked ${done.length} file${done.length === 1 ? '' : 's'} as ${state}: ${some(done)}.`);
        const refused = `GitHub refused ${failed.length} of ${unique.length}, which stay as they were: ${some(failed.map((f) => f.path))} (${failed[0]!.error}). Try those again in a moment.`;
        return done.length === 0 ? fail(refused) : text(`Marked ${done.length} of ${unique.length} files as ${state}. ${refused}`);
      }),
  );

  server.registerTool(
    'search_code',
    {
      title: 'Search the code',
      description:
        'Searches the pull request’s code in its worktree, like Find in files in PR Review: the changed files, or every file. With show, the results also open in PR Review’s Find in files, for when the user asks to find something.',
      inputSchema: {
        pr: PR,
        query: z.string().min(1),
        regex: z.boolean().default(false),
        match_case: z.boolean().default(false),
        whole_word: z.boolean().default(false),
        include: z.string().default('').describe('Comma-separated globs of files to search, e.g. "*.kusto, src/"'),
        exclude: z.string().default(''),
        scope: z.enum(['changed', 'all']).default('changed').describe('changed: the files the pull request changes; all: every file'),
        show: z.boolean().default(false).describe('Also show the results in PR Review'),
      },
      annotations: { readOnlyHint: true },
    },
    async ({ pr, query, regex, match_case, whole_word, include, exclude, scope, show }) =>
      guarded(async () => {
        const q = { pattern: query, regex, matchCase: match_case, wholeWord: whole_word, include, exclude, scope };
        const result = await bridge.searchCode(pr, q);
        if (result.error) return fail(result.error);
        if (show) bridge.reveal(pr, { kind: 'search', query: q });
        return json({ total: result.total, truncated: result.truncated, files: result.files.map((f) => ({ path: f.path, matches: f.matches.map((m) => ({ line: m.line, text: m.text })) })) });
      }),
  );

  server.registerTool(
    'show_in_app',
    {
      title: 'Show something in PR Review',
      description:
        'Brings a file (at a line, if given), a review thread or a draft comment into view in the pull request’s tab in PR Review. Use it when the user asks to show, open or find something; give exactly one of path, thread_id (from get_pr) or draft_id.',
      inputSchema: {
        pr: PR,
        path: z.string().optional(),
        line: z.number().int().positive().optional().describe('A line of the file in the pull request’s head, with path'),
        thread_id: z.string().optional(),
        draft_id: z.string().optional(),
      },
      annotations: { readOnlyHint: true },
    },
    async ({ pr, path, line, thread_id, draft_id }) =>
      guarded(async () => {
        if ([path, thread_id, draft_id].filter((v) => v !== undefined).length !== 1) return fail('Give exactly one of path, thread_id or draft_id.');
        if (line !== undefined && path === undefined) return fail('line goes with path.');
        const snap = bridge.snapshot(pr);
        if (thread_id !== undefined) {
          const thread = snap.threads.find((t) => t.id === thread_id);
          if (!thread) return fail(`There is no review thread ${thread_id} (get_pr lists them).`);
          bridge.reveal(pr, { kind: 'thread', path: thread.path, threadId: thread.id });
          return text(`Showing the thread on ${thread.path} in PR Review.`);
        }
        if (draft_id !== undefined) {
          const draft = snap.drafts.find((d) => d.id === draft_id);
          if (!draft) return fail(`There is no draft ${draft_id} (list_drafts shows them).`);
          bridge.reveal(pr, { kind: 'draft', path: draft.path, draftId: draft.id });
          return text(`Showing the draft on ${draft.path}:${draft.line} in PR Review.`);
        }
        const file = path!.replace(/^\.?\//, '');
        const changed = snap.files.some((f) => f.path === file);
        if (!changed && !(await bridge.allFiles(pr)).includes(file)) return fail(`${file} isn't in the pull request’s head. Paths are relative to the repository root.`);
        bridge.reveal(pr, { kind: 'file', path: file, line: line ?? null, changed });
        return text(`Showing ${file}${line ? `:${line}` : ''} in PR Review.`);
      }),
  );
}
