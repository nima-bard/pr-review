import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, describe, expect, it, vi } from 'vitest';
import { AppState } from '../../src/core/store/appState';
import { AgentRunner } from '../../src/main/agents/agentRunner';
import type { Connector, TurnContext } from '../../src/main/agents/connector';
import type { AgentRequest } from '../../src/shared/model';

const dirs: string[] = [];
afterAll(() => dirs.forEach((d) => rmSync(d, { recursive: true, force: true })));

/** A runner with one Claude agent, `parallel` requests at once, and a stand-in Claude whose turns end when told to. */
function setup(parallel: number) {
  const dir = mkdtempSync(join(tmpdir(), 'prr-agents-'));
  dirs.push(dir);
  writeFileSync(join(dir, 'state.json'), JSON.stringify({ settings: { agents: [{ id: 'c', name: 'Claude', kind: 'claude-code', command: '', model: '' }], agentParallel: parallel } }));
  const starts: { ctx: TurnContext; finish(): void }[] = [];
  const claude: Connector = {
    start(ctx, update) {
      let resolve!: (v: { sessionId: string | null }) => void;
      const done = new Promise<{ sessionId: string | null }>((r) => (resolve = r));
      starts.push({
        ctx,
        finish: () => {
          update({ status: 'done', reply: 'ok' });
          resolve({ sessionId: ctx.fork ? 'forked-id' : ctx.sessionId });
        },
      });
      return { stop: () => resolve({ sessionId: null }), done };
    },
  };
  const runner = new AgentRunner({
    appState: new AppState(dir),
    emit: () => undefined,
    connector: () => claude,
    prepare: async () => ({ worktree: '/wt', env: { PR_NUMBER: '1', PR_TITLE: 'T' }, prompt: 'p' }),
    mcp: async () => ({ url: 'http://127.0.0.1:1/mcp', token: 't' }),
  });
  return { runner, starts };
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
});
