import { execFile } from 'node:child_process';

export class GitError extends Error {
  constructor(
    message: string,
    readonly args: readonly string[],
    readonly stderr: string,
    readonly exitCode: number | null,
  ) {
    super(message);
    this.name = 'GitError';
  }
}

export const FIXED_CONFIG = ['-c', 'core.quotepath=off', '-c', 'color.ui=false', '-c', 'diff.external=', '-c', 'diff.noprefix=false'];
export const ENV = { GIT_TERMINAL_PROMPT: '0', GIT_OPTIONAL_LOCKS: '0', LC_ALL: 'C' };

export function git(cwd: string, args: readonly string[], maxBuffer = 256 * 1024 * 1024): Promise<string> {
  return new Promise((resolve, reject) => {
    execFile(
      'git',
      [...FIXED_CONFIG, ...args],
      { cwd, env: { ...process.env, ...ENV }, maxBuffer, encoding: 'utf8' },
      (err, stdout, stderr) => {
        if (err) {
          const firstLine = stderr.split('\n').find((l) => l.trim() !== '') ?? err.message;
          reject(new GitError(firstLine, args, stderr, typeof err.code === 'number' ? err.code : null));
          return;
        }
        resolve(stdout);
      },
    );
  });
}

export async function gitOk(cwd: string, args: readonly string[]): Promise<boolean> {
  try {
    await git(cwd, args);
    return true;
  } catch {
    return false;
  }
}

export function gh(cwd: string, args: readonly string[]): Promise<string> {
  return new Promise((resolve, reject) => {
    execFile('gh', [...args], { cwd, env: { ...process.env, GH_PROMPT_DISABLED: '1', NO_COLOR: '1' }, maxBuffer: 64 * 1024 * 1024 }, (err, stdout, stderr) => {
      if (err) {
        reject(new Error(stderr.split('\n').find((l) => l.trim() !== '') ?? err.message));
        return;
      }
      resolve(stdout);
    });
  });
}
