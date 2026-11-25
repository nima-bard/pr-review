import { describe, expect, it } from 'vitest';
import { EMPTY_STREAM, parseClaudeLine } from '../../../src/core/agents/claudeStream';

/** Shaped like a recorded `claude -p --output-format stream-json --verbose` run (Claude Code 2.1.311), shortened. */
const RUN = [
  { type: 'system', subtype: 'init', cwd: '/wt', session_id: 'S1', tools: [], mcp_servers: [{ name: 'pr-review', status: 'connected' }], model: 'claude-haiku' },
  { type: 'rate_limit_event', rate_limit_info: {}, session_id: 'S1' },
  { type: 'assistant', message: { content: [{ type: 'thinking', thinking: '' }] }, session_id: 'S1' },
  { type: 'assistant', message: { content: [{ type: 'tool_use', id: 'tu0', name: 'ToolSearch', input: { query: 'select:mcp__pr-review__add_draft' } }] } },
  { type: 'assistant', message: { content: [{ type: 'tool_use', id: 'tu1', name: 'Read', input: { file_path: '/wt/src/a.ts' } }] } },
  { type: 'assistant', message: { content: [{ type: 'tool_use', id: 'tu2', name: 'mcp__pr-review__add_draft', input: { pr: 'k', path: 'src/a.ts', line: 7 } }] } },
  { type: 'user', message: { content: [{ type: 'tool_result', tool_use_id: 'tu2', is_error: true, content: [{ type: 'text', text: 'Line 7 isn’t in the diff' }] }] } },
  { type: 'assistant', message: { content: [{ type: 'tool_use', id: 'tu3', name: 'mcp__pr-review__add_draft', input: { pr: 'k', path: 'src/a.ts', line: 9, start_line: 8 } }] } },
  { type: 'user', message: { content: [{ type: 'tool_result', tool_use_id: 'tu3', content: [{ type: 'text', text: 'Added draft d1' }] }] } },
  { type: 'assistant', message: { content: [{ type: 'text', text: 'One comment added.' }] } },
  { type: 'assistant', message: { content: [{ type: 'text', text: 'Nothing else stood out.' }] } },
  { type: 'result', subtype: 'success', is_error: false, result: 'Nothing else stood out.', session_id: 'S1', total_cost_usd: 0.0054 },
].map((m) => JSON.stringify(m));

const run = (lines: string[]) => lines.reduce(parseClaudeLine, EMPTY_STREAM);

describe('parseClaudeLine', () => {
  it('collects the reply, the activity worth showing, the session and the cost', () => {
    const s = run(RUN);
    expect(s.reply).toBe('One comment added.\n\nNothing else stood out.');
    expect(s.activity).toEqual(['Read /wt/src/a.ts', 'Added a draft on src/a.ts:7 (rejected)', 'Added a draft on src/a.ts:8–9']);
    expect(s).toMatchObject({ sessionId: 'S1', costUsd: 0.0054, done: true, error: null });
  });

  it('takes the new session id of a forked run, and ignores lines that are not JSON', () => {
    const s = run(['not json', JSON.stringify({ type: 'system', subtype: 'init', session_id: 'FORK' }), JSON.stringify({ type: 'result', subtype: 'success', result: 'Hi', session_id: 'FORK' })]);
    expect(s).toMatchObject({ sessionId: 'FORK', reply: 'Hi' });
  });

  it('reports an error result', () => {
    const s = run([JSON.stringify({ type: 'result', subtype: 'error_max_turns', is_error: true, session_id: 'S', errors: ['Reached max turns'] })]);
    expect(s).toMatchObject({ done: true, error: 'Reached max turns' });
  });
});
