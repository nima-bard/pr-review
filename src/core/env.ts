import { execFile } from 'node:child_process';
import { access } from 'node:fs/promises';
import { constants } from 'node:fs';
import { delimiter, join } from 'node:path';

const FALLBACK_DIRS = ['/opt/homebrew/bin', '/usr/local/bin', '/usr/bin', '/bin', '/usr/sbin', '/sbin'];

function loginShellPath(): Promise<string | undefined> {
  const shell = process.env.SHELL || '/bin/zsh';
  return new Promise((resolve) => {
    execFile(shell, ['-ilc', 'printf "__PATH__%s__PATH__" "$PATH"'], { timeout: 3000 }, (err, stdout) => {
      if (err) {
        resolve(undefined);
        return;
      }
      const match = /__PATH__(.*)__PATH__/s.exec(stdout);
      resolve(match?.[1]?.trim() || undefined);
    });
  });
}

export async function fixPath(): Promise<void> {
  const fromShell = await loginShellPath();
  const parts = [
    ...(fromShell ? fromShell.split(delimiter) : []),
    ...(process.env.PATH ?? '').split(delimiter),
    ...FALLBACK_DIRS,
  ].filter(Boolean);
  process.env.PATH = [...new Set(parts)].join(delimiter);
}

export async function findTool(name: string): Promise<string | null> {
  for (const dir of (process.env.PATH ?? '').split(delimiter)) {
    const candidate = join(dir, name);
    try {
      await access(candidate, constants.X_OK);
      return candidate;
    } catch {
      continue;
    }
  }
  return null;
}
