import { mkdtempSync, readFileSync, rmSync, statSync, writeFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const decrypt = vi.fn(async (data: Buffer) => ({ result: data.toString().replace(/^enc:/, ''), shouldReEncrypt: false }));
vi.mock('electron', () => ({ safeStorage: { decryptStringAsync: (data: Buffer) => decrypt(data), encryptStringAsync: vi.fn() } }));
const { McpTokenStore } = await import('../../src/main/mcpToken');

describe('McpTokenStore', () => {
  let dir: string;
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'prr-mcp-token-'));
    decrypt.mockClear();
    delete process.env.PR_REVIEW_MCP_TOKEN;
  });
  afterEach(() => rmSync(dir, { recursive: true, force: true }));

  it('makes a token in a file only you can read, without asking the Keychain', async () => {
    const token = await new McpTokenStore(dir).get();
    expect(token).toMatch(/^[\w-]{40,}$/);
    expect(readFileSync(join(dir, 'mcp-token'), 'utf8')).toBe(token);
    expect(statSync(join(dir, 'mcp-token')).mode & 0o777).toBe(0o600);
    expect(decrypt).not.toHaveBeenCalled();
  });

  it('keeps the same token from one start to the next', async () => {
    const first = await new McpTokenStore(dir).get();
    expect(await new McpTokenStore(dir).get()).toBe(first);
    expect(decrypt).not.toHaveBeenCalled();
  });

  it('moves an earlier encrypted token over once, so registered clients keep working', async () => {
    writeFileSync(join(dir, 'mcp-token.bin'), 'enc:old-token');
    expect(await new McpTokenStore(dir).get()).toBe('old-token');
    expect(decrypt).toHaveBeenCalledTimes(1);
    expect(existsSync(join(dir, 'mcp-token.bin'))).toBe(false);
    expect(await new McpTokenStore(dir).get()).toBe('old-token');
    expect(decrypt).toHaveBeenCalledTimes(1);
  });

  it('makes a new token when the encrypted one can’t be read (the Keychain said no)', async () => {
    writeFileSync(join(dir, 'mcp-token.bin'), 'enc:old-token');
    decrypt.mockRejectedValueOnce(new Error('denied'));
    const token = await new McpTokenStore(dir).get();
    expect(token).not.toBe('old-token');
    expect(existsSync(join(dir, 'mcp-token.bin'))).toBe(false);
  });

  it('a reset gives a new token', async () => {
    const store = new McpTokenStore(dir);
    const first = await store.get();
    expect(await store.reset()).not.toBe(first);
    expect(await store.get()).not.toBe(first);
  });
});
