import { chmodSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { CLAUDE_DENIED, claudeArgs, promptLine, startClaude, type ClaudeProcessOptions } from '../../src/main/agents/claudeProcess';

const dir = mkdtempSync(join(tmpdir(), 'prr-claude-process-'));
/**
 * A stand-in for `claude -p --input-format stream-json`: a turn (init, then a result) for each prompt line, an error
 * result for a prompt saying "refuse", and exit code 1 with a message for one saying "crash". A prompt saying
 * "background" starts an agent in the background (and a watcher, which isn't work), which finishes a moment after the
 * turn; Claude then answers in a turn of its own, with no init, as Claude Code does. Exits when stdin ends.
 */
const FAKE = `#!/usr/bin/env node
const rl = require('node:readline').createInterface({ input: process.stdin });
const out = (m) => process.stdout.write(JSON.stringify(m) + '\\n');
rl.on('line', (line) => {
  const text = JSON.parse(line).message.content[0].text;
  if (text.includes('crash')) { process.stderr.write('No conversation found with session ID: s1'); process.exit(1); }
  out({ type: 'system', subtype: 'init', session_id: 's1' });
  if (text.includes('background')) {
    const watcher = { task_id: 'w1', task_type: 'monitor', description: 'Watch the build', ambient: true };
    out({ type: 'system', subtype: 'background_tasks_changed', tasks: [{ task_id: 'a1', task_type: 'local_agent', description: 'Find the callers' }, watcher] });
    setTimeout(() => {
      out({ type: 'system', subtype: 'task_notification', task_id: 'a1', status: 'completed', output_file: '', summary: 'done' });
      out({ type: 'system', subtype: 'background_tasks_changed', tasks: [watcher] });
      out({ type: 'assistant', message: { content: [{ type: 'text', text: 'Three callers.' }] } });
      out({ type: 'result', subtype: 'success', result: 'Three callers.' });
    }, 150);
  }
  out({ type: 'assistant', message: { content: [{ type: 'text', text: 'ok: ' + text }] } });
  out(text.includes('refuse') ? { type: 'result', subtype: 'error_during_execution', is_error: true, result: 'refused' } : { type: 'result', subtype: 'success', result: 'ok' });
});
rl.on('close', () => process.exit(0));
`;
const before = process.env.PR_REVIEW_CLAUDE;
beforeAll(() => {
  writeFileSync(join(dir, 'claude'), FAKE);
  chmodSync(join(dir, 'claude'), 0o755);
  process.env.PR_REVIEW_CLAUDE = join(dir, 'claude');
});
afterAll(() => {
  if (before === undefined) delete process.env.PR_REVIEW_CLAUDE;
  else process.env.PR_REVIEW_CLAUDE = before;
  rmSync(dir, { recursive: true, force: true });
});

const base = { sessionId: 's1', title: 'PR #7 · Title', model: '', effort: '', systemPrompt: 'Work with PR Review.', mcp: { url: 'http://127.0.0.1:1/mcp', headers: { Authorization: 'Bearer t' } } };

describe('claudeArgs', () => {
  it('lets Claude change files, commit and push only while you contribute on the branch, never force-push, and never post reviews', () => {
    const tools = (args: string[], flag: string) => args[args.indexOf(flag) + 1]!.split(',');
    const reading = claudeArgs({ ...base, isNew: false });
    expect(tools(reading, '--allowedTools')).not.toContain('Edit');
    expect(tools(reading, '--allowedTools')).not.toContain('Bash(git commit:*)');
    expect(tools(reading, '--disallowedTools')).toEqual(expect.arrayContaining(['Edit', 'Write', 'Bash(gh api:*)']));
    const editing = claudeArgs({ ...base, isNew: false, editing: true });
    expect(tools(editing, '--allowedTools')).toEqual(expect.arrayContaining(['Edit', 'Write', 'Read', 'Bash(git commit:*)', 'Bash(git push:*)']));
    expect(tools(editing, '--disallowedTools')).toEqual(expect.arrayContaining(['Bash(git push --force:*)', 'Bash(git push -f:*)']));
    expect(tools(editing, '--disallowedTools')).not.toContain('Edit');
    expect(tools(editing, '--disallowedTools')).toEqual(expect.arrayContaining(['Bash(gh api:*)', 'Bash(gh pr review:*)', 'AskUserQuestion']));
  });

  it('starts a new session named after the PR, or resumes one, taking prompts as stream-json on stdin', () => {
    const fresh = claudeArgs({ ...base, isNew: true });
    expect(fresh.slice(0, 6)).toEqual(['-p', '--input-format', 'stream-json', '--output-format', 'stream-json', '--verbose']);
    expect(fresh).toEqual(expect.arrayContaining(['--session-id', 's1', '--name', 'PR #7 · Title', '--permission-mode', 'dontAsk']));
    expect(fresh).not.toContain('--model');
    expect(fresh).not.toContain('--effort');
    const resumed = claudeArgs({ ...base, isNew: false, model: 'opus', effort: 'high' });
    expect(resumed).toEqual(expect.arrayContaining(['--resume', 's1', '--model', 'opus', '--effort', 'high']));
    expect(resumed).not.toContain('--name');
    expect(resumed[resumed.indexOf('--disallowedTools') + 1]).toBe(CLAUDE_DENIED.join(','));
  });

  it('gives the rules once, as an addition to Claude Code’s system prompt, not in each prompt', () => {
    const args = claudeArgs({ ...base, isNew: true });
    expect(args[args.indexOf('--append-system-prompt') + 1]).toBe('Work with PR Review.');
  });

  it('sends a prompt as one stream-json user message', () => {
    expect(JSON.parse(promptLine('s1', 'Hi\nthere'))).toEqual({ type: 'user', message: { role: 'user', content: [{ type: 'text', text: 'Hi\nthere' }] }, parent_tool_use_id: null, session_id: 's1' });
  });
});

describe('startClaude', () => {
  const start = (events: string[]) =>
    startClaude({ ...base, isNew: false, cwd: dir, env: {}, onTurn: () => events.push('turn'), onResult: (error) => events.push(error ? `error: ${error}` : 'answered'), onBackground: (tasks) => events.push(`background: ${tasks.map((t) => `${t.kind} ${t.description}`).join(', ')}`) } satisfies ClaudeProcessOptions);

  it('takes prompts one after another in one process, and exits when there are no more', async () => {
    const events: string[] = [];
    const claude = start(events);
    claude.send('one');
    claude.send('refuse this');
    claude.send('two');
    await new Promise((r) => setTimeout(r, 400));
    claude.close();
    expect(await claude.ended).toBeNull();
    expect(events).toEqual(['turn', 'answered', 'turn', 'error: refused', 'turn', 'answered']);
  });

  it('says what runs in the background, without watchers, and counts Claude’s answer once it finishes as a turn', async () => {
    const events: string[] = [];
    const claude = start(events);
    claude.send('look in the background');
    await new Promise((r) => setTimeout(r, 600));
    claude.close();
    expect(await claude.ended).toBeNull();
    expect(events).toEqual(['turn', 'background: agent Find the callers', 'answered', 'turn', 'background: ', 'answered']);
  });

  it('ends with what Claude Code said when it fails', async () => {
    const claude = start([]);
    claude.send('crash');
    expect(await claude.ended).toBe('No conversation found with session ID: s1');
  });
});
