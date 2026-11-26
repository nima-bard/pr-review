import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { describe, expect, it } from 'vitest';
import { ranges, registerReviewTools } from '../../../src/core/agents/mcpTools';
import type { AgentDraftInput, ReviewBridge } from '../../../src/core/agents/reviewBridge';
import type { CodeSearchQuery, Draft, DraftOrigin, FileDiffModel, PrSnapshot, RevealTarget } from '../../../src/shared/model';

const draft = (id: string, origin?: DraftOrigin): Draft => ({
  id,
  path: 'src/a.ts',
  subject: 'line',
  side: 'RIGHT',
  line: 3,
  body: `draft ${id}`,
  headOid: 'h',
  createdAt: '2026-01-01T00:00:00Z',
  ...(origin ? { origin } : {}),
});

/** A bridge over one open PR whose only changed file is src/a.ts (RIGHT lines 1–5 and 9, LEFT line 2). */
function fakeBridge() {
  // 'mine': yours (written, or an agent's that you edited, which drops its origin); 'claude': an agent's, untouched.
  const drafts: Draft[] = [draft('mine'), draft('claude', { agent: 'Claude' })];
  const added: { input: AgentDraftInput; origin: DraftOrigin }[] = [];
  const viewed: { paths: string[]; viewed: boolean }[] = [];
  const reveals: RevealTarget[] = [];
  const searches: CodeSearchQuery[] = [];
  const snap = {
    key: 'github.com/o/r#1',
    details: { url: 'https://github.com/o/r/pull/1', title: 'T' },
    worktree: { path: '/wt' },
    files: [{ path: 'src/a.ts' }, { path: 'db/orders.kusto' }, { path: 'refused/x.kusto' }],
    threads: [{ id: 'thread-1', path: 'src/a.ts' }],
    drafts,
  } as unknown as PrSnapshot;
  const diff: FileDiffModel = { path: 'src/a.ts', oldPath: 'src/a.ts', change: 'modified', patch: '@@', binary: false, commentable: { RIGHT: [1, 2, 3, 4, 5, 9], LEFT: [2] } };
  const bridge: ReviewBridge = {
    openPrs: () => [{ key: snap.key, url: snap.details.url, title: 'T', worktree: '/wt' }],
    snapshot: (pr) => {
      if (pr !== snap.key) throw new Error(`Open ${pr} in PR Review first.`);
      return snap;
    },
    fileDiff: async (_pr, path) => (path === 'src/a.ts' ? diff : null),
    addDraft: async (_pr, input, origin) => {
      added.push({ input, origin });
      return draft('new');
    },
    updateDraft: async (_pr, id) => draft(id),
    deleteDraft: async (_pr, id) => {
      drafts.splice(
        drafts.findIndex((d) => d.id === id),
        1,
      );
    },
    setViewed: async (_pr, paths, v) => {
      viewed.push({ paths, viewed: v });
      // GitHub keeps refusing anything under refused/.
      return paths.filter((path) => path.startsWith('refused/')).map((path) => ({ path, error: 'GitHub: Something went wrong' }));
    },
    searchCode: async (_pr, query) => {
      searches.push(query);
      return query.pattern === '(' ? { files: [], total: 0, truncated: false, error: 'Invalid regular expression' } : { files: [{ path: 'src/a.ts', matches: [{ line: 2, text: 'run()', ranges: [[0, 3]] }] }], total: 1, truncated: false, error: null };
    },
    allFiles: async () => ['src/a.ts', 'db/orders.kusto', 'README.md'],
    reveal: (_pr, target) => void reveals.push(target),
  };
  return { bridge, added, drafts, viewed, reveals, searches };
}

async function connect(bridge: ReviewBridge) {
  const server = new McpServer({ name: 'pr-review', version: '1' });
  registerReviewTools(server, bridge, () => ({ agent: 'Claude' }));
  const [a, b] = InMemoryTransport.createLinkedPair();
  await server.connect(a);
  const client = new Client({ name: 'test', version: '1' });
  await client.connect(b);
  const call = async (name: string, args: Record<string, unknown>) => {
    const res = (await client.callTool({ name, arguments: args })) as { content: { text: string }[]; isError?: boolean };
    return { text: res.content[0]?.text ?? '', isError: res.isError === true };
  };
  return { client, call };
}

const pr = 'github.com/o/r#1';

describe('PR Review MCP tools', () => {
  it('lists the tools', async () => {
    const { client } = await connect(fakeBridge().bridge);
    expect((await client.listTools()).tools.map((t) => t.name).sort()).toEqual([
      'add_draft',
      'delete_draft',
      'get_file_diff',
      'get_pr',
      'list_drafts',
      'list_open_prs',
      'offer_choices',
      'search_code',
      'set_viewed',
      'show_in_app',
      'update_draft',
    ]);
  });

  it('offer_choices takes a short question and up to four choices, and tells Claude to end its answer', async () => {
    const { call } = await connect(fakeBridge().bridge);
    const ok = await call('offer_choices', { question: 'Leave a comment?', choices: [{ label: 'Yes, leave a comment', prompt: 'Yes, write it.' }, { label: 'No', prompt: null }] });
    expect(ok).toEqual({ isError: false, text: expect.stringContaining('End your answer now') });
    const five = Array.from({ length: 5 }, (_, i) => ({ label: `c${i}`, prompt: null }));
    expect((await call('offer_choices', { question: 'Too many?', choices: five })).isError).toBe(true);
  });

  it('set_viewed ticks changed files, and refuses files the pull request does not change', async () => {
    const { bridge, viewed } = fakeBridge();
    const { call } = await connect(bridge);
    expect(await call('set_viewed', { pr, paths: ['db/orders.kusto', 'db/orders.kusto'] })).toEqual({ isError: false, text: 'Marked 1 file as viewed: db/orders.kusto.' });
    expect(await call('set_viewed', { pr, paths: ['src/a.ts'], viewed: false })).toMatchObject({ text: 'Marked 1 file as not viewed: src/a.ts.' });
    expect(await call('set_viewed', { pr, paths: ['src/a.ts', 'README.md'] })).toEqual({ isError: true, text: expect.stringContaining('Not changed in this pull request: README.md.') });
    expect(viewed).toEqual([
      { paths: ['db/orders.kusto'], viewed: true },
      { paths: ['src/a.ts'], viewed: false },
    ]);
  });

  it('set_viewed says which files GitHub refused, and fails only when it refused them all', async () => {
    const { call } = await connect(fakeBridge().bridge);
    expect(await call('set_viewed', { pr, paths: ['db/orders.kusto', 'refused/x.kusto'] })).toEqual({
      isError: false,
      text: 'Marked 1 of 2 files as viewed. GitHub refused 1 of 2, which stay as they were: refused/x.kusto (GitHub: Something went wrong). Try those again in a moment.',
    });
    expect(await call('set_viewed', { pr, paths: ['refused/x.kusto'] })).toMatchObject({ isError: true, text: expect.stringContaining('GitHub refused 1 of 1') });
  });

  it('search_code returns the matches, and shows them in the app only when asked', async () => {
    const { bridge, reveals, searches } = fakeBridge();
    const { call } = await connect(bridge);
    const found = JSON.parse((await call('search_code', { pr, query: 'run', include: '*.ts' })).text) as unknown;
    expect(found).toEqual({ total: 1, truncated: false, files: [{ path: 'src/a.ts', matches: [{ line: 2, text: 'run()' }] }] });
    expect(searches[0]).toEqual({ pattern: 'run', regex: false, matchCase: false, wholeWord: false, include: '*.ts', exclude: '', scope: 'changed' });
    expect(reveals).toEqual([]);
    await call('search_code', { pr, query: 'run', scope: 'all', show: true });
    expect(reveals).toEqual([{ kind: 'search', query: expect.objectContaining({ pattern: 'run', scope: 'all' }) }]);
    expect(await call('search_code', { pr, query: '(', regex: true, show: true })).toEqual({ isError: true, text: 'Invalid regular expression' });
    expect(reveals).toHaveLength(1);
  });

  it('show_in_app shows a changed or unchanged file at a line, a thread or a draft', async () => {
    const { bridge, reveals } = fakeBridge();
    const { call } = await connect(bridge);
    expect(await call('show_in_app', { pr, path: 'db/orders.kusto' })).toEqual({ isError: false, text: 'Showing db/orders.kusto in PR Review.' });
    await call('show_in_app', { pr, path: './README.md', line: 4 });
    await call('show_in_app', { pr, thread_id: 'thread-1' });
    await call('show_in_app', { pr, draft_id: 'claude' });
    expect(reveals).toEqual([
      { kind: 'file', path: 'db/orders.kusto', line: null, changed: true },
      { kind: 'file', path: 'README.md', line: 4, changed: false },
      { kind: 'thread', path: 'src/a.ts', threadId: 'thread-1' },
      { kind: 'draft', path: 'src/a.ts', draftId: 'claude' },
    ]);
  });

  it('show_in_app needs exactly one thing to show, and one that exists', async () => {
    const { bridge, reveals } = fakeBridge();
    const { call } = await connect(bridge);
    expect(await call('show_in_app', { pr })).toEqual({ isError: true, text: 'Give exactly one of path, thread_id or draft_id.' });
    expect((await call('show_in_app', { pr, path: 'src/a.ts', thread_id: 'thread-1' })).isError).toBe(true);
    expect(await call('show_in_app', { pr, thread_id: 'thread-1', line: 3 })).toEqual({ isError: true, text: 'line goes with path.' });
    expect((await call('show_in_app', { pr, path: 'nope.ts' })).text).toContain("nope.ts isn't in the pull request’s head");
    expect((await call('show_in_app', { pr, thread_id: 'x' })).isError).toBe(true);
    expect(reveals).toEqual([]);
  });

  it('add_draft saves a draft on commentable lines, with the caller as its origin', async () => {
    const { bridge, added } = fakeBridge();
    const { call } = await connect(bridge);
    const res = await call('add_draft', { pr, path: 'src/a.ts', line: 4, start_line: 2, body: 'Why?' });
    expect(res.isError).toBe(false);
    expect(added).toEqual([{ input: { path: 'src/a.ts', side: 'RIGHT', line: 4, startLine: 2, body: 'Why?' }, origin: { agent: 'Claude' } }]);
  });

  it('add_draft rejects lines outside the diff with the commentable ranges, and files that did not change', async () => {
    const { bridge, added } = fakeBridge();
    const { call } = await connect(bridge);
    const outside = await call('add_draft', { pr, path: 'src/a.ts', line: 7, body: 'x' });
    expect(outside).toEqual({ isError: true, text: expect.stringContaining('Commentable lines: 1–5, 9.') });
    const left = await call('add_draft', { pr, path: 'src/a.ts', line: 3, side: 'LEFT', body: 'x' });
    expect(left.text).toContain('Commentable lines: 2.');
    const unchanged = await call('add_draft', { pr, path: 'src/b.ts', line: 1, body: 'x' });
    expect(unchanged).toEqual({ isError: true, text: expect.stringContaining("isn't changed") });
    expect(added).toEqual([]);
  });

  it('says to open the PR first when it is not open', async () => {
    const { call } = await connect(fakeBridge().bridge);
    expect(await call('get_pr', { pr: 'o/x#2' })).toEqual({ isError: true, text: 'Open o/x#2 in PR Review first.' });
  });

  it("update_draft and delete_draft refuse the user's drafts, and change an agent's own", async () => {
    const { bridge, drafts } = fakeBridge();
    const { call } = await connect(bridge);
    expect(await call('update_draft', { pr, id: 'mine', body: 'y' })).toEqual({ isError: true, text: "That draft is the user's (they wrote or edited it); an agent can't change it." });
    expect((await call('delete_draft', { pr, id: 'mine' })).isError).toBe(true);
    expect((await call('update_draft', { pr, id: 'claude', body: 'y' })).isError).toBe(false);
    expect((await call('delete_draft', { pr, id: 'claude' })).isError).toBe(false);
    expect(drafts.map((d) => d.id)).toEqual(['mine']);
  });

  it('list_drafts says who wrote each draft', async () => {
    const { call } = await connect(fakeBridge().bridge);
    const list = JSON.parse((await call('list_drafts', { pr })).text) as { id: string; by: string }[];
    expect(list.map((d) => [d.id, d.by])).toEqual([
      ['mine', 'user'],
      ['claude', 'Claude'],
    ]);
  });
});

describe('ranges', () => {
  it('folds consecutive lines', () => {
    expect(ranges([1, 2, 3, 7, 8, 10])).toBe('1–3, 7–8, 10');
    expect(ranges([5, 4, 4])).toBe('4–5');
    expect(ranges([])).toBe('none');
  });
});
