import { safeStorage } from 'electron';
import { randomBytes } from 'node:crypto';
import { readFile, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';

/**
 * The bearer token MCP clients send to the PR Review MCP server, in a file only you can read (0600) in the app's data
 * folder. Not encrypted with the Keychain-backed safeStorage key: the server only listens on 127.0.0.1, and
 * `claude mcp add` keeps the same token in plain text in ~/.claude.json anyway, while reading a Keychain-encrypted copy
 * at every start made macOS ask for the login password after each update (the app is signed ad hoc, so to the Keychain
 * each build is a new app). Made on first use; a reset makes a new one (registered clients must connect again).
 */
export class McpTokenStore {
  private token: Promise<string> | null = null;

  constructor(private readonly dir: string) {}

  private get file(): string {
    return join(this.dir, 'mcp-token');
  }

  /** Where earlier builds kept it, encrypted with safeStorage: read once (the Keychain may ask one last time) and moved. */
  private get encryptedFile(): string {
    return join(this.dir, 'mcp-token.bin');
  }

  /** PR_REVIEW_MCP_TOKEN replaces the stored token (automated runs). */
  get(): Promise<string> {
    if (process.env.PR_REVIEW_MCP_TOKEN) return Promise.resolve(process.env.PR_REVIEW_MCP_TOKEN);
    this.token ??= this.load().catch((err: unknown) => {
      this.token = null;
      throw err;
    });
    return this.token;
  }

  async reset(): Promise<string> {
    return this.save(randomBytes(32).toString('base64url'));
  }

  private async save(token: string): Promise<string> {
    await writeFile(this.file, token, { mode: 0o600 });
    await rm(this.encryptedFile, { force: true });
    this.token = Promise.resolve(token);
    return token;
  }

  private async load(): Promise<string> {
    const saved = (await readFile(this.file, 'utf8').catch(() => '')).trim();
    if (saved) return saved;
    // Only an install that had the encrypted file asks the Keychain (once); a new one never does.
    const encrypted = await readFile(this.encryptedFile).catch(() => null);
    if (encrypted) {
      const moved = await safeStorage.decryptStringAsync(encrypted).then((r) => r.result, () => '');
      if (moved) return this.save(moved);
    }
    return this.reset();
  }
}
