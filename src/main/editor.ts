import { execFile } from 'node:child_process';
import { join } from 'node:path';

/** Opens file:line in VS Code-style editors (`code`, `cursor`, `windsurf` all accept `-g file:line`). */
export function openInEditor(command: string, root: string, path: string, line: number): Promise<void> {
  return new Promise((resolve, reject) => {
    execFile(command, ['-g', `${join(root, path)}:${Math.max(1, line)}`], { timeout: 15_000 }, (err) => {
      if (err) reject(new Error(`Could not run "${command}". Set the editor command in Settings (⌘,).`));
      else resolve();
    });
  });
}
