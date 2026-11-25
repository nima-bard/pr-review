import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { describe, expect, it } from 'vitest';
import { ranges, registerReviewTools } from '../../../src/core/agents/mcpTools';
import type { AgentDraftInput, ReviewBridge } from '../../../src/core/agents/reviewBridge';
import type { Draft, DraftOrigin, FileDiffModel, PrSnapshot } from '../../../src/shared/model';

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
  const drafts: Draft[] = [draft('mine'), draft('accepted', { agent: 'Claude', turnId: null, acceptedAt: '2026-01-02T00:00:00Z' }), draft('suggested', { agent: 'Claude', turnId: 't', acceptedAt: null })];
  const added: { input: AgentDraftInput; origin: Omit<DraftOrigin, 'acceptedAt'> }[] = [];
  const snap = { key: 'github.com/o/r#1', details: { url: 'https://github.com/o/r/pull/1', title: 'T' }, worktree: { path: '/wt' }, drafts } as unknown as PrSnapshot;
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
  };
  return { bridge, added, drafts };
}

async function connect(bridge: ReviewBridge) {
  const server = new McpServer({ name: 'pr-review', version: '1' });
  registerReviewTools(server, bridge, () => ({ agent: 'Claude', turnId: 'turn-1' }));
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
  it('lists the seven tools', async () => {
    const { client } = await connect(fakeBridge().bridge);
    expect((await client.listTools()).tools.map((t) => t.name).sort()).toEqual(['add_draft', 'delete_draft', 'get_file_diff', 'get_pr', 'list_drafts', 'list_open_prs', 'update_draft']);
  });

  it('add_draft saves a suggestion on commentable lines, with the caller as its origin', async () => {
    const { bridge, added } = fakeBridge();
    const { call } = await connect(bridge);
    const res = await call('add_draft', { pr, path: 'src/a.ts', line: 4, start_line: 2, body: 'Why?' });
    expect(res.isError).toBe(false);
    expect(added).toEqual([{ input: { path: 'src/a.ts', side: 'RIGHT', line: 4, startLine: 2, body: 'Why?' }, origin: { agent: 'Claude', turnId: 'turn-1' } }]);
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

  it("update_draft and delete_draft refuse the user's drafts and accepted suggestions", async () => {
    const { bridge, drafts } = fakeBridge();
    const { call } = await connect(bridge);
    for (const id of ['mine', 'accepted']) {
      expect(await call('update_draft', { pr, id, body: 'y' })).toEqual({ isError: true, text: "That draft is the user's; it can't be changed by an agent." });
      expect((await call('delete_draft', { pr, id })).isError).toBe(true);
    }
    expect((await call('update_draft', { pr, id: 'suggested', body: 'y' })).isError).toBe(false);
    expect((await call('delete_draft', { pr, id: 'suggested' })).isError).toBe(false);
    expect(drafts.map((d) => d.id)).toEqual(['mine', 'accepted']);
  });

  it('list_drafts says who wrote each draft and whether it was accepted', async () => {
    const { call } = await connect(fakeBridge().bridge);
    const list = JSON.parse((await call('list_drafts', { pr })).text) as { id: string; status: string }[];
    expect(list.map((d) => [d.id, d.status])).toEqual([
      ['mine', 'user draft'],
      ['accepted', 'accepted'],
      ['suggested', 'suggested'],
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
