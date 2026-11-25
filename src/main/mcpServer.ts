import { randomUUID, timingSafeEqual } from 'node:crypto';
import { createServer, type IncomingMessage } from 'node:http';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import { z } from 'zod';
import { registerReviewTools } from '../core/agents/mcpTools';
import type { ReviewBridge } from '../core/agents/reviewBridge';
import { version } from '../../package.json';

const LOCAL_HOSTS = new Set(['127.0.0.1', 'localhost']);

/** What the server needs from the app besides the review tools: where a live session's replies go. */
export interface ChannelBridge extends ReviewBridge {
  /** A live terminal session answered the app's request `turnId` with the `reply` tool. */
  agentReply(pr: string, turnId: string, text: string): Promise<void>;
}

export interface RunningMcpServer {
  url: string;
  /** Why it isn't listening (the port is taken…), or null. */
  error(): string | null;
  /** Whether a live session (claude-terminal) for PR `key` is connected and can take pushes. */
  channelConnected(key: string): boolean;
  /** Pushes a request into PR `key`'s live session, as a channel event it acts on as its next turn. */
  push(key: string, turnId: string, content: string, meta: Record<string, string>): Promise<void>;
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

const header = (req: IncomingMessage, name: string): string | null => {
  const value = req.headers[name];
  return typeof value === 'string' && value !== '' ? value : null;
};

/**
 * Who a request comes from, for the drafts it adds: the app's own agent runs say so in headers (`X-PR-Review-Agent`,
 * `X-PR-Review-Turn`); other clients are named from their user agent.
 */
function caller(req: IncomingMessage): { agent: string; turnId: string | null } {
  const agent = header(req, 'x-pr-review-agent') ?? (/^claude-code\b/i.test(req.headers['user-agent'] ?? '') ? 'Claude Code' : 'MCP client');
  return { agent, turnId: header(req, 'x-pr-review-turn') };
}

/** A live session's connection: its MCP server (to push through) and the request it's working on. */
interface Channel {
  key: string;
  mcp: McpServer;
  transport: StreamableHTTPServerTransport;
  turnId: string | null;
}

/** For every client: what the server is for, and how its tools fit together. */
const INSTRUCTIONS =
  'PR Review is the macOS app where the user reviews GitHub pull requests, each checked out in a worktree. These tools read the pull requests open in it and act there for the user: ' +
  'review comments go into the user’s pending review as drafts (add_draft), never straight to GitHub; set_viewed ticks files’ Viewed checkboxes; show_in_app and search_code with show bring a file, line, thread, draft or search results into view. ' +
  'Start with list_open_prs or get_pr. Show things only when the user asks to see or find them.';

const CHANNEL_INSTRUCTIONS =
  `${INSTRUCTIONS} PR Review sends requests about the pull request you are reviewing as <channel source="pr-review"> events. Act on each one as if the user typed it. ` +
  'When a request has a turn_id, answer it briefly with the reply tool (the answer shows in PR Review).';

/**
 * The PR Review MCP server on 127.0.0.1:`port`, over Streamable HTTP. Tool calls are stateless (drafts live in the app,
 * not in MCP sessions). A live terminal session (`X-PR-Review-Channel` and `X-PR-Review-Pr` headers) gets a stateful
 * MCP session instead, declaring Claude Code's `claude/channel` capability, so the app can push requests into it.
 */
export function startMcpServer(bridge: ChannelBridge, port: number, token: string): RunningMcpServer {
  let error: string | null = null;
  /** MCP session id → live session. */
  const channels = new Map<string, Channel>();
  const channelFor = (key: string) => [...channels.values()].reverse().find((c) => c.key === key);

  const openChannel = (req: IncomingMessage, key: string): Channel => {
    const mcp = new McpServer({ name: 'pr-review', version }, { capabilities: { experimental: { 'claude/channel': {} } }, instructions: CHANNEL_INSTRUCTIONS });
    const agent = header(req, 'x-pr-review-agent') ?? 'Claude Code';
    const transport: StreamableHTTPServerTransport = new StreamableHTTPServerTransport({
      sessionIdGenerator: () => randomUUID(),
      onsessioninitialized: (id) => void channels.set(id, channel),
      onsessionclosed: (id) => void channels.delete(id),
    });
    const channel: Channel = { key, mcp, transport, turnId: null };
    transport.onclose = () => {
      if (transport.sessionId) channels.delete(transport.sessionId);
    };
    registerReviewTools(mcp, bridge, () => ({ agent, turnId: channel.turnId }));
    mcp.registerTool(
      'reply',
      {
        title: 'Answer PR Review',
        description: 'Sends a short answer (Markdown) to a request PR Review pushed into this session; it shows where the user asked it.',
        inputSchema: { turn_id: z.string().describe('The turn_id of the request'), text: z.string().min(1) },
      },
      async ({ turn_id, text }) => {
        await bridge.agentReply(key, turn_id, text);
        return { content: [{ type: 'text' as const, text: 'Sent to PR Review.' }] };
      },
    );
    return channel;
  };

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
    const failed = () => {
      if (!res.headersSent) res.writeHead(500).end();
    };
    const sessionId = header(req, 'mcp-session-id');
    const existing = sessionId ? channels.get(sessionId) : undefined;
    if (existing) {
      existing.transport.handleRequest(req, res).catch(failed);
      return;
    }
    const pr = header(req, 'x-pr-review-pr');
    if (header(req, 'x-pr-review-channel') && pr && req.method === 'POST' && !sessionId) {
      const channel = openChannel(req, pr);
      channel.mcp
        .connect(channel.transport)
        .then(() => channel.transport.handleRequest(req, res))
        .catch(failed);
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
      .catch(failed);
  });
  server.on('error', (err: NodeJS.ErrnoException) => {
    error = err.code === 'EADDRINUSE' ? `Port ${port} is in use by another program. Choose another port in Settings › Agents.` : err.message;
  });
  server.listen(port, '127.0.0.1');
  return {
    url: `http://127.0.0.1:${port}/mcp`,
    error: () => error,
    channelConnected: (key) => channelFor(key) !== undefined,
    push: async (key, turnId, content, meta) => {
      const channel = channelFor(key);
      if (!channel) throw new Error('No Claude session in a terminal is connected for this pull request.');
      channel.turnId = turnId;
      await channel.mcp.server.notification({ method: 'notifications/claude/channel', params: { content, meta: { ...meta, turn_id: turnId } } });
    },
    close: () => {
      for (const c of channels.values()) void c.transport.close().catch(() => undefined);
      channels.clear();
      server.close();
    },
  };
}
