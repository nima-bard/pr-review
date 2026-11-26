import { describe, expect, it } from 'vitest';
import { askPrefix, asks, claudePrompt, claudeSystemPrompt, modelChoice, modelLabel, modelMenuItems, promptHeader, readPrompt, requestLabel, sessionTitle } from '../../src/shared/agents';
import type { AgentRequest, ClaudeModel, ClaudeView, Exchange, PrSnapshot } from '../../src/shared/model';

const snap = { key: 'github.com/o/r#7', details: { url: 'https://github.com/o/r/pull/7' }, worktree: { path: '/wt/pr-7' } } as unknown as PrSnapshot;
const lines: AgentRequest = { kind: 'lines', prompt: ' Does this break our guidelines? ', target: { path: 'src/a.ts', side: 'RIGHT', startLine: 3, endLine: 5 } };
const free: AgentRequest = { kind: 'prompt', prompt: 'Is this safe?\nThink about nulls.', target: null };

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

describe('claudeSystemPrompt', () => {
  it('says where the pull request is checked out, how to respond, and that comments go to the review as drafts', () => {
    const p = claudeSystemPrompt(snap);
    expect(p).toContain('https://github.com/o/r/pull/7');
    expect(p).toContain('checked out at /wt/pr-7');
    expect(p).toContain('A question, or a request to check, investigate or explain something: answer it in your reply only. Do not add a review comment');
    expect(p).toContain('set_viewed, show_in_app, search_code with show');
    expect(p).toContain('add_draft (pr "github.com/o/r#7"');
    expect(p).toContain('end with the pr-review tool offer_choices');
    expect(p).toContain('have a subagent do the search');
  });
});

describe('claudePrompt', () => {
  it('is just the header and your words for a request: the rules are in the system prompt', () => {
    expect(claudePrompt(free)).toBe('PR Review · request\n\nIs this safe?\nThink about nulls.');
  });

  it('gives a line ask its lines, the threads on them and where add_draft goes', () => {
    const p = claudePrompt(lines, { code: 'const a = 1;', threads: [{ author: 'ann', body: 'Rename\nthis' }] });
    expect(p).toContain('src/a.ts, new lines 3–5:');
    expect(p).toContain('```\nconst a = 1;\n```');
    expect(p).toContain('- ann: Rename this');
    expect(p).toContain('add_draft (path "src/a.ts", line 5, start_line 3, side "RIGHT")');
    expect(p).not.toContain('How to respond');
  });

  it('starts with the header, never with "/", which Claude Desktop links disarm', () => {
    for (const request of [lines, free]) {
      const p = claudePrompt(request);
      expect(p.startsWith(`${promptHeader(request)}\n`)).toBe(true);
      expect(p.startsWith('/')).toBe(false);
    }
  });
});

describe('readPrompt', () => {
  it('gives back the request a prompt PR Review sent was made from, from the session', () => {
    expect(readPrompt(claudePrompt(lines, { code: 'x', threads: [] }))).toEqual({ ...lines, prompt: 'Does this break our guidelines?' });
    expect(readPrompt(claudePrompt(free))).toEqual(free);
    const old = { ...lines, target: { path: 'a folder/b, c.ts', side: 'LEFT' as const, startLine: 9, endLine: 12 } };
    expect(readPrompt(claudePrompt(old))?.target).toEqual(old.target);
  });

  it('is null for a prompt typed elsewhere', () => {
    expect(readPrompt('Is this safe?')).toBeNull();
    expect(readPrompt('PR Review is great, isn’t it?')).toBeNull();
  });
});

describe('asks', () => {
  const exchange = (id: string, done: boolean): Exchange => ({ id, asked: 'app', request: free, at: null, endedAt: null, reply: '', activity: [], draftIds: [], offer: null, done });
  const view = (busy: ClaudeView['busy'], exchanges: Exchange[]): ClaudeView => ({
    sessionId: 's',
    exchanges,
    pending: [{ id: 'p1', request: lines, state: 'waiting', error: null }],
    busy,
    waitingFor: null,
    hiddenMarkers: [],
    dismissedOffers: [],
    modelChoice: null,
    error: null,
  });

  it('says how each question stands: answered, being answered (the last, while someone answers), stopped, or on its way', () => {
    expect(asks(view('app', [exchange('a', true), exchange('b', false), exchange('c', false)])).map((a) => [a.id, a.status])).toEqual([
      ['a', 'answered'],
      ['b', 'stopped'],
      ['c', 'answering'],
      ['p1', 'waiting'],
    ]);
    expect(asks(view(null, [exchange('c', false)]))[0]?.status).toBe('stopped');
  });
});

describe('labels', () => {
  it('labels requests, with only the file name for headers', () => {
    expect(requestLabel(lines)).toBe('src/a.ts:3–5');
    expect(requestLabel(lines, { fileName: true })).toBe('a.ts:3–5');
    expect(requestLabel(free)).toBe('Request');
  });

  it('names the PR session after the pull request, the same every time', () => {
    expect(sessionTitle('12', 'fix(login): retry once')).toBe('PR #12 · fix(login): retry once');
    expect(sessionTitle('7', '')).toBe('PR #7');
    expect(sessionTitle(undefined, 'x')).toBeNull();
    expect(sessionTitle('1', 'x'.repeat(200))).toHaveLength(80);
  });
});

describe('the conversation’s model picker', () => {
  const models: ClaudeModel[] = [
    { value: '', name: 'Default (recommended)', description: 'Opus 5.5 · Best for everyday, complex tasks', efforts: ['low', 'high', 'xhigh'] },
    { value: 'claude-fable-5-2', name: 'Fable 5.2', description: 'Most capable', efforts: ['low', 'high'] },
    { value: 'claude-haiku-4-5', name: 'Haiku 4.5', description: 'Fastest', efforts: [] },
  ];
  const ids = (items: ReturnType<typeof modelMenuItems>) => items.map((i) => (i === 'separator' ? '-' : `${i.id}${i.checked ? '*' : ''}${i.enabled === false ? '!' : ''}`));

  it('shows the model and effort as Claude Desktop does, naming the default by what it is', () => {
    expect(modelLabel(models, { model: '', effort: 'xhigh' })).toEqual({ model: 'Opus 5.5', effort: 'Extra' });
    expect(modelLabel(models, { model: 'claude-fable-5-2', effort: '' })).toEqual({ model: 'Fable 5.2', effort: null });
    expect(modelLabel(models, { model: 'claude-haiku-4-5', effort: 'high' })).toEqual({ model: 'Haiku 4.5', effort: null });
  });

  it('lists the models, the chosen one’s effort levels, and going back to Settings’ default', () => {
    expect(ids(modelMenuItems(models, { model: 'claude-fable-5-2', effort: 'high' }, false))).toEqual([
      'heading:model!',
      'model:',
      'model:claude-fable-5-2*',
      'model:claude-haiku-4-5',
      '-',
      'heading:effort!',
      'effort:',
      'effort:low',
      'effort:high*',
      '-',
      'default',
    ]);
    expect(ids(modelMenuItems(models, { model: 'claude-haiku-4-5', effort: '' }, true)).slice(-4)).toEqual(['heading:effort!', 'effort:*!', '-', 'default*!']);
  });

  it('turns a choice into the model and effort to use, keeping the effort only where the model has it', () => {
    const c = { model: '', effort: 'xhigh' as const };
    expect(modelChoice(models, c, 'model:claude-fable-5-2')).toEqual({ model: 'claude-fable-5-2', effort: '' });
    expect(modelChoice(models, { model: '', effort: 'low' }, 'model:claude-fable-5-2')).toEqual({ model: 'claude-fable-5-2', effort: 'low' });
    expect(modelChoice(models, c, 'effort:high')).toEqual({ model: '', effort: 'high' });
    expect(modelChoice(models, c, 'default')).toBe('default');
    expect(modelChoice(models, c, null)).toBeNull();
    expect(modelChoice(models, c, 'effort:huge')).toBeNull();
  });
});
