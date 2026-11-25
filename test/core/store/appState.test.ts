import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import { AppState } from '../../../src/core/store/appState';

const dir = mkdtempSync(join(tmpdir(), 'prr-appstate-'));
afterAll(() => rmSync(dir, { recursive: true, force: true }));

describe('AppState', () => {
  it('drops saved agents of a kind the app no longer has, like the old Claude Desktop hand-off', async () => {
    const claude = { id: 'a', name: 'Claude', kind: 'claude-code', command: '', model: '' };
    const handOff = { id: 'b', name: 'Claude Desktop', kind: 'claude-desktop', command: '', model: '' };
    writeFileSync(join(dir, 'state.json'), JSON.stringify({ settings: { agents: [claude, handOff] } }));
    expect((await new AppState(dir).settings()).agents).toEqual([claude]);
  });
});
