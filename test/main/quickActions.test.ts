import { execFileSync } from 'node:child_process';
import { existsSync, mkdtempSync, realpathSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

describe('terminalScript', () => {
  const shell = process.env.SHELL;
  // The script runs the command in $SHELL, then stays in an interactive $SHELL: sh, with no input, ends there.
  beforeAll(() => {
    process.env.SHELL = '/bin/sh';
  });
  afterAll(() => {
    process.env.SHELL = shell;
  });

  it('runs the command in the worktree with the variables as plain text, and deletes itself', async () => {
    const { terminalScript } = await import('../../src/main/quickActions');
    const dir = realpathSync(mkdtempSync(join(tmpdir(), 'qa-')));
    const title = `"; touch pwned; echo '$(id)`;
    const script = join(dir, 'run.command');
    writeFileSync(script, terminalScript(dir, { PR_TITLE: title, PR_NUMBER: '7' }, 'printf "[%s|%s|%s]" "$PR_TITLE" "$PWD" "$PR_NUMBER"', 'Test'), { mode: 0o700 });
    const out = execFileSync('/bin/sh', [script], { input: '', encoding: 'utf8', env: { ...process.env, SHELL: '/bin/sh' } });
    expect(out).toContain(`[${title}|${dir}|7]`);
    expect(existsSync(join(dir, 'pwned'))).toBe(false);
    expect(existsSync(script)).toBe(false);
  });
});
