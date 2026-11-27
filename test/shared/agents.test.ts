import { describe, expect, it } from 'vitest';
import { askPrefix, asks, claudePrompt, claudeSystemPrompt, contextSize, effortMenuItems, hasEfforts, modelChoice, modelLabel, modelMenuItems, promptHeader, readPrompt, requestLabel, sessionTitle } from '../../src/shared/agents';
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
  it('tells Claude whether it may change files: reviewing it suggests a change as a comment, contributing it makes it, and commits only when asked', () => {
    const reading = claudeSystemPrompt({ ...snap, worktree: { path: '/wt/pr-7', checkout: 'reading', branch: null } } as unknown as PrSnapshot);
    expect(reading).toContain('The checkout is read only');
    expect(reading).toContain('or for a change to the code or its wording (rephrase, rename, fix, suggest…): add exactly one review comment');
    const editing = claudeSystemPrompt({ ...snap, worktree: { path: '/wt/pr-7', checkout: 'editing', branch: 'feature/x' } } as unknown as PrSnapshot);
    expect(editing).toContain("The checkout is on the pull request's branch feature/x, where the user contributes");
    expect(editing).toContain('Commit or push only when the user asks you to');
    expect(editing).toContain('never force-push');
    expect(editing).not.toContain('The checkout is read only');
  });

  it('says where the pull request is checked out, how to respond, and that comments go to the review as drafts', () => {
    const p = claudeSystemPrompt(snap);
    expect(p).toContain('https://github.com/o/r/pull/7');
    expect(p).toContain('checked out at /wt/pr-7');
    expect(p).toContain('A question, or a request to check, investigate or explain something: answer it in your reply only. Do not add a review comment');
    expect(p).toContain('set_viewed, show_in_app, search_code with show');
    expect(p).toContain('add_draft (pr "github.com/o/r#7"');
    // The choices come after a complete answer: what Claude found is never only in a button's prompt (the user doesn't read those).
    expect(p).toContain('offer it with the pr-review tool offer_choices');
    expect(p).toContain('Your answer comes first and is complete on its own');
    expect(p).toContain('never leave a conclusion to a choice');
    expect(p).toContain('write nothing after it');
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

describe('a question about a review thread', () => {
  const thread: AgentRequest = { kind: 'thread', prompt: 'Is this addressed?', target: { path: 'src/a.ts', side: 'RIGHT', startLine: 139, endLine: 139 }, thread: { id: 'PRRT_1', path: 'src/a.ts' } };
  const fileThread: AgentRequest = { kind: 'thread', prompt: 'Why?', target: null, thread: { id: 'PRRT_2', path: 'docs/a b.md' } };

  it('gives Claude the whole thread, the code it’s on and where a new comment there goes', () => {
    const p = claudePrompt(thread, { code: 'createIndex()', threads: [{ author: 'ann', body: 'No **rollout** step.' }, { author: 'bo', body: 'Added it.' }] });
    expect(p.startsWith('PR Review · thread PRRT_1 on src/a.ts, new lines 139–139\n\nIs this addressed?')).toBe(true);
    expect(p).toContain('The review thread on src/a.ts, new lines 139–139:\n- ann: No **rollout** step.\n- bo: Added it.');
    expect(p).toContain('```\ncreateIndex()\n```');
    expect(claudePrompt(fileThread, { code: null, threads: [] })).toContain('The review thread on docs/a b.md (a comment on the file):');
  });

  it('is read back from the session with its thread, and labelled by it', () => {
    expect(readPrompt(claudePrompt(thread))).toEqual(thread);
    expect(readPrompt(claudePrompt(fileThread))).toEqual(fileThread);
    expect(requestLabel(thread, { fileName: true })).toBe('Thread on a.ts:139');
    expect(requestLabel(fileThread)).toBe('Thread on docs/a b.md');
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
    background: [],
    waitingFor: null,
    hiddenMarkers: [],
    dismissedOffers: [],
    modelChoice: null,
    context: null,
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

  it('has a model menu, with going back to Settings’ default, and a separate effort menu for the chosen model', () => {
    expect(ids(modelMenuItems(models, { model: 'claude-fable-5-2', effort: 'high' }, false))).toEqual(['model:', 'model:claude-fable-5-2*', 'model:claude-haiku-4-5', '-', 'default']);
    expect(ids(modelMenuItems(models, { model: '', effort: '' }, true))).toEqual(['model:', 'model:claude-fable-5-2', 'model:claude-haiku-4-5', '-', 'default*']);
    expect(ids(effortMenuItems(models, { model: 'claude-fable-5-2', effort: 'high' }))).toEqual(['effort:', 'effort:low', 'effort:high*']);
    expect(hasEfforts(models, { model: 'claude-haiku-4-5', effort: '' })).toBe(false);
  });

  it('says how big each model’s context is in the menu, where Claude Code said', () => {
    const sized: ClaudeModel[] = [
      { value: 'opus', name: 'Opus 5.5', description: 'For complex work', efforts: [], contextWindow: 1_000_000 },
      { value: 'claude-opus-4-6', name: 'Opus 4.6', description: '', efforts: [], contextWindow: 200_000 },
      { value: 'haiku', name: 'Haiku 5.5', description: 'Fastest', efforts: [] },
    ];
    const labels = modelMenuItems(sized, { model: 'opus', effort: '' }, false).flatMap((i) => (i === 'separator' ? [] : [i.label]));
    expect(labels).toEqual(['Claude Code’s default', 'Opus 5.5 · For complex work · 1M context', 'Opus 4.6 · 200k context', 'Haiku 5.5 · Fastest', 'The default from Settings › Claude']);
    expect(contextSize(1_500_000)).toBe('1.5M context');
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

describe('a question about the file open in a tab', () => {
  const request = { kind: 'file' as const, prompt: 'What does this file do?', target: null, file: { path: 'src/billing/rate.ts' } };

  it('says which file in its header and context, and is read back from the session as it was', () => {
    const p = claudePrompt(request);
    expect(p.split('\n')[0]).toBe('PR Review · file src/billing/rate.ts');
    expect(p).toContain('The file src/billing/rate.ts, which the user has open in PR Review');
    expect(p).toContain('add_draft (path "src/billing/rate.ts"');
    expect(readPrompt(p)).toEqual(request);
  });

  it('is labelled with the file, or only its name in a header', () => {
    expect(requestLabel(request)).toBe('src/billing/rate.ts');
    expect(requestLabel(request, { fileName: true })).toBe('rate.ts');
  });

  it('is explained in the system prompt', () => {
    expect(claudeSystemPrompt(snap)).toContain('"PR Review · file <path>"');
  });
});

describe('a question about a word or name selected on a line', () => {
  const request = {
    kind: 'lines' as const,
    prompt: 'Where else is this used?',
    target: { path: 'src/a.ts', side: 'RIGHT' as const, startLine: 12, endLine: 12 },
    selection: { text: 'retryPolicy', from: 11, to: 21 },
  };

  it('names the selection and its columns beside the line, and is read back from the session with them', () => {
    const p = claudePrompt(request, { code: 'const p = retryPolicy(3);', threads: [] });
    expect(p).toContain('Selected on these lines: "retryPolicy", columns 11–21 (the part of the line the question is about)');
    expect(readPrompt(p)).toEqual(request);
  });

  it('reads back any text, quotes and backslashes too, and a single column', () => {
    const odd = { ...request, selection: { text: 'say "hi" \\ \'there\'', from: 4, to: 4 } };
    expect(readPrompt(claudePrompt(odd))).toEqual(odd);
  });

  it('shows where on the line in its label, then the selection, cut short when long', () => {
    expect(requestLabel(request, { fileName: true })).toBe('a.ts:12:11–21 · retryPolicy');
    expect(requestLabel({ ...request, selection: { text: 'x'.repeat(60), from: 1, to: 60 } })).toBe(`src/a.ts:12:1–60 · ${'x'.repeat(39)}…`);
  });

  it('leaves a whole-lines question as it was', () => {
    const { selection: _, ...whole } = request;
    expect(claudePrompt(whole)).not.toContain('Selected on these lines');
    expect(readPrompt(claudePrompt(whole))).toEqual(whole);
  });
});
