import { safeStorage } from 'electron';
import { randomBytes } from 'node:crypto';
import { readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';

/**
 * The bearer token MCP clients send to the PR Review MCP server, encrypted with the macOS Keychain-backed safeStorage
 * key like the device-flow token. Made on first use; a reset makes a new one (registered clients must connect again).
 */
export class McpTokenStore {
  private token: Promise<string> | null = null;

  constructor(private readonly dir: string) {}

  private get file(): string {
    return join(this.dir, 'mcp-token.bin');
  }

  /** PR_REVIEW_MCP_TOKEN replaces the stored token (automated runs, which must not touch the Keychain). */
  get(): Promise<string> {
    if (process.env.PR_REVIEW_MCP_TOKEN) return Promise.resolve(process.env.PR_REVIEW_MCP_TOKEN);
    this.token ??= this.load().catch((err: unknown) => {
      this.token = null;
      throw err;
    });
    return this.token;
  }

  async reset(): Promise<string> {
    const token = randomBytes(32).toString('base64url');
    await writeFile(this.file, await safeStorage.encryptStringAsync(token), { mode: 0o600 });
    this.token = Promise.resolve(token);
    return token;
  }

  private async load(): Promise<string> {
    try {
      const res = await safeStorage.decryptStringAsync(await readFile(this.file));
      if (res.result) return res.result;
    } catch {
      // No token yet, or it can't be read any more: make a new one.
    }
    return this.reset();
  }
}
