import { mkdtempSync, realpathSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import { buildConversation } from '../../src/core/agents/conversation';
import { sessionChangedAt, sessionMessages } from '../../src/main/agents/claudeSessions';
import { appendSession } from '../helpers/claudeSession';

const config = mkdtempSync(join(tmpdir(), 'prr-claude-config-'));
const cwd = realpathSync(mkdtempSync(join(tmpdir(), 'prr-worktree-')));
const before = process.env.CLAUDE_CONFIG_DIR;
process.env.CLAUDE_CONFIG_DIR = config;
afterAll(() => {
  if (before === undefined) delete process.env.CLAUDE_CONFIG_DIR;
  else process.env.CLAUDE_CONFIG_DIR = before;
  rmSync(config, { recursive: true, force: true });
  rmSync(cwd, { recursive: true, force: true });
});

describe("reading a PR's Claude session through the Agent SDK", () => {
  it('reads what Claude Code wrote: the prompts and answers, and when the session last changed', async () => {
    const id = '11111111-2222-4333-8444-555555555555';
    expect(await sessionChangedAt(id, cwd)).toBeUndefined();
    appendSession(config, cwd, id, [
      { type: 'user', message: { role: 'user', content: 'PR Review · request\n\nIs this safe?\n\n--- PR Review context ---\nrules' } },
      { type: 'assistant', message: { role: 'assistant', content: [{ type: 'text', text: 'Yes.' }], stop_reason: 'end_turn' } },
    ]);
    expect(await sessionChangedAt(id, cwd)).toEqual(expect.any(Number));
    const conversation = buildConversation(await sessionMessages(id, cwd));
    expect(conversation).toEqual([expect.objectContaining({ asked: 'app', request: { kind: 'prompt', prompt: 'Is this safe?', target: null }, reply: 'Yes.', done: true })]);
  });
});
