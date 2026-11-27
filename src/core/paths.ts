import { homedir } from 'node:os';
import { join } from 'node:path';

/** A folder typed in Settings as "~/source" (or "~"), as the path it means; any other path as it is. */
export function expandHome(path: string): string {
  if (path === '~') return homedir();
  return path.startsWith('~/') ? join(homedir(), path.slice(2)) : path;
}
