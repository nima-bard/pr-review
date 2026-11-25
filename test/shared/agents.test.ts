import { describe, expect, it } from 'vitest';
import { agentPrompt, askPrefix, requestLabel } from '../../src/shared/agents';
import type { AgentRequest, PrSnapshot } from '../../src/shared/model';

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

  it('never starts with "/", which Claude Desktop links disarm', () => {
    for (const request of [lines, { kind: 'review', prompt: '', target: null }, { kind: 'prompt', prompt: 'Summarise', target: null }] as AgentRequest[]) {
      expect(agentPrompt(snap, request).startsWith('/')).toBe(false);
    }
  });

  it('labels requests', () => {
    expect(requestLabel(lines)).toBe('src/a.ts:3–5');
    expect(requestLabel({ kind: 'review', prompt: '', target: null })).toBe('Review the pull request');
  });
});
