import { execFile } from 'node:child_process';
import { realpath, stat } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join } from 'node:path';
import type { SetupInfo } from '../shared/model';
import { scanRoots } from '../core/repos/registry';

/** First line of `cmd args` (a version), or null when it isn't installed. */
function firstLine(cmd: string, args: string[]): Promise<string | null> {
  return new Promise((resolve) => execFile(cmd, args, { timeout: 5000 }, (err, out) => resolve(err ? null : (out.trim().split('\n')[0] ?? null))));
}

const exists = (path: string) => stat(path).then(() => true, () => false);

/** VS Code-style editors (they take `-g file:line`): their shell command, or the one inside the app when it isn't on the PATH. */
const EDITORS = [
  { label: 'Visual Studio Code', command: 'code', app: 'Visual Studio Code.app/Contents/Resources/app/bin/code' },
  { label: 'Cursor', command: 'cursor', app: 'Cursor.app/Contents/Resources/app/bin/cursor' },
  { label: 'Windsurf', command: 'windsurf', app: 'Windsurf.app/Contents/Resources/app/bin/windsurf' },
  { label: 'VS Code Insiders', command: 'code-insiders', app: 'Visual Studio Code - Insiders.app/Contents/Resources/app/bin/code-insiders' },
  { label: 'VSCodium', command: 'codium', app: 'VSCodium.app/Contents/Resources/app/bin/codium' },
];

/** Folders people usually keep their clones in. */
const CODE_FOLDERS = ['source', 'src', 'code', 'Developer', 'dev', 'projects', 'repos', 'git', 'github', 'workspace', 'work'];

/** What the first-run setup suggests: installed tools, editors, and folders that hold git clones. */
export async function setupInfo(): Promise<SetupInfo> {
  const home = homedir();
  const [git, gh] = await Promise.all([firstLine('git', ['--version']), firstLine('gh', ['--version'])]);
  const editors: SetupInfo['editors'] = [];
  for (const e of EDITORS) {
    if (await firstLine('which', [e.command])) editors.push({ label: e.label, command: e.command });
    else {
      const bundled = [join('/Applications', e.app), join(home, 'Applications', e.app)];
      for (const path of bundled) {
        if (await exists(path)) {
          editors.push({ label: e.label, command: path });
          break;
        }
      }
    }
  }
  const folders: SetupInfo['folders'] = [];
  const seen = new Set<string>();
  for (const name of CODE_FOLDERS) {
    // macOS folders are case-insensitive: "code" and "Code" are the same folder.
    const dir = await realpath(join(home, name)).catch(() => null);
    if (!dir || seen.has(dir) || !(await stat(dir).then((s) => s.isDirectory(), () => false))) continue;
    seen.add(dir);
    const repos = new Set((await scanRoots([dir])).map((r) => r.path)).size;
    if (repos > 0) folders.push({ path: dir, repos });
  }
  return { home, git, gh, editors, folders };
}
