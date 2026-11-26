import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, describe, expect, it, vi } from 'vitest';
import { AppState } from '../../src/core/store/appState';
import { AgentRunner } from '../../src/main/agents/agentRunner';
import type { Connector, TurnContext } from '../../src/main/agents/connector';
import type { AgentRequest, OutsideClaude } from '../../src/shared/model';

const dirs: string[] = [];
afterAll(() => dirs.forEach((d) => rmSync(d, { recursive: true, force: true })));

/** A runner with one Claude agent, `parallel` requests at once, and a stand-in Claude whose turns end when told to. */
function setup(parallel: number) {
  const dir = mkdtempSync(join(tmpdir(), 'prr-agents-'));
  dirs.push(dir);
  writeFileSync(join(dir, 'state.json'), JSON.stringify({ settings: { agents: [{ id: 'c', name: 'Claude', kind: 'claude-code', command: '', model: '' }], agentParallel: parallel } }));
  const starts: { ctx: TurnContext; finish(): void; fail(error: string): void }[] = [];
  const claude: Connector = {
    start(ctx, update) {
      let resolve!: (v: { sessionId: string | null }) => void;
      const done = new Promise<{ sessionId: string | null }>((r) => (resolve = r));
      starts.push({
        ctx,
        finish: () => {
          update({ status: 'done', reply: `answer ${starts.length}` });
          resolve({ sessionId: ctx.fork ? 'forked-id' : ctx.sessionId });
        },
        fail: (error) => {
          update({ status: 'failed', error });
          resolve({ sessionId: null });
        },
      });
      return { stop: () => resolve({ sessionId: null }), done };
    },
  };
  /** Where the PR's session stays open outside the app once claimed, and its transcript as written so far. */
  const outside: { open: OutsideClaude | null; transcript: string } = { open: null, transcript: '' };
  const runner = new AgentRunner({
    appState: new AppState(dir),
    emit: () => undefined,
    connector: () => claude,
    prepare: async () => ({ worktree: '/wt', env: { PR_NUMBER: '1', PR_TITLE: 'T' }, prompt: 'p' }),
    mcp: async () => ({ url: 'http://127.0.0.1:1/mcp', token: 't' }),
    claimSession: async () => outside.open,
    findTranscript: async () => '/transcript.jsonl',
    readTranscript: async (_path, offset) => (outside.transcript.length > offset ? { text: outside.transcript.slice(offset), end: outside.transcript.length, restarted: false } : null),
  });
  return { runner, starts, outside };
}

const ask = (prompt: string): AgentRequest => ({ kind: 'prompt', prompt, target: null });
const key = 'github.com/o/r#1';

describe('AgentRunner', () => {
  it("runs a second request beside the first: the first on the PR's session, the second on a side branch", async () => {
    const { runner, starts } = setup(3);
    await runner.ask(key, ask('first'));
    await runner.ask(key, ask('second'));
    await vi.waitFor(() => expect(starts).toHaveLength(2));
    const [first, second] = starts;
    expect(first!.ctx).toMatchObject({ main: true, fork: false, resume: false });
    // No session yet to branch from: the side request starts a fresh, unnamed one.
    expect(second!.ctx).toMatchObject({ main: false, fork: false, resume: false });
    expect(second!.ctx.sessionId).not.toBe(first!.ctx.sessionId);
    first!.finish();
    second!.finish();
    await vi.waitFor(async () => expect((await runner.session(key))?.turns.map((t) => [t.status, t.branch === true])).toEqual([
      ['done', false],
      ['done', true],
    ]));
  });

  it("branches from the PR's session once it exists, and keeps the PR's session id", async () => {
    const { runner, starts } = setup(3);
    await runner.ask(key, ask('first'));
    await vi.waitFor(() => expect(starts).toHaveLength(1));
    const mainId = starts[0]!.ctx.sessionId;
    starts[0]!.finish();
    await vi.waitFor(async () => expect((await runner.session(key))?.started).toBe(true));
    await runner.ask(key, ask('second'));
    await runner.ask(key, ask('third'));
    await vi.waitFor(() => expect(starts).toHaveLength(3));
    expect(starts[1]!.ctx).toMatchObject({ main: true, resume: true, fork: false, sessionId: mainId });
    expect(starts[2]!.ctx).toMatchObject({ main: false, resume: true, fork: true, sessionId: mainId });
    starts[2]!.finish();
    starts[1]!.finish();
    // The side branch's new id never replaces the PR's session.
    await vi.waitFor(async () => expect((await runner.session(key))?.turns.every((t) => t.status === 'done')).toBe(true));
    expect((await runner.session(key))?.sessionId).toBe(mainId);
  });

  it('runs no more at once than Settings allows; the next starts when one ends', async () => {
    const { runner, starts } = setup(2);
    for (const p of ['a', 'b', 'c']) await runner.ask(key, ask(p));
    await vi.waitFor(() => expect(starts).toHaveLength(2));
    expect((await runner.session(key))?.turns.map((t) => t.status)).toEqual(['running', 'running', 'queued']);
    starts[1]!.finish();
    await vi.waitFor(() => expect(starts).toHaveLength(3));
  });

  it("opens in Claude Desktop only while no request writes to the PR's session", async () => {
    const { runner, starts } = setup(3);
    await runner.ask(key, ask('first'));
    await vi.waitFor(() => expect(starts).toHaveLength(1));
    starts[0]!.finish();
    await vi.waitFor(async () => expect((await runner.session(key))?.started).toBe(true));
    await runner.ask(key, ask('on the session'));
    await runner.ask(key, ask('beside it'));
    await vi.waitFor(() => expect(starts).toHaveLength(3));
    await expect(runner.desktopSession(key)).rejects.toThrow('still answering');
    starts[1]!.finish();
    // Only the side branch still runs: the session itself is free.
    await vi.waitFor(async () => expect(await runner.desktopSession(key)).toBe(starts[0]!.ctx.sessionId));
    starts[2]!.finish();
  });

  /** A runner whose PR session has one finished question, "first". */
  async function withConversation() {
    const setUp = setup(3);
    await setUp.runner.ask(key, ask('first'));
    await vi.waitFor(() => expect(setUp.starts).toHaveLength(1));
    setUp.starts[0]!.finish();
    await vi.waitFor(async () => expect((await setUp.runner.session(key))?.started).toBe(true));
    return setUp;
  }

  it("runs a request again on a new session, with a recap, when the PR's session was deleted", async () => {
    const { runner, starts } = await withConversation();
    const oldId = starts[0]!.ctx.sessionId;
    await runner.ask(key, ask('second'));
    await vi.waitFor(() => expect(starts).toHaveLength(2));
    starts[1]!.fail(`No conversation found with session ID: ${oldId}`);
    await vi.waitFor(() => expect(starts).toHaveLength(3));
    const retry = starts[2]!.ctx;
    expect(retry).toMatchObject({ main: true, resume: false });
    expect(retry.sessionId).not.toBe(oldId);
    expect(retry.prompt).toContain('Asked: first\nYou answered: answer 1');
    expect(retry.prompt.endsWith('\n\np')).toBe(true);
    starts[2]!.finish();
    await vi.waitFor(async () => expect((await runner.session(key))?.turns.map((t) => t.status)).toEqual(['done', 'done']));
    expect(await runner.session(key)).toMatchObject({ sessionId: retry.sessionId, started: true, restoreHistory: false });
  });

  it('restores a deleted session for Claude Desktop: a short request on a new session that carries the recap', async () => {
    const { runner, starts } = await withConversation();
    const restoring = runner.restore(key);
    await vi.waitFor(() => expect(starts).toHaveLength(2));
    const ctx = starts[1]!.ctx;
    expect(ctx).toMatchObject({ main: true, resume: false, request: { kind: 'restore' } });
    expect(ctx.prompt).toContain('Asked: first');
    starts[1]!.finish();
    await restoring;
    expect(await runner.desktopSession(key)).toBe(ctx.sessionId);
  });

  it('says why when the deleted session could not be restored', async () => {
    const { runner, starts } = await withConversation();
    const restoring = runner.restore(key);
    await vi.waitFor(() => expect(starts).toHaveLength(2));
    starts[1]!.fail('Not signed in');
    await expect(restoring).rejects.toThrow('Not signed in');
    // The next request still starts the new session with the recap.
    await runner.ask(key, ask('again'));
    await vi.waitFor(() => expect(starts).toHaveLength(3));
    expect(starts[2]!.ctx.prompt).toContain('Asked: first');
  });

  it('runs beside the session while Claude Desktop is answering in it, so the conversation there is not split', async () => {
    const { runner, starts, outside } = await withConversation();
    outside.open = 'desktop';
    await runner.ask(key, ask('while Desktop has it'));
    await vi.waitFor(() => expect(starts).toHaveLength(2));
    expect(starts[1]!.ctx).toMatchObject({ main: false, resume: true, fork: true, sessionId: starts[0]!.ctx.sessionId });
    // The session isn't the app's to write to now, so Desktop can still be opened on it.
    expect(await runner.desktopSession(key)).toBe(starts[0]!.ctx.sessionId);
    starts[1]!.finish();
    await vi.waitFor(async () => expect((await runner.session(key))?.turns.at(-1)).toMatchObject({ status: 'done', branch: true, besideOpen: 'desktop' }));
    expect((await runner.session(key))?.sessionId).toBe(starts[0]!.ctx.sessionId);
    // It didn't write to the session, so a copy Desktop loaded after the first request still has everything.
    const first = Date.parse((await runner.session(key))!.turns[0]!.endedAt!);
    expect(await runner.lastWrittenAt(key)).toBe(first);
  });

  it('shows what was asked in Claude Desktop, read from the transcript, in time order', async () => {
    const { runner, outside } = await withConversation();
    const line = (o: Record<string, unknown>) => `${JSON.stringify(o)}\n`;
    outside.transcript =
      line({ type: 'user', uuid: 'own', entrypoint: 'sdk-cli', turnOrigin: 'sdk', timestamp: '2000-01-01T00:00:00Z', message: { content: 'first' } }) +
      line({ type: 'user', uuid: 'd1', entrypoint: 'claude-desktop', turnOrigin: 'human', timestamp: '2999-01-01T00:00:00Z', message: { content: 'Asked in Desktop' } }) +
      line({ type: 'assistant', message: { content: [{ type: 'text', text: 'Working on it' }], stop_reason: 'tool_use' } });
    await runner.syncOutside(key);
    const turn = (await runner.session(key))?.turns.at(-1);
    expect(turn).toMatchObject({ id: 'outside-d1', outside: 'desktop', status: 'running', reply: 'Working on it', request: { prompt: 'Asked in Desktop' } });
    outside.transcript += line({ type: 'assistant', timestamp: '2999-01-01T00:01:00Z', message: { content: [{ type: 'text', text: 'Done.' }], stop_reason: 'end_turn' } });
    await runner.syncOutside(key);
    const turns = (await runner.session(key))?.turns ?? [];
    // The app's own request isn't added twice.
    expect(turns.map((t) => t.outside ?? 'app')).toEqual(['app', 'desktop']);
    expect(turns[1]).toMatchObject({ status: 'done', reply: 'Working on it\n\nDone.', endedAt: '2999-01-01T00:01:00Z' });
  });
});
