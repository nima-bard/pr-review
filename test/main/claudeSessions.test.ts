import { spawnSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import { desktopSessionLink, openSession } from '../../src/main/agents/claudeSessions';

const dir = mkdtempSync(join(tmpdir(), 'prr-claude-sessions-'));
afterAll(() => rmSync(dir, { recursive: true, force: true }));

/** A process id that has ended. */
const ended = spawnSync('true').pid;
const entry = (pid: number, fields: Record<string, unknown>) => writeFileSync(join(dir, `${pid}.json`), JSON.stringify({ pid, ...fields }));

describe('openSession', () => {
  it('finds the live process that has a session open, and whether Claude Desktop runs it', async () => {
    entry(process.pid, { sessionId: 'desktop-one', entrypoint: 'claude-desktop', hostSessionId: 'local_desktop-one' });
    expect(await openSession('desktop-one', dir)).toEqual({ pid: process.pid, inDesktop: true, desktopId: 'local_desktop-one' });
    entry(process.pid, { sessionId: 'in-terminal', entrypoint: 'cli' });
    expect(await openSession('in-terminal', dir)).toEqual({ pid: process.pid, inDesktop: false, desktopId: null });
  });

  it('skips entries left by processes that have ended, other sessions and unreadable files', async () => {
    entry(ended, { sessionId: 'gone', entrypoint: 'claude-desktop' });
    writeFileSync(join(dir, '1.json'), '{not json');
    expect(await openSession('gone', dir)).toBeNull();
    expect(await openSession('never-opened', dir)).toBeNull();
    expect(await openSession('x', join(dir, 'missing'))).toBeNull();
  });

  it("names Desktop's session after Claude Code's when the entry has no usable Desktop id", async () => {
    entry(process.pid, { sessionId: 'abc-1', entrypoint: 'claude-desktop', hostSessionId: 'local_../evil' });
    expect((await openSession('abc-1', dir))?.desktopId).toBe('local_abc-1');
  });
});

describe('desktopSessionLink', () => {
  it("switches Claude Desktop to the session with its code/continue link", () => {
    expect(desktopSessionLink('local_f52ec0a6-fca2')).toBe('claude://code/continue?session=local_f52ec0a6-fca2');
  });
});
