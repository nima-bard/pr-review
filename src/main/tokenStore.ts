import { safeStorage } from 'electron';
import { readFile, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';

/** Device-flow tokens, encrypted with the macOS Keychain-backed safeStorage key. */
export class TokenStore {
  constructor(private readonly dir: string) {}

  private file(host: string): string {
    return join(this.dir, `token-${host.replace(/[^a-z0-9.-]/gi, '_')}.bin`);
  }

  async get(host: string): Promise<string | null> {
    try {
      if (!(await safeStorage.isAsyncEncryptionAvailable())) return null;
      const res = await safeStorage.decryptStringAsync(await readFile(this.file(host)));
      if (res.shouldReEncrypt) await this.set(host, res.result);
      return res.result || null;
    } catch {
      return null;
    }
  }

  async set(host: string, token: string): Promise<void> {
    await writeFile(this.file(host), await safeStorage.encryptStringAsync(token));
  }

  async clear(host: string): Promise<void> {
    await rm(this.file(host), { force: true });
  }
}
