import { describe, expect, it } from 'vitest';
import { buildConversation, contextTokens, type SessionLine } from '../../../src/core/agents/conversation';

let n = 0;
const user = (content: unknown, extra: Partial<SessionLine> = {}): SessionLine => ({ type: 'user', uuid: `u${++n}`, message: { role: 'user', content }, timestamp: '2026-11-26T08:00:00Z', ...extra });
const say = (text: string, stop = 'tool_use'): SessionLine => ({ type: 'assistant', uuid: `a${++n}`, message: { role: 'assistant', content: [{ type: 'text', text }], stop_reason: stop } });
const tool = (id: string, name: string, input: Record<string, unknown>): SessionLine => ({ type: 'assistant', uuid: `t${++n}`, message: { content: [{ type: 'tool_use', id, name, input }], stop_reason: 'tool_use' } });
const result = (id: string, text: string, isError = false): SessionLine => user([{ type: 'tool_result', tool_use_id: id, is_error: isError, content: [{ type: 'text', text }] }]);
const fromApp = (header: string, words: string) => `${header}\n\n${words}\n\n--- PR Review context ---\nPull request …`;

describe('buildConversation', () => {
  it("reads PR Review's prompts back: what was asked, about which lines, and the answer with its steps and comments", () => {
    const [ex] = buildConversation([
      user(fromApp('PR Review · src/a.ts, new lines 3–5', 'Is this safe?')),
      tool('t1', 'Read', { file_path: 'src/a.ts' }),
      result('t1', 'file contents'),
      tool('t2', 'mcp__pr-review__add_draft', { path: 'src/a.ts', line: 5 }),
      result('t2', 'Added draft d-42 on src/a.ts:5. The user will review it in PR Review.'),
      say('No: a null gets through.', 'end_turn'),
    ]);
    expect(ex).toMatchObject({
      asked: 'app',
      request: { kind: 'lines', prompt: 'Is this safe?', target: { path: 'src/a.ts', side: 'RIGHT', startLine: 3, endLine: 5 } },
      reply: 'No: a null gets through.',
      activity: ['Read src/a.ts', 'Added a draft on src/a.ts:5'],
      draftIds: ['d-42'],
      done: true,
      at: '2026-11-26T08:00:00Z',
    });
  });

  it('shows prompts typed in Claude Desktop or Claude Code as asked elsewhere, with their whole text', () => {
    const [ex] = buildConversation([user('What does line 9 do?'), say('It checks the role.', 'end_turn')]);
    expect(ex).toMatchObject({ asked: 'elsewhere', request: { kind: 'prompt', prompt: 'What does line 9 do?', target: null }, reply: 'It checks the role.' });
  });

  it('is not done until Claude ends its turn, and marks a refused tool call', () => {
    const [ex] = buildConversation([user('Check it'), tool('t1', 'Bash', { command: 'gh api repos/x --method POST' }), result('t1', 'denied', true), say('Working on it…')]);
    expect(ex).toMatchObject({ done: false, activity: ['Ran gh api repos/x --method POST (rejected)'], reply: 'Working on it…' });
  });

  it('leaves out subagents’ messages, commands, and anything before the first prompt', () => {
    const conversation = buildConversation([
      say('(left from before)'),
      user('Review it'),
      { ...say('subagent notes'), parent_tool_use_id: 'task-1' },
      say('Two findings.', 'end_turn'),
      user('<command-name>/compact</command-name>'),
      say('(compacting)'),
    ]);
    expect(conversation.map((e) => [e.request.prompt, e.reply])).toEqual([['Review it', 'Two findings.']]);
  });

  it('reads the choices Claude offered at the end of its answer, and leaves the call out of what it did', () => {
    const offer = { question: 'Leave a comment about the five missing processors?', choices: [{ label: 'Yes, leave a comment', prompt: 'Yes, write that comment.' }, { label: 'No', prompt: null }] };
    const [ex] = buildConversation([user('Is the list complete?'), say('No: five are missing.'), tool('t9', 'mcp__pr-review__offer_choices', offer), result('t9', 'PR Review shows these as buttons…'), say('', 'end_turn')]);
    expect(ex).toMatchObject({ offer, activity: [], reply: 'No: five are missing.', done: true });
    const [broken] = buildConversation([user('x'), tool('t1', 'mcp__pr-review__offer_choices', { question: 'Huh?', choices: [{ label: '' }] })]);
    expect(broken?.offer).toBeNull();
  });

  it('counts an answer as finished when the next question was queued into its turn, but not one you stopped', () => {
    const [first, second] = buildConversation([user('Is it safe?'), say('Yes.'), user('Where is it set?', { isQueuedCommand: true }), say('In the seed.', 'end_turn')]);
    expect([first?.done, first?.reply, second?.done]).toEqual([true, 'Yes.', true]);
    const stopped = buildConversation([user('Is it safe?'), say('Checking…'), user([{ type: 'text', text: '[Request interrupted by user]' }]), user('Never mind')]);
    expect(stopped.map((e) => [e.request.prompt, e.done])).toEqual([
      ['Is it safe?', false],
      ['Never mind', false],
    ]);
  });

  it('knows when Claude last wrote, for how long it worked', () => {
    const [ex] = buildConversation([user('Is it safe?'), { ...say('Yes.', 'end_turn'), timestamp: '2026-11-26T08:00:42Z' }]);
    expect([ex?.at, ex?.endedAt]).toEqual(['2026-11-26T08:00:00Z', '2026-11-26T08:00:42Z']);
  });

  it('reads the text of a prompt sent with an image', () => {
    const [ex] = buildConversation([user([{ type: 'image' }, { type: 'text', text: 'What is this?' }])]);
    expect(ex?.request.prompt).toBe('What is this?');
  });
});

describe('contextTokens', () => {
  const used = (usage: Record<string, number>, extra: Partial<SessionLine> = {}): SessionLine => ({ ...say('…'), message: { role: 'assistant', content: [], usage }, ...extra });

  it('is what Claude’s last call in the conversation read and wrote, not a subagent’s', () => {
    expect(contextTokens([user('Hi'), used({ input_tokens: 10, cache_read_input_tokens: 40_000, cache_creation_input_tokens: 2000, output_tokens: 500 }), used({ input_tokens: 90_000 }, { parent_tool_use_id: 'task' })])).toBe(42_510);
  });

  it('is null before Claude has answered', () => {
    expect(contextTokens([user('Hi')])).toBeNull();
  });
});
