import { afterEach, describe, expect, it, vi } from 'vitest';
import type { SessionLine } from '../../src/core/agents/conversation';
import type { ClaudePointer } from '../../src/core/store/claudePointer';
import type { ClaudeProcess, ClaudeProcessOptions } from '../../src/main/agents/claudeProcess';
import { IDLE_MS, PrClaude } from '../../src/main/agents/prClaude';
import { promptHeader } from '../../src/shared/agents';
import type { AgentRequest, ClaudeApp, ClaudeSettings, ClaudeView } from '../../src/shared/model';

interface FakeProcess extends ClaudeProcess {
  options: ClaudeProcessOptions;
  sent: string[];
  calls: string[];
  exit(error: string | null): void;
}

/** A PR's Claude with a stand-in session (lines by id), pointer, and `claude` processes the test drives. */
function setup(start: { sessionId?: string; exists?: boolean } = {}) {
  let pointer: ClaudePointer = { sessionId: start.sessionId ?? null, hiddenMarkers: [], dismissedOffers: [], modelChoice: null };
  const sessions = new Map<string, SessionLine[]>();
  if (start.sessionId && start.exists !== false) sessions.set(start.sessionId, []);
  let version = 0;
  let claimed: ClaudeApp | null = null;
  let terminalAnswering = false;
  let settings: ClaudeSettings = { enabled: true, model: '', effort: '' };
  const processes: FakeProcess[] = [];
  const views: ClaudeView[] = [];
  const claude = new PrClaude({
    prepare: async (request) => ({ worktree: '/wt', env: {}, title: 'PR #1 · T', prompt: `${promptHeader(request)}\n\n${request.prompt}`, systemPrompt: 'How to work with PR Review' }),
    worktree: () => '/wt',
    settings: async () => settings,
    mcp: async () => ({ url: 'http://127.0.0.1:1/mcp', headers: {} }),
    pointer: {
      read: async () => pointer,
      write: async (p) => {
        pointer = p;
      },
    },
    session: { changedAt: async (id) => (sessions.has(id) ? version : undefined), messages: async (id) => sessions.get(id) ?? [] },
    elsewhere: async () => null,
    claim: async () => claimed,
    takeFromTerminal: async () => {
      if (terminalAnswering) return false;
      claimed = null;
      return true;
    },
    start: (options) => {
      if (options.isNew) sessions.set(options.sessionId, []);
      let exit!: (error: string | null) => void;
      const proc: FakeProcess = {
        options,
        sent: [],
        calls: [],
        send: (prompt) => void proc.sent.push(prompt),
        interrupt: () => void proc.calls.push('interrupt'),
        close: () => {
          proc.calls.push('close');
          exit(null);
        },
        kill: () => void proc.calls.push('kill'),
        ended: new Promise((r) => (exit = r)),
        exit: (error) => exit(error),
      };
      processes.push(proc);
      return proc;
    },
    emit: (view) => void views.push(view),
  });
  /** Claude reads the oldest unread prompt of `proc` and answers it: both land in the session, and the turn ends. */
  const answer = (proc: FakeProcess, reply = 'ok', usage?: Record<string, number>, contextWindow?: number) => {
    const prompt = proc.sent.shift()!;
    const lines = sessions.get(proc.options.sessionId)!;
    lines.push({ type: 'user', uuid: `u${lines.length}`, message: { content: prompt } });
    lines.push({ type: 'assistant', uuid: `a${lines.length}`, message: { content: [{ type: 'text', text: reply }], stop_reason: 'end_turn', usage } });
    version++;
    proc.options.onTurn();
    proc.options.onResult(null, contextWindow);
  };
  /** Someone types in Claude Desktop (or Claude Code) and gets an answer, writing to the session from outside the app. */
  const writeElsewhere = (sessionId: string, prompt: string) => {
    const lines = sessions.get(sessionId)!;
    lines.push({ type: 'user', uuid: `d${lines.length}`, message: { content: prompt } });
    lines.push({ type: 'assistant', uuid: `d${lines.length}`, message: { content: [{ type: 'text', text: 'From Desktop.' }], stop_reason: 'end_turn' } });
    version++;
  };
  return {
    claude,
    processes,
    views,
    sessions,
    answer,
    writeElsewhere,
    pointer: () => pointer,
    claimedBy: (app: ClaudeApp | null) => {
      claimed = app;
    },
    terminalAnswering: (answering: boolean) => {
      terminalAnswering = answering;
    },
    changeSettings: (patch: Partial<ClaudeSettings>) => {
      settings = { ...settings, ...patch };
    },
  };
}

const ask = (prompt: string): AgentRequest => ({ kind: 'prompt', prompt, target: null });
afterEach(() => vi.useRealTimers());

describe('PrClaude', () => {
  it('starts a new session for the first question, named after the PR, and shows it from the session once Claude has read it', async () => {
    const { claude, processes, answer, pointer } = setup();
    claude.ask(ask('Is this safe?'));
    await vi.waitFor(() => expect(processes[0]?.sent).toHaveLength(1));
    const proc = processes[0]!;
    expect(proc.options).toMatchObject({ isNew: true, title: 'PR #1 · T', cwd: '/wt', systemPrompt: 'How to work with PR Review', model: '', effort: '' });
    expect(pointer().sessionId).toBe(proc.options.sessionId);
    expect(claude.view().pending.map((p) => p.state)).toEqual(['sent']);
    answer(proc, 'Yes.');
    await vi.waitFor(() => expect(claude.view().exchanges).toHaveLength(1));
    expect(claude.view()).toMatchObject({ pending: [], exchanges: [{ asked: 'app', request: { prompt: 'Is this safe?' }, reply: 'Yes.', done: true }] });
  });

  it('sends a question asked while Claude answers into the same process, after the first', async () => {
    const { claude, processes } = setup({ sessionId: 's1' });
    claude.ask(ask('one'));
    await vi.waitFor(() => expect(processes[0]?.sent).toHaveLength(1));
    claude.ask(ask('two'));
    await vi.waitFor(() => expect(processes[0]?.sent).toHaveLength(2));
    expect(processes).toHaveLength(1);
    expect(processes[0]!.options).toMatchObject({ isNew: false, sessionId: 's1' });
  });

  it('starts its claude again when someone else wrote to the session while it was idle, so the conversation is not split', async () => {
    const { claude, processes, answer, writeElsewhere } = setup({ sessionId: 's1' });
    claude.ask(ask('one'));
    await vi.waitFor(() => expect(processes[0]?.sent).toHaveLength(1));
    answer(processes[0]!);
    await vi.waitFor(() => expect(claude.view().exchanges).toHaveLength(1));
    await new Promise((r) => setTimeout(r, 20));
    claude.ask(ask('two, still in the same process'));
    await vi.waitFor(() => expect(processes[0]!.sent).toHaveLength(1));
    expect(processes).toHaveLength(1);
    answer(processes[0]!);
    await vi.waitFor(() => expect(claude.view().exchanges).toHaveLength(2));
    await new Promise((r) => setTimeout(r, 20));

    writeElsewhere('s1', 'Typed in Claude Desktop');
    claude.ask(ask('three'));
    await vi.waitFor(() => expect(processes[1]?.sent).toHaveLength(1));
    expect(processes[0]!.calls).toContain('close');
    expect(processes[1]!.options).toMatchObject({ isNew: false, sessionId: 's1' });
  });

  it('starts its claude again with the model and effort chosen in Settings since it started', async () => {
    const { claude, processes, answer, changeSettings } = setup({ sessionId: 's1' });
    claude.ask(ask('one'));
    await vi.waitFor(() => expect(processes[0]?.sent).toHaveLength(1));
    answer(processes[0]!);
    await vi.waitFor(() => expect(claude.view().exchanges).toHaveLength(1));
    await new Promise((r) => setTimeout(r, 20));
    changeSettings({ model: 'claude-fable-5-2', effort: 'high' });
    claude.ask(ask('two'));
    await vi.waitFor(() => expect(processes[1]?.sent).toHaveLength(1));
    expect(processes[0]!.calls).toContain('close');
    expect(processes[1]!.options).toMatchObject({ isNew: false, sessionId: 's1', model: 'claude-fable-5-2', effort: 'high' });
  });

  it('uses the model and effort chosen in the conversation over Settings, until it goes back to the default', async () => {
    const { claude, processes, answer, pointer } = setup({ sessionId: 's1' });
    await claude.chooseModel({ model: 'claude-haiku-5-5', effort: 'low' });
    expect(pointer().modelChoice).toEqual({ model: 'claude-haiku-5-5', effort: 'low' });
    expect(claude.view().modelChoice).toEqual({ model: 'claude-haiku-5-5', effort: 'low' });
    claude.ask(ask('one'));
    await vi.waitFor(() => expect(processes[0]?.sent).toHaveLength(1));
    expect(processes[0]!.options).toMatchObject({ model: 'claude-haiku-5-5', effort: 'low' });
    answer(processes[0]!);
    await vi.waitFor(() => expect(claude.view().exchanges).toHaveLength(1));
    await new Promise((r) => setTimeout(r, 20));
    await claude.chooseModel(null);
    claude.ask(ask('two'));
    await vi.waitFor(() => expect(processes[1]?.sent).toHaveLength(1));
    expect(processes[1]!.options).toMatchObject({ model: '', effort: '' });
  });

  it('says how full the context is, against the window Claude Code names for the model', async () => {
    const { claude, processes, answer } = setup({ sessionId: 's1' });
    claude.ask(ask('one'));
    await vi.waitFor(() => expect(processes[0]?.sent).toHaveLength(1));
    answer(processes[0]!, 'ok', { input_tokens: 10, cache_read_input_tokens: 49_990 });
    await vi.waitFor(() => expect(claude.view().context).toEqual({ tokens: 50_000, window: 200_000 }));
    claude.ask(ask('two'));
    await vi.waitFor(() => expect(processes[0]?.sent).toHaveLength(1));
    answer(processes[0]!, 'ok', { input_tokens: 300_000 }, 1_000_000);
    await vi.waitFor(() => expect(claude.view().context).toEqual({ tokens: 300_000, window: 1_000_000 }));
  });

  it('waits while Claude Desktop is answering in the session, and sends once it is free', async () => {
    const { claude, processes, claimedBy } = setup({ sessionId: 's1' });
    claimedBy('desktop');
    claude.ask(ask('later'));
    await vi.waitFor(() => expect(claude.view().waitingFor).toBe('desktop'));
    expect(processes).toHaveLength(0);
    expect(claude.view().pending.map((p) => p.state)).toEqual(['waiting']);
    claimedBy(null);
    await claude.refresh(true);
    await vi.waitFor(() => expect(processes[0]?.sent).toHaveLength(1));
    expect(claude.view().waitingFor).toBeNull();
  });

  it('starts a new session when the one it had is gone, and when Claude Code says so on resuming', async () => {
    const gone = setup({ sessionId: 'old', exists: false });
    gone.claude.ask(ask('hello'));
    await vi.waitFor(() => expect(gone.processes[0]?.sent).toHaveLength(1));
    expect(gone.processes[0]!.options.isNew).toBe(true);
    expect(gone.pointer().sessionId).not.toBe('old');

    const deleted = setup({ sessionId: 's1' });
    deleted.claude.ask(ask('again'));
    await vi.waitFor(() => expect(deleted.processes[0]?.sent).toHaveLength(1));
    deleted.sessions.delete('s1');
    deleted.processes[0]!.exit('No conversation found with session ID: s1');
    await vi.waitFor(() => expect(deleted.processes[1]?.sent).toHaveLength(1));
    expect(deleted.processes[1]!.options.isNew).toBe(true);
  });

  it('shows why a question could not be sent, and sends it again on Retry', async () => {
    const { claude, processes } = setup({ sessionId: 's1' });
    claude.ask(ask('one'));
    await vi.waitFor(() => expect(processes[0]?.sent).toHaveLength(1));
    processes[0]!.exit('Not signed in');
    await vi.waitFor(() => expect(claude.view().pending[0]).toMatchObject({ state: 'failed', error: 'Not signed in' }));
    expect(claude.view().error).toBe('Not signed in');
    claude.retry(claude.view().pending[0]!.id);
    await vi.waitFor(() => expect(processes[1]?.sent).toHaveLength(1));
  });

  it('stops the answer in progress, cancels a question not sent yet, and hides a marker', async () => {
    const { claude, processes, pointer } = setup({ sessionId: 's1' });
    claude.ask(ask('long one'));
    await vi.waitFor(() => expect(processes[0]?.sent).toHaveLength(1));
    processes[0]!.options.onTurn();
    claude.stop();
    expect(processes[0]!.calls).toContain('interrupt');
    processes[0]!.options.onResult('Claude stopped (error_during_execution).');
    expect(claude.view().error).toBeNull();

    const waiting = setup({ sessionId: 's2' });
    waiting.claimedBy('terminal');
    waiting.claude.ask(ask('not now'));
    await vi.waitFor(() => expect(waiting.claude.view().waitingFor).toBe('terminal'));
    waiting.claude.cancel(waiting.claude.view().pending[0]!.id);
    expect(waiting.claude.view().pending).toEqual([]);

    await claude.hideMarker('u0');
    expect(pointer().hiddenMarkers).toEqual(['u0']);
    await claude.dismissOffer('a1');
    expect(claude.view().dismissedOffers).toEqual(['a1']);
  });

  it('takes the session from Claude Code in a terminal on OK, and a new question replaces the one waiting for that answer', async () => {
    const { claude, processes, claimedBy, terminalAnswering } = setup({ sessionId: 's1' });
    claimedBy('terminal');
    claude.ask(ask('first'));
    await vi.waitFor(() => expect(claude.view().waitingFor).toBe('terminal'));
    claude.ask(ask('second, instead'));
    expect(claude.view().pending.map((p) => p.request.prompt)).toEqual(['second, instead']);

    terminalAnswering(true);
    await expect(claude.takeOver()).rejects.toThrow('answering in Claude Code');
    expect(processes).toHaveLength(0);

    terminalAnswering(false);
    await claude.takeOver();
    await vi.waitFor(() => expect(processes[0]?.sent).toEqual(['PR Review · request\n\nsecond, instead']));
    expect(claude.view().waitingFor).toBeNull();
  });

  it('queues questions behind Claude Desktop answering, which ends by itself', async () => {
    const { claude, claimedBy } = setup({ sessionId: 's1' });
    claimedBy('desktop');
    claude.ask(ask('one'));
    await vi.waitFor(() => expect(claude.view().waitingFor).toBe('desktop'));
    claude.ask(ask('two'));
    expect(claude.view().pending.map((p) => p.request.prompt)).toEqual(['one', 'two']);
  });

  it('lets go of the session for Claude Desktop or Claude Code when idle, not while answering', async () => {
    const { claude, processes, answer } = setup({ sessionId: 's1' });
    claude.ask(ask('one'));
    await vi.waitFor(() => expect(processes[0]?.sent).toHaveLength(1));
    processes[0]!.options.onTurn();
    expect(await claude.release()).toBe(false);
    answer(processes[0]!);
    expect(await claude.release()).toBe(true);
    expect(processes[0]!.calls).toContain('close');
  });

  it('closes its claude a minute after the last answer', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    const { claude, processes, answer } = setup({ sessionId: 's1' });
    claude.ask(ask('one'));
    await vi.waitFor(() => expect(processes[0]?.sent).toHaveLength(1));
    answer(processes[0]!);
    await vi.advanceTimersByTimeAsync(IDLE_MS - 1000);
    expect(processes[0]!.calls).not.toContain('close');
    await vi.advanceTimersByTimeAsync(2000);
    expect(processes[0]!.calls).toContain('close');
  });
});
