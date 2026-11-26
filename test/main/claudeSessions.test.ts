import { execFileSync, spawn, spawnSync, type ChildProcess } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import { claimSession, openElsewhere, openSession, sameProcess, takeFromTerminal } from '../../src/main/agents/claudeSessions';

const dir = mkdtempSync(join(tmpdir(), 'prr-claude-sessions-'));
const children: ChildProcess[] = [];
afterAll(() => {
  for (const c of children) c.kill('SIGKILL');
  rmSync(dir, { recursive: true, force: true });
});

/** A process id that has ended. */
const ended = spawnSync('true').pid;
const entry = (pid: number, fields: Record<string, unknown>) => writeFileSync(join(dir, `${pid}.json`), JSON.stringify({ pid, ...fields }));

describe('openSession', () => {
  it('finds the live process that has a session open, and whether Claude Desktop runs it', async () => {
    entry(process.pid, { sessionId: 'desktop-one', entrypoint: 'claude-desktop', hostSessionId: 'local_desktop-one' });
    expect(await openSession('desktop-one', dir)).toMatchObject({ pid: process.pid, entrypoint: 'claude-desktop', inDesktop: true, desktopId: 'local_desktop-one' });
    entry(process.pid, { sessionId: 'in-terminal', entrypoint: 'cli' });
    expect(await openSession('in-terminal', dir)).toEqual({ pid: process.pid, entrypoint: 'cli', inDesktop: false, desktopId: null, status: '', startedAt: null, procStart: null });
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

describe('handing a session back from Claude Desktop', () => {
  /** A stand-in for Claude Code: `sleep`, run through a link named `claude`, so `ps` shows it as claude. */
  const fake = join(dir, 'bin', 'claude');
  mkdirSync(join(dir, 'bin'), { recursive: true });
  symlinkSync('/bin/sleep', fake);
  /** Runs a stand-in and registers it as having `sessionId` open, as Claude Code would. */
  async function holder(sessionId: string, fields: Record<string, unknown>) {
    const child = spawn(fake, ['30']);
    children.push(child);
    await new Promise((r) => setTimeout(r, 200));
    const procStart = execFileSync('ps', ['-p', String(child.pid), '-o', 'lstart='], { env: { ...process.env, TZ: 'UTC' }, encoding: 'utf8' }).trim();
    entry(child.pid!, { sessionId, procStart, ...fields });
    return { child, procStart, running: () => child.exitCode === null && child.signalCode === null };
  }

  it('tells the registered Claude process from another one with the same pid', async () => {
    const { child, procStart } = await holder('who', { entrypoint: 'claude-desktop', status: 'idle' });
    expect(await sameProcess(child.pid!, procStart)).toBe(true);
    expect(await sameProcess(child.pid!, 'Mon Jan  1 00:00:00 2001')).toBe(false);
    expect(await sameProcess(process.pid, procStart)).toBe(false);
  });

  it("closes Claude Desktop's idle copy, so the app can write to the session", async () => {
    const { child, running } = await holder('idle-in-desktop', { entrypoint: 'claude-desktop', status: 'idle' });
    expect(await claimSession('idle-in-desktop', { dir })).toBeNull();
    if (running()) await new Promise((r) => child.once('exit', r));
    expect(child.signalCode).toBe('SIGTERM');
  });

  it('leaves Desktop answering, a terminal and an unconfirmed process alone, and says where the session stays open', async () => {
    const busy = await holder('busy-in-desktop', { entrypoint: 'claude-desktop', status: 'busy' });
    expect(await claimSession('busy-in-desktop', { dir })).toBe('desktop');
    const terminal = await holder('in-terminal-2', { entrypoint: 'cli', status: 'idle' });
    expect(await claimSession('in-terminal-2', { dir })).toBe('terminal');
    const other = await holder('recycled', { entrypoint: 'claude-desktop', status: 'idle' });
    entry(other.child.pid!, { sessionId: 'recycled', entrypoint: 'claude-desktop', status: 'idle', procStart: 'Mon Jan  1 00:00:00 2001' });
    expect(await claimSession('recycled', { dir })).toBe('desktop');
    expect([busy.running(), terminal.running(), other.running()]).toEqual([true, true, true]);
  });

  it('says where else a session is open and whether Claude is answering there', async () => {
    await holder('answering-in-desktop', { entrypoint: 'claude-desktop', status: 'busy' });
    expect(await openElsewhere('answering-in-desktop', dir)).toEqual({ app: 'desktop', busy: true });
    await holder('idle-in-terminal', { entrypoint: 'cli', status: 'idle' });
    expect(await openElsewhere('idle-in-terminal', dir)).toEqual({ app: 'terminal', busy: false });
  });

  it('takes a session from an idle Claude Code in a terminal when asked, never while it answers', async () => {
    const answering = await holder('busy-in-terminal', { entrypoint: 'cli', status: 'busy' });
    expect(await takeFromTerminal('busy-in-terminal', { dir })).toBe(false);
    expect(answering.running()).toBe(true);
    const idle = await holder('idle-in-terminal-2', { entrypoint: 'cli', status: 'idle' });
    expect(await takeFromTerminal('idle-in-terminal-2', { dir })).toBe(true);
    if (idle.running()) await new Promise((r) => idle.child.once('exit', r));
    expect(idle.child.signalCode).toBe('SIGTERM');
    expect(await takeFromTerminal('nowhere', { dir })).toBe(true);
  });

  it("finds Claude Desktop or a terminal holding a session even while the app's own claude -p has it too", async () => {
    await holder('shared', { entrypoint: 'sdk-cli', status: 'idle' });
    await holder('shared', { entrypoint: 'claude-desktop', status: 'busy' });
    expect(await openElsewhere('shared', dir)).toEqual({ app: 'desktop', busy: true });
  });

  it("doesn't count the app's own claude -p runs, or a session open nowhere", async () => {
    const own = await holder('own-run', { entrypoint: 'sdk-cli', status: 'busy' });
    expect(await claimSession('own-run', { dir })).toBeNull();
    expect(own.running()).toBe(true);
    expect(await claimSession('nowhere', { dir })).toBeNull();
  });
});
