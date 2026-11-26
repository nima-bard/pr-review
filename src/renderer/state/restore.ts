import { prKey } from '../../shared/model';
import { parsePrInput } from '../../shared/prInput';

/**
 * The saved pull request tabs to restore: each pull request once, and none that's already open. Startup can run more
 * than once (React's StrictMode runs effects twice under `npm run dev`), and a second run must not add them again.
 */
export function tabsToRestore(inputs: readonly string[], openKeys: ReadonlySet<string>): { key: string; input: string }[] {
  const out: { key: string; input: string }[] = [];
  for (const input of inputs) {
    const ref = parsePrInput(input);
    if (!ref) continue;
    const key = prKey(ref);
    if (openKeys.has(key) || out.some((t) => t.key === key)) continue;
    out.push({ key, input });
  }
  return out;
}
