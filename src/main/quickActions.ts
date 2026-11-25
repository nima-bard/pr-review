import { execFile, spawn, type ChildProcess } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { chmod, mkdir, stat, writeFile } from 'node:fs/promises';
import { homedir, tmpdir } from 'node:os';
import { join } from 'node:path';
import type { ActionRun } from '../shared/model';
import { shellQuote, TERMINALS } from '../shared/quickActions';

const SHELL = process.env.SHELL || '/bin/zsh';
const OUTPUT_LIMIT = 200_000;

async function exists(path: string): Promise<boolean> {
  return stat(path).then(
    () => true,
    () => false,
  );
}

async function appPath(app: string): Promise<string | null> {
  const candidates = app === 'Terminal' ? ['/System/Applications/Utilities/Terminal.app'] : [join('/Applications', `${app}.app`), join(homedir(), 'Applications', `${app}.app`)];
  for (const c of candidates) if (await exists(c)) return c;
  return null;
}

/** The terminal apps installed, in TERMINALS' order (Terminal always is). */
export async function installedTerminals(): Promise<{ id: string; name: string }[]> {
  const found = await Promise.all(TERMINALS.map(async (t) => ((await appPath(t.app)) ? { id: t.id, name: t.name } : null)));
  return found.filter((t): t is { id: string; name: string } => t !== null);
}

/** The terminal to use: the chosen one if it's installed, else the first installed. */
async function pickTerminal(chosen: string): Promise<{ id: string; app: string; path: string }> {
  const order = [...TERMINALS.filter((t) => t.id === chosen), ...TERMINALS.filter((t) => t.id !== chosen)];
  for (const t of order) {
    const path = await appPath(t.app);
    if (path) return { id: t.id, app: t.app, path };
  }
  return { id: 'terminal', app: 'Terminal', path: '/System/Applications/Utilities/Terminal.app' };
}

function run(cmd: string, args: string[]): Promise<void> {
  return new Promise((resolve, reject) => execFile(cmd, args, (err, _out, stderr) => (err ? reject(new Error(stderr.trim() || err.message)) : resolve())));
}

/** "…" for AppleScript. */
const appleString = (s: string) => `"${s.replace(/\\/g, '\\\\').replace(/"/g, '\\"')}"`;

/**
 * A script that sets the variables, goes to `cwd`, shows and runs the command in the login shell, then stays in an
 * interactive shell there. It deletes itself when it starts. Every value is single-quoted, so nothing in it (a PR
 * title, a branch name) can run as a command.
 */
export function terminalScript(cwd: string, env: Record<string, string>, command: string, name: string): string {
  const lines = [
    '#!/bin/sh',
    'rm -f "$0"',
    `cd ${shellQuote(cwd)} || exit 1`,
    ...Object.entries(env).map(([k, v]) => `export ${k}=${shellQuote(v)}`),
    `export PR_ACTION_COMMAND=${shellQuote(command)}`,
    `printf '\\033[2m▸ PR Review: %s\\033[0m\\n' ${shellQuote(name)}`,
    'if [ -n "$PR_ACTION_COMMAND" ]; then',
    `  printf '\\033[2m  %s\\033[0m\\n\\n' "$PR_ACTION_COMMAND"`,
    `  ${shellQuote(SHELL)} -ilc "$PR_ACTION_COMMAND"`,
    'fi',
    `exec ${shellQuote(SHELL)} -il`,
  ];
  return `${lines.join('\n')}\n`;
}

/** Opens a new terminal window or tab (in `terminal`, or the first one installed) that runs `command` in `cwd`. */
export async function openInTerminal(terminal: string, cwd: string, env: Record<string, string>, command: string, name: string): Promise<void> {
  const dir = join(tmpdir(), 'pr-review-actions');
  await mkdir(dir, { recursive: true });
  const script = join(dir, `${randomUUID()}.command`);
  await writeFile(script, terminalScript(cwd, env, command, name));
  await chmod(script, 0o700);
  const t = await pickTerminal(terminal);
  switch (t.id) {
    case 'iterm':
      // A tab in the front window, or a window when there's none.
      await run('osascript', [
        '-e',
        `tell application "iTerm"
  activate
  if (count of windows) = 0 then
    create window with default profile command ${appleString(script)}
  else
    tell current window to create tab with default profile command ${appleString(script)}
  end if
end tell`,
      ]);
      return;
    case 'ghostty':
      await run('open', ['-na', t.path, '--args', '-e', script]);
      return;
    case 'wezterm':
      await run(join(t.path, 'Contents/MacOS/wezterm'), ['start', '--cwd', cwd, '--', script]);
      return;
    case 'kitty':
      await run('open', ['-na', t.path, '--args', '--directory', cwd, script]);
      return;
    case 'alacritty':
      await run('open', ['-na', t.path, '--args', '--working-directory', cwd, '-e', script]);
      return;
    default:
      await run('open', ['-a', t.path, script]);
  }
}

/**
 * Background quick actions: each runs in the login shell in its own process group (so stopping it stops what it
 * started too), with its output kept and reported as it comes, a few times a second.
 */
export class ActionRunner {
  private readonly runs = new Map<string, { key: string; run: ActionRun; child: ChildProcess | null; stopped: boolean }>();

  constructor(
    private readonly emit: (key: string, run: ActionRun) => void,
    private readonly finished: (key: string, run: ActionRun) => void,
  ) {}

  start(key: string, action: { id: string; name: string; command: string }, cwd: string, env: Record<string, string>, file: string | null): ActionRun {
    const run: ActionRun = { id: randomUUID(), actionId: action.id, name: action.name, command: action.command, file, startedAt: new Date().toISOString(), endedAt: null, status: 'running', exitCode: null, output: '' };
    const entry = { key, run, child: null as ChildProcess | null, stopped: false };
    this.runs.set(run.id, entry);
    let timer: NodeJS.Timeout | null = null;
    const report = () => {
      timer = null;
      this.emit(key, { ...run });
    };
    const append = (chunk: Buffer) => {
      run.output = (run.output + chunk.toString('utf8')).slice(-OUTPUT_LIMIT);
      timer ??= setTimeout(report, 250);
    };
    const end = (status: ActionRun['status'], exitCode: number | null, note = '') => {
      if (run.endedAt) return;
      if (timer) clearTimeout(timer);
      if (note) run.output = (run.output + note).slice(-OUTPUT_LIMIT);
      Object.assign(run, { status, exitCode, endedAt: new Date().toISOString() });
      entry.child = null;
      this.emit(key, { ...run });
      this.finished(key, { ...run });
    };
    try {
      const child = spawn(SHELL, ['-lc', action.command], { cwd, env: { ...process.env, ...env }, detached: true, stdio: ['ignore', 'pipe', 'pipe'] });
      entry.child = child;
      child.stdout.on('data', append);
      child.stderr.on('data', append);
      child.on('error', (err) => end('failed', null, `\n${err.message}\n`));
      child.on('close', (code) => end(entry.stopped ? 'stopped' : code === 0 ? 'succeeded' : 'failed', code));
    } catch (err) {
      end('failed', null, err instanceof Error ? err.message : String(err));
    }
    this.emit(key, { ...run });
    return { ...run };
  }

  stop(id: string): void {
    const entry = this.runs.get(id);
    const pid = entry?.child?.pid;
    if (!entry || !pid) return;
    entry.stopped = true;
    try {
      process.kill(-pid, 'SIGTERM');
    } catch {
      entry.child?.kill('SIGTERM');
    }
  }

  /** The runs for a pull request, newest first. */
  list(key: string): ActionRun[] {
    return [...this.runs.values()]
      .filter((e) => e.key === key)
      .map((e) => ({ ...e.run }))
      .reverse();
  }

  /** Forgets a finished run. */
  dismiss(id: string): void {
    if (this.runs.get(id)?.run.endedAt) this.runs.delete(id);
  }

  /** Stops everything still running (the app is quitting). */
  stopAll(): void {
    for (const id of this.runs.keys()) this.stop(id);
  }
}
