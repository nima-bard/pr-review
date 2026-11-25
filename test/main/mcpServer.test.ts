import { request } from 'node:http';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { startMcpServer, type ChannelBridge, type RunningMcpServer } from '../../src/main/mcpServer';

const port = 47_000 + Math.floor(Math.random() * 900);
const token = 'secret';

const replies: string[] = [];
const bridge: ChannelBridge = {
  openPrs: () => [{ key: 'github.com/o/r#1', url: 'https://github.com/o/r/pull/1', title: 'T', worktree: '/wt' }],
  snapshot: () => {
    throw new Error('not open');
  },
  fileDiff: async () => null,
  addDraft: async () => {
    throw new Error('unused');
  },
  updateDraft: async () => {
    throw new Error('unused');
  },
  deleteDraft: async () => undefined,
  agentReply: async (pr, turnId, text) => void replies.push(`${pr} ${turnId} ${text}`),
};

/** A raw POST, to check what the server refuses before MCP sees the request. */
function post(path: string, headers: Record<string, string>): Promise<number> {
  return new Promise((resolve, reject) => {
    const req = request({ host: '127.0.0.1', port, path, method: 'POST', headers: { 'content-type': 'application/json', ...headers } }, (res) => {
      res.resume();
      resolve(res.statusCode ?? 0);
    });
    req.on('error', reject);
    req.end('{}');
  });
}

let server: RunningMcpServer;
beforeAll(async () => {
  server = startMcpServer(bridge, port, token);
  await new Promise((r) => setTimeout(r, 50));
});
afterAll(() => server.close());

describe('the PR Review MCP server', () => {
  it('refuses requests without the token, from a web page (Origin), for another Host, and other paths', async () => {
    expect(await post('/mcp', {})).toBe(401);
    expect(await post('/mcp', { authorization: 'Bearer wrong' })).toBe(401);
    expect(await post('/mcp', { authorization: `Bearer ${token}`, origin: 'https://evil.example' })).toBe(401);
    expect(await post('/mcp', { authorization: `Bearer ${token}`, host: `evil.example:${port}` })).toBe(401);
    expect(await post('/other', { authorization: `Bearer ${token}` })).toBe(404);
  });

  it('answers tool calls from an MCP client holding the token', async () => {
    const client = new Client({ name: 'test', version: '1' });
    await client.connect(new StreamableHTTPClientTransport(new URL(server.url), { requestInit: { headers: { Authorization: `Bearer ${token}` } } }));
    const res = (await client.callTool({ name: 'list_open_prs', arguments: {} })) as { content: { text: string }[] };
    expect(JSON.parse(res.content[0]!.text)).toEqual([{ key: 'github.com/o/r#1', url: 'https://github.com/o/r/pull/1', title: 'T', worktree: '/wt' }]);
    await client.close();
    expect(server.error()).toBeNull();
  });
});
