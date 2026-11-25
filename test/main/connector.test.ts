import { describe, expect, it } from 'vitest';
import { runWithTerminal, terminalText } from '../../src/main/agents/connector';

describe('runWithTerminal', () => {
  it('gives the command a terminal, which claude --desktop requires', async () => {
    await expect(runWithTerminal('sh', ['-c', 'test -t 1'], undefined)).resolves.toBeUndefined();
  });

  it('rejects with what the command printed, as plain text', async () => {
    await expect(runWithTerminal('sh', ['-c', 'printf "\\033[31mNo session found\\033[0m\\n"; exit 3'], undefined)).rejects.toThrow(/^No session found$/);
  });
});

describe('terminalText', () => {
  it('drops colour and cursor codes, and the ^D and backspaces that script echoes', () => {
    expect(terminalText('^D\b\b\u001b[0m\u001b[31mNo session found.\u001b[0m\n\u001b[?25h')).toBe('No session found.');
  });
});
