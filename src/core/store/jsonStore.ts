import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import { dirname } from 'node:path';

export async function readJson<T>(file: string, fallback: T): Promise<T> {
  try {
    return JSON.parse(await readFile(file, 'utf8')) as T;
  } catch {
    return fallback;
  }
}

const chains = new Map<string, Promise<void>>();

/** Atomic write (tmp + rename), serialized per file so concurrent saves never interleave. */
export function writeJson(file: string, value: unknown): Promise<void> {
  const prev = chains.get(file) ?? Promise.resolve();
  const next = prev
    .catch(() => undefined)
    .then(async () => {
      await mkdir(dirname(file), { recursive: true });
      const tmp = `${file}.${process.pid}.${Date.now()}.tmp`;
      await writeFile(tmp, JSON.stringify(value, null, 2));
      await rename(tmp, file);
    });
  chains.set(file, next);
  return next;
}
