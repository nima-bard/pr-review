import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import { AppState } from '../../../src/core/store/appState';

const dir = mkdtempSync(join(tmpdir(), 'prr-appstate-'));
afterAll(() => rmSync(dir, { recursive: true, force: true }));

describe('AppState', () => {
  it('turns settings from when the app listed agents into Claude settings: on, with Claude’s model', async () => {
    const claude = { id: 'a', name: 'Claude', kind: 'claude-code', command: '', model: 'opus' };
    const codex = { id: 'b', name: 'Codex', kind: 'command', command: 'codex exec "$PR_PROMPT"', model: '' };
    writeFileSync(join(dir, 'state.json'), JSON.stringify({ settings: { agents: [codex, claude], agentParallel: 3 } }));
    const settings = await new AppState(dir).settings();
    expect(settings.claude).toEqual({ enabled: true, model: 'opus', effort: '' });
    expect(settings).not.toHaveProperty('agents');
    expect(settings).not.toHaveProperty('agentParallel');
  });

  it('has Claude off out of the box (it’s optional), with Claude Code’s default model', async () => {
    writeFileSync(join(dir, 'state.json'), '{}');
    expect((await new AppState(dir).settings()).claude).toEqual({ enabled: false, model: '', effort: '' });
  });

  it('keeps saved Claude settings', async () => {
    writeFileSync(join(dir, 'state.json'), JSON.stringify({ settings: { claude: { enabled: true, model: 'sonnet', effort: 'high' } } }));
    expect((await new AppState(dir).settings()).claude).toEqual({ enabled: true, model: 'sonnet', effort: 'high' });
  });
});
