import { describe, expect, it } from 'vitest';
import type { OpenSession } from '../../src/main/agents/claudeSessions';
import { desktopSessionLink, openStep, TERMINAL_COMMAND, terminalText } from '../../src/main/agents/openClaude';

const holder = (entrypoint: string, status = 'idle'): OpenSession => ({ pid: 1, entrypoint, inDesktop: entrypoint === 'claude-desktop', desktopId: entrypoint === 'claude-desktop' ? 'local_x' : null, status, startedAt: 0, procStart: 'x' });

describe('openStep', () => {
  it("opens a session that's open nowhere, or only in the app's own claude -p", () => {
    for (const app of ['desktop', 'terminal'] as const) {
      expect(openStep(app, null)).toEqual({ do: 'launch', closeDesktopFirst: false });
      expect(openStep(app, holder('sdk-cli', 'busy'))).toEqual({ do: 'launch', closeDesktopFirst: false });
    }
  });

  it('switches Claude Desktop to a session it has; Claude Code gets it once Desktop’s copy is idle', () => {
    expect(openStep('desktop', holder('claude-desktop', 'busy'))).toEqual({ do: 'show' });
    expect(openStep('terminal', holder('claude-desktop', 'idle'))).toEqual({ do: 'launch', closeDesktopFirst: true });
    expect(openStep('terminal', holder('claude-desktop', 'busy'))).toMatchObject({ do: 'refuse', reason: expect.stringContaining('answering in Claude Desktop') });
  });

  it('leaves a session open in a terminal there', () => {
    expect(openStep('terminal', holder('cli'))).toMatchObject({ do: 'refuse', reason: expect.stringContaining('already open in Claude Code') });
    expect(openStep('desktop', holder('cli'))).toMatchObject({ do: 'refuse', reason: expect.stringContaining('Run /desktop there') });
  });
});

describe('opening', () => {
  it('starts Claude Code with the session id in a variable, never in the command text', () => {
    expect(TERMINAL_COMMAND).toBe('"$PR_CLAUDE_BIN" --resume "$PR_CLAUDE_SESSION"');
  });

  it("switches Claude Desktop to its session with Desktop's code/continue link", () => {
    expect(desktopSessionLink('local_f52ec0a6-fca2')).toBe('claude://code/continue?session=local_f52ec0a6-fca2');
  });

  it('reads what `script` captured from claude --desktop as plain text', () => {
    expect(terminalText('\u001b[31mNo session found with ID x\u001b[0m^D\b\b\r\n')).toBe('No session found with ID x');
  });
});
