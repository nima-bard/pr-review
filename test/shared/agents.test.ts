import { describe, expect, it } from 'vitest';
import { agentPrompt, askPrefix, conversationRecap, requestLabel, sessionTitle } from '../../src/shared/agents';
import type { AgentRequest, AgentTurn, PrSnapshot } from '../../src/shared/model';

const snap = { key: 'github.com/o/r#7', details: { url: 'https://github.com/o/r/pull/7' }, worktree: { path: '/wt/pr-7' } } as unknown as PrSnapshot;

describe('askPrefix', () => {
  it('turns "/ask …" and "/claude …" into an ask, without the prefix or surrounding quotes', () => {
    expect(askPrefix('/ask is this safe?')).toBe('is this safe?');
    expect(askPrefix('  /Claude "check the guidelines"')).toBe('check the guidelines');
    expect(askPrefix('/claude')).toBe('');
  });

  it('leaves comments alone', () => {
    expect(askPrefix('Why /ask here?')).toBeNull();
    expect(askPrefix('/asking for a friend')).toBeNull();
  });
});

describe('agentPrompt', () => {
  const lines: AgentRequest = { kind: 'lines', prompt: ' Does this break our guidelines? ', target: { path: 'src/a.ts', side: 'RIGHT', startLine: 3, endLine: 5 } };

  it('asks for a review with the code-review skill in the worktree, as drafts', () => {
    const p = agentPrompt(snap, { kind: 'review', prompt: '', target: null });
    expect(p).toContain('Review pull request https://github.com/o/r/pull/7 with the code-review skill');
    expect(p).toContain('checked out at /wt/pr-7');
    expect(p).toContain('add_draft (pr "github.com/o/r#7")');
  });

  it('gives a line ask its lines, the threads on them and where add_draft goes', () => {
    const p = agentPrompt(snap, lines, { code: 'const a = 1;', threads: [{ author: 'ann', body: 'Rename\nthis' }] });
    expect(p.startsWith('Does this break our guidelines?\n')).toBe(true);
    expect(p).toContain('new lines 3–5');
    expect(p).toContain('```\nconst a = 1;\n```');
    expect(p).toContain('- ann: Rename this');
    expect(p).toContain('add_draft (path "src/a.ts", line 5, start_line 3, side "RIGHT")');
  });

  it('tells a line ask and a free request to answer questions without adding a review comment, and to act in the app with its tools', () => {
    for (const request of [lines, { kind: 'prompt', prompt: 'Is this safe?', target: null }] as AgentRequest[]) {
      const p = agentPrompt(snap, request);
      expect(p).toContain('A question, or a request to check, investigate or explain something: answer it in your reply only. Do not add a review comment');
      expect(p).toContain('A request to do something in PR Review (mark files as viewed, show or find');
      expect(p).toContain('set_viewed, show_in_app, search_code with show');
      expect(p).toContain('A request for a comment, or for a change to the code or its wording');
    }
  });

  it('never starts with "/", which Claude Desktop links disarm', () => {
    for (const request of [lines, { kind: 'review', prompt: '', target: null }, { kind: 'prompt', prompt: 'Summarise', target: null }] as AgentRequest[]) {
      expect(agentPrompt(snap, request).startsWith('/')).toBe(false);
    }
  });

  it('labels requests, with only the file name for headers', () => {
    expect(requestLabel(lines)).toBe('src/a.ts:3–5');
    expect(requestLabel(lines, { fileName: true })).toBe('a.ts:3–5');
    expect(requestLabel({ kind: 'review', prompt: '', target: null })).toBe('Review the pull request');
  });

  it('names the PR session after the pull request, the same every time', () => {
    expect(sessionTitle('3022', 'ci(pipelines): link builds')).toBe('PR #3022 · ci(pipelines): link builds');
    expect(sessionTitle('7', '')).toBe('PR #7');
    expect(sessionTitle(undefined, 'x')).toBeNull();
    expect(sessionTitle('1', 'x'.repeat(200))).toHaveLength(80);
  });
});

describe('conversationRecap', () => {
  const turn = (request: AgentRequest, reply: string, status: AgentTurn['status'] = 'done'): AgentTurn => ({
    id: Math.random().toString(),
    connectorId: 'c',
    agent: 'Claude',
    request,
    startedAt: '',
    endedAt: '',
    status,
    reply,
    activity: [],
    draftIds: [],
    costUsd: null,
    error: null,
  });

  it('lists what was asked and answered, oldest first, with where a line ask was', () => {
    const recap = conversationRecap([
      turn({ kind: 'review', prompt: '', target: null }, 'Two findings.'),
      turn({ kind: 'lines', prompt: 'Is this safe?', target: { path: 'src/a.ts', side: 'RIGHT', startLine: 3, endLine: 3 } }, 'Yes.'),
      turn({ kind: 'prompt', prompt: 'Still running', target: null }, '', 'running'),
      turn({ kind: 'prompt', prompt: 'Failed', target: null }, 'partial', 'failed'),
      turn({ kind: 'restore', prompt: '', target: null }, 'Ready.'),
    ]);
    expect(recap).toContain('Asked: Review the pull request\nYou answered: Two findings.\n\nAsked: Is this safe? (about src/a.ts:3)\nYou answered: Yes.\n\nEnd of the earlier conversation.');
    expect(recap).not.toContain('Failed');
    expect(recap).not.toContain('Ready.');
  });

  it('keeps the newest when the conversation is long, and is null when there is nothing to recap', () => {
    const long = Array.from({ length: 20 }, (_, i) => turn({ kind: 'prompt', prompt: `q${i}`, target: null }, `${i}`.padEnd(5000, '.')));
    const recap = conversationRecap(long) ?? '';
    expect(recap).toContain('Asked: q19');
    expect(recap).not.toContain('Asked: q0\n');
    expect(recap.length).toBeLessThan(20_000);
    expect(conversationRecap([turn({ kind: 'prompt', prompt: 'x', target: null }, '', 'stopped')])).toBeNull();
  });
});
