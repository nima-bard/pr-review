import { execFileSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';

export interface TempRepo {
  dir: string;
  git(...args: string[]): string;
  write(path: string, content: string): void;
  commit(message: string, files?: Record<string, string | null>): string;
  cleanup(): void;
}

export function tempRepo(prefix = 'prr-test-'): TempRepo {
  const dir = mkdtempSync(join(tmpdir(), prefix));
  const run = (...args: string[]) =>
    execFileSync('git', args, {
      cwd: dir,
      encoding: 'utf8',
      env: {
        ...process.env,
        GIT_AUTHOR_NAME: 't',
        GIT_AUTHOR_EMAIL: 't@example.com',
        GIT_COMMITTER_NAME: 't',
        GIT_COMMITTER_EMAIL: 't@example.com',
      },
    });
  run('init', '-q', '-b', 'main');
  run('config', 'commit.gpgsign', 'false');
  const write = (path: string, content: string) => {
    const full = join(dir, path);
    mkdirSync(dirname(full), { recursive: true });
    writeFileSync(full, content);
  };
  return {
    dir,
    git: run,
    write,
    commit(message, files = {}) {
      for (const [path, content] of Object.entries(files)) {
        if (content === null) run('rm', '-q', path);
        else write(path, content);
      }
      run('add', '-A');
      run('commit', '-q', '--allow-empty', '-m', message);
      return run('rev-parse', 'HEAD').trim();
    },
    cleanup() {
      rmSync(dir, { recursive: true, force: true });
    },
  };
}

export const lines = (...ls: string[]) => `${ls.join('\n')}\n`;
