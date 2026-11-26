import { timingSafeEqual } from 'node:crypto';
import { createServer, type IncomingMessage } from 'node:http';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import { registerReviewTools } from '../core/agents/mcpTools';
import type { ReviewBridge } from '../core/agents/reviewBridge';
import { version } from '../../package.json';

const LOCAL_HOSTS = new Set(['127.0.0.1', 'localhost']);

export interface RunningMcpServer {
  url: string;
  /** Why it isn't listening (the port is taken…), or null. */
  error(): string | null;
  close(): void;
}

/** Compares in constant time, so response timing doesn't reveal how much of a guessed token was right. */
function sameSecret(given: string | undefined, expected: string): boolean {
  const a = Buffer.from(given ?? '');
  const b = Buffer.from(expected);
  return a.length === b.length && timingSafeEqual(a, b);
}

/** Only this machine's clients holding the token: a browser page can't reach it (it sends an Origin, or the wrong Host). */
export function allowed(req: IncomingMessage, token: string, port: number): boolean {
  const host = req.headers.host?.replace(new RegExp(`:${port}$`), '') ?? '';
  return LOCAL_HOSTS.has(host) && req.headers.origin === undefined && sameSecret(req.headers.authorization, `Bearer ${token}`);
}

/**
 * Who a request comes from, for the drafts it adds: the app's own Claude says so in a header (`X-PR-Review-Agent`);
 * other clients are named from their user agent.
 */
function caller(req: IncomingMessage): { agent: string } {
  const named = req.headers['x-pr-review-agent'];
  return { agent: typeof named === 'string' && named !== '' ? named : /^claude-code\b/i.test(req.headers['user-agent'] ?? '') ? 'Claude Code' : 'MCP client' };
}

/** For every client: what the server is for, and how its tools fit together. */
const INSTRUCTIONS =
  'PR Review is the macOS app where the user reviews GitHub pull requests, each checked out in a worktree. These tools read the pull requests open in it and act there for the user: ' +
  'review comments go into the user’s pending review as drafts (add_draft), never straight to GitHub; set_viewed ticks files’ Viewed checkboxes; show_in_app and search_code with show bring a file, line, thread, draft or search results into view. ' +
  'Start with list_open_prs or get_pr. Show things only when the user asks to see or find them. To offer a follow-up you could do there, end your answer with offer_choices (buttons in PR Review).';

/**
 * The PR Review MCP server on 127.0.0.1:`port`, over Streamable HTTP. Stateless: each request gets its own server and
 * transport, since drafts live in the app, not in MCP sessions.
 */
export function startMcpServer(bridge: ReviewBridge, port: number, token: string): RunningMcpServer {
  let error: string | null = null;
  const server = createServer((req, res) => {
    const path = req.url?.split('?')[0];
    if (path !== '/mcp') {
      res.writeHead(404).end();
      return;
    }
    if (!allowed(req, token, port)) {
      res.writeHead(401).end();
      return;
    }
    const mcp = new McpServer({ name: 'pr-review', version }, { instructions: INSTRUCTIONS });
    const from = caller(req);
    registerReviewTools(mcp, bridge, () => from);
    const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined });
    res.on('close', () => void transport.close().catch(() => undefined));
    mcp
      .connect(transport)
      .then(() => transport.handleRequest(req, res))
      .catch(() => {
        if (!res.headersSent) res.writeHead(500).end();
      });
  });
  server.on('error', (err: NodeJS.ErrnoException) => {
    error = err.code === 'EADDRINUSE' ? `Port ${port} is in use by another program. Choose another port in Settings › Claude.` : err.message;
  });
  server.listen(port, '127.0.0.1');
  return {
    url: `http://127.0.0.1:${port}/mcp`,
    error: () => error,
    close: () => server.close(),
  };
}
